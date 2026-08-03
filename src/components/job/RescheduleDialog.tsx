'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { DateTimeSlotPicker } from '@/components/ui/date-time-slot-picker';
import { useSlotRecommendations, SlotAdvisory } from '@/components/job/SlotRecommendations';
import { api, ApiError } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { showToast } from '@/components/ui/toast';

type RescheduleReason = { id: number; label: string };

/*
 * 'YYYY-MM-DDTHH:mm' in IST wall-clock — matches DateTimeSlotPicker's value
 * format AND the BE's IST wall-clock contract, with NO UTC round-trip (which
 * would shift the day/time across the +05:30 boundary). Built from Intl parts
 * so it's correct regardless of the browser's local timezone.
 */
function istNowLocalInput(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

/*
 * Reschedule dialog for the Schedule & Assign modal. The modal's Date/Time
 * fields are read-only; this is the ONLY way to move the appointment. New date
 * & time + reason + remarks are ALL mandatory (the submit button stays disabled
 * until every field is filled). On save it PATCHes /admin/jobs/:id/reschedule
 * (the BE persists the new schedule + derived slot columns, logs reason+remarks
 * to scheduling_history and a job comment, and expires open offers), then calls
 * onDone() so the modal re-ranks candidates against the new date.
 *
 * The reason list comes from GET /admin/jobs/reschedule-reasons — query-agnostic
 * here; whatever rows that endpoint returns are what the dropdown shows.
 */
export function RescheduleDialog({ open, jobId, onClose, onDone, initialDateTime, initialRemarks }: {
  open: boolean;
  jobId: number | null;
  onClose: () => void;
  onDone: () => void;
  // Optional pre-fill: when launched from the "Apply Requested Date &
  // Reschedule" action on a customer reschedule request, seed the date &
  // remarks from the request so Ops only needs to confirm the reason. The
  // reason stays empty on purpose (a proper action_type=8 CRM reason must be
  // chosen so the audit trail is correct).
  initialDateTime?: string;
  initialRemarks?: string;
}) {
  const reasons = useFetch<RescheduleReason[]>(
    open ? '/admin/jobs/reschedule-reasons' : null,
    { enabled: open },
  );
  const [dateTime, setDateTime] = useState('');
  const [reasonId, setReasonId] = useState('');
  const [remarks, setRemarks] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Best-slot advisory for the picked new date. Keyed on the LIVE `dateTime`
  // picker state (already 'YYYY-MM-DDTHH:mm'), so changing the date re-runs the
  // recommendation for the new day. Gated on `open` so it doesn't fetch while
  // the dialog is closed (mirrors the reschedule-reasons fetch above).
  const rec = useSlotRecommendations(open ? jobId : null, dateTime);

  // Reset every field on each open so a prior attempt never leaks in. When
  // pre-fill props are supplied (apply-from-request flow), seed date + remarks.
  useEffect(() => {
    if (open) {
      setDateTime(initialDateTime ?? '');
      setReasonId('');
      setRemarks(initialRemarks ?? '');
      setErr(null);
    }
  }, [open, initialDateTime, initialRemarks]);

  const minLocal = useMemo(() => istNowLocalInput(), [open]);
  const reasonOptions = (reasons.data ?? []).map((r) => ({ value: r.id, label: r.label }));
  const canSubmit =
    !!jobId && !!dateTime && !!reasonId && remarks.trim().length > 0 && !loading;

  async function go() {
    if (!jobId) return;
    if (!dateTime) { setErr('Pick a new date & time'); return; }
    if (!reasonId) { setErr('Reschedule reason is required'); return; }
    if (!remarks.trim()) { setErr('Remarks are required'); return; }
    setLoading(true); setErr(null);
    try {
      const label = reasonOptions.find((o) => String(o.value) === String(reasonId))?.label;
      await api.rescheduleJob(jobId, {
        // IST wall-clock 'YYYY-MM-DDTHH:mm' — sent verbatim (BE parses it as
        // wall-clock; never convert to UTC/ISO here).
        requestedDateTime: dateTime,
        reasonId: Number(reasonId),
        rescheduleReason: label,
        remarks: remarks.trim(),
      });
      showToast({ variant: 'success', message: 'Job rescheduled' });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Reschedule failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    // eslint-disable-next-line no-restricted-syntax
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reschedule Job{jobId ? ` #${jobId}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">New Date &amp; Time *</Label>
            {/* granularity="hour-frame": Reschedule COMMITS a booking —
                api.rescheduleJob → job.service reschedule() writes
                requested_date_time, requested_time (the frame START) and the
                derived time_slot band in one transaction. On the half-hour grid
                ops could store requested_time '16:30', which is not one of the
                ten frame starts the model defines, and reopening the same job in
                Confirm & Schedule (hour-frame) then dropped its TimeSelect into
                "After Hours / Custom Time" for a 4:30 PM slot sitting squarely
                inside '3PM to 7PM'. The custom-time row is still there for a
                genuinely off-grid move. */}
            <DateTimeSlotPicker min={minLocal} value={dateTime} onChange={setDateTime} granularity="hour-frame" />
            <SlotAdvisory
              best={rec.best}
              attendanceKnown={rec.attendanceKnown}
              candidatePool={rec.candidatePool}
              loading={rec.loading}
              failed={rec.failed}
            />
          </div>
          <div>
            <Label className="text-sm font-medium block mb-1">Reschedule Reason *</Label>
            <SearchSelect
              value={reasonId}
              onChange={(v) => setReasonId(v)}
              options={reasonOptions}
              placeholder={reasons.loading ? 'Loading reasons…' : 'Select a reason…'}
            />
          </div>
          <div>
            <Label className="text-sm font-medium block mb-1">Remarks *</Label>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
              placeholder="Why is this job being rescheduled…"
              maxLength={500}
            />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={loading}>Back</Button>
            <Button onClick={go} disabled={!canSubmit}>
              {loading ? 'Rescheduling…' : 'Reschedule'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
