'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { showToast } from '@/components/ui/toast';
import { useFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { collectedByCode, collectedByLabel, COLLECTED_BY_JOB_OPTIONS } from '@/lib/collected-by';
import { ST } from '@/lib/utils';

/*
 * AUDIT & CHECKOUT (Under Audit 10 → Pending for Feedback 3), 2026-09-30.
 *
 * The new CRM's port of legacy EasyFix_CRM JobAction.saveCheckOutJob →
 * sp_ef_checkout_job_and_update_transaction, which ops still ran from the
 * legacy CRM because nothing here moved a job out of Under Audit.
 *
 * Legacy's screen refuses unless Collected By is 1 (Easyfixer) or 2 (Easyfix)
 * and the SP writes it with the checkout. Same here: ops confirm it, and it
 * rides the status PATCH as `extras.collected_by`, so the backend writes it,
 * the status and the completion ledger in ONE transaction (setStatus →
 * job-ledger.service). The payout preview is GET /completion-ledger, the
 * read-only twin of that posting.
 *
 * Charges are reviewed and edited on the Billing & Charges tab the Audit
 * action opens on — this dialog only confirms and posts.
 */

type LedgerPreview = {
  postable: boolean;
  reason: string | null;
  already: { job_transaction: boolean; technician_ledger: boolean };
  amounts: { efr: number; ef: number; client: number; tax: number; unpriced: number[] } | null;
};
type StatusResult = { ledger?: { posted: boolean; reason: string | null; amounts: { efr: number } | null } };

export const completionLedgerKey = (jobId: number) => `/admin/jobs/${jobId}/completion-ledger`;

const rupees = (v: number) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function AuditCheckoutDialog({ open, onClose, jobId, collectedBy, onDone }: {
  open: boolean; onClose: () => void; jobId: number; collectedBy: unknown; onDone: () => void;
}) {
  // Esc / X / overlay get the same discard prompt as the Cancel button (ops policy).
  const guardedOpenChange = useFormDirtyGuard(onClose);
  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Audit &amp; Checkout · Job #{jobId}</DialogTitle>
          <DialogDescription>Moves the job to Pending for Feedback and posts the technician payout.</DialogDescription>
        </DialogHeader>
        {open && <Body jobId={jobId} collectedBy={collectedBy} onClose={onClose} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ jobId, collectedBy, onClose, onDone }: {
  jobId: number; collectedBy: unknown; onClose: () => void; onDone: () => void;
}) {
  const { data: preview, loading, error } = useFetch<LedgerPreview>(completionLedgerKey(jobId));
  // Only the two per-job values legacy's checkout accepts; a stored 3 (Client)
  // or an unset job starts blank and must be picked.
  const initial = collectedByLabel(collectedBy);
  const [collected, setCollected] = useState(
    COLLECTED_BY_JOB_OPTIONS.some((o) => o.value === initial) ? String(initial) : '',
  );
  const [saving, setSaving] = useState(false);
  const a = preview?.amounts;
  const alreadyPosted = !!preview?.already.technician_ledger;

  async function checkout() {
    const code = collectedByCode(collected);
    if (code !== 1 && code !== 2) {
      showToast({ variant: 'error', message: 'Select Collected By before checking out' });
      return;
    }
    setSaving(true);
    try {
      const res = await api.patch<StatusResult>(`/admin/jobs/${jobId}/status`, {
        status: ST.COMPLETED, extras: { collected_by: code },
      });
      const l = res?.ledger;
      if (l?.posted) {
        showToast({ variant: 'success', message: `Checked Out · ${rupees(l.amounts?.efr ?? 0)} posted to the technician` });
      } else {
        showToast({ variant: 'warning', message: `Checked Out · payout not posted: ${l?.reason ?? 'unknown reason'}` });
      }
      onDone();
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Checkout failed' }) });
    } finally { setSaving(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium block mb-1">Collected By</Label>
        <Select
          value={collected}
          onChange={(e) => setCollected(e.target.value)}
          options={COLLECTED_BY_JOB_OPTIONS}
          placeholder="Select…"
          disabled={saving}
        />
      </div>

      <div className="rounded-md border p-3 text-sm">
        <div className="font-medium mb-2">Payout Preview</div>
        {loading && <div className="text-muted-foreground">Loading…</div>}
        {error && <div className="text-urgent-strong">{error}</div>}
        {a && (
          <dl className="grid grid-cols-2 gap-y-1">
            <dt className="text-muted-foreground">Technician</dt><dd className="text-right">{rupees(a.efr)}</dd>
            <dt className="text-muted-foreground">EasyFix</dt><dd className="text-right">{rupees(a.ef)}</dd>
            <dt className="text-muted-foreground">Client</dt><dd className="text-right">{rupees(a.client)}</dd>
            <dt className="text-muted-foreground">Service Tax</dt><dd className="text-right">{rupees(a.tax)}</dd>
          </dl>
        )}
        {a && a.unpriced.length > 0 && (
          <p className="mt-2 text-warning-strong">
            {a.unpriced.length} service line(s) have no rate card and add nothing to the payout.
          </p>
        )}
        {alreadyPosted && <p className="mt-2 text-muted-foreground">Already posted for this job — checkout will not post it again.</p>}
        {/* 'collected_by' reasons are answered by the picker above, which is sent with the checkout. */}
        {preview && !preview.postable && !String(preview.reason).startsWith('collected_by') && (
          <p className="mt-2 text-warning-strong">Payout will not post: {preview.reason}</p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <CancelButton onCancel={onClose} disabled={saving} />
        <Button onClick={checkout} disabled={saving || !collected}>{saving ? 'Checking Out…' : 'Audit & Checkout'}</Button>
      </div>
    </div>
  );
}
