'use client';

import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Coins, Loader2 } from 'lucide-react';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import {
  api,
  ApiError,
  ADVANCE_STATUS_LABEL,
  type JobChargesResponse,
  type JobCharge,
  type JobChargeService,
  type Advance,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { formatDate } from '@/lib/utils';
import { AddChargeDialog, type ChargeMode } from './AddChargeDialog';
import { AdvanceRequestDialog } from './AdvanceRequestDialog';
import { JobDocumentsCard } from './JobDocumentsCard';

/*
 * BillingChargesTab — the "Billing & Charges" job-workspace tab.
 * Replicates the legacy CheckIn-detail right-column actions:
 *   - Job Summary matrix (Services / Material / Travel / Incentive /
 *     Penalty / Total  ×  Client Charge / Tx Charge / EF Margin).
 *   - Travel / Incentive / Penalty line items with edit / delete /
 *     client-approval toggle.
 *   - Advance requests (raise + mini list).
 *   - Job Sheet + Purchase Order document widgets.
 *   - Per-service client-billing approval ("Approve Tx").
 *
 * Visibility + every mutating control are gated on `canManage`
 * (me.canManageJobCharges), enforced fail-closed by the parent tab list.
 */

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function inr(v: number): string {
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1';
}

/* type string → dialog mode (Travel / Incentive / Penalty). */
function chargeMode(type: string): ChargeMode | null {
  const t = type.toLowerCase();
  if (t.includes('travel')) return 'travel';
  if (t.includes('incent')) return 'incentive';
  if (t.includes('penal')) return 'penalty';
  return null;
}

const ADVANCE_TONE: Record<number, StatusChipTone> = {
  0: 'amber',
  1: 'sky',
  2: 'emerald',
  3: 'red',
};

export function BillingChargesTab({
  jobId,
  clientId,
  efrId,
  canManage,
}: {
  jobId: number;
  clientId: number | null;
  efrId: number | null;
  canManage: boolean;
}) {
  const chargesKey = `/admin/jobs/${jobId}/charges`;
  const advancesKey = `/admin/advances?jobId=${jobId}`;
  const { data, loading, error, refetch } = useFetch<JobChargesResponse>(chargesKey);
  const advances = useFetch<Advance[] | { items?: Advance[] }>(advancesKey);

  const confirm = useConfirm();

  // Dialog state
  const [chargeDialog, setChargeDialog] = useState<{ mode: ChargeMode; editing: JobCharge | null } | null>(null);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  // In-flight approval toggles (charge id / service id) to disable controls.
  const [busyCharge, setBusyCharge] = useState<Set<number>>(new Set());
  const [busyService, setBusyService] = useState<Set<number>>(new Set());

  const onChargesMutated = () => {
    invalidateFetch((k) => k.startsWith(chargesKey));
    refetch();
  };
  const onAdvancesMutated = () => {
    invalidateFetch((k) => k.startsWith('/admin/advances'));
    advances.refetch();
  };

  const materials: JobCharge[] = useMemo(() => data?.materials ?? [], [data]);
  const services: JobChargeService[] = useMemo(() => data?.services ?? [], [data]);
  const advanceRows: Advance[] = Array.isArray(advances.data)
    ? advances.data
    : (advances.data?.items ?? []);

  /*
   * Job Summary matrix. Travel / Incentive / Penalty / Material rows are
   * bucketed from the `materials` line items (each carries tx + client
   * charge). The Services row is derived from the `services` array —
   * the contract exposes only `total_charge` per service (the client
   * charge), with no per-service tx split, so Tx Charge for services
   * shows 0 and its margin equals its client charge. (Assumption noted;
   * the BE owns the true figures.)
   */
  const matrix = useMemo(() => {
    const bucket = {
      travel: { tx: 0, client: 0 },
      incentive: { tx: 0, client: 0 },
      penalty: { tx: 0, client: 0 },
      material: { tx: 0, client: 0 },
    };
    for (const m of materials) {
      const mode = chargeMode(String(m.type ?? ''));
      const key = mode ?? (String(m.type ?? '').toLowerCase().includes('material') ? 'material' : null);
      if (key && key in bucket) {
        bucket[key as keyof typeof bucket].tx += n(m.tx_charge);
        bucket[key as keyof typeof bucket].client += n(m.client_charge);
      }
    }
    const servicesClient = services.reduce((s, r) => s + n(r.total_charge), 0);
    const rows = [
      { label: 'Services', client: servicesClient, tx: 0 },
      { label: 'Material', client: bucket.material.client, tx: bucket.material.tx },
      { label: 'Travel', client: bucket.travel.client, tx: bucket.travel.tx },
      { label: 'Incentive', client: bucket.incentive.client, tx: bucket.incentive.tx },
      { label: 'Penalty', client: bucket.penalty.client, tx: bucket.penalty.tx },
    ];
    const total = rows.reduce(
      (acc, r) => ({ client: acc.client + r.client, tx: acc.tx + r.tx }),
      { client: 0, tx: 0 },
    );
    return { rows, total };
  }, [materials, services]);

  // Only the actionable Travel / Incentive / Penalty items get a row in
  // the line-items list (Material-type items, if any, are matrix-only —
  // there is no edit endpoint for them).
  const lineItems = useMemo(
    () => materials.filter((m) => chargeMode(String(m.type ?? '')) != null),
    [materials],
  );

  async function toggleChargeApproval(charge: JobCharge, next: boolean) {
    setBusyCharge((prev) => new Set(prev).add(charge.id));
    try {
      await api.setJobChargeApproval(jobId, charge.id, next);
      onChargesMutated();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Update failed' });
    } finally {
      setBusyCharge((prev) => {
        const s = new Set(prev); s.delete(charge.id); return s;
      });
    }
  }

  async function deleteCharge(charge: JobCharge) {
    const ok = await confirm({
      title: 'Delete Charge?',
      description: 'This line item will be removed from the job. This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.deleteJobCharge(jobId, charge.id);
      showToast({ variant: 'success', message: 'Charge Deleted' });
      onChargesMutated();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Delete failed' });
    }
  }

  async function toggleServiceApproval(svc: JobChargeService, next: boolean) {
    setBusyService((prev) => new Set(prev).add(svc.job_service_id));
    try {
      await api.setJobServiceApproval(jobId, svc.job_service_id, next ? 1 : 0);
      onChargesMutated();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Update failed' });
    } finally {
      setBusyService((prev) => {
        const s = new Set(prev); s.delete(svc.job_service_id); return s;
      });
    }
  }

  if (loading && !data) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading billing &amp; charges…</div>;
  }
  if (error && !data) {
    return <div className="py-8 text-center text-sm text-destructive">{error}</div>;
  }

  return (
    <div className="space-y-5">
      {/* ─── Job Summary matrix ─────────────────────────────────────── */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="border-b px-4 py-2 text-sm font-semibold text-slate-700">Job Summary</div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-left">Head</th>
                <th className="!text-right">Client Charge</th>
                <th className="!text-right">Tx Charge</th>
                <th className="!text-right">EF Margin</th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((r) => (
                <tr key={r.label}>
                  <td className="!text-left font-medium">{r.label}</td>
                  <td className="!text-right font-mono">{inr(r.client)}</td>
                  <td className="!text-right font-mono">{inr(r.tx)}</td>
                  <td className="!text-right font-mono">{inr(r.client - r.tx)}</td>
                </tr>
              ))}
              <tr className="bg-slate-50/60">
                <td className="!text-left font-semibold">Total</td>
                <td className="!text-right font-mono font-semibold">{inr(matrix.total.client)}</td>
                <td className="!text-right font-mono font-semibold">{inr(matrix.total.tx)}</td>
                <td className="!text-right font-mono font-semibold">{inr(matrix.total.client - matrix.total.tx)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Charge line items (Travel / Incentive / Penalty) ───────── */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="text-sm font-semibold text-slate-700">Charges</div>
          {canManage && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setChargeDialog({ mode: 'penalty', editing: null })}>
                <Plus className="size-3.5 mr-1" /> Add Penalty
              </Button>
              <Button size="sm" variant="outline" onClick={() => setChargeDialog({ mode: 'travel', editing: null })}>
                <Plus className="size-3.5 mr-1" /> Add Travel
              </Button>
              <Button size="sm" variant="outline" onClick={() => setChargeDialog({ mode: 'incentive', editing: null })}>
                <Plus className="size-3.5 mr-1" /> Add Incentive
              </Button>
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-left">Type</th>
                <th className="!text-left">Details</th>
                <th className="!text-right">Tx ₹</th>
                <th className="!text-right">Client ₹</th>
                <th className="!text-center">Client Approval?</th>
                {canManage && <th className="!text-right w-24">Action</th>}
              </tr>
            </thead>
            <tbody>
              {lineItems.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 6 : 5} className="!text-center py-4 text-xs text-muted-foreground">
                    No travel, incentive or penalty charges recorded.
                  </td>
                </tr>
              ) : lineItems.map((m) => {
                const mode = chargeMode(String(m.type ?? ''))!;
                const details = mode === 'travel'
                  ? `${m.from_city_name ?? '—'} → ${m.to_city_name ?? '—'}${m.total_distance != null ? ` · ${n(m.total_distance)} km` : ''}`
                  : (m.reason ?? '—');
                return (
                  <tr key={m.id}>
                    <td className="!text-left"><span className="capitalize font-medium">{mode}</span></td>
                    <td className="!text-left">
                      <div>{details}</div>
                      {m.document_name && <div className="text-xs text-muted-foreground">Doc: {m.document_name}</div>}
                    </td>
                    <td className="!text-right font-mono">{inr(n(m.tx_charge))}</td>
                    <td className="!text-right font-mono">{inr(n(m.client_charge))}</td>
                    <td className="!text-center">
                      <div className="flex justify-center">
                        <Switch
                          checked={truthy(m.is_client_approval_needed)}
                          onCheckedChange={(next) => void toggleChargeApproval(m, next)}
                          disabled={!canManage || busyCharge.has(m.id)}
                        />
                      </div>
                    </td>
                    {canManage && (
                      <td className="!text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            aria-label="Edit charge"
                            onClick={() => setChargeDialog({ mode, editing: m })}
                            className="text-slate-500 hover:text-slate-800"
                          >
                            <Pencil className="size-4" />
                          </button>
                          <button
                            type="button"
                            aria-label="Delete charge"
                            onClick={() => void deleteCharge(m)}
                            className="text-rose-500 hover:text-rose-700"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Service billing approval ("Approve Tx") ────────────────── */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="border-b px-4 py-2 text-sm font-semibold text-slate-700">Service Billing Approval</div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-left">Service</th>
                <th className="!text-right">Qty</th>
                <th className="!text-right">Total ₹</th>
                <th className="!text-center">PM Approved</th>
                <th className="!text-center">Client Approval?</th>
              </tr>
            </thead>
            <tbody>
              {services.length === 0 ? (
                <tr><td colSpan={5} className="!text-center py-4 text-xs text-muted-foreground">No services on this job.</td></tr>
              ) : services.map((s) => (
                <tr key={s.job_service_id}>
                  <td className="!text-left font-medium">{s.service_name ?? '—'}</td>
                  <td className="!text-right font-mono">{n(s.quantity)}</td>
                  <td className="!text-right font-mono">{inr(n(s.total_charge))}</td>
                  <td className="!text-center">
                    {truthy(s.is_approved_by_pm)
                      ? <StatusChip tone="emerald" size="sm">Yes</StatusChip>
                      : <StatusChip tone="slate" size="sm">No</StatusChip>}
                  </td>
                  <td className="!text-center">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary disabled:opacity-50"
                      checked={truthy(s.approval_by_client)}
                      disabled={!canManage || busyService.has(s.job_service_id)}
                      onChange={(e) => void toggleServiceApproval(s, e.target.checked)}
                      aria-label={`Client approval for ${s.service_name ?? 'service'}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Advance requests ───────────────────────────────────────── */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <Coins className="size-4 text-amber-600" /> Advance Requests
          </div>
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => setAdvanceOpen(true)}>
              <Plus className="size-3.5 mr-1" /> Advance Request
            </Button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-left">Requested On</th>
                <th className="!text-right">Advance ₹</th>
                <th className="!text-right">Job Total ₹</th>
                <th className="!text-left">Remarks</th>
                <th className="!text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {advances.loading && advanceRows.length === 0 ? (
                <tr><td colSpan={5} className="!text-center py-4 text-xs text-muted-foreground">
                  <Loader2 className="inline size-3.5 animate-spin mr-1" /> Loading…
                </td></tr>
              ) : advanceRows.length === 0 ? (
                <tr><td colSpan={5} className="!text-center py-4 text-xs text-muted-foreground">No advance requests for this job.</td></tr>
              ) : advanceRows.map((a) => (
                <tr key={a.advance_id}>
                  <td className="!text-left text-xs">{a.initiated_on ? formatDate(a.initiated_on) : '—'}</td>
                  <td className="!text-right font-mono">{a.advance_amt != null ? inr(n(a.advance_amt)) : '—'}</td>
                  <td className="!text-right font-mono">{a.job_total_amt != null ? inr(n(a.job_total_amt)) : '—'}</td>
                  <td className="!text-left text-xs">{a.pm_remarks ?? '—'}</td>
                  <td className="!text-center">
                    <StatusChip tone={ADVANCE_TONE[a.adv_status] ?? 'slate'} size="sm">
                      {ADVANCE_STATUS_LABEL[a.adv_status] ?? String(a.adv_status)}
                    </StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Job Sheet + Purchase Order documents ───────────────────── */}
      <JobDocumentsCard
        jobId={jobId}
        jobSheet={data?.documents?.jobSheet ?? []}
        purchaseOrder={data?.documents?.purchaseOrder ?? []}
        canManage={canManage}
        onMutated={onChargesMutated}
      />

      {/* Dialogs */}
      {chargeDialog && (
        <AddChargeDialog
          open
          mode={chargeDialog.mode}
          jobId={jobId}
          editing={chargeDialog.editing}
          onClose={() => setChargeDialog(null)}
          onSaved={() => { setChargeDialog(null); onChargesMutated(); }}
        />
      )}
      <AdvanceRequestDialog
        open={advanceOpen}
        jobId={jobId}
        efrId={efrId}
        clientId={clientId}
        jobTotalAmt={matrix.total.client}
        onClose={() => setAdvanceOpen(false)}
        onSaved={() => { setAdvanceOpen(false); onAdvancesMutated(); }}
      />
    </div>
  );
}
