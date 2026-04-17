'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Mail, Save, RotateCcw, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
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
  const weights          = (settings ?? []).filter((s) => s.key.endsWith('_weight'));
  const advanced         = (settings ?? []).filter((s) =>
    !s.key.endsWith('_weight') &&
    !['running_frequency', 'auto_assign_failure_email'].includes(s.key)
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
                Notifies this address whenever auto-assignment fails to persist a technician — whether no eligible candidate was found, the save errored, or any other issue occurred in the flow. Once the assignment is saved in the DB, no email is sent. Leave blank to skip notifications.
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

          {/* 4. Scoring Weights — collapsible */}
          {weights.length > 0 && (
            <Collapsible
              title="Scoring Weights"
              blurb="L3 composite score = Σ(weight × signal). Recommended total = 1.0 but the engine normalises, so unequal sums still work."
              open={showWeights}
              onToggle={() => setShowWeights((s) => !s)}
            >
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {weights.map((w) => (
                  <div key={w.id} className="space-y-1">
                    <Label className="text-xs flex items-center gap-1.5">
                      {titleCase(w.key)}
                      {w.is_overridden && scope !== 'global' && <span className="text-[10px] rounded bg-amber-100 text-amber-800 px-1">overridden</span>}
                    </Label>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number" step="0.01" min={0} max={1}
                        value={draft[w.id] ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, [w.id]: e.target.value }))}
                      />
                      <SaveBtn setting={w} draft={draft} scope={scope} saving={saving} onSave={saveValue} onClear={clearOverride} compact />
                    </div>
                  </div>
                ))}
              </div>
            </Collapsible>
          )}

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
