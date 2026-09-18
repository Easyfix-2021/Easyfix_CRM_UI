'use client';

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetch } from '@/lib/hooks';
import { formatDate, istNowWallClock } from '@/lib/utils';
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
  open, jobId, currentAppointment, originalAppointment, liveOffers = 0, onClose, onDone,
}: {
  open: boolean;
  jobId: number | null;
  /*
   * Open offers that this reschedule will expire. The backend expires them and
   * stamps closed_reason = 'rescheduled'; the operator has to know BEFORE
   * saving that the job goes back to square one and must be offered again.
   */
  liveOffers?: number;
  /** What the job says now — the thing being changed. */
  currentAppointment: string | null;
  /** What the customer was first promised; SDA is scored against this. */
  originalAppointment: string | null;
  onClose: () => void;
  /** Called with the NEW appointment (IST wall clock 'YYYY-MM-DDTHH:mm'). */
  onDone: (newAppointment: string) => void;
}) {
  const [dueTo, setDueTo] = useState<DueTo | ''>('');
  const [dateTime, setDateTime] = useState('');
  const [reasonId, setReasonId] = useState('');
  const [remarks, setRemarks] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const confirmAction = useConfirm();

  /*
   * Reasons are fetched per party, so the list can only ever offer reasons that
   * belong to the party chosen in step 1. Keyed on the party, so switching it
   * re-reads (module-cached) rather than filtering a stale list client-side.
   */
  const byParty = useFetch<Reason[]>(
    open && dueTo ? `/admin/jobs/action-reasons?type=reschedule&dueTo=${DUE_TO_PARAM[dueTo]}` : null,
  );
  /*
   * FALLBACK, and it is a temporary one. The six seeded reschedule reasons
   * carry the party numbering this repo disproved on 2026-07-14, so the
   * customer-worded reasons sit under EasyFix and `dueTo=customer` legitimately
   * returns nothing. Correcting those six rows is the business's call and has
   * been deferred, so rather than present an empty dropdown the dialog falls
   * back to the unfiltered list AND SAYS SO — a filter that silently shows
   * everything is worse than no filter. Delete this branch, and `dueTo=any`
   * with it, once the catalogue is fixed.
   */
  const partyEmpty = !!dueTo && !byParty.loading && (byParty.data ?? []).length === 0;
  const unfiltered = useFetch<Reason[]>(
    open && partyEmpty ? '/admin/jobs/action-reasons?type=reschedule&dueTo=any' : null,
  );
  const reasons = {
    loading: byParty.loading || (partyEmpty && unfiltered.loading),
    data: partyEmpty ? unfiltered.data : byParty.data,
  };

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
  /*
   * NO PAST DATE OR TIME. The picker greys out earlier days and, on today,
   * hides slots that have already started; taken fresh on every open so a
   * dialog left open does not keep offering a slot that has since passed.
   * The submit re-checks, for the minutes between opening and saving.
   */
  const minLocal = useMemo(() => istNowWallClock(), [open]);

  /*
   * What is still missing, in the order the form asks for it — ONE source for
   * both the disabled button and the hint beside it, so they can never
   * disagree about why it cannot be submitted.
   */
  const blocker =
    !dateTime ? 'date'
      : !dueTo ? 'Step 1: choose who this is due to'
        : !reasonId ? 'Step 2: select a reason'
          : remarks.trim().length < MIN_REMARKS
            ? `Step 3: ${MIN_REMARKS - remarks.trim().length} more character${MIN_REMARKS - remarks.trim().length === 1 ? '' : 's'} of remarks`
            : '';

  async function submit() {
    if (!jobId) return;
    if (!dateTime) { setErr('Pick the new date and time'); return; }
    if (dateTime.slice(0, 16) <= istNowWallClock()) {
      setErr('That time has already passed — pick a later date and time');
      return;
    }
    if (!dueTo) { setErr('Step 1: choose who this reschedule is due to'); return; }
    if (!reasonId) { setErr('Step 2: select a reason'); return; }
    if (remarks.trim().length < MIN_REMARKS) {
      setErr(`Step 3: add remarks of at least ${MIN_REMARKS} characters`);
      return;
    }
    /*
     * Last-moment confirm, and only when it can actually cost something: a
     * reschedule EXPIRES every open offer (closed_reason = 'rescheduled') and
     * the job has to be offered again from scratch. The warning above says so
     * while the form is filled; this catches the operator who filled it anyway.
     */
    if (liveOffers > 0) {
      const ok = await confirmAction({
        title: `Reschedule and expire ${liveOffers} offer${liveOffers === 1 ? '' : 's'}?`,
        icon: <AlertTriangle className="h-5 w-5" />,
        iconAccent: 'amber',
        /*
         * Short lines, one fact each. The paragraph this replaced said the same
         * thing in three clauses, and an operator mid-task reads the first line
         * and clicks — so the first line has to be the consequence, not the
         * preamble.
         */
        description: (
          <ul className="space-y-1.5 text-sm">
            <li>• {liveOffers} technician{liveOffers === 1 ? '' : 's'} waiting to reply will lose the offer.</li>
            <li>• They will see it as <b>Expired · Appointment rescheduled</b>.</li>
            <li>• The job moves to <b>Offer Rejected/Expired</b> until you offer it again.</li>
            <li>• <b>Next step:</b> choose technicians and offer it again for the new time — before you close the console.</li>
          </ul>
        ),
        confirmLabel: 'Reschedule and re-offer',
      });
      if (!ok) return;
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
      onDone(dateTime);
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
      {/* A column that never exceeds the viewport: header and footer are fixed
          bands and only the middle scrolls, so Submit is on screen from the
          moment the dialog opens. It used to sit below a 70vh body and the
          operator had to scroll to discover it existed. */}
      <DialogContent noPadding className="flex max-h-[92vh] !max-w-2xl flex-col overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b-[3px] border-primary bg-sidebar px-4 py-3 text-sidebar-foreground">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-white/10">
            <CalendarClock className="h-4 w-4" />
          </span>
          {/* No close button here: DialogContent renders its own ✕ in this
              corner, and the hand-rolled one sat directly on top of it. */}
          <h2 className="flex-1 text-base font-semibold">Reschedule job{jobId ? ` #${jobId}` : ''}</h2>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {/* WHAT is changing, before WHY: the two appointments side by side, so
              the operator can see whether this move leaves the original date —
              which is exactly what decides SDA. */}
          <div className="space-y-2 rounded-md border bg-muted/40 p-2.5">
            {/* Both dates on ONE line: they are read together — "where it is
                now" against "what the customer was first promised" — and two
                stacked rows made a comparison look like a list. */}
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
              <span><span className="text-muted-foreground">Current </span><strong>{currentAppointment ? formatDate(currentAppointment) : 'Not set'}</strong></span>
              <span><span className="text-muted-foreground">Original </span><strong>{originalAppointment ? formatDate(originalAppointment) : '—'}</strong></span>
            </div>
            <div>
              <Label className="text-sm font-medium">New date &amp; time <span className="text-urgent-strong">*</span></Label>
              {/* Same picker and granularity the Current tab uses: reschedule
                  COMMITS a booking, and a half-hour value is not a frame start
                  the model defines. */}
              <DateTimeSlotPicker
                min={minLocal}
                value={dateTime}
                onChange={setDateTime}
                granularity="hour-frame"
                disabled={saving}
              />
            </div>
          </div>

          {liveOffers > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-warning bg-warning-tint px-3 py-2 text-sm text-warning-strong">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <b>{liveOffers} offer{liveOffers === 1 ? '' : 's'} open.</b> Rescheduling expires {liveOffers === 1 ? 'it' : 'them'} — offer it again for the new time before closing the console.
              </span>
            </p>
          )}

          {/* Due to → Reason → Remarks, one under the other, with the four
              parties on ONE line — read top to bottom with no scrolling. */}
          <Step n={1} label="Reschedule due to" required>
            <div className="flex flex-wrap gap-2 sm:flex-nowrap">
              {DUE_TO.map((d) => (
                <label
                  key={d}
                  className={`inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-sm ${dueTo === d ? 'border-primary bg-primary/5 font-medium' : 'hover:bg-muted'}`}
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
            {partyEmpty && !reasons.loading && options.length > 0 && (
              <p className="mt-1 text-xs text-warning-strong">
                No reasons are tagged to {dueTo} yet, so every reschedule reason is listed.
              </p>
            )}
            {dueTo && !reasons.loading && options.length === 0 && (
              <p className="mt-1 text-sm text-warning-strong">
                No reschedule reasons are configured. Add them in settings before rescheduling from here.
              </p>
            )}
          </Step>

          <Step n={3} label="Remarks" required>
            <textarea
              className="h-16 w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm"
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

          {/* NOT a choice — a statement of what the save sends, checked against
              the backend (2026-09-17): reschedule fires RescheduleTech, whose
              notification sends the CUSTOMER an SMS with the new time and the
              CLIENT's system the webhook. Nothing is pushed to the technician,
              so the line says so rather than promising it. */}
          <p className="border-t pt-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Notify</span> · the customer gets an SMS with the new time and the
            client’s system is updated. The technician is <b>not</b> notified — call them. Open offers are expired and must
            be sent again for the new time.
          </p>

          {err && <p className="text-sm text-urgent-strong" role="alert">{err}</p>}
        </div>

        {/* The button is ALWAYS here, disabled until the form is complete, with
            the missing piece named beside it. Hiding it (or leaving it enabled
            and erroring) both left the operator asking "where is the button" —
            the honest answer is "here, and this is what it still needs". */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-muted/30 px-4 py-2.5">
          {/* The step hints stay; the date one is dropped (ops, 2026-09-17) —
              the empty picker at the top already says what is missing. */}
          {blocker && blocker !== 'date' && <span className="mr-auto text-xs text-muted-foreground">{blocker}</span>}
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Close</Button>
          <Button type="button" onClick={submit} disabled={saving || !!blocker}>
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
