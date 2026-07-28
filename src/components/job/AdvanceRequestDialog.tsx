'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showToast } from '@/components/ui/toast';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

/*
 * AdvanceRequestDialog — PM raises an advance-payment request against a
 * job (legacy CheckIn-detail "Advance" action). POSTs the existing
 * POST /admin/advances endpoint; the multi-step approval workflow lives
 * on the Finance → Advances page.
 *
 * jobTotalAmt is derived by the parent from the charges matrix and shown
 * read-only. A technician (efrId) and client (clientId) must be resolved
 * on the job before an advance can be raised — the submit is blocked with
 * an inline hint otherwise.
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
  jobTotalAmt: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [advanceAmt, setAdvanceAmt] = useState('');
  const [pmRemarks, setPmRemarks] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  const blockedReason = efrId == null
    ? 'Assign a technician to this job before raising an advance.'
    : clientId == null
      ? 'This job has no client mapped, so an advance cannot be raised.'
      : null;

  async function submit() {
    if (blockedReason || efrId == null || clientId == null) { setErr(blockedReason); return; }
    const amt = Number(advanceAmt);
    if (!Number.isFinite(amt) || amt <= 0) { setErr('Enter a valid advance amount.'); return; }
    if (!pmRemarks.trim()) { setErr('PM remarks are required.'); return; }

    setSaving(true);
    setErr(null);
    try {
      await api.createAdvance({
        jobId,
        efrId,
        clientId,
        advanceAmt: amt,
        jobTotalAmt,
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

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Advance Request</DialogTitle>
          <DialogDescription>Raise an advance-payment request for the assigned technician.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {blockedReason && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {blockedReason}
            </div>
          )}
          <div>
            <Label className="mb-1 block text-sm font-medium">Job Total (₹)</Label>
            <Input value={jobTotalAmt.toLocaleString('en-IN')} readOnly className="bg-muted/30 font-mono" />
          </div>
          <div>
            <Label className="mb-1 block text-sm font-medium">Advance Amount (₹) *</Label>
            <Input
              value={advanceAmt}
              onChange={(e) => setAdvanceAmt(e.target.value.replace(/[^\d.]/g, ''))}
              inputMode="decimal"
              className="font-mono"
              disabled={!!blockedReason}
            />
          </div>
          <div>
            <Label className="mb-1 block text-sm font-medium">PM Remarks *</Label>
            <Input
              value={pmRemarks}
              onChange={(e) => setPmRemarks(e.target.value)}
              placeholder="Reason for the advance"
              disabled={!!blockedReason}
            />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving || !!blockedReason}>
            {saving ? 'Requesting…' : 'Raise Request'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
