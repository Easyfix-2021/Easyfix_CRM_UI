'use client';

/*
 * Client Profile → SLA & Priorities.
 *
 * The contracted performance targets this client is judged against, backed by
 * easyfix_client_target through GET/PUT/DELETE /admin/clients/:clientId/targets.
 * The GET is a passthrough of services/client-target.service.js — the SAME
 * module the client portal's Performance book compares its numbers to — so an
 * operator and a client read one set of figures rather than two that drift.
 *
 * ─── 'source' IS THE MOST IMPORTANT FIELD ON THE SCREEN ─────────────────────
 * A missing easyfix_client_target row is NORMAL: the service falls back to the
 * platform defaults so Performance stays renderable. Rendering those defaults
 * as if they were contracted would turn "what we hold ourselves to" into "what
 * we promised them" — the sentence nobody wants read back to them in a QBR. So
 * the banner states which it is, every time, and the Reset action exists
 * precisely so a client can go BACK to platform-default.
 *
 * ─── WHY RESET IS A DELETE, NOT "TYPE THE DEFAULTS BACK IN" ─────────────────
 * Saving the default VALUES leaves the row in place, and `source` keeps
 * reporting 'contracted'. Only removing the row restores 'platform-default'.
 * Without that, the first accidental save would mark a client as contracted
 * forever — which is why Reset is offered whenever a contracted row exists.
 */

import { useEffect, useMemo, useState } from 'react';
import { History, Info, Loader2, RotateCcw, Save, ShieldCheck, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusChip } from '@/components/ui/StatusChip';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import type { ClientTargets } from '@/lib/client-types';
import { SectionShell } from '@/components/client/SectionShell';

type MetricKey = 'sla_pct' | 'ftfr_pct' | 'revisit_pct' | 'avg_age_days' | 'approval_response_hours';

const METRICS: Array<{
  key: MetricKey; label: string; unit: string; note: string; min: number; max: number; step: string;
}> = [
  { key: 'sla_pct',  label: 'SLA Met', unit: '%', min: 0, max: 100, step: '0.01',
    note: 'Share of jobs meeting every EasyFix-owned TAT segment.' },
  { key: 'ftfr_pct', label: 'First-Time Fix Rate', unit: '%', min: 0, max: 100, step: '0.01',
    note: 'Closed on the first visit, no revisit raised.' },
  { key: 'revisit_pct', label: 'Revisit Rate', unit: '%', min: 0, max: 100, step: '0.01',
    note: 'Lower is better.' },
  { key: 'avg_age_days', label: 'Average Age At Close', unit: ' days', min: 0, max: 365, step: '0.01',
    note: 'Lower is better.' },
  { key: 'approval_response_hours', label: 'Approval Response', unit: ' hrs', min: 1, max: 720, step: '1',
    note: 'The CLIENT-owned clock — how fast they approve an estimate.' },
];

type FormState = Record<MetricKey, string>;

/* Strings, not numbers: a controlled <input type="number"> round-trips strings,
   and coercing per keystroke makes "9" unrepresentable while you delete the 5
   from "95". Coercion happens once, on submit. */
function seed(t: ClientTargets): FormState {
  return {
    sla_pct: String(t.sla_pct),
    ftfr_pct: String(t.ftfr_pct),
    revisit_pct: String(t.revisit_pct),
    avg_age_days: String(t.avg_age_days),
    approval_response_hours: String(t.approval_response_hours),
  };
}

export function SlaTargetsSection({ clientId, canEdit }: { clientId: number; canEdit: boolean }) {
  const key = `/admin/clients/${clientId}/targets`;
  const { data, loading, error, refetch } = useFetch<ClientTargets>(key);
  const [form, setForm] = useState<FormState | null>(null);
  const [snapshot, setSnapshot] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    if (!data) return;
    const next = seed(data);
    setForm(next);
    setSnapshot(next);
  }, [data]);

  const contracted = data?.source === 'contracted';
  const dirty = useMemo(
    () => !!form && !!snapshot && JSON.stringify(form) !== JSON.stringify(snapshot),
    [form, snapshot],
  );

  function set(k: MetricKey, v: string) {
    setForm((f) => (f ? { ...f, [k]: v } : f));
  }

  async function save() {
    if (!form || !canEdit || saving) return;
    /*
     * Validate locally against the same bounds the Joi schema enforces, so a
     * typo is a message beside the field rather than a round trip and a 400.
     */
    for (const m of METRICS) {
      const n = Number(form[m.key]);
      if (form[m.key].trim() === '' || !Number.isFinite(n) || n < m.min || n > m.max) {
        showToast({ variant: 'error', message: `${m.label} must be between ${m.min} and ${m.max}.` });
        return;
      }
    }
    setSaving(true);
    try {
      // The WHOLE set every time — easyfix_client_target's columns are NOT NULL
      // with defaults, so a partial upsert would silently reset the untouched
      // fields to the platform values.
      await api.put(key, {
        sla_pct: Number(form.sla_pct),
        ftfr_pct: Number(form.ftfr_pct),
        revisit_pct: Number(form.revisit_pct),
        avg_age_days: Number(form.avg_age_days),
        approval_response_hours: Number(form.approval_response_hours),
      } as never);
      invalidateFetch((k) => k === key);
      refetch();
      showToast({ variant: 'success', message: 'Targets saved. This client is now on contracted targets.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Could not save targets.' });
    } finally { setSaving(false); }
  }

  async function reset() {
    if (!canEdit || saving) return;
    const ok = await confirm({
      title: 'Reset To Platform Defaults',
      description: 'Remove this client’s contracted targets? Their Performance book will be judged against the EasyFix platform defaults again. This does not change any historical numbers.',
      confirmLabel: 'Reset',
      variant: 'destructive',
    });
    if (!ok) return;
    setSaving(true);
    try {
      await api.delete(key);
      invalidateFetch((k) => k === key);
      refetch();
      showToast({ variant: 'success', message: 'Back on platform defaults.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Could not reset targets.' });
    } finally { setSaving(false); }
  }

  return (
    <SectionShell
      title="SLA & Priorities"
      note="The performance targets this client's numbers are judged against."
    >
      {error && <p className="text-sm text-urgent-strong">{error}</p>}
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && form && (
        <>
          <div
            className={`text-xs rounded px-3 py-2 flex items-start gap-2 border ${
              contracted
                ? 'bg-success-tint text-success-strong border-success'
                : 'bg-warning-tint text-warning-strong border-warning'
            }`}
          >
            {contracted ? <ShieldCheck className="size-4 mt-0.5 shrink-0" /> : <Info className="size-4 mt-0.5 shrink-0" />}
            <span>
              {contracted
                ? 'These are CONTRACTED targets — a row exists for this client in easyfix_client_target.'
                : 'No contracted targets are configured, so the PLATFORM DEFAULTS are shown. They are what EasyFix holds itself to, not a commitment made to this client. Edit and save to make them contracted.'}
            </span>
          </div>

          {/*
            * WHO AGREED THIS, AND WHEN. The columns were always written and
            * never shown, which made the contracted banner an assertion nobody
            * could check — the first question in any QBR dispute is "who set
            * this?". Only rendered when a contracted row exists: platform
            * defaults have no author.
            *
            * A null name with a live id means the operator's tbl_user row is
            * gone (the service LEFT JOINs rather than dropping the target), so
            * say that plainly instead of printing "by null".
            */}
          {contracted && (data.updatedAt || data.updatedBy) && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <History className="size-3.5 shrink-0" />
              Last set
              {data.updatedBy
                ? <> by <span className="font-medium text-foreground">
                    {data.updatedBy.name ?? `user #${data.updatedBy.id} (no longer in the CRM)`}
                  </span></>
                : ' by an unrecorded user'}
              {data.updatedAt && <> on {formatDate(data.updatedAt)}</>}
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {METRICS.map((m) => {
              const dir = data.directions?.[m.key];
              return (
                <div key={m.key} className="rounded border bg-card px-3 py-2 space-y-1">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1 flex-wrap">
                    {m.label}
                    <StatusChip tone="neutral" size="sm">
                      {dir === 'lower' ? 'Lower Is Better' : 'Higher Is Better'}
                    </StatusChip>
                  </Label>
                  {canEdit ? (
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={m.min}
                        max={m.max}
                        step={m.step}
                        value={form[m.key]}
                        onChange={(e) => set(m.key, e.target.value)}
                        className="tabular-nums"
                      />
                      <span className="text-sm text-muted-foreground shrink-0">{m.unit.trim() || '%'}</span>
                    </div>
                  ) : (
                    <div className="text-lg font-semibold tabular-nums">
                      {String(data[m.key])}{m.unit}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">{m.note}</p>
                </div>
              );
            })}
          </div>

          {canEdit && (
            <div className="flex items-center gap-2 flex-wrap border-t pt-3">
              <Button onClick={save} disabled={!dirty || saving}>
                {saving ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Save className="size-4 mr-1" />}
                {saving ? 'Saving…' : 'Save Targets'}
              </Button>
              <Button variant="outline" onClick={() => snapshot && setForm(snapshot)} disabled={!dirty || saving}>
                <RotateCcw className="size-4 mr-1" /> Discard
              </Button>
              {contracted && (
                <Button variant="ghost" onClick={reset} disabled={saving}
                  className="text-urgent hover:text-urgent-strong ml-auto">
                  <Undo2 className="size-4 mr-1" /> Reset To Platform Defaults
                </Button>
              )}
              {dirty && <span className="text-xs text-warning-strong">Unsaved changes</span>}
            </div>
          )}

          <p className="text-xs text-muted-foreground border-t pt-3">
            These targets drive the client portal&apos;s Performance book and the
            On Track / Watch / At Risk verdicts on it. The signed SLA document
            belongs in the Overview document checklist.
          </p>
        </>
      )}
    </SectionShell>
  );
}
