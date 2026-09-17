'use client';

import { useRef, useState } from 'react';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { AlertTriangle, CalendarClock, CalendarCheck, CalendarDays, Ban, User, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { showToast } from '@/components/ui/toast';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { formatDate, relativeTime } from '@/lib/utils';
import { displaySlot } from '@/lib/job-slots';
import { istToday } from '@/lib/due-date';
import { appRequestOf, type AppRequestFields } from '@/lib/job-app-request';
import { CallableMobile } from '@/components/calls/CallButton';
import { ScheduleAssignUplifted, type UpliftedJob, type UpliftedProbe } from './ScheduleAssignUplifted';
import { ScheduleAssignRescheduleDialog } from './ScheduleAssignRescheduleDialog';
import { TechRequestActions, APP_REQUEST_ACTION } from './TechRequestActions';
import { JobRemarksView } from './JobRemarksView';
import { JobInternalNotes, type JobNote } from './JobInternalNotes';
import { AddRemarksDialog } from './AddRemarksDialog';

/*
 * PendingStartConsole — the job console for an ACCEPTED job (My Orders →
 * Pending to Start), opened from the row's "Open job console" icon.
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

type State = 'cancel' | 'reschedule' | 'missed' | 'today' | 'future';

const SA_API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

/* The tab-priority classifier, for ONE job. Kept beside the component that
   renders it; the server applies the same order to the list. */
function stateOf(job: HeaderJob | null): State {
  const req = job ? appRequestOf(job) : null;
  if (req?.kind === 'cancel') return 'cancel';
  if (req?.kind === 'reschedule') return 'reschedule';
  const day = String(job?.requested_date_time ?? '').slice(0, 10);
  const today = istToday();
  if (!day || day < today) return 'missed';
  return day === today ? 'today' : 'future';
}

export function PendingStartConsole({ open, jobId, onClose, onChanged }: {
  open: boolean;
  jobId: number | null;
  onClose: () => void;
  /** Tell the list behind the console that this job may have changed tab. */
  onChanged?: () => void;
}) {
  const { me } = useMe();
  const header = useFetch<{ job: HeaderJob }>(open && jobId ? `/admin/jobs/${jobId}/header` : null);
  const detail = useFetch<Probe>(open && jobId ? `/admin/jobs/${jobId}` : null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [remarksOpen, setRemarksOpen] = useState(false);
  const [remarksKey, setRemarksKey] = useState(0);
  const [pinnedNotes, setPinnedNotes] = useState<JobNote[]>([]);
  const notesRef = useRef<HTMLDivElement | null>(null);

  /* Trust a payload only when it IS this job — useFetch keeps the previous
     job's data while the next loads (same guard as Schedule & Assign). */
  const job = header.data?.job && Number(header.data.job.job_id) === Number(jobId) ? header.data.job : null;
  const probe = detail.data && Number(detail.data.job_id) === Number(jobId) ? detail.data : null;

  const state = stateOf(job);
  const req = job ? appRequestOf(job) : null;
  const canResolve = hasAction(me, APP_REQUEST_ACTION);
  /* Nothing on the console itself is a form — every write happens in a child
     dialog with its own guard — so this never blocks a close. It exists so the
     Dialog's close goes through the estate's shared handler. */
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: () => false });

  /*
   * After any decision: re-read the job, and REMOUNT the remarks thread with
   * its cache dropped first — the thread is a mounted useFetch with a 30s TTL,
   * so a remount alone re-serves the comment list from before the decision.
   */
  function reloadRemarks() {
    if (jobId != null) {
      invalidateFetch((k) => k.startsWith(`/admin/jobs/${jobId}/comments`)
        || k.startsWith(`/admin/jobs/${jobId}/customer-requests`));
    }
    setRemarksKey((n) => n + 1);
  }
  function refresh() {
    header.refetch();
    detail.refetch();
    reloadRemarks();
    onChanged?.();
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
    <TechRequestActions jobId={jobId} request={req} allowed={canResolve} onActioned={refresh} variant="button" />
  ) : null;

  const action = !job ? null
    : state === 'cancel' ? strip('urgent', Ban, 'Technician asked to cancel this job',
      <>{req?.reason || 'No reason given'}{req?.raisedAt ? ` · raised ${formatDate(req.raisedAt)} (${relativeTime(req.raisedAt)})` : ''} · confirm with the customer before approving</>,
      requestActions)
      : state === 'reschedule' ? strip('warning', CalendarClock, 'Technician asked to reschedule',
        <>{req?.reason || 'No reason given'}{req?.requestedFor ? ` · wants ${formatDate(req.requestedFor)}` : ''}{req?.raisedAt ? ` · raised ${relativeTime(req.raisedAt)}` : ''}</>,
        requestActions)
        : state === 'missed' ? strip('urgent', AlertTriangle, 'Appointment passed — not checked in',
          <>The appointment was {job.requested_date_time ? formatDate(job.requested_date_time) : 'not set'}. Call the technician, or reschedule with a reason.</>,
          <Button size="sm" onClick={() => setRescheduleOpen(true)}><CalendarClock className="mr-1.5 h-3.5 w-3.5" />Reschedule</Button>)
          : state === 'today' ? strip('info', CalendarCheck, 'Visit today',
            <>{slot || 'Time not set'} · {job.efr_name || 'Technician'} is scheduled — nothing to do unless the slot slips</>)
            : strip('neutral', CalendarDays, 'Scheduled',
              <>{job.requested_date_time ? formatDate(job.requested_date_time) : 'Date not set'}{slot ? ` · ${slot}` : ''} · waiting for the visit</>);

  const stateOverride = !job ? undefined : {
    cancel: { label: 'Cancel request', sub: 'Waiting on you', chipClass: 'border-urgent bg-urgent-tint text-urgent-strong' },
    reschedule: { label: 'Reschedule request', sub: 'Waiting on you', chipClass: 'border-warning bg-warning-tint text-warning-strong' },
    missed: { label: 'Slot missed', sub: 'Appointment has passed', chipClass: 'border-urgent bg-urgent-tint text-urgent-strong' },
    today: { label: 'Today', sub: 'Visit due today', chipClass: 'border-info bg-info-tint text-info-strong' },
    future: { label: 'Future', sub: 'Pending to start', chipClass: 'border-border bg-muted text-muted-foreground' },
  }[state];

  const technician = job ? (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-info-tint text-info-strong">
          <User className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{job.efr_name || 'Technician'}</p>
          <p className="text-muted-foreground">{job.efr_id ? `Efr #${job.efr_id}` : 'Efr ID not available'}</p>
        </div>
      </div>
      <div className="flex items-start justify-between gap-3 border-t pt-1.5">
        <span className="text-muted-foreground">Mobile</span>
        <span className="font-medium">
          {job.efr_mobile && job.efr_id
            ? <CallableMobile efrId={job.efr_id} jobContextId={jobId ?? undefined} mobile={job.efr_mobile} />
            : '—'}
        </span>
      </div>
      <div className="flex items-start justify-between gap-3 border-t pt-1.5">
        <span className="text-muted-foreground">Accepted</span>
        <span className="font-medium">{job.accepted_date_time ? formatDate(job.accepted_date_time) : '—'}</span>
      </div>
      <div className="flex items-start justify-between gap-3 border-t pt-1.5">
        <span className="text-muted-foreground">Checked in</span>
        <span className="font-medium">{job.checkin_date_time ? formatDate(job.checkin_date_time) : 'Not yet'}</span>
      </div>
    </div>
  ) : null;

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent noPadding className="!max-w-none w-[calc(100vw-48px)] h-[calc(100vh-48px)] overflow-hidden flex flex-col">
        <DialogHeader className="px-6 py-4">
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Job Console
            {jobId && <span className="text-sm font-normal text-ink-300">· Job #{jobId}</span>}
            {probe?.job_reference_id && <span className="text-sm font-normal text-ink-300">· {probe.job_reference_id}</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-4">
          {/* Blank with a loader until BOTH of this job's reads are in — the
              detail read carries the reference and the attachments, and
              rendering before it painted "No image attached" for a moment. */}
          {!job || (!probe && !detail.error) ? (
            header.error
              ? <p className="text-sm text-urgent-strong">Could not load this job: {header.error}</p>
              : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading job…</p>
          ) : (
            <>
              <ScheduleAssignUplifted
                jobId={jobId}
                job={job}
                probe={probe}
                offers={null}
                offerable={false}
                onReschedule={() => setRescheduleOpen(true)}
                onPickTechnicians={() => { /* an accepted job is not offered */ }}
                apiBase={SA_API_BASE}
                actionOverride={action}
                technicianOverride={technician}
                stateOverride={stateOverride}
                pinnedNotes={pinnedNotes}
                onShowNotes={() => notesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              />
              {/* Remarks two thirds, internal notes one third — the same bottom
                  row as Schedule & Assign. Notes can be added on an accepted job;
                  its editors above stay read-only here. */}
              <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
                <JobRemarksView key={`${jobId}-${remarksKey}`} jobId={jobId} />
                <div ref={notesRef} className="scroll-mt-4">
                  <JobInternalNotes key={jobId ?? 'none'} jobId={jobId} canAdd onPinnedChange={setPinnedNotes} />
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter className="px-6 sm:justify-between">
          <Button variant="outline" className="border-success text-success-strong" onClick={() => setRemarksOpen(true)} disabled={!job}>
            Add Remarks
          </Button>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>

        {jobId != null && (
          <ScheduleAssignRescheduleDialog
            open={rescheduleOpen}
            jobId={jobId}
            currentAppointment={job?.requested_date_time ?? null}
            originalAppointment={probe?.original_appointment_date_time ?? null}
            onClose={() => setRescheduleOpen(false)}
            onDone={refresh}
          />
        )}
        {jobId != null && (
          <AddRemarksDialog
            open={remarksOpen}
            jobId={jobId}
            onClose={() => setRemarksOpen(false)}
            onSaved={() => {
              showToast({ variant: 'success', message: 'Remark Added' });
              setRemarksOpen(false);
              reloadRemarks();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
