'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type AdvanceContext } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

/*
 * AdvanceRequestDialog — PM raises an advance-payment request against a job.
 * POSTs POST /admin/advances; the Ops/Finance steps live on Finance → Audit
 * Advance.
 *
 * REBUILT 2026-09-28 to legacy parity. This dialog used to ask for an amount
 * and remarks and nothing else, while the legacy form
 * (EasyFix_CRM pages/jobs/paymentDetails.vm) put the decision context in front
 * of the PM before they typed a number:
 *
 *   Client OPEN   FOH = that client's jobs at status 21
 *                 ESA = that client's jobs at status 15
 *   Tx OPEN       OOA = this technician's jobs not in (3, 5, 6, 7)
 *   Max Allowed   60% of the job total, rounded to 1 decimal
 *
 * All four are computed by GET /admin/advances/context so the browser cannot
 * disagree with the cap the server enforces — legacy computed the cap in
 * Velocity and checked it in JavaScript only, so nothing ever stopped an
 * over-cap save.
 *
 * NOT PORTED YET — "Upload Client Approval". Legacy wrote the file to
 * /var/www/html/easydoc/upload_jobs/ and stored its name in
 * tbl_efr_advance_payment.supporting_document. The column and the API field
 * exist here, but there is no admin upload endpoint that targets an advance
 * (uploadJobDocument only accepts the JobSheet / PurchaseOrder categories), so
 * a file input would have nowhere to post. Needs a backend endpoint first.
 */
export function AdvanceRequestDialog({
  open,
  jobId,
  efrId,
  clientId,
  jobTotalAmt,
  onClose,
  onSaved,
}: {
  open: boolean;
  jobId: number;
  efrId: number | null;
  clientId: number | null;
  /* Fallback only — the figure shown and submitted is the server's, once the
     context lands. Kept so the field is never blank on first paint. */
  jobTotalAmt: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [advanceAmt, setAdvanceAmt] = useState('');
  const [pmRemarks, setPmRemarks] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ctxKey = open
    ? `/admin/advances/context?jobId=${jobId}${efrId != null ? `&efrId=${efrId}` : ''}`
    : null;
  const { data: ctx, loading: ctxLoading } = useFetch<AdvanceContext>(ctxKey);

  useEffect(() => {
    if (!open) return;
    setAdvanceAmt('');
    setPmRemarks('');
    setErr(null);
  }, [open]);

  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: () => Boolean(advanceAmt || pmRemarks),
    when: () => !saving,
  });

  const total = ctx?.job_total_amt ?? jobTotalAmt;
  const maxAllowed = ctx?.max_allowed_advance ?? 0;
  const entered = Number(advanceAmt);
  /* Mirrors the server rule exactly: a job with nothing costed yet has no
     meaningful cap, and legacy let the PM raise against it. */
  const capApplies = total > 0;
  const overCap = capApplies && Number.isFinite(entered) && entered > maxAllowed;

  const blockedReason = efrId == null
    ? 'Assign a technician to this job before raising an advance.'
    : clientId == null
      ? 'This job has no client mapped, so an advance cannot be raised.'
      : null;

  async function submit() {
    if (blockedReason || efrId == null || clientId == null) { setErr(blockedReason); return; }
    const amt = Number(advanceAmt);
    if (!Number.isFinite(amt) || amt <= 0) { setErr('Enter a valid advance amount.'); return; }
    if (overCap) { setErr(`Value exceeds max allowed advance (${maxAllowed}).`); return; }
    if (!pmRemarks.trim()) { setErr('PM remarks are required.'); return; }

    setSaving(true);
    setErr(null);
    try {
      await api.createAdvance({
        jobId,
        efrId,
        clientId,
        advanceAmt: amt,
        jobTotalAmt: total,
        pmRemarks: pmRemarks.trim(),
      });
      showToast({ variant: 'success', message: 'Advance Requested' });
      onSaved();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Request failed';
      setErr(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSaving(false);
    }
  }

  const counter = (label: string, sub: string, value: number | undefined) => (
    <div>
      <Input value={ctxLoading ? '…' : String(value ?? 0)} readOnly className="bg-muted/30 font-mono" />
      <p className="mt-0.5 text-center text-xs text-muted-foreground">{sub}</p>
      <span className="sr-only">{label}</span>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Advance Payment Request</DialogTitle>
          <DialogDescription>Raise an advance-payment request for the assigned technician.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {blockedReason && (
            <div className="rounded-md border border-warning bg-warning-tint px-3 py-2 text-xs text-warning-strong">
              {blockedReason}
            </div>
          )}

          {/* Client OPEN — FOH / ESA, read-only decision context. */}
          <div className="grid grid-cols-[7rem_1fr_1fr] items-start gap-2">
            <Label className="pt-2 text-sm font-medium">Client OPEN</Label>
            {counter('FOH', 'FOH', ctx?.foh_count)}
            {counter('ESA', 'ESA', ctx?.esa_count)}
          </div>

          {/* Tx OPEN — OOA. */}
          <div className="grid grid-cols-[7rem_1fr_1fr] items-start gap-2">
            <Label className="pt-2 text-sm font-medium">Tx OPEN</Label>
            {counter('OOA', 'OOA', ctx?.tx_open_count)}
            <div />
          </div>

          <div>
            <Label className="mb-1 block text-sm font-medium">Total Job Value (₹)</Label>
            <Input value={total.toLocaleString('en-IN')} readOnly className="bg-muted/30 font-mono" />
            <p className="mt-0.5 text-xs text-urgent-strong">Max 60% approved for advance</p>
          </div>

          <div>
            <Label className="mb-1 block text-sm font-medium">Advance Request Value (₹) *</Label>
            <Input
              value={advanceAmt}
              onChange={(e) => setAdvanceAmt(e.target.value.replace(/[^\d.]/g, ''))}
              inputMode="decimal"
              placeholder="Enter advance request amount"
              className="font-mono"
              disabled={!!blockedReason}
            />
            <p className="mt-0.5 text-xs text-muted-foreground">
              {capApplies ? `Max Allowed: ${maxAllowed}` : 'No charges costed on this job yet — no cap applies.'}
            </p>
            {overCap && (
              <p className="mt-0.5 text-xs text-urgent-strong">Value exceeds max allowed advance!</p>
            )}
          </div>

          <div>
            <Label className="mb-1 block text-sm font-medium">Comments *</Label>
            <textarea
              value={pmRemarks}
              onChange={(e) => setPmRemarks(e.target.value)}
              rows={2}
              placeholder="Enter remarks for log"
              disabled={!!blockedReason}
              className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus:outline-none focus-visible:outline-none focus-visible:border-foreground/40 disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-700 disabled:opacity-90"
            />
          </div>

          {err && <div className="text-sm text-urgent-strong">{err}</div>}
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving || !!blockedReason || overCap}>
            {saving ? 'Requesting…' : 'Save & Add Advance Request'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
