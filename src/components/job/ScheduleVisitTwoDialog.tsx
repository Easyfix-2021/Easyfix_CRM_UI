'use client';

/*
 * Schedule Visit 2 — the ONE dialog for booking a revisit's second visit
 * (V3 Phase 4, spec 4.3/D7 + CRM section). Opened from two places, per the
 * spec: the JobModal action bar (status-10/REVISIT jobs) and the /ops-desk
 * row action for `waitingFor === 'schedule_visit2'` — one component so the
 * two surfaces cannot drift, same precedent as VerifyWithCustomerDialog.
 *
 * POST /admin/jobs/:id/schedule-visit-two { visitOn } — BE moves status
 * 10 -> 1, bumps visit_number, keeps the same technician (BACKEND-B,
 * jobs-phase4.js). `visitOn` is IST wall-clock 'YYYY-MM-DDTHH:mm', sent
 * verbatim — same convention as rescheduleJob's requestedDateTime.
 *
 * Flow: pick a date/time, click "Schedule Visit 2" -> useConfirm() double
 * -checks the operator meant it (no native confirm()) -> POST -> toast ->
 * onDone() (caller invalidates/refetches its job/list).
 *
 * Gate: both callers show this action only behind `isJobAppRequestResolve`
 * (same as the rest of the Ops Desk) — this component does not re-check it.
 */

import { useEffect, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { DateTimeSlotPicker } from '@/components/ui/date-time-slot-picker';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { formatDate, istNowWallClock } from '@/lib/utils';

export function ScheduleVisitTwoDialog({ open, jobId, jobTitle, onClose, onDone }: {
  open: boolean;
  jobId: number | null;
  jobTitle?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [visitOn, setVisitOn] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  useEffect(() => { if (open) setVisitOn(''); }, [open]);

  const minLocal = istNowWallClock();
  const canSubmit = !!jobId && !!visitOn && !busy;

  async function go() {
    if (!jobId || !visitOn) return;
    const ok = await confirm({
      title: 'Schedule Visit 2?',
      description: `Book this job's second visit for ${formatDate(visitOn)}${jobTitle ? ` — ${jobTitle}` : ''}. The same technician stays assigned.`,
      confirmLabel: 'Schedule Visit 2',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.scheduleVisitTwo(jobId, visitOn);
      showToast({ variant: 'success', message: 'Visit 2 scheduled' });
      onDone();
      onClose();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Failed to schedule Visit 2' });
    } finally {
      setBusy(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: () => !!visitOn, when: () => !busy });

  return (
    // eslint-disable-next-line no-restricted-syntax
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <span className="inline-flex items-center gap-1.5"><CalendarPlus className="size-4" /> Schedule Visit 2{jobId ? ` · Job #${jobId}` : ''}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 p-4">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Visit Date &amp; Time *</Label>
            <DateTimeSlotPicker min={minLocal} value={visitOn} onChange={setVisitOn} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
          <Button onClick={go} disabled={!canSubmit}>{busy ? 'Scheduling…' : 'Schedule Visit 2'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
