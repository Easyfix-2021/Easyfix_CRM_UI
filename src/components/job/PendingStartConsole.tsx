'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CalendarClock, CalendarCheck, CalendarDays, Ban, Loader2, MapPin, UserCog, Star, Repeat } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { formatDate, relativeTime, formatEasyfixerName } from '@/lib/utils';
import { api, type JobOffersResponse } from '@/lib/api';
import { LiveLocationPopover } from '@/components/location/LiveLocationPopover';
import { displaySlot } from '@/lib/job-slots';
import { PTS_STATUS, ptsStateOf, appointmentTiming } from '@/lib/pending-start-status';
import { PtsTimingChip, useMinuteClock } from './PendingStartLiveStatus';
import { appRequestOf, type AppRequestFields } from '@/lib/job-app-request';
import { CallableMobile } from '@/components/calls/CallButton';
import { ScheduleAssignUplifted, OfferRepliesList, type UpliftedJob, type UpliftedProbe } from './ScheduleAssignUplifted';
import { ServicesOneListDialog } from './ServicesOneListDialog';
import { ScheduleAssignRescheduleDialog } from './ScheduleAssignRescheduleDialog';
import { TechRequestActions, APP_REQUEST_ACTION } from './TechRequestActions';
import type { JobNote } from './JobInternalNotes';

/*
 * PendingStartConsoleBody — the job console for an ACCEPTED job (My Orders →
 * Pending to Start). It is the UPLIFTED tab of the Reassign Technician popup
 * (AssignTechnicianModal, mode 'reassign'): that popup owns the technician
 * list, the Reassign commit, Add Remarks, Cancel and the remarks / notes row;
 * this body is everything above the technician list. Opened on Uplifted from
 * the row's console icon, on Current from the row's reassign icon.
 *
 * SAME LAYOUT AS SCHEDULE & ASSIGN'S UPLIFTED TAB, deliberately: it renders
 * <ScheduleAssignUplifted> and swaps in only what differs for a job a technician
 * has already taken — the "what to do now" strip, the Technician card, and the
 * Current state tile. Two consoles that looked alike but were built twice would
 * be the drift this estate keeps paying for.
 *
 * WHAT TO DO NOW is decided by the SAME priority the page's tabs use, so the tab
 * an operator clicked and the strip they land on always agree:
 *   cancel request → reschedule request → slot missed → today → future.
 * Requests are answered with the existing <TechRequestActions> (Approve opens
 * the audited Cancel / Reschedule dialogs, Reject clears the flag with a comment)
 * — the same control the row icons use, so the decision is identical from the
 * list and from here.
 *
 * READS /admin/jobs/:id/header — the Schedule & Assign job header without the
 * technician ranking, which an accepted job does not need — plus the job detail
 * for the reference, the original appointment and the booking's attachments.
 */

type HeaderJob = NonNullable<UpliftedJob> & AppRequestFields & {
  job_id?: number;
  efr_id?: number | null;
  efr_name?: string | null;
  efr_mobile?: string | null;
  checkin_date_time?: string | null;
  accepted_date_time?: string | null;
  /* The assigned technician's track record, from the header. */
  efr_completed_7d?: number | null;
  efr_open_jobs?: number | null;
  efr_avg_rating?: number | null;
};

type Probe = NonNullable<UpliftedProbe> & { job_id?: number };

const SA_API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

/* The status + timing rule is shared with the My Orders row — see
   lib/pending-start-status.ts — so the row and its console always agree. */

export function PendingStartConsoleBody({
  active, jobId, onChanged, onJobCancelled, onRescheduled, onRescheduleClosed, onJobMoved, onAppointment,
  onChangeTechnician, openRescheduleSignal, pinnedNotes, onShowNotes,
}: {
  /** The popup is open on this tab — reads only run while it is. */
  active: boolean;
  jobId: number | null;
  /** Something on the job changed: refresh the list behind and the remarks thread. */
  onChanged: () => void;
  /** An approved cancellation cancelled the job — the host closes. */
  onJobCancelled: () => void;
  /** THIS body's Reschedule popup saved a new time — the host re-ranks and may prompt to reassign. */
  onRescheduled: () => void;
  /** THIS body's Reschedule popup closed (saved or not) — the host drops a pending reassign intent. */
  onRescheduleClosed: () => void;
  /**
   * Something that feeds the ranking changed WITHOUT this body's Reschedule
   * popup (a technician request approved/rejected, services saved) — the host
   * re-ranks, but must not treat it as the reschedule a reassign was waiting on.
   */
  onJobMoved: () => void;
  /** The job's current appointment as this body last read it (the fast /header). */
  onAppointment: (requestedDateTime: string | null) => void;
  /**
   * Start a reassign: the host asks to reschedule first when the appointment
   * has passed, otherwise it scrolls to its technician list.
   */
  onChangeTechnician: () => void;
  /** The host bumps this to open this body's Reschedule popup (reassign → reschedule first). */
  openRescheduleSignal: number;
  pinnedNotes: JobNote[];
  onShowNotes: () => void;
}) {
  const { me } = useMe();
  const header = useFetch<{ job: HeaderJob }>(active && jobId ? `/admin/jobs/${jobId}/header` : null);
  const detail = useFetch<Probe>(active && jobId ? `/admin/jobs/${jobId}` : null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  /* Open the Reschedule popup when the host asks (a reassign on a passed
     appointment). Keyed on the signal CHANGING, so a remount does not reopen it. */
  const lastSignal = useRef(openRescheduleSignal);
  useEffect(() => {
    if (openRescheduleSignal !== lastSignal.current) {
      lastSignal.current = openRescheduleSignal;
      setRescheduleOpen(true);
    }
  }, [openRescheduleSignal]);
  /* Who else this job was offered to before it was accepted — shown under the
     assigned technician. Trusted only for this job's key (useFetch keeps the
     previous job's list while the next loads). */
  const offersKey = active && jobId ? `/admin/jobs/${jobId}/offers` : null;
  const offers = useFetch<JobOffersResponse>(offersKey);
  const offerItems = offers.dataKey === offersKey ? (offers.data?.items ?? []) : [];
  const offersLoaded = offers.dataKey === offersKey;

  /* Trust a payload only when it IS this job — useFetch keeps the previous
     job's data while the next loads (same guard as Schedule & Assign). */
  const job = header.data?.job && Number(header.data.job.job_id) === Number(jobId) ? header.data.job : null;
  const probe = detail.data && Number(detail.data.job_id) === Number(jobId) ? detail.data : null;
  /* Report the appointment up whenever this body's read of it changes: the
     host's own copy comes from /candidates (the slow ranking pass), and the
     "reschedule first" check must not wait for it — nor trust it after a
     request approval moved the time. */
  const appointmentNow = job ? (job.requested_date_time ?? null) : undefined;
  useEffect(() => {
    if (appointmentNow !== undefined) onAppointment(appointmentNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentNow]);

  const now = useMinuteClock();
  const state = ptsStateOf(job);
  const timing = appointmentTiming(job?.requested_date_time, now);
  const timingChip = job ? <PtsTimingChip requestedDateTime={job.requested_date_time} now={now} /> : null;
  const req = job ? appRequestOf(job) : null;
  const canResolve = hasAction(me, APP_REQUEST_ACTION);
  const canReassign = hasAction(me, 'isJobReassign');

  /*
   * After any decision: re-read the job and its offers here, and let the host
   * refresh the list behind and remount the remarks thread (its cache dropped
   * first — a remount alone re-serves the 30s-cached comment list).
   */
  function refresh() {
    if (jobId != null) {
      invalidateFetch((k) => k.startsWith(`/admin/jobs/${jobId}/comments`)
        || k.startsWith(`/admin/jobs/${jobId}/customer-requests`));
    }
    header.refetch();
    detail.refetch();
    offers.refetch();
    onChanged();
  }
  function afterReschedule() {
    refresh();
    onRescheduled();
  }

  const slot = displaySlot(job?.requested_date_time, job?.time_slot);
  const strip = (tone: 'urgent' | 'warning' | 'info' | 'neutral', Icon: typeof AlertTriangle, title: string, sub: React.ReactNode, actions?: React.ReactNode) => {
    const wrap = {
      urgent: 'border-urgent bg-urgent-tint text-urgent-strong',
      warning: 'border-warning bg-warning-tint text-warning-strong',
      info: 'border-info bg-info-tint text-info-strong',
      neutral: 'border-border bg-muted/40 text-foreground',
    }[tone];
    const plate = {
      urgent: 'bg-destructive text-destructive-foreground',
      warning: 'bg-warning text-white',
      info: 'bg-info text-white',
      neutral: 'bg-sidebar text-sidebar-foreground',
    }[tone];
    return (
      <div className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 ${wrap}`}>
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${plate}`}><Icon className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs opacity-90">{sub}</p>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    );
  };

  const requestActions = req && jobId != null ? (
    <TechRequestActions
      jobId={jobId}
      request={req}
      allowed={canResolve}
      /* An approved reschedule moves the appointment: re-read here AND have the
         host re-rank, or its "reschedule first" check keeps the old time. */
      onActioned={() => { refresh(); onJobMoved(); }}
      onCancelled={onJobCancelled}
      variant="button"
    />
  ) : null;
  /* Every state can hand the job to someone else — through the host's reassign
     flow (reschedule first when the time has passed, then the list). */
  const reassignButton = canReassign ? (
    <Button size="sm" variant="outline" onClick={onChangeTechnician}>
      <UserCog className="mr-1.5 h-3.5 w-3.5" />Reassign technician
    </Button>
  ) : null;
  const withReassign = (node: React.ReactNode) => (
    <>{node}{reassignButton}</>
  );

  /*
   * The line under each title leads with the timing chip, so "what is waiting"
   * (the title) and "how close the visit is" (the chip) read together. Today's
   * title itself follows the timing: that is the one state where the right
   * action changes through the day.
   */
  const sub = (text: React.ReactNode) => (
    <span className="inline-flex flex-wrap items-center gap-1.5">{timingChip}<span>{text}</span></span>
  );
  const action = !job ? null
    : state === 'cancel' ? strip('urgent', Ban, 'Technician asked to cancel this job',
      sub(<>{req?.reason || 'No reason given'}{req?.raisedAt ? ` · raised ${formatDate(req.raisedAt)} (${relativeTime(req.raisedAt)})` : ''} · confirm with the customer before approving</>),
      withReassign(requestActions))
      : state === 'reschedule' ? strip('warning', CalendarClock, 'Technician asked to reschedule',
        sub(<>{req?.reason || 'No reason given'}{req?.requestedFor ? ` · wants ${formatDate(req.requestedFor)}` : ''}{req?.raisedAt ? ` · raised ${relativeTime(req.raisedAt)}` : ''}</>),
        withReassign(requestActions))
        : state === 'missed' ? strip('urgent', AlertTriangle, 'Slot missed — not checked in',
          sub(<>The appointment was {job.requested_date_time ? formatDate(job.requested_date_time) : 'not set'}. Call the technician, or reschedule with a reason.</>),
          withReassign(<Button size="sm" onClick={() => setRescheduleOpen(true)}><CalendarClock className="mr-1.5 h-3.5 w-3.5" />Reschedule</Button>))
          : state === 'today'
            ? (timing?.kind === 'late'
              ? strip('urgent', AlertTriangle, 'Running late — not checked in',
                sub(<>{slot || 'Time not set'} · call {job.efr_name || 'the technician'} for an ETA, or reschedule with a reason</>),
                withReassign(<Button size="sm" variant="outline" onClick={() => setRescheduleOpen(true)}><CalendarClock className="mr-1.5 h-3.5 w-3.5" />Reschedule</Button>))
              : timing?.kind === 'close_loop'
                ? strip('warning', CalendarCheck, 'Close loop — visit within 2 hours',
                  sub(<>{slot || 'Time not set'} · confirm {job.efr_name || 'the technician'} is on the way</>), reassignButton)
                : strip('info', CalendarCheck, 'Due today',
                  sub(<>{slot || 'Time not set'} · {job.efr_name || 'Technician'} is scheduled — nothing to do unless the slot slips</>), reassignButton))
            : strip('neutral', CalendarDays, 'Upcoming',
              sub(<>{job.requested_date_time ? formatDate(job.requested_date_time) : 'Date not set'}{slot ? ` · ${slot}` : ''} · waiting for the visit</>), reassignButton);

  /* Current state tile: the same status label as the row, the timing chip
     beside it, and who the job is waiting on underneath. */
  const stateOverride = !job ? undefined : {
    label: PTS_STATUS[state].label,
    sub: {
      cancel: 'Waiting on you',
      reschedule: 'Waiting on you',
      missed: 'Appointment day has passed',
      today: 'Visit due today',
      future: 'Pending to start',
    }[state],
    chipClass: {
      cancel: 'border-urgent bg-urgent-tint text-urgent-strong',
      reschedule: 'border-warning bg-warning-tint text-warning-strong',
      missed: 'border-urgent bg-urgent-tint text-urgent-strong',
      today: 'border-info bg-info-tint text-info-strong',
      future: 'border-border bg-muted text-muted-foreground',
    }[state],
    extra: timingChip,
  };

  /*
   * THE TECHNICIAN TILE (ops mockup, 2026-09-17): who has the job and how they
   * are doing, the two actions that matter on an accepted job, then everyone
   * else the job was offered to. The tile is exactly as tall as Customer and
   * Client beside it; the offer list takes the height that is left and scrolls
   * inside it. No Cancel here (it lives in the popup footer) and no Notify yet.
   *
   *   Efr # · accepted <time>  — only when the technician actually accepted an
   *                              offer; jobs assigned the old way show no time
   *   No check-in              — every job in this bucket, until check-in
   *   ★ rating                 — AVG customer rating, as on Manage Easyfixers
   *   Track record             — completed in the last 7 days (status 3/5) and
   *                              open jobs now (status 1, 2, 20)
   *   Change                   — the reassign flow (reschedule first if late)
   *
   * No photo: the backend serves no technician profile image yet, so the
   * avatar is the technician's initials.
   */
  const efrName = job?.efr_name ? formatEasyfixerName(job.efr_name) : '';
  const efrInitials = efrName.replace(/^Trainee · /, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  const live = offerItems.filter((o) => (o.offer_status ?? 0) === 0).length;
  const closed = offerItems.length - live;
  const completed7d = job?.efr_completed_7d;
  const openJobs = job?.efr_open_jobs;
  const technician = job ? (
    <div className="flex min-h-0 flex-1 flex-col gap-2 text-xs">
      <div className="flex items-start gap-3">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-info bg-info-tint text-base font-semibold text-info-strong" aria-hidden>
          {efrInitials || '—'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{efrName || 'Technician'}</p>
          <p className="text-muted-foreground">
            {job.efr_id ? `Efr #${job.efr_id}` : 'Efr ID not available'}
            {job.accepted_date_time ? ` · accepted ${formatDate(job.accepted_date_time)}` : ''}
          </p>
          <p className="mt-1 flex flex-wrap gap-1">
            {!job.checkin_date_time && (
              <span className="inline-flex rounded-full border border-urgent bg-urgent-tint px-2 py-0.5 text-xs font-medium text-urgent-strong">No check-in</span>
            )}
            {job.efr_avg_rating != null && (
              <span className="inline-flex items-center gap-0.5 rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-foreground" title="Average customer rating, as on Manage Easyfixers">
                <Star className="h-3 w-3" aria-hidden />{Number(job.efr_avg_rating).toFixed(1)} rating
              </span>
            )}
          </p>
        </div>
      </div>
      <div>
        <div className="flex items-start justify-between gap-3 border-t py-1.5">
          <span className="text-muted-foreground">Mobile</span>
          <span className="font-medium">
            {job.efr_mobile && job.efr_id
              ? <CallableMobile efrId={job.efr_id} jobContextId={jobId ?? undefined} mobile={job.efr_mobile} />
              : '—'}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3 border-t py-1.5">
          <span className="shrink-0 text-muted-foreground">Track record</span>
          <span className="text-right font-medium">
            {completed7d == null && openJobs == null
              ? '—'
              : <>{completed7d ?? 0} completed (7 days) · {openJobs ?? 0} open job{openJobs === 1 ? '' : 's'}</>}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t pt-2">
        {/* Latest GPS fix from the technician app — the same popup Manage
            Easyfixers uses. */}
        {job.efr_id && (
          <Button size="sm" variant="outline" onClick={() => setLocationOpen(true)}>
            <MapPin className="mr-1.5 h-3.5 w-3.5" />Live location
          </Button>
        )}
        {canReassign && (
          <Button size="sm" variant="outline" onClick={onChangeTechnician}>
            <Repeat className="mr-1.5 h-3.5 w-3.5" />Change
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t pt-2">
        <span className="font-semibold uppercase tracking-wide text-muted-foreground">Offer replies</span>
        <span className="text-muted-foreground">{live} waiting · {closed} closed</span>
      </div>
      <OfferRepliesList
        offers={offerItems}
        jobId={jobId}
        emptyText={offersLoaded ? 'Assigned directly — this job was never offered to other technicians.' : 'Loading offers…'}
      />
    </div>
  ) : null;

  /* Blank with a loader until BOTH of this job's reads are in — the detail
     read carries the reference and the attachments, and rendering before it
     painted "No image attached" for a moment. */
  /*
   * The Reschedule and Services popups render whether or not the job has
   * loaded: the host can ask for Reschedule (a reassign on a passed
   * appointment) before this body's /header read lands — or after it failed —
   * and a popup that is not mounted would swallow that request and leave the
   * host's reassign intent armed.
   */
  const dialogs = (
    <>
      {jobId != null && (
        <ScheduleAssignRescheduleDialog
          open={rescheduleOpen}
          jobId={jobId}
          currentAppointment={job?.requested_date_time ?? null}
          originalAppointment={probe?.original_appointment_date_time ?? null}
          onClose={() => { setRescheduleOpen(false); onRescheduleClosed(); }}
          onDone={() => afterReschedule()}
        />
      )}
      {jobId != null && (
        <ServicesOneListDialog
          open={servicesOpen}
          jobId={jobId}
          onClose={() => setServicesOpen(false)}
          onSaved={() => { header.refetch(); onChanged(); onJobMoved(); }}
        />
      )}
    </>
  );

  if (!job || (!probe && !detail.error)) {
    return (
      <>
        {header.error
          ? <p className="text-sm text-urgent-strong">Could not load this job: {header.error}</p>
          : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading job…</p>}
        {dialogs}
      </>
    );
  }

  return (
    <>
      <ScheduleAssignUplifted
        jobId={jobId}
        job={job}
        probe={probe}
        offers={null}
        offerable={false}
        onReschedule={() => setRescheduleOpen(true)}
        onPickTechnicians={onChangeTechnician}
        apiBase={SA_API_BASE}
        actionOverride={action}
        technicianOverride={technician}
        stateOverride={stateOverride}
        pinnedNotes={pinnedNotes}
        onShowNotes={onShowNotes}
        /* Editable on an accepted job too (ops, 2026-09-17): the same one-list
           services editor and the same PATCH for the job notes as Schedule &
           Assign, then a re-read of the header. */
        onEditServices={jobId != null ? () => setServicesOpen(true) : undefined}
        onSaveDetails={jobId != null ? async (patch) => {
          await api.patch(`/admin/jobs/${jobId}`, patch);
          header.refetch();
        } : undefined}
      />

      {dialogs}
      <LiveLocationPopover
        open={locationOpen}
        onClose={() => setLocationOpen(false)}
        source="easyfixer"
        id={locationOpen && job.efr_id ? Number(job.efr_id) : null}
        title={efrName ? `${efrName}${job.efr_id ? ` · Efr #${job.efr_id}` : ''}` : undefined}
      />
    </>
  );
}
