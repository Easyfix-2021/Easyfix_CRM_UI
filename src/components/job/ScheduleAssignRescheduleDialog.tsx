'use client';

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import { DateTimeSlotPicker } from '@/components/ui/date-time-slot-picker';

/*
 * ScheduleAssignRescheduleDialog — the Uplifted tab's reschedule popup.
 *
 * SAME THREE ANSWERS THE CANCEL POPUP TAKES, in the same order: who it is due
 * to, the reason, and remarks. Ops kept asking why two dialogs about the same
 * kind of decision looked nothing alike, and the honest answer was that they
 * grew separately — this closes that gap for the console.
 *
 * DUE TO is not a new field on the wire. `action_taken_reason` rows carry a
 * user_type, which IS the party, so picking the party filters the reason list
 * and the chosen reason id records the party — the same derivation the Manage
 * Jobs "Open Due to" column already reads (tbl_job.enum_reason_id, written by
 * reschedule through addComment). One value, not two that can disagree.
 *
 * The Current tab keeps <RescheduleDialog> untouched. Both PATCH the identical
 * endpoint with the identical body.
 */

type Reason = { id: number; label: string };

const DUE_TO = ['Customer', 'Client', 'EasyFix', 'Technician'] as const;
type DueTo = typeof DUE_TO[number];

/** The `dueTo` query value the backend's DUE_TO_USER_TYPE map expects. */
const DUE_TO_PARAM: Record<DueTo, string> = {
  Customer: 'customer', Client: 'client', EasyFix: 'easyfix', Technician: 'technician',
};

const MIN_REMARKS = 15;

export function ScheduleAssignRescheduleDialog({
  open, jobId, currentAppointment, originalAppointment, onClose, onDone,
}: {
  open: boolean;
  jobId: number | null;
  /** What the job says now — the thing being changed. */
  currentAppointment: string | null;
  /** What the customer was first promised; SDA is scored against this. */
  originalAppointment: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [dueTo, setDueTo] = useState<DueTo | ''>('');
  const [dateTime, setDateTime] = useState('');
  const [reasonId, setReasonId] = useState('');
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /*
   * Reasons are fetched per party, so the list can only ever offer reasons that
   * belong to the party chosen in step 1. Keyed on the party, so switching it
   * re-reads (module-cached) rather than filtering a stale list client-side.
   */
  const reasons = useFetch<Reason[]>(
    open && dueTo ? `/admin/jobs/action-reasons?type=reschedule&dueTo=${DUE_TO_PARAM[dueTo]}` : null,
  );

  // Every field resets on each open — a previous attempt must never leak into
  // the next job's reschedule.
  useEffect(() => {
    if (!open) return;
    setDueTo(''); setDateTime(''); setReasonId(''); setRemarks(''); setErr(null);
  }, [open]);

  // A reason belongs to the party it was listed under; changing the party
  // invalidates the pick rather than silently keeping a foreign reason id.
  useEffect(() => { setReasonId(''); }, [dueTo]);

  const options = useMemo(() => (reasons.data ?? []), [reasons.data]);

  async function submit() {
    if (!jobId) return;
    if (!dateTime) { setErr('Pick the new date and time'); return; }
    if (!dueTo) { setErr('Step 1: choose who this reschedule is due to'); return; }
    if (!reasonId) { setErr('Step 2: select a reason'); return; }
    if (remarks.trim().length < MIN_REMARKS) {
      setErr(`Step 3: add remarks of at least ${MIN_REMARKS} characters`);
      return;
    }
    setSaving(true); setErr(null);
    try {
      const label = options.find((o) => String(o.id) === String(reasonId))?.label;
      await api.rescheduleJob(jobId, {
        // IST wall-clock 'YYYY-MM-DDTHH:mm', sent verbatim — the BE parses it as
        // wall-clock. Never convert to UTC here (same contract as the Current
        // tab's dialog).
        requestedDateTime: dateTime,
        reasonId: Number(reasonId),
        rescheduleReason: label,
        remarks: remarks.trim(),
      });
      showToast({ variant: 'success', message: 'Job Rescheduled.' });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Reschedule failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    // eslint-disable-next-line no-restricted-syntax
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent noPadding className="!max-w-2xl overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b-[3px] border-primary bg-sidebar px-4 py-3 text-sidebar-foreground">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-white/10">
            <CalendarClock className="h-4 w-4" />
          </span>
          <h2 className="flex-1 text-base font-semibold">Reschedule job{jobId ? ` #${jobId}` : ''}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-md bg-white/10 hover:bg-white/20">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4">
          {/* WHAT is changing, before WHY: the two appointments side by side, so
              the operator can see whether this move leaves the original date —
              which is exactly what decides SDA. */}
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-muted-foreground">Current appointment</span>
              <strong>{currentAppointment ? formatDate(currentAppointment) : 'Not set'}</strong>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-muted-foreground">Original appointment</span>
              <strong>{originalAppointment ? formatDate(originalAppointment) : '—'}</strong>
            </div>
            <div>
              <Label className="text-sm font-medium">New date &amp; time <span className="text-urgent-strong">*</span></Label>
              {/* Same picker and granularity the Current tab uses: reschedule
                  COMMITS a booking, and a half-hour value is not a frame start
                  the model defines. */}
              <DateTimeSlotPicker
                value={dateTime}
                onChange={setDateTime}
                granularity="hour-frame"
                disabled={saving}
              />
            </div>
          </div>

          <Step n={1} label="Reschedule due to" required>
            <div className="flex flex-wrap gap-2">
              {DUE_TO.map((d) => (
                <label
                  key={d}
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${dueTo === d ? 'border-primary bg-primary/5 font-medium' : 'hover:bg-muted'}`}
                >
                  <input
                    type="radio"
                    name="sa-reschedule-due"
                    className="accent-primary"
                    checked={dueTo === d}
                    disabled={saving}
                    onChange={() => { setDueTo(d); setErr(null); }}
                  />
                  {d}
                </label>
              ))}
            </div>
          </Step>

          <Step n={2} label="Reason" required>
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm disabled:text-muted-foreground"
              value={reasonId}
              disabled={!dueTo || saving || reasons.loading}
              onChange={(e) => { setReasonId(e.target.value); setErr(null); }}
            >
              <option value="">
                {!dueTo ? 'Choose who it’s due to first' : reasons.loading ? 'Loading reasons…' : 'Select reason'}
              </option>
              {options.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            {dueTo && !reasons.loading && options.length === 0 && (
              <p className="mt-1 text-sm text-warning-strong">
                No reschedule reasons are configured for {dueTo}. Pick another party or add the reason in settings.
              </p>
            )}
          </Step>

          <Step n={3} label="Remarks" required>
            <textarea
              className="min-h-[88px] w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              placeholder="Called the technician twice at 12:15 pm, no answer. Customer agreed to a new time."
              value={remarks}
              disabled={saving}
              onChange={(e) => { setRemarks(e.target.value); setErr(null); }}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>At least {MIN_REMARKS} characters</span>
              <span className="tabular-nums">{remarks.trim().length}</span>
            </div>
          </Step>

          {/* NOT a choice — a statement. Reschedule notifies both parties on
              its own; ticked-and-disabled says who gets told without offering a
              switch that would do nothing. */}
          <div className="border-t pt-3">
            <p className="text-sm font-medium">Notify</p>
            <div className="mt-1.5 flex flex-wrap gap-4 text-sm text-muted-foreground">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked disabled className="accent-primary" />SMS the customer</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked disabled className="accent-primary" />Notify technician</label>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Sent automatically on every reschedule. Open offers are withdrawn and sent again for the new time.</p>
          </div>

          {err && <p className="text-sm text-urgent-strong" role="alert">{err}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Close</Button>
          <Button type="button" onClick={submit} disabled={saving}>
            {saving ? 'Submitting…' : 'Submit reschedule'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, label, required, children }: {
  n: number; label: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-3">
      <span className="grid h-7 w-7 place-items-center rounded-full bg-sidebar text-xs font-semibold text-sidebar-foreground">{n}</span>
      <div>
        <p className="mb-1.5 text-sm font-semibold">
          {label}{required && <span className="text-urgent-strong"> *</span>}
        </p>
        {children}
      </div>
    </div>
  );
}
