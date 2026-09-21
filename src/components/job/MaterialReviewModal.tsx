'use client';

/*
 * MaterialReviewModal — the PM's review step for job_status 16 "Pending for
 * Material" once the technician has sent the quote in (material_sub_status 2,
 * "Review Pending"). Split OUT of JobModal's Summary tab (2026-09-21): the
 * Eye/View icon on every list now opens the plain, unmodified JobModal (same
 * as every other status), and this dedicated "Material Review" row action
 * opens this modal instead. Self-gates on status/sub-status/permission —
 * renders nothing outside that exact state or without isJobMaterialReview.
 *
 * Reuses:
 *   - GET /admin/jobs/:id — the SAME endpoint + useFetch hook JobModal uses,
 *     for the compact Job Details block up top.
 *   - GET /admin/quotations?jobId= — the SAME rows the Quotations tab shows,
 *     so this modal and that tab can never disagree on what was quoted.
 *
 * POST /admin/jobs/:id/material-review {decision, reason?, permission_required, lines?}
 *   approve → 15 Client Approval Pending, permission_required stored, per-line
 *             decisions applied (approved lines get approved_charge + status 1,
 *             rejected lines get status 2) in the same transaction.
 *   reject  → back to 16 sub-status 1 (Quotation Pending), reason to the tech;
 *             a whole-review reject sends no `lines` — every line stays at 0.
 * See EasyFix_Backend docs/superpowers/specs/2026-09-18-ops-material-approval-design.md.
 *
 * Real /admin/quotations columns are `type`, `name`, `unit` (= quantity),
 * `unit_price`, `status`, `approved_charge`, `client_charge` — see JobModal's
 * QuotationRow (exported from there so this file doesn't redeclare it).
 */

import { useEffect, useMemo, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { StatusChip } from '@/components/ui/StatusChip';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { cn, formatDate, formatEasyfixerName, statusLabel, statusTone } from '@/lib/utils';
import type { QuotationRow } from './JobModal';

type JobDetails = Record<string, unknown> & {
  job_id: number; job_status: number;
  fk_easyfixter_id?: number | null;
  client_name?: string | null; customer_name?: string | null; city_name?: string | null;
  service_category?: string | null; job_type?: string | null;
  easyfixer_name?: string | null; requested_date_time?: string | null;
};

type MaterialLineState = { rejected: boolean; amount: string };

function quotedLineAmount(r: QuotationRow): number {
  return (Number(r.unit) || 0) * (Number(r.unit_price) || 0);
}

// client_charge is the rate-card unit price snapshotted at quote time — null
// means no rate existed and must render "—", never ₹0 (see JobModal's
// original note; a genuine non-null 0 rate is distinct and renders as 0.00).
function rateCardLineAmount(r: QuotationRow): number | null {
  if (r.client_charge == null) return null;
  return (Number(r.unit) || 0) * Number(r.client_charge);
}

export function MaterialReviewModal({
  open, jobId, onClose, onReviewed,
}: {
  open: boolean;
  jobId: number | null;
  onClose: () => void;
  /* Called after a successful Reject/Send so the caller's list refetches. */
  onReviewed?: () => void;
}) {
  const { me } = useMe();
  const can = actionFlags(me, ['isJobMaterialReview']);
  const enabled = open && jobId != null && can.isJobMaterialReview;

  const { data: job } = useFetch<JobDetails>(enabled ? `/admin/jobs/${jobId}` : null);
  const { data: quoteData } = useFetch<QuotationRow[]>(
    enabled ? `/admin/quotations?jobId=${jobId}` : null,
  );
  const rows: QuotationRow[] = Array.isArray(quoteData) ? quoteData : [];
  const materialRows = useMemo(
    // Pending = not yet actioned (action_on NULL) — see JobModal's original note.
    () => rows.filter((r) => String(r.type) === 'material' && r.action_on == null),
    [rows],
  );

  const confirm = useConfirm();
  const [permissionRequired, setPermissionRequired] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [lineState, setLineState] = useState<Record<number, MaterialLineState>>({});

  // Fresh state whenever a different job's review opens.
  useEffect(() => {
    if (!open) return;
    setPermissionRequired(false);
    setRejecting(false);
    setReason('');
    setLineState({});
  }, [open, jobId]);

  useEffect(() => {
    setLineState((prev) => {
      const missing = materialRows.filter((r) => !(Number(r.id) in prev));
      if (missing.length === 0) return prev;
      const next = { ...prev };
      for (const r of missing) {
        next[Number(r.id)] = { rejected: false, amount: quotedLineAmount(r).toFixed(2) };
      }
      return next;
    });
  }, [materialRows]);

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });

  if (!jobId) return null;

  const quotedTotal = materialRows.reduce((sum, r) => sum + quotedLineAmount(r), 0);
  const rateCardTotal = materialRows.reduce((sum, r) => sum + (rateCardLineAmount(r) ?? 0), 0);
  const approvedTotal = materialRows.reduce((sum, r) => {
    const st = lineState[Number(r.id)];
    if (!st || st.rejected) return sum;
    const n = Number(st.amount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  // Send is blocked while any non-rejected row has a blank, non-numeric or
  // negative amount — half-filled table can't go out.
  const hasInvalidLine = materialRows.some((r) => {
    const st = lineState[Number(r.id)];
    if (!st || st.rejected) return false;
    const n = Number(st.amount);
    return st.amount.trim() === '' || !Number.isFinite(n) || n < 0;
  });

  function setLine(id: number, patch: Partial<MaterialLineState>) {
    setLineState((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function submit(decision: 'approve' | 'reject') {
    if (decision === 'reject' && !reason.trim()) {
      showToast({ variant: 'error', message: 'A Reject Reason Is Required' });
      return;
    }
    if (decision === 'approve' && hasInvalidLine) {
      showToast({ variant: 'error', message: 'Enter A Valid Approved Amount For Every Line' });
      return;
    }
    if (decision === 'approve') {
      const ok = await confirm({
        title: 'Send Request To Client?',
        description: 'The client contact will be emailed and notified to review this material quote.',
        confirmLabel: 'Send Request',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const lines = decision === 'approve'
        ? materialRows.map((r) => {
            const id = Number(r.id);
            const st = lineState[id];
            return st?.rejected
              ? { line_id: id, decision: 'reject' as const }
              : { line_id: id, decision: 'approve' as const, approved_amount: Number(st?.amount) };
          })
        : undefined;
      await api.post(`/admin/jobs/${jobId}/material-review`, {
        decision,
        ...(decision === 'reject' ? { reason: reason.trim() } : {}),
        permission_required: permissionRequired,
        ...(lines ? { lines } : {}),
      });
      showToast({
        variant: 'success',
        message: decision === 'approve' ? 'Request Sent To Client' : 'Material Quote Rejected',
      });
      // Any surface listing this job (Manage Jobs, My Orders, dashboard
      // counts) reads a status/sub-status that just changed.
      invalidateFetch((k) => k.startsWith('/admin/jobs') || k.startsWith('/admin/quotations'));
      onReviewed?.();
      onClose();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Failed To Submit Review' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <ClipboardList className="h-4 w-4" />
            Material Review — Job #{jobId}
            {job && (
              <StatusChip tone={statusTone(Number(job.job_status))} size="sm">
                {statusLabel(Number(job.job_status), { assigned: job.fk_easyfixter_id != null })}
              </StatusChip>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* Compact Job Details — the same job payload JobModal fetches
              (GET /admin/jobs/:id via useFetch), just the fields ops needs
              to place this review without opening a second modal. */}
          {job && (
            <div className="rounded-lg border bg-muted/20 p-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
              <div><div className="text-xs text-muted-foreground">Client</div><div className="font-medium truncate">{job.client_name || '—'}</div></div>
              <div><div className="text-xs text-muted-foreground">Customer</div><div className="font-medium truncate">{job.customer_name || '—'}</div></div>
              <div><div className="text-xs text-muted-foreground">City</div><div className="font-medium truncate">{job.city_name || '—'}</div></div>
              <div><div className="text-xs text-muted-foreground">Service / Category</div><div className="font-medium truncate">{job.service_category || job.job_type || '—'}</div></div>
              <div><div className="text-xs text-muted-foreground">Technician</div><div className="font-medium truncate">{job.easyfixer_name ? formatEasyfixerName(job.easyfixer_name) : '—'}</div></div>
              <div><div className="text-xs text-muted-foreground">Appointment</div><div className="font-medium truncate">{job.requested_date_time ? formatDate(job.requested_date_time) : '—'}</div></div>
            </div>
          )}

          {materialRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No Material Lines Pending Review.</div>
          ) : (
            <div className="rounded-lg border bg-card overflow-hidden">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="!text-left">Item</th>
                    <th className="!text-right">Qty</th>
                    <th className="!text-right">Rate Card (₹)</th>
                    <th className="!text-right">Quoted (₹)</th>
                    <th className="!text-right">Approved (₹)</th>
                    <th className="!text-center">Reject</th>
                  </tr>
                </thead>
                <tbody>
                  {materialRows.map((r) => {
                    const id = Number(r.id);
                    const st = lineState[id] ?? { rejected: false, amount: quotedLineAmount(r).toFixed(2) };
                    const amountInvalid = !st.rejected
                      && (st.amount.trim() === '' || !Number.isFinite(Number(st.amount)) || Number(st.amount) < 0);
                    const rateCardAmt = rateCardLineAmount(r);
                    const quotedAmt = quotedLineAmount(r);
                    // Ops sees at a glance where the technician quoted above
                    // the rate card. No highlight when there is no rate card
                    // to compare.
                    const isOverRate = rateCardAmt != null && quotedAmt > rateCardAmt;
                    return (
                      <tr key={id}>
                        <td className="!text-left">{String(r.name ?? '—')}</td>
                        <td className="!text-right font-mono text-xs">{String(r.unit ?? '')}</td>
                        <td className="!text-right font-mono text-xs">{rateCardAmt != null ? rateCardAmt.toFixed(2) : '—'}</td>
                        <td className={cn('!text-right font-mono text-xs', isOverRate && 'bg-urgent-tint text-urgent-strong rounded px-1')}>
                          {quotedAmt.toFixed(2)}
                          {isOverRate && <span className="ml-1 font-semibold">(+₹{(quotedAmt - (rateCardAmt as number)).toFixed(2)})</span>}
                        </td>
                        <td className="!text-right">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={st.amount}
                            onChange={(e) => setLine(id, { amount: e.target.value })}
                            disabled={st.rejected}
                            aria-invalid={amountInvalid}
                            className={cn('font-mono text-xs h-8 w-28 ml-auto', amountInvalid && 'border-urgent')}
                          />
                        </td>
                        <td className="!text-center">
                          <Checkbox
                            checked={st.rejected}
                            onChange={(rejected) => setLine(id, { rejected })}
                            label={`Reject ${String(r.name ?? 'line')}`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="font-medium">
                    <td className="!text-left" colSpan={2}>Total</td>
                    <td className="!text-right font-mono text-xs">{rateCardTotal.toFixed(2)}</td>
                    <td className="!text-right font-mono text-xs">{quotedTotal.toFixed(2)}</td>
                    <td className="!text-right font-mono text-xs">{approvedTotal.toFixed(2)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Bug fix: the shared Checkbox only ever wired `label` to
              aria-label (an accessible name for screen readers), never to
              visible text — so this rendered as an unlabelled box under the
              table. Wrapping it in a <label> with a visible <span>, same
              convention as RecoveryKeyDialog / access-roles' surface grid. */}
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <Checkbox
              checked={permissionRequired}
              onChange={setPermissionRequired}
              label="Appointment / Permission Required"
            />
            <span>Appointment / Permission Required</span>
          </label>

          {rejecting && (
            <div className="space-y-2">
              <Label htmlFor="material-reject-reason">Reject Reason</Label>
              <Input
                id="material-reject-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for the technician"
                autoFocus
              />
            </div>
          )}
        </div>

        <DialogFooter>
          {rejecting ? (
            <>
              <Button variant="outline" onClick={() => { setRejecting(false); setReason(''); }} disabled={busy}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => submit('reject')} disabled={busy || !reason.trim()}>
                {busy ? '…' : 'Confirm Reject'}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                className="border-urgent text-urgent-strong hover:bg-urgent/10"
                onClick={() => setRejecting(true)}
                disabled={busy}
              >
                Reject Request
              </Button>
              <Button onClick={() => submit('approve')} disabled={busy || hasInvalidLine}>
                {busy ? '…' : 'Send Request to Client'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
