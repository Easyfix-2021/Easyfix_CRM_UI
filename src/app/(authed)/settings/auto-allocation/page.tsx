'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Mail, Save, RotateCcw, AlertCircle, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { SearchSelect } from '@/components/ui/search-select';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { cn } from '@/lib/utils';

/*
 * Manage Auto Allocations
 * ------------------------
 *   Scope: "Global defaults" vs a specific client.
 *   Global scope → PATCH /admin/auto-allocation/default { settingId, value }
 *   Client scope → PUT /admin/auto-allocation/override { clientId, settingId, value }
 *
 * Binary behaviour: running_frequency is either 'instant' (auto-allocate at
 * creation) or anything else (skip). We removed the 'schedule' batch option
 * since there's no cron backing it — the toggle is purely on/off.
 *
 * UI layers (top → bottom):
 *   1. Scope picker + clients-with-overrides chips
 *   2. Auto-Allocate Jobs toggle
 *   3. Failure Notification Email
 *   4. Scoring Weights (collapsible)
 *   5. Advanced (collapsible) — description + type-specific input only
 */

type Setting = {
  id: number;
  key: string;
  description: string | null;
  data_type: 'string' | 'integer' | 'bool' | 'double' | 'time' | 'json';
  default_value: string | null;
  effective_value: string | number | boolean | null;
  is_overridden: boolean;
};
type ClientLite = { client_id: number; client_name: string };

export default function AutoAllocationPage() {
  const lk = useLookup();
  const [scope, setScope] = useState<'global' | number>('global');
  const [overridden, setOverridden] = useState<ClientLite[]>([]);
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showWeights, setShowWeights] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Collapsed by default — ops who already know the flow shouldn't have to
  // scroll past it every visit. The chevron + tinted card make it obvious
  // there's content to expand.
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [draft, setDraft] = useState<Record<number, string>>({});

  /*
   * Toggle-specific state for the Auto-Allocate Jobs switch.
   *   - toggleOptimistic: what the UI should *show* right now; null means
   *     "fall back to the server value". This makes the switch feel instant.
   *   - toggleRef.saving: is a request currently in flight?
   *   - toggleRef.queued: the user's most recent intent while a save is in
   *     flight. When the current save resolves, if this differs from what we
   *     just sent, we fire another save. Only the LATEST click survives —
   *     intermediate flips get coalesced so the server never lags behind by
   *     more than one request no matter how fast the user toggles.
   */
  const [toggleOptimistic, setToggleOptimistic] = useState<boolean | null>(null);
  const toggleRef = useRef<{ saving: boolean; queued: boolean | null }>({ saving: false, queued: null });

  async function load() {
    setLoading(true); setError(null);
    try {
      const qs = scope === 'global' ? {} : { clientId: scope };
      const rows = await api.get<Setting[]>('/admin/auto-allocation', qs);
      setSettings(rows);
      setDraft(Object.fromEntries(rows.map((r) => [r.id, stringify(r.effective_value, r.data_type)])));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load settings');
      setSettings([]);
    } finally { setLoading(false); }
  }
  useEffect(() => {
    // Scope changed → drop any lingering optimistic toggle state so the UI
    // reflects the new scope's server value, not the previous scope's click.
    setToggleOptimistic(null);
    toggleRef.current = { saving: false, queued: null };
    load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [scope]);

  useEffect(() => {
    api.get<ClientLite[]>('/admin/auto-allocation/clients-with-overrides')
      .then(setOverridden).catch(() => setOverridden([]));
  }, []);

  const byKey = useMemo(() => {
    const m = new Map<string, Setting>();
    (settings ?? []).forEach((s) => m.set(s.key, s));
    return m;
  }, [settings]);

  async function saveValue(s: Setting, value: string) {
    setSaving(s.id); setError(null); setToast(null);
    try {
      if (scope === 'global') {
        await api.patch('/admin/auto-allocation/default', { settingId: s.id, value });
      } else {
        await api.put('/admin/auto-allocation/override', { clientId: scope, settingId: s.id, value });
      }
      setToast(`Saved: ${titleCase(s.key)}`);
      await load();
      if (scope !== 'global') {
        api.get<ClientLite[]>('/admin/auto-allocation/clients-with-overrides')
          .then(setOverridden).catch(() => {});
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setSaving(null); }
  }

  /*
   * Dedicated handler for the Auto-Allocate Jobs toggle. Unlike saveValue:
   *   - No success toast — the switch visibly moves, that's feedback enough.
   *   - Optimistic UI — the switch reflects the user's last click instantly.
   *   - Serialized requests with coalescing — rapid toggles collapse into one
   *     in-flight request + one queued "final" intent, so we can't backlog
   *     stale requests or race-condition ourselves into a flipped state.
   */
  async function handleToggleAutoAllocate(next: boolean) {
    if (!runningFrequency) return;
    setToggleOptimistic(next);

    if (toggleRef.current.saving) {
      toggleRef.current.queued = next;
      return;
    }
    toggleRef.current.saving = true;
    let target = next;
    try {
      while (true) {
        const value = target ? 'instant' : 'off';
        setError(null);
        try {
          if (scope === 'global') {
            await api.patch('/admin/auto-allocation/default', { settingId: runningFrequency.id, value });
          } else {
            await api.put('/admin/auto-allocation/override', { clientId: scope, settingId: runningFrequency.id, value });
          }
        } catch (e) {
          setError(e instanceof ApiError ? e.message : 'Save failed');
          // Revert optimistic: reload server truth.
          break;
        }
        // If the user clicked again while we were saving, fire another save
        // with the latest intent. Otherwise we're done.
        const q = toggleRef.current.queued;
        if (q !== null && q !== target) {
          target = q;
          toggleRef.current.queued = null;
          continue;
        }
        toggleRef.current.queued = null;
        break;
      }
    } finally {
      toggleRef.current.saving = false;
      await load();
      setToggleOptimistic(null);
      if (scope !== 'global') {
        api.get<ClientLite[]>('/admin/auto-allocation/clients-with-overrides')
          .then(setOverridden).catch(() => {});
      }
    }
  }

  async function clearOverride(s: Setting) {
    if (scope === 'global') return;
    if (!confirm(`Remove this override? "${titleCase(s.key)}" will revert to the global default.`)) return;
    setSaving(s.id); setError(null); setToast(null);
    try {
      await api.delete(`/admin/auto-allocation/override?clientId=${scope}&settingId=${s.id}`);
      setToast(`Override cleared for ${titleCase(s.key)}`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Clear failed');
    } finally { setSaving(null); }
  }

  const runningFrequency = byKey.get('running_frequency');
  const failureEmail     = byKey.get('auto_assign_failure_email');
  /*
   * Weight categorisation
   * ─────────────────────
   * The engine's L3 score has 3 dimensions — Workload, Rating, Completion.
   * Many legacy weight rows already exist in tbl_autoallocation_setting; we
   * group them here so ops see semantic categories instead of a flat list.
   *
   * Backend (services/auto-assign.service.js::scoreFromSettings) sums each
   * category's sub-weights into that dimension's effective W, so editing any
   * sub-weight here actually moves the engine — keep this map in sync with
   * the matching map in the backend file.
   *
   * `workload_weight` / `rating_weight` / `completion_weight` are the
   * "primary" knobs for each dimension and remain editable even if no other
   * sub-weights exist. Anything that ends in `_weight` but isn't in any list
   * is silently ignored (legacy noise; not surfaced to ops).
   */
  /*
   * Weight model
   * ────────────
   *   3 DIMENSION weights (workload / rating / completion) — these ARE the W
   *   values used in the L3 score. They MUST sum to 1.0 across the three.
   *
   *   Within Completion only, 3 sub-weights are PROPORTIONS that split the
   *   dimension's W = 0.25 across cancellation, escalation, and estimate-
   *   rejection failure modes. They MUST sum to 1.0 within the bucket.
   *
   *   So if completion_weight = 0.25 and cancellation_weight = 0.4, the
   *   cancellation signal contributes 0.25 × 0.4 = 0.10 to the final score.
   *   Workload and Rating have no sub-weights — their dimension W is the
   *   contribution directly.
   *
   * Mirrors backend WEIGHT_BUCKETS + COMPLETION_SUB_WEIGHTS.
   */
  const WEIGHT_CATEGORIES: Record<'workload' | 'rating' | 'completion', {
    title: string; blurb: string; dimensionKey: string; subWeightKeys: string[];
  }> = {
    workload: {
      title: 'Workload Weight',
      blurb: 'Atomic dimension — controls how heavily current job-load influences ranking. Higher → engine prefers techs with spare capacity.',
      dimensionKey: 'workload_weight',
      subWeightKeys: [],
    },
    rating: {
      title: 'Rating Weight',
      blurb: 'Atomic dimension — controls how heavily 90-day customer ratings influence ranking. Higher → engine prefers techs with strong rating history.',
      dimensionKey: 'rating_weight',
      subWeightKeys: [],
    },
    completion: {
      title: 'Completion Weight',
      blurb: 'Composite dimension — the W is split proportionally across the failure-mode sub-weights below. Sub-weight values are PROPORTIONS that must sum to 1.0; each sub-weight\'s contribution = (W × proportion).',
      dimensionKey: 'completion_weight',
      subWeightKeys: ['cancellation_weight', 'escalation_weight', 'estimate_rejection_weight'],
    },
  };
  type WeightCategoryKey = keyof typeof WEIGHT_CATEGORIES;

  // Lookup: bucket containing each known weight key (used by both grouping + the
  // Advanced-section denylist so a sub-weight never accidentally leaks there).
  const KEY_TO_BUCKET = new Map<string, WeightCategoryKey>();
  for (const cat of Object.keys(WEIGHT_CATEGORIES) as WeightCategoryKey[]) {
    KEY_TO_BUCKET.set(WEIGHT_CATEGORIES[cat].dimensionKey, cat);
    for (const sk of WEIGHT_CATEGORIES[cat].subWeightKeys) KEY_TO_BUCKET.set(sk, cat);
  }
  const allWeightKeys = new Set(KEY_TO_BUCKET.keys());

  // Per-bucket grouping: { dimension: Setting | undefined, subs: Setting[] }
  const groupedWeights = useMemo(() => {
    const out: Record<WeightCategoryKey, { dimension?: Setting; subs: Setting[] }> = {
      workload:   { subs: [] },
      rating:     { subs: [] },
      completion: { subs: [] },
    };
    for (const s of settings ?? []) {
      const bucket = KEY_TO_BUCKET.get(s.key);
      if (!bucket) continue;
      if (s.key === WEIGHT_CATEGORIES[bucket].dimensionKey) out[bucket].dimension = s;
      else out[bucket].subs.push(s);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);
  const totalWeightSettings =
    Object.values(groupedWeights).reduce((acc, g) => acc + (g.dimension ? 1 : 0) + g.subs.length, 0);
  /*
   * Keys hidden from Advanced — either:
   *   - Surfaced elsewhere (running_frequency = the toggle, failure_email = its own card).
   *   - Made obsolete by realtime behaviour (auto_assign_top_candidates_count
   *     was a batch-mode knob; we now compute top-10 in realtime when ops click
   *     Auto-assign in the Job modal, and on creation we always assign #1).
   *   - Not yet wired into the engine — surfacing them would imply tuning has
   *     an effect when it doesn't. Re-add to Advanced as each gets consumed.
   *
   * The rows themselves stay in the DB (no DELETE needed) — we just don't
   * render them. Easy to put back: drop the key from this Set.
   */
  const HIDDEN_FROM_ADVANCED = new Set([
    'running_frequency',
    'auto_assign_failure_email',
    'auto_assign_top_candidates_count',
    'predefined_estimate_tat',
    'job_schedule_time',
    'new_easyfixer_joining_days',
    'score_update_window',
    'history_days',
  ]);
  const advanced = (settings ?? []).filter((s) =>
    !allWeightKeys.has(s.key) &&
    !s.key.endsWith('_weight') && // hide any uncategorised legacy *_weight rows from Advanced too
    !HIDDEN_FROM_ADVANCED.has(s.key)
  );

  // Optimistic UI: show the user's last click immediately; fall back to server
  // truth once any in-flight save resolves and `load()` refreshes settings.
  const autoAllocateOn = toggleOptimistic ?? (runningFrequency?.effective_value === 'instant');

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-semibold">Manage Auto Allocations</h1>
        <p className="text-sm text-muted-foreground">
          Control when the auto-assignment engine runs, who hears about failures, and how the scoring works.
        </p>
      </div>

      <HowItWorks open={showHowItWorks} onToggle={() => setShowHowItWorks((s) => !s)} />

      {/* 1. Scope picker + clients-with-overrides chips — all in one card */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <Label className="shrink-0">Scope</Label>
            <div className="flex items-center gap-2">
              <Button
                size="sm" variant={scope === 'global' ? 'default' : 'outline'}
                onClick={() => setScope('global')}
              >Global Defaults</Button>
              <span className="text-xs text-muted-foreground">or</span>
              <SearchSelect
                value={scope === 'global' ? '' : String(scope)}
                onChange={(v) => setScope(v ? Number(v) : 'global')}
                options={lk.toOpts.clients.map((c) => ({ value: c.value, label: String(c.label) }))}
                placeholder="— Specific Client —"
                className="w-72"
              />
            </div>
          </div>
          {overridden.length > 0 && (
            <div className="pt-2 border-t">
              <div className="text-xs text-muted-foreground mb-1.5">Clients with active overrides:</div>
              <div className="flex flex-wrap gap-1.5">
                {overridden.map((c) => (
                  <button
                    key={c.client_id}
                    onClick={() => setScope(c.client_id)}
                    className={cn(
                      'text-xs rounded border px-2 py-1 transition-colors',
                      scope === c.client_id
                        ? 'border-primary bg-primary/10 text-primary font-medium'
                        : 'hover:border-primary hover:bg-muted/50'
                    )}
                  >
                    {c.client_name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {toast && <div className="text-xs rounded border border-emerald-200 bg-emerald-50 text-emerald-800 px-3 py-2">{toast}</div>}
      {error && <div className="text-xs rounded border border-destructive/30 bg-destructive/10 text-destructive px-3 py-2">{error}</div>}

      {loading && <div className="text-sm text-muted-foreground py-8 text-center">Loading settings…</div>}

      {!loading && settings && (
        <>
          {/* 2. Auto-Allocate Jobs toggle */}
          {runningFrequency && (
            <Card>
              <CardContent className="p-3 flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">Auto-Allocate Jobs</div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    When enabled, newly created jobs are assigned to the best-matched technician automatically.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Toggle
                    on={autoAllocateOn}
                    onChange={handleToggleAutoAllocate}
                  />
                  {scope !== 'global' && runningFrequency.is_overridden && (
                    <Button size="sm" variant="ghost" title="Revert to global default"
                      onClick={() => clearOverride(runningFrequency)}>
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* 3. Failure Notification Email */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Mail className="h-4 w-4 text-primary" /> Failure Notification Email
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Notifies this address whenever auto-assignment fails to persist a technician — whether no eligible technician was found, the save errored, or any other issue occurred in the flow. Once the assignment is saved in the DB, no email is sent. Leave blank to skip notifications.
              </p>
              {failureEmail ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="email"
                    value={draft[failureEmail.id] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [failureEmail.id]: e.target.value }))}
                    placeholder="ops@example.com"
                  />
                  <SaveBtn setting={failureEmail} draft={draft} scope={scope} saving={saving} onSave={saveValue} onClear={clearOverride} />
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <div>
                    Settings row <code>auto_assign_failure_email</code> doesn&apos;t exist in the database yet. Run the migration shipped with this feature, then refresh.
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 4. Scoring Weights — collapsible, 3 sub-sections (Workload / Rating / Completion) */}
          {totalWeightSettings > 0 && (() => {
            // Live dimension W per bucket from current drafts (or fall back to
            // the saved effective_value if no draft change yet).
            const liveDimW = (catKey: WeightCategoryKey): number => {
              const dim = groupedWeights[catKey].dimension;
              if (!dim) return 0;
              const raw = draft[dim.id] ?? stringify(dim.effective_value, dim.data_type);
              const n = Number(raw);
              return Number.isFinite(n) ? n : 0;
            };
            const dim = {
              workload:   liveDimW('workload'),
              rating:     liveDimW('rating'),
              completion: liveDimW('completion'),
            };
            const dimSum = dim.workload + dim.rating + dim.completion;
            const dimSumOK = Math.abs(dimSum - 1) < 0.001;

            // Sub-weight sum within Completion (proportions — must = 1.0).
            const completionSubSum = groupedWeights.completion.subs.reduce((acc, w) => {
              const raw = draft[w.id] ?? stringify(w.effective_value, w.data_type);
              const n = Number(raw);
              return Number.isFinite(n) ? acc + n : acc;
            }, 0);
            const completionSubsOK =
              groupedWeights.completion.subs.length === 0 || Math.abs(completionSubSum - 1) < 0.001;

            return (
              <Collapsible
                title="Scoring Weights"
                blurb="L3 composite score = (W_workload × workload_score) + (W_rating × rating_score) + (W_completion × completion_score). Workload + Rating + Completion must SUM TO 1.0. Within Completion, the failure-mode sub-weights are PROPORTIONS that split W_completion — they must also sum to 1.0."
                open={showWeights}
                onToggle={() => setShowWeights((s) => !s)}
              >
                {/* Header strip — live dimension Ws + cross-bucket validation */}
                <div className={cn(
                  'mb-4 rounded-md border px-3 py-2 text-xs flex flex-wrap items-center gap-x-4 gap-y-1.5',
                  dimSumOK ? 'bg-blue-50/40 border-blue-200' : 'bg-amber-50 border-amber-300'
                )}>
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-white border px-1.5 py-0.5"><strong>W_workload</strong> = {dim.workload.toFixed(2)}</span>
                    <span className="rounded bg-white border px-1.5 py-0.5"><strong>W_rating</strong> = {dim.rating.toFixed(2)}</span>
                    <span className="rounded bg-white border px-1.5 py-0.5"><strong>W_completion</strong> = {dim.completion.toFixed(2)}</span>
                  </div>
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-muted-foreground">Sum:</span>
                    <strong className={dimSumOK ? 'text-emerald-700' : 'text-amber-800'}>{dimSum.toFixed(2)}</strong>
                    {dimSumOK
                      ? <span className="text-emerald-700">✓</span>
                      : <span className="text-amber-800 font-medium">— must be 1.00</span>}
                  </div>
                </div>

                <div className="space-y-4">
                  {(Object.keys(WEIGHT_CATEGORIES) as WeightCategoryKey[]).map((catKey) => {
                    const cat = WEIGHT_CATEGORIES[catKey];
                    const group = groupedWeights[catKey];
                    return (
                      <WeightSubSection
                        key={catKey}
                        title={cat.title}
                        blurb={cat.blurb}
                        dimensionWeight={dim[catKey]}
                        dimensionSetting={group.dimension}
                        subSettings={group.subs}
                        subWeightKeysExpected={cat.subWeightKeys}
                        // Only completion has sub-weight validation right now.
                        subSumOK={catKey === 'completion' ? completionSubsOK : true}
                        subSumActual={catKey === 'completion' ? completionSubSum : null}
                        draft={draft}
                        scope={scope}
                        saving={saving}
                        setDraft={setDraft}
                        onSave={saveValue}
                        onClear={clearOverride}
                      />
                    );
                  })}
                </div>
              </Collapsible>
            );
          })()}

          {/* 5. Advanced — collapsible, description + type-appropriate input only */}
          {advanced.length > 0 && (
            <Collapsible
              title="Advanced"
              blurb="Operational knobs — history windows, batch times, tier overrides, and customer communication defaults."
              open={showAdvanced}
              onToggle={() => setShowAdvanced((s) => !s)}
            >
              <div className="divide-y">
                {advanced.map((s) => (
                  <div key={s.id} className="py-3 flex flex-col md:flex-row md:items-center md:gap-4 gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{titleCase(s.key)}</div>
                      {s.description && (
                        <p className="text-xs text-muted-foreground whitespace-pre-line mt-0.5">{s.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 md:w-[18rem] shrink-0">
                      <ValueInput setting={s} value={draft[s.id] ?? ''}
                        onChange={(v) => setDraft((d) => ({ ...d, [s.id]: v }))} />
                      <SaveBtn setting={s} draft={draft} scope={scope} saving={saving} onSave={saveValue} onClear={clearOverride} compact />
                    </div>
                  </div>
                ))}
              </div>
            </Collapsible>
          )}
        </>
      )}
    </div>
  );
}

// ─── How it Works panel ─────────────────────────────────────────────
/*
 * Single source of truth for "what does the engine actually do?" displayed
 * inline so ops can self-serve answers without pinging engineering. Mirrors
 * the backend service docstring in services/auto-assign.service.js — keep
 * the two in sync when the pipeline changes.
 */
function HowItWorks({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const Chev = open ? ChevronDown : ChevronRight;
  return (
    <Card className="border-blue-200 bg-blue-50/30">
      <button type="button" onClick={onToggle} className="w-full text-left">
        <CardHeader className="py-3 flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-blue-700" />
            <CardTitle className="text-base text-blue-900">How It Works?</CardTitle>
          </div>
          <Chev className="h-4 w-4 text-blue-700" />
        </CardHeader>
      </button>
      {open && (
        <CardContent className="space-y-4 text-[13px] text-foreground/90 leading-relaxed">
          <Section title="When does it run?">
            <p>
              The engine fires once per job, immediately after the job is created (CRM, Excel upload,
              client API or external integration) — but only if the client&apos;s <em>Auto-Allocate Jobs</em> toggle
              is ON. The job-create response returns first; the assignment runs asynchronously, so the
              caller never waits on it.
            </p>
            <p>
              There is <strong>no batch / cron job</strong> — failed allocations stay in <span className="badge">BOOKED</span>{' '}
              status and need manual reassignment from the job page.
            </p>
          </Section>

          <Section title="Layer 1 — Eligibility filter (who CAN do this job)">
            <p>For each new job, technicians are excluded if they:</p>
            <ul className="list-disc ml-5 space-y-1 mt-1">
              <li>Are inactive (<code>efr_status = 0</code>)</li>
              <li>Have not been profile-verified (<code>is_technician_verified = 0</code>)</li>
              <li>Are not in the customer&apos;s city (<code>tbl_easyfixer.efr_cityId</code>)</li>
              <li>Don&apos;t cover the customer&apos;s service category (skill match on <code>efr_service_category</code>)</li>
              <li>
                <strong>Are not zone-mapped to the customer&apos;s pincode.</strong> Each tech is mapped to a single{' '}
                <em>city-zone</em> (<code>efr_zone_city_id</code>); the customer pincode is resolved through{' '}
                <code>pincode_firefox_city_mapping</code> → <code>tbl_zone_city_mapping</code> →{' '}
                <code>tbl_zone_master</code>. If a tech&apos;s zone doesn&apos;t cover that pincode, they&apos;re out — even
                if they live next door. Manage zones under <em>Easyfixers → Zones</em>.
              </li>
              <li>
                Have already <strong>rejected or rescheduled</strong> off this exact job earlier (a row in{' '}
                <code>scheduling_history</code> with a non-empty <code>reschedule_reason</code>).
              </li>
            </ul>
          </Section>

          <Section title="Layer 2 — Availability filter (who SHOULDN'T get more work right now)">
            <p>From the L1 set, drop technicians who:</p>
            <ul className="list-disc ml-5 space-y-1 mt-1">
              <li>Already have <code>≥ Max Concurrent Jobs</code> active (status BOOKED / SCHEDULED / IN_PROGRESS).</li>
              <li>Have a booking conflict on the same date + time slot.</li>
            </ul>
            <p className="text-xs text-muted-foreground mt-1.5">
              Caps are configured under <em>Advanced</em> below. There is no longer a hard distance cap — that role
              is handled entirely by zone membership in L1.
            </p>
          </Section>

          <Section title="Layer 3 — Composite score (rank what's left)">
            <p>Each surviving technician gets a score in [0, 1]:</p>
            <pre className="bg-white border rounded p-2 text-xs overflow-x-auto mt-1">
{`score = (W_workload × workload_score)
      + (W_rating × rating_score)
      + (W_completion × completion_score)

workload_score   = (maxJobs − activeJobs) / maxJobs
rating_score     = avg_customer_rating / 5             (default 3.0 if no ratings in 90d)
completion_score = completed / (completed + cancelled) (default 0.8 if no history in 90d)

Built-in defaults: W_workload = 0.45, W_rating = 0.30, W_completion = 0.25`}
            </pre>
            <p>
              Each dimension W has its own row in <code>tbl_autoallocation_setting</code> — these three values
              must <strong>sum to 1.0</strong>:
            </p>
            <ul className="list-disc ml-5 space-y-1 mt-1">
              <li><strong>Workload:</strong> <code>workload_weight</code> (single value, e.g. <code>0.45</code>)</li>
              <li><strong>Rating:</strong> <code>rating_weight</code> (single value, e.g. <code>0.30</code>)</li>
              <li><strong>Completion:</strong> <code>completion_weight</code> (single value, e.g. <code>0.25</code>)</li>
            </ul>
            <p className="mt-2">
              Within <strong>Completion only</strong>, three sub-weights act as <strong>PROPORTIONS</strong> that split
              the dimension W across failure modes — they must sum to <code>1.0</code> within the bucket:
            </p>
            <ul className="list-disc ml-5 space-y-1 mt-1">
              <li><code>cancellation_weight</code> + <code>escalation_weight</code> + <code>estimate_rejection_weight</code> = 1.0</li>
              <li>Each sub-weight&apos;s contribution = <code>W_completion × proportion</code> (e.g. <code>0.25 × 0.40 = 0.10</code>)</li>
            </ul>
            <p className="text-xs text-muted-foreground mt-2">
              Per-failure-mode SCORING (computing each tech&apos;s cancellation / escalation / estimate-rejection rates
              separately) is not yet wired in the engine — the proportions are stored + tunable now so they can shape
              behaviour the moment that scoring lands. As a safety net, the engine still normalises dimension Ws to 1.0
              at runtime, so if the three values drift slightly the rank order stays correct. Stats are batched in 4
              queries regardless of how many technicians pass L1, so even saturated cities score in ~2 s against the
              full 384 k-row job table.
            </p>
          </Section>

          <Section title="Assignment + side-effects">
            <p>
              The top-ranked technician is assigned via the same code path as a manual assignment from the job page:
            </p>
            <ul className="list-disc ml-5 space-y-1 mt-1">
              <li>Single transaction: <code>UPDATE tbl_job</code> (sets <code>fk_easyfixter_id</code>, scheduled time, status BOOKED → SCHEDULED) + <code>INSERT scheduling_history</code>.</li>
              <li>After commit (fire-and-forget): <code>TechAssigned</code> webhook fires to subscribed clients (Decathlon etc.).</li>
              <li>FCM push lands on the chosen technician&apos;s device.</li>
            </ul>
          </Section>

          <Section title="Manual reassignment + Top-10 list">
            <p>
              When ops click <em>Reassign</em> on a job, the same engine runs in <strong>real time</strong> and returns
              the top 10 technicians with their scores, workload, rating and completion ratio. Ops can pick the recommended
              technician, choose any of the other 9, or fall back to the manual searchable picker (which shows the full
              eligible list for edge cases).
            </p>
          </Section>

          <Section title="What if it can't assign?">
            <p>
              If no technician clears L1 + L2, OR the assignment errors before being persisted, the engine sends an email
              to the address configured in <em>Failure Notification Email</em> below. The job stays in BOOKED for manual
              triage. Once the assignment is saved in the DB, no further notifications fire — downstream webhook + FCM
              delivery have their own retry / DLQ handling.
            </p>
          </Section>

          <Section title="Per-client overrides">
            <p>
              Every setting on this page resolves <code>per-client override → global default → built-in fallback</code>.
              Switch the <em>Scope</em> picker above to a specific client to view (or override) just that client&apos;s
              behaviour without affecting anyone else. Reads are realtime — toggling here applies to the very next job
              created.
            </p>
          </Section>
        </CardContent>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-semibold text-blue-950 mb-1">{title}</div>
      <div className="space-y-1 text-foreground/85">{children}</div>
    </div>
  );
}

// ─── Helpers + small components ──────────────────────────────────────

function stringify(v: unknown, type: Setting['data_type']): string {
  if (v == null) return '';
  if (type === 'bool')  return v ? 'true' : 'false';
  if (type === 'json')  try { return JSON.stringify(v); } catch { return String(v); }
  return String(v);
}

/*
 * snake_case / lowercased key → "Title Case Text". Drops common suffix words
 * that don't read well as UI text but are fine in DB-land:
 *   running_frequency → "Running Frequency"
 *   auto_assign_failure_email → "Auto Assign Failure Email"
 *   tat_service_catg_tier → "Tat Service Catg Tier"
 */
function titleCase(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function Toggle({ on, onChange, disabled }: {
  on: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        on ? 'bg-primary' : 'bg-input',
        disabled && 'opacity-60 cursor-not-allowed'
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow',
          on ? 'translate-x-6' : 'translate-x-1'
        )}
      />
    </button>
  );
}

/*
 * One category card (Workload / Rating / Completion) inside the Scoring
 * Weights collapsible.
 *
 * Layout:
 *   - Header bar:  title + blurb + "Bucket sum = N.NN" badge
 *                  (Bucket sum = the dimension W value itself)
 *   - Body top:    single input for the DIMENSION weight (workload_weight etc.)
 *   - Body bottom: only when subWeightKeys exist (today: only Completion)
 *                  → grid of sub-weight inputs that act as PROPORTIONS within
 *                    this dimension. Each input shows its contribution math
 *                    inline ("× 0.25 = 0.075"). A footer line shows the live
 *                    sub-weight sum with a ✓/⚠ marker for the must-equal-1
 *                    invariant.
 *
 * Empty state for the dimension: if the row hasn't been seeded in the DB yet,
 * a code block of the relevant SQL INSERT is shown so ops can copy-paste it.
 */
function WeightSubSection({
  title, blurb, dimensionWeight, dimensionSetting, subSettings, subWeightKeysExpected,
  subSumOK, subSumActual, draft, scope, saving, setDraft, onSave, onClear,
}: {
  title: string; blurb: string;
  dimensionWeight: number;
  dimensionSetting?: Setting;
  subSettings: Setting[];
  subWeightKeysExpected: string[];
  subSumOK: boolean;
  subSumActual: number | null;
  draft: Record<number, string>;
  scope: 'global' | number;
  saving: number | null;
  setDraft: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  onSave: (s: Setting, v: string) => Promise<void> | void;
  onClear: (s: Setting) => Promise<void> | void;
}) {
  const expectedDimKey = title.split(' ')[0].toLowerCase() + '_weight';
  // Inline SQL ops can paste into MySQL Workbench / DBeaver — keeps them
  // unblocked when a fresh DB is missing this dimension's seed row.
  const insertSnippet = `INSERT INTO tbl_autoallocation_setting (\`key\`, default_value, description, data_type)\nVALUES ('${expectedDimKey}', '0.30', '${title} dimension weight', 'double');`;
  return (
    <div className="rounded-md border bg-muted/20">
      <div className="px-3 py-2 border-b flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{blurb}</p>
        </div>
        <span
          className="text-[10px] uppercase tracking-wide rounded bg-primary/10 text-primary px-2 py-0.5 shrink-0 font-medium"
          title="The dimension weight (W) for this bucket. Must combine with the other 2 dimensions to sum to 1.0."
        >
          Bucket sum = {dimensionWeight.toFixed(2)}
        </span>
      </div>
      <div className="p-3 space-y-3">
        {/* Dimension weight input (single field) */}
        {dimensionSetting ? (
          <div className="max-w-xs">
            <Label className="text-xs flex items-center gap-1.5">
              {titleCase(dimensionSetting.key)}
              {dimensionSetting.is_overridden && scope !== 'global' && (
                <span className="text-[10px] rounded bg-amber-100 text-amber-800 px-1">overridden</span>
              )}
            </Label>
            <div className="flex items-center gap-1.5">
              <Input
                type="number" step="0.01" min={0} max={1}
                value={draft[dimensionSetting.id] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [dimensionSetting.id]: e.target.value }))}
              />
              <SaveBtn setting={dimensionSetting} draft={draft} scope={scope} saving={saving} onSave={onSave} onClear={onClear} compact />
            </div>
          </div>
        ) : (
          <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 space-y-1.5">
            <div>
              No DB row for <code>{expectedDimKey}</code> yet — the engine uses its built-in default.
              Insert the row to make it editable here:
            </div>
            <pre className="bg-white border rounded p-1.5 text-[11px] overflow-x-auto whitespace-pre">{insertSnippet}</pre>
          </div>
        )}

        {/* Sub-weight grid (proportions, only when subWeightKeysExpected non-empty) */}
        {subWeightKeysExpected.length > 0 && (
          <div className="border-t pt-3">
            <div className="text-xs font-medium mb-2 text-muted-foreground">
              Sub-weight proportions <span className="text-[10px] uppercase tracking-wide">(must sum to 1.0)</span>
            </div>
            {subSettings.length === 0 ? (
              <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                No sub-weight rows yet. Expected keys: {subWeightKeysExpected.map((k) => <code key={k} className="mx-0.5">{k}</code>)}.
                Insert them via <code>tbl_autoallocation_setting</code> with <code>data_type=&apos;double&apos;</code>; values should sum to 1.0.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {subSettings.map((w) => {
                    const raw = draft[w.id] ?? '';
                    const propVal = Number(raw);
                    const contribution = Number.isFinite(propVal) ? dimensionWeight * propVal : 0;
                    return (
                      <div key={w.id} className="space-y-1">
                        <Label className="text-xs flex items-center gap-1.5">
                          {titleCase(w.key)}
                          {w.is_overridden && scope !== 'global' && (
                            <span className="text-[10px] rounded bg-amber-100 text-amber-800 px-1">overridden</span>
                          )}
                        </Label>
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number" step="0.01" min={0} max={1}
                            value={raw}
                            onChange={(e) => setDraft((d) => ({ ...d, [w.id]: e.target.value }))}
                          />
                          <SaveBtn setting={w} draft={draft} scope={scope} saving={saving} onSave={onSave} onClear={onClear} compact />
                        </div>
                        {/*
                          * Live contribution math — the user's mental model is
                          * "what does this knob actually contribute to the
                          * final score?". Showing the multiplication answers
                          * that without making them do arithmetic.
                          */}
                        <div className="text-[10px] text-muted-foreground tabular-nums">
                          contributes {dimensionWeight.toFixed(2)} × {Number.isFinite(propVal) ? propVal.toFixed(2) : '—'} = <strong>{contribution.toFixed(3)}</strong>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Sub-weight sum validation footer */}
                {subSumActual !== null && (
                  <div className={cn(
                    'mt-3 rounded px-2 py-1 text-[11px] flex items-center justify-between',
                    subSumOK
                      ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                      : 'bg-amber-50 border border-amber-300 text-amber-900'
                  )}>
                    <span>Sub-weight sum</span>
                    <span className="tabular-nums">
                      <strong>{subSumActual.toFixed(2)}</strong>
                      {subSumOK ? ' ✓' : ' — must be 1.00'}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Collapsible({
  title, blurb, open, onToggle, children,
}: {
  title: string; blurb?: string; open: boolean;
  onToggle: () => void; children: React.ReactNode;
}) {
  const Chev = open ? ChevronDown : ChevronRight;
  return (
    <Card>
      <button type="button" onClick={onToggle} className="w-full text-left">
        <CardHeader className="py-3 flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            {blurb && <p className="text-xs text-muted-foreground mt-1">{blurb}</p>}
          </div>
          <Chev className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
      </button>
      {open && <CardContent>{children}</CardContent>}
    </Card>
  );
}

/*
 * Renders the right input for a setting's data_type:
 *   bool              → Yes / No radio pair
 *   string Yes/No val → Yes / No radio pair (legacy rows like AllowMessageCustomer)
 *   integer           → number input, step=1
 *   double            → number input, step=0.01
 *   time              → time input
 *   json              → textarea
 *   string (default)  → text input
 * Key + data_type are deliberately NOT rendered to the user — only the
 * description + value control. Type validation piggybacks on the input's
 * native `type` attribute.
 */
function ValueInput({
  setting, value, onChange,
}: {
  setting: Setting; value: string; onChange: (v: string) => void;
}) {
  const looksBoolean =
    setting.data_type === 'bool' ||
    (setting.data_type === 'string' && ['Yes', 'No', 'yes', 'no', 'true', 'false'].includes(String(setting.default_value ?? '')));

  if (looksBoolean) {
    const truthy = ['true', 'yes', '1'].includes(String(value).toLowerCase());
    return (
      <div className="flex items-center gap-3 text-sm flex-1">
        {[
          { label: 'Yes', v: setting.data_type === 'bool' ? 'true' : 'Yes' },
          { label: 'No',  v: setting.data_type === 'bool' ? 'false' : 'No' },
        ].map((opt) => (
          <label key={opt.label} className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              checked={truthy === (opt.label === 'Yes')}
              onChange={() => onChange(opt.v)}
              className="h-3.5 w-3.5 accent-primary"
            />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
    );
  }

  if (setting.data_type === 'integer')
    return <Input type="number" step={1} value={value} onChange={(e) => onChange(e.target.value)} className="flex-1" />;
  if (setting.data_type === 'double')
    return <Input type="number" step="0.01" value={value} onChange={(e) => onChange(e.target.value)} className="flex-1" />;
  if (setting.data_type === 'time')
    return <Input type="time" value={value} onChange={(e) => onChange(e.target.value)} className="flex-1" />;
  if (setting.data_type === 'json')
    return (
      <textarea
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 rounded-md border border-input bg-background px-3 py-1 text-xs font-mono shadow-sm"
      />
    );
  return <Input value={value} onChange={(e) => onChange(e.target.value)} className="flex-1" />;
}

function SaveBtn({
  setting, draft, scope, saving, onSave, onClear, compact,
}: {
  setting: Setting;
  draft: Record<number, string>;
  scope: 'global' | number;
  saving: number | null;
  onSave: (s: Setting, v: string) => void;
  onClear: (s: Setting) => void;
  compact?: boolean;
}) {
  const dirty = (draft[setting.id] ?? '') !== stringify(setting.effective_value, setting.data_type);
  const isSaving = saving === setting.id;
  const canClear = scope !== 'global' && setting.is_overridden;

  return (
    <div className="flex items-center gap-1 shrink-0">
      <Button
        size={compact ? 'sm' : 'default'}
        variant={dirty ? 'default' : 'outline'}
        disabled={!dirty || isSaving}
        onClick={() => onSave(setting, draft[setting.id] ?? '')}
        title="Save change"
      >
        <Save className="h-3.5 w-3.5" />
        {!compact && <span className="ml-1">{isSaving ? 'Saving…' : 'Save'}</span>}
      </Button>
      {canClear && (
        <Button
          size={compact ? 'sm' : 'default'}
          variant="ghost"
          disabled={isSaving}
          onClick={() => onClear(setting)}
          title="Clear override (revert to global default)"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
