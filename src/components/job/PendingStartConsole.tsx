'use client';

import { useState } from 'react';
import { AlertTriangle, CalendarClock, CalendarCheck, CalendarDays, Ban, Loader2, MapPin, UserCog } from 'lucide-react';
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
};

type Probe = NonNullable<UpliftedProbe> & { job_id?: number };

const SA_API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

/* The status + timing rule is shared with the My Orders row — see
   lib/pending-start-status.ts — so the row and its console always agree. */

export function PendingStartConsoleBody({
  active, jobId, onChanged, onJobCancelled, onRescheduled, onPickTechnicians, pinnedNotes, onShowNotes,
}: {
  /** The popup is open on this tab — reads only run while it is. */
  active: boolean;
  jobId: number | null;
  /** Something on the job changed: refresh the list behind and the remarks thread. */
  onChanged: () => void;
  /** An approved cancellation cancelled the job — the host closes. */
  onJobCancelled: () => void;
  /** The appointment moved — the host re-ranks its technician list. */
  onRescheduled: () => void;
  /** Scroll to the host's technician list. */
  onPickTechnicians: () => void;
  pinnedNotes: JobNote[];
  onShowNotes: () => void;
}) {
  const { me } = useMe();
  const header = useFetch<{ job: HeaderJob }>(active && jobId ? `/admin/jobs/${jobId}/header` : null);
  const detail = useFetch<Probe>(active && jobId ? `/admin/jobs/${jobId}` : null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
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
    <TechRequestActions jobId={jobId} request={req} allowed={canResolve} onActioned={refresh} onCancelled={onJobCancelled} variant="button" />
  ) : null;
  /* Every state can hand the job to someone else: the button scrolls to the
     technician list below, where Reassign commits. */
  const reassignButton = canReassign ? (
    <Button size="sm" variant="outline" onClick={onPickTechnicians}>
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
   * The assigned technician, then everyone else the job was offered to. The
   * card is exactly as tall as Customer and Client beside it; the offer list
   * takes whatever height is left and scrolls inside it.
   *
   * No photo: the backend serves no technician profile image yet, so the
   * avatar is the technician's initials.
   */
  const efrName = job?.efr_name ? formatEasyfixerName(job.efr_name) : '';
  const efrInitials = efrName.replace(/^Trainee · /, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  const technician = job ? (
    <div className="flex min-h-0 flex-1 flex-col gap-2 text-xs">
      <div className="flex items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-info bg-info-tint text-sm font-semibold text-info-strong" aria-hidden>
          {efrInitials || '—'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{efrName || 'Technician'}</p>
          <p className="text-muted-foreground">{job.efr_id ? `Efr #${job.efr_id}` : 'Efr ID not available'}</p>
        </div>
        {/* Latest GPS fix from the technician app — the same popup Manage
            Easyfixers uses. */}
        {job.efr_id && (
          <button
            type="button"
            onClick={() => setLocationOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
          >
            <MapPin className="h-3.5 w-3.5" />Live location
          </button>
        )}
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
          <span className="text-muted-foreground">Accepted</span>
          <span className="font-medium">{job.accepted_date_time ? formatDate(job.accepted_date_time) : '—'}</span>
        </div>
        <div className="flex items-start justify-between gap-3 border-t py-1.5">
          <span className="text-muted-foreground">Checked in</span>
          <span className="font-medium">{job.checkin_date_time ? formatDate(job.checkin_date_time) : 'Not yet'}</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t pt-2">
        <span className="font-semibold uppercase tracking-wide text-muted-foreground">Offered to</span>
        <span className="inline-flex min-w-[1.5rem] justify-center rounded-full border bg-muted px-1.5 py-0.5 font-medium tabular-nums text-muted-foreground">
          {offerItems.length}
        </span>
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
  if (!job || (!probe && !detail.error)) {
    return header.error
      ? <p className="text-sm text-urgent-strong">Could not load this job: {header.error}</p>
      : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading job…</p>;
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
        onPickTechnicians={onPickTechnicians}
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

      {jobId != null && (
        <ScheduleAssignRescheduleDialog
          open={rescheduleOpen}
          jobId={jobId}
          currentAppointment={job.requested_date_time ?? null}
          originalAppointment={probe?.original_appointment_date_time ?? null}
          onClose={() => setRescheduleOpen(false)}
          onDone={afterReschedule}
        />
      )}
      {jobId != null && (
        <ServicesOneListDialog
          open={servicesOpen}
          jobId={jobId}
          onClose={() => setServicesOpen(false)}
          onSaved={() => { header.refetch(); onChanged(); onRescheduled(); }}
        />
      )}
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
