'use client';

/*
 * Extracted from JobModal (2026-09-09) so the list-page rows can mount the SAME
 * dialog. Two row-level "Check in" buttons — /my-orders and /jobs — were still
 * calling quickStatusChange(id, 2), i.e. PATCH /admin/jobs/:id/status, which
 * writes job_status and none of the check-in columns. A job checked in from a
 * row therefore reached IN_PROGRESS with checkin_date_time null while the same
 * job checked in from the workspace got a proper TAT anchor, and no report
 * could tell the two apart.
 *
 * Extracting rather than copying is the point: the POST, the mandatory-reason
 * rule and the 409 handling stay in one component with three mount points. The
 * rows lose nothing — quickStatusChange already interrupted them with a confirm
 * dialog, so this is the same click count with a reason field on it.
 *
 * Kept beside CancelWithReasonDialog, its direct sibling in shape and purpose.
 */

import { useEffect, useState } from 'react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Label } from '@/components/ui/label';
import { showToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatApiError } from '@/lib/api-errors';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

/*
 * CheckInWithReasonDialog — ops-side check-in (SCHEDULED → In Progress).
 *
 * The reason is MANDATORY and is the whole point of the dialog: a check-in
 * performed from the web is by definition one the technician did not perform
 * from the app, and the audit trail has to say why. Free text (not the
 * action_taken_reason dropdown) because there is no seeded reason list for this
 * action — the backend takes `reason` as a required string, max 500.
 *
 * Submit posts to /admin/jobs/:id/checkin rather than the generic status PATCH:
 * that endpoint writes checkin_date_time (the TAT anchor) and the rest of the
 * check-in columns, which PATCH /status does not. A 409 (no technician assigned,
 * or the job is no longer status 1) is rendered verbatim from the backend.
 */
export function CheckInWithReasonDialog({ open, onClose, jobId, onDone }: {
  open: boolean; onClose: () => void; jobId: number; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setReason(''); setErr(null); }
  }, [open]);
  const trimmed = reason.trim();
  /*
   * House rule: no inline onOpenChange. The guard routes Esc / X /
   * overlay-click through the shared discard prompt, and skips it while the
   * POST is in flight (the modal is about to unmount anyway) or when nothing
   * has been typed.
   */
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: () => trimmed.length > 0,
    when: () => !loading,
  });
  async function go() {
    if (!trimmed) { setErr('A reason is required.'); return; }
    setLoading(true); setErr(null);
    try {
      await api.post(`/admin/jobs/${jobId}/checkin`, { reason: trimmed });
      showToast({ variant: 'success', message: 'Checked In' });
      onDone();
    } catch (e) {
      setErr(formatApiError(e, { fallback: 'Check-in failed' }));
    } finally { setLoading(false); }
  }
  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Check In · Job #{jobId}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This moves the order to In Progress and stamps the check-in time.
            Check-in is normally done by the technician from the app — record why
            it is being done here.
          </p>
          <div>
            <Label className="text-sm font-medium block mb-1">Reason</Label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[110px]"
              placeholder="e.g. technician on site but unable to check in from the app…"
              maxLength={500}
            />
            <div className="text-xs text-muted-foreground text-right">{reason.length} / 500</div>
          </div>
          {err && <div className="text-sm text-urgent-strong">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={loading} />
            <Button onClick={go} disabled={loading || !trimmed}>
              {loading ? 'Checking In…' : 'Check In'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
