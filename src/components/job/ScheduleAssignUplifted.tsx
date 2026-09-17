'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Send, Clock, AlertTriangle, CalendarClock, User, Building2, Wrench, MapPin,
  Image as ImageIcon, Video, Box, FileText, Pencil, ChevronLeft, ChevronRight, Plus, Pin, Flame,
} from 'lucide-react';
import type { JobOffer } from '@/lib/api';
import { formatDate, relativeTime, appointmentIsPast } from '@/lib/utils';
import { formatJobAge, jobAgeTitle } from '@/lib/job-age';
import { displaySlot } from '@/lib/job-slots';
import { formatServiceAddress } from '@/lib/format';
import { collectedByText } from '@/lib/collected-by';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { showToast } from '@/components/ui/toast';
import { formatApiError } from '@/lib/api-errors';
import { CallableMobile } from '@/components/calls/CallButton';
import { JobAddressEditDialog } from './JobModal';
import type { JobServiceRow } from './JobContextPanel';
import type { JobNote } from './JobInternalNotes';

/*
 * ScheduleAssignUplifted — the "Uplifted" tab of Schedule & Assign.
 *
 * WHAT IT IS: a re-presentation of the SAME job, offers and actions the Current
 * tab shows, arranged the way the queue is actually worked — what to do now at
 * the top, then when it happened, then who it is for, then what the job is,
 * then who it was offered to. It fetches nothing: every value arrives as a
 * prop, and every mutation is a callback the modal owns, so the two tabs can
 * diverge in layout but never in behaviour.
 *
 * It DOES carry the editors (services / notes / address), because this tab
 * replaces <JobContextPanel> rather than sitting above it — each one calls the
 * very same handler the panel calls in the Current tab.
 *
 * PHASE 1 scope (unallocated jobs): Unallocated · Offered-waiting · No takers.
 * Accepted-job states (technician reschedule/cancel requests, missed
 * appointment, change technician, live location) are phase 2.
 */

type Bucket = 'unallocated' | 'offered' | 'no_takers';

export type UpliftedJob = {
  job_id?: number;
  customer_name?: string | null;
  customer_mob_no?: string | null;
  client_name?: string | null;
  client_ref_id?: string | null;
  client_spoc?: string | null;
  client_spoc_name?: string | null;
  address?: string | null;
  city_name?: string | null;
  pin_code?: string | null;
  job_type?: string | null;
  payment_mode?: string | null;
  requested_date_time?: string | null;
  time_slot?: string | null;
  created_date_time?: string | null;
  created_by_name?: string | null;
  /*
   * The timeline's five stamped moments, all from tbl_job. Optional because a
   * payload that predates them simply renders the step as not-yet-happened —
   * the console must not blank out because one column has not shipped.
   */
  ticket_created_date_time?: string | null;
  original_scheduling_date_time?: string | null;
  first_scheduled_by_name?: string | null;
  /* tbl_job.checkin_date_time — the column mobile-performance.service.js
     scores OTA and SDA on. Acceptance has no column of its own: it lives on
     the accepted OFFER row, which this console already receives. */
  checkin_date_time?: string | null;
  checkin_by_name?: string | null;
  /* Acceptance is stamped on the accepted OFFER row, which GET /offers
     deliberately excludes — the header resolves it instead. */
  accepted_date_time?: string | null;
  accepted_efr_name?: string | null;
  /* The EFFECTIVE payment answer (customerPays: paid_by = 2 OR collected_by = 1),
     computed server-side so the panel cannot contradict the COD gate. */
  payment_label?: string | null;
  /** Who collects payment — the backend's own mapping, not a raw code. */
  collected_by_label?: string | null;
  collected_by?: number | string | null;
  job_desc?: string | null;
  efr_special_notes?: string | null;
  services?: JobServiceRow[] | null;
  /* Server-computed age, the SAME two fields the job list renders — so the
     popup and the row behind it can never report different ages. */
  ageDays?: number | null;
  ageSecs?: number | null;
  project_manager_name?: string | null;
  zonal_manager_name?: string | null;
  /* tbl_job.job_client_owner's name — the list's "Easyfix SPOC" column. */
  easyfix_spoc_name?: string | null;
  /* Customer contact beyond name + mobile (View Details' Customer card). */
  customer_email?: string | null;
  additional_name?: string | null;
  additional_number?: string | null;
  /* Client card: client facts, SPOC contact and the EasyFix people on it. */
  client_spoc_email?: string | null;
  vertical_name?: string | null;
  source_type?: string | null;
  helper_req?: number | null;
  branch_details?: string | null;
  building_name?: string | null;
  product_code?: string | null;
  custom_properties?: Array<{ label?: string | null; name?: string | null; value?: unknown }> | null;
  owner_name?: string | null;
  client_primary_spoc_name?: string | null;
  client_secondary_spoc_name?: string | null;
  /* The latest tbl_easyfixer_rating_by_customer row, as the Escalated view
     reads it. is_escalated is always 0/1 from the header. */
  is_escalated?: number | null;
  no_of_escalations?: number | null;
  escalated_time?: string | null;
  escalated_by_name?: string | null;
  escalated_comments?: string | null;
} | null;

export type UpliftedProbe = {
  job_reference_id?: string | null;
  /*
   * The appointment as first booked. Stamped on tbl_job and projected by
   * GET /admin/jobs/:id, so a rescheduled job can still be judged against the
   * date the customer was originally promised — which is what SDA scores on.
   */
  original_appointment_date_time?: string | null;
  original_appointment_time?: string | null;
  images?: Array<Record<string, unknown>> | null;
  videos?: Array<{ media_id: number; content_type?: string | null; source?: string | null; created_at?: string | null }> | null;
} | null;

/*
 * Client TAT, in hours from booking. A PLACEHOLDER, deliberately one constant
 * in one place: the per-client value is not on this payload yet, and the tile
 * is more useful with a stated, uniform target than absent. When the real
 * per-client TAT lands, delete this and read it off the job — every use below
 * goes through `TAT_HOURS`.
 */
const TAT_HOURS = 96;

/** Offer lifecycle → the bucket the scheduling queue triages by. */
export function offerBucket(offers: JobOffer[] | null | undefined): Bucket {
  const items = offers ?? [];
  if (items.length === 0) return 'unallocated';
  if (items.some((o) => (o.offer_status ?? 0) === 0)) return 'offered';
  return 'no_takers';
}

/*
 * ONE vocabulary for the bucket, shared with the My Orders tab strip: the tab
 * an operator clicked and the state this console reports have to be the same
 * words, or the console reads as a different system.
 */
const TONE: Record<Bucket, {
  wrap: string; icon: string; Icon: typeof Send; title: string; state: string; chip: string;
}> = {
  unallocated: {
    wrap: 'border-info bg-info-tint text-info-strong', icon: 'bg-info text-white', Icon: Send,
    title: 'Offer this job to technicians', state: 'Unallocated',
    chip: 'border-info bg-info-tint text-info-strong',
  },
  offered: {
    wrap: 'border-warning bg-warning-tint text-warning-strong', icon: 'bg-warning text-white', Icon: Clock,
    title: 'Waiting for a technician to accept', state: 'Offered-waiting',
    chip: 'border-warning bg-warning-tint text-warning-strong',
  },
  no_takers: {
    wrap: 'border-urgent bg-urgent-tint text-urgent-strong', icon: 'bg-urgent text-white', Icon: AlertTriangle,
    title: 'No takers — offer to more technicians', state: 'No takers',
    chip: 'border-urgent bg-urgent-tint text-urgent-strong',
  },
};

export function ScheduleAssignUplifted({
  jobId, job, probe, offers, offersLoading, offerable,
  onReschedule, onPickTechnicians, onSaveDetails, onEditServices, onAddressSaved, apiBase,
  actionOverride, technicianOverride, stateOverride, pinnedNotes, onShowNotes,
}: {
  jobId: number | null;
  job: UpliftedJob;
  probe: UpliftedProbe;
  offers: JobOffer[] | null;
  offersLoading?: boolean;
  offerable: boolean;
  onReschedule: () => void;
  /** Scrolls the Top-10 table into view — the table itself stays shared. */
  onPickTechnicians: () => void;
  onSaveDetails?: (patch: { job_desc?: string; efr_special_notes?: string }) => Promise<void>;
  onEditServices?: () => void;
  onAddressSaved?: () => void;
  apiBase: string;
  /*
   * ACCEPTED-JOB SLOTS. The Pending to Start console renders this same layout
   * for a job a technician has already taken; only three things differ from an
   * unallocated job, and they are swapped in rather than forked so the two
   * consoles cannot drift in look: the "what to do now" strip (technician
   * requests / missed slot / today / future instead of the offer bucket), the
   * Technician card (the assigned technician instead of offer replies), and
   * the Current state tile. Omit all three and this is Schedule & Assign.
   */
  actionOverride?: React.ReactNode;
  technicianOverride?: React.ReactNode;
  stateOverride?: { label: string; sub: string; chipClass: string };
  /* Pinned internal notes (from the notes thread below the console), flagged on
     the Job notes card with a jump to them. */
  pinnedNotes?: JobNote[];
  onShowNotes?: () => void;
}) {
  const { me } = useMe();
  const bucket = offerBucket(offers);
  const tone = TONE[bucket];
  const items = offers ?? [];

  /* The technician who took the job. Acceptance is stamped on the OFFER row
     (offer_status 1 + responded_at), not on tbl_job — so the timeline reads it
     from the same offers payload the replies list uses. */
  const accepted = items.find((o) => o.offer_status === 1) ?? null;
  const live = items.filter((o) => (o.offer_status ?? 0) === 0);
  const closed = items.filter((o) => (o.offer_status ?? 0) !== 0);

  const canEditDetails = !!onSaveDetails && hasAction(me, 'isJobEdit');
  const canEditAddress = !!onAddressSaved && hasAction(me, 'isJobEdit');
  const canEditServices = !!onEditServices && hasAction(me, 'isJobEdit');
  const [addressOpen, setAddressOpen] = useState(false);

  const appointment = job?.requested_date_time ?? null;
  const originalAppt = probe?.original_appointment_date_time ?? null;
  /*
   * Compared on the rendered day, not the raw string: the two columns are
   * stamped by different code paths, and what matters to SDA is whether the
   * visit moved to ANOTHER DAY, not whether the timestamps differ.
   */
  const apptDay = appointment ? formatDate(appointment).split(',')[0] : null;
  const origDay = originalAppt ? formatDate(originalAppt).split(',')[0] : null;
  const apptMoved = !!origDay && !!apptDay && origDay !== apptDay;
  /* Past appointment = the job is already late, which moves Reschedule up into
     the action strip. Same predicate the offer button is disabled by. */
  const apptPast = appointmentIsPast(appointment);
  /* Services drive the Top-10 ranking and one is mandatory — see the strip. */
  const noService = !!job && (job.services ?? []).length === 0;
  const blocked = noService || apptPast;

  /*
   * TAT left = the client's window minus the job's age. Uses the SAME ageSecs
   * the list renders, so the countdown cannot disagree with the Age column;
   * falls back to created_date_time only on a payload that predates the field.
   */
  const ageSecs = useMemo(() => {
    if (typeof job?.ageSecs === 'number') return job.ageSecs;
    if (!job?.created_date_time) return null;
    const t = new Date(String(job.created_date_time).replace(' ', 'T')).getTime();
    return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 1000)) : null;
  }, [job?.ageSecs, job?.created_date_time]);
  const tatLeftSecs = ageSecs == null ? null : TAT_HOURS * 3600 - ageSecs;
  const tatLabel = tatLeftSecs == null
    ? '—'
    : tatLeftSecs <= 0
      ? `Overdue by ${hm(-tatLeftSecs)}`
      : hm(tatLeftSecs);
  const tatTone = tatLeftSecs == null ? '' : tatLeftSecs <= 0 ? 'urgent' : tatLeftSecs < 24 * 3600 ? 'warning' : 'success';
  const tatDue = job?.created_date_time
    ? formatDate(new Date(new Date(String(job.created_date_time).replace(' ', 'T')).getTime() + TAT_HOURS * 3600_000).toISOString())
    : '—';

  const media = useMemo(() => {
    const imgs = (probe?.images ?? []).map((raw) => {
      const id = String((raw as Record<string, unknown>).image_id ?? '');
      const cat = String((raw as Record<string, unknown>).image_category ?? '');
      const name = String((raw as Record<string, unknown>).image ?? '');
      return id
        ? { id, kind: 'image' as const, label: name || cat || 'Photo', meta: cat || 'Photo', url: `${apiBase}/admin/jobs/images/${id}/file` }
        : null;
    }).filter(Boolean) as Array<{ id: string; kind: 'image'; label: string; meta: string; url: string }>;
    const vids = (probe?.videos ?? []).map((v) => ({
      id: String(v.media_id), kind: 'video' as const,
      label: `Video ${v.media_id}`, meta: v.source || 'Customer',
      url: `${apiBase}/admin/jobs/videos/${v.media_id}/file`,
    }));
    return [...imgs, ...vids];
  }, [probe?.images, probe?.videos, apiBase]);

  /*
   * FIVE STEPS, each with WHEN and WHO — the two questions asked of a timeline.
   * Every value is a stored column, never derived from another step: "Created"
   * is the client's ticket (raised by their SPOC), "Booked" is the EasyFix user
   * who turned it into a job, "Offered" is the first scheduling push, and the
   * last two are the technician's own actions. A step with no timestamp has not
   * happened; the first such step is the one being waited on.
   */
  const steps: Array<{ name: string; when: string | null; who: string | null }> = [
    { name: 'Created', when: job?.ticket_created_date_time ?? null, who: job?.client_spoc_name || job?.client_spoc || null },
    { name: 'Booked', when: job?.created_date_time ?? null, who: job?.created_by_name ?? null },
    { name: 'Offered', when: job?.original_scheduling_date_time ?? null, who: job?.first_scheduled_by_name ?? null },
    { name: 'Accepted', when: job?.accepted_date_time ?? accepted?.responded_at ?? null, who: job?.accepted_efr_name ?? accepted?.efr_name ?? null },
    { name: 'Check-In', when: job?.checkin_date_time ?? null, who: job?.checkin_by_name ?? null },
  ];
  const firstPending = steps.findIndex((s) => !s.when);
  const escalated = Number(job?.is_escalated ?? 0) === 1;
  const escalations = Number(job?.no_of_escalations ?? 0);

  return (
    <div className="space-y-3">
      {/*
        * What to do now. A PAST APPOINTMENT OVERRIDES THE BUCKET: the server
        * refuses to offer a job whose appointment has gone, and the footer
        * button is disabled to match — so the strip must stop saying "offer
        * this job" beside a button that cannot. It names the blocker and puts
        * Reschedule first; offering comes back the moment there is a future
        * time to offer.
        */}
      {actionOverride ?? (
      <>
      {/*
        * BLOCKERS OUTRANK THE BUCKET, in the order they have to be fixed:
        *   1. no service — a job with nothing to do cannot be ranked (the Top-10
        *      matches technicians on the job's services) or offered, and one
        *      service is mandatory, so this is the first thing to put right;
        *   2. a past appointment — the server refuses to offer it.
        * Only when neither applies does the strip describe the offer bucket.
        */}
      <div className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 ${blocked ? 'border-urgent bg-urgent-tint text-urgent-strong' : tone.wrap}`}>
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${blocked ? 'bg-destructive text-destructive-foreground' : tone.icon}`}>
          {blocked ? <AlertTriangle className="h-4 w-4" /> : <tone.Icon className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {noService ? 'Add a service first — this job has none'
              : apptPast ? 'Reschedule first — this appointment has passed'
                : tone.title}
          </p>
          <p className="text-xs opacity-90">
            {noService
              ? <>Every job needs at least one service. Technicians are matched on it, so it can’t be offered until one is added.</>
              : apptPast
                ? <>The appointment was {appointment ? formatDate(appointment) : 'not set'}. Technicians can’t be offered a job whose time has gone — set a new date and time, then offer.</>
                : <>
                  {bucket === 'unallocated' && <>Appointment {appointment ? formatDate(appointment) : 'not set'} · first technician to accept gets the job</>}
                  {bucket === 'offered' && <>{live.length} of {items.length} still to reply · {closed.length} expired or rejected</>}
                  {bucket === 'no_takers' && <>Expired and rejected: {closed.length} · widen the search or reschedule with the customer</>}
                </>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* One primary action, matching the blocker being named. Reschedule
              appears here only while the appointment is past; otherwise it
              lives under the Appointment tile. */}
          {noService ? (
            canEditServices && (
              <button type="button" onClick={onEditServices} className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90">
                <Plus className="mr-1 inline h-3.5 w-3.5" />Add service
              </button>
            )
          ) : apptPast ? (
            <button type="button" onClick={onReschedule} className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90">
              <CalendarClock className="mr-1 inline h-3.5 w-3.5" />Reschedule now
            </button>
          ) : offerable && (
            <button type="button" onClick={onPickTechnicians} className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90">
              {bucket === 'unallocated' ? 'Choose technicians' : 'Offer to more'}
            </button>
          )}
        </div>
      </div>

      </>
      )}

      {/* ── Timeline + the five status tiles + the job's flat facts ── */}
      <div className="rounded-md border bg-card">
        <div className="px-3 pt-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />Timeline
          </h3>
        </div>
        <div className="overflow-x-auto px-3 pb-3 pt-1">
          <div className="flex min-w-[560px]">
            {steps.map((s, i) => {
              const state = s.when ? 'done' : i === firstPending ? 'now' : 'next';
              return (
                <div key={s.name} className="relative flex flex-1 flex-col items-center gap-1 px-1 text-center">
                  {i > 0 && (
                    <span className={`absolute left-[-50%] top-[7px] h-0.5 w-full ${state === 'next' ? 'bg-border' : 'bg-success'}`} />
                  )}
                  <span className={[
                    'relative z-[1] h-4 w-4 rounded-full border-2',
                    state === 'done' ? 'border-success bg-success'
                      : state === 'now' ? 'border-primary bg-background ring-4 ring-primary/20'
                        : 'border-border bg-background',
                  ].join(' ')} />
                  <span className={`text-xs leading-tight ${state === 'now' ? 'font-semibold text-primary' : state === 'next' ? 'text-muted-foreground' : 'font-medium'}`}>
                    {s.name}
                  </span>
                  <span className="text-xs leading-tight text-muted-foreground">{s.when ? formatDate(s.when) : '—'}</span>
                  {/* WHO, on its own line: a timeline that says when but not by
                      whom sends the next question to a different screen. */}
                  <span className="max-w-[120px] truncate text-xs leading-tight text-muted-foreground" title={s.who || undefined}>
                    {s.who || (state === 'done' ? '—' : '')}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px border-t bg-border lg:grid-cols-5">
          <div className="bg-card px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Job age</p>
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold tabular-nums" title={job ? jobAgeTitle(job) : undefined}>{job ? formatJobAge(job) : '—'}</span>
              {/* An escalated job says so where its age is read — the two facts
                  that decide how urgently it is worked sit together. */}
              {escalated && (
                <span
                  className="inline-flex items-center gap-0.5 rounded-full border border-urgent bg-urgent-tint px-2 py-0.5 text-xs font-medium text-urgent-strong"
                  title={job?.escalated_comments || undefined}
                >
                  <Flame className="h-3 w-3" />Escalated{escalations > 1 ? ` ×${escalations}` : ''}
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {escalated
                ? [job?.escalated_time ? formatDate(job.escalated_time) : null, job?.escalated_by_name ? `by ${job.escalated_by_name}` : null].filter(Boolean).join(' · ') || 'Escalated'
                : 'Since ticket created'}
            </p>
          </div>
          <div className="bg-card px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current state</p>
            <p><span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${stateOverride?.chipClass ?? tone.chip}`}>{stateOverride?.label ?? tone.state}</span></p>
            <p className="text-xs text-muted-foreground">
              {stateOverride ? stateOverride.sub
                : offersLoading ? 'Loading offers…'
                  : bucket === 'unallocated' ? 'Waiting on you'
                    : bucket === 'offered' ? 'Waiting on technicians' : 'Expired and rejected'}
            </p>
          </div>
          <div className="bg-card px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Appointment</p>
            <p className="text-sm font-semibold">{appointment ? formatDate(appointment) : 'Not set'}</p>
            <p className={`text-xs ${apptPast ? 'font-medium text-urgent-strong' : apptMoved ? 'font-medium text-warning-strong' : 'text-muted-foreground'}`}>
              {apptPast
                ? 'Passed · reschedule before offering'
                : apptMoved ? `Original ${formatDate(originalAppt)}` : (displaySlot(job?.requested_date_time, job?.time_slot) || 'Fixed at booking')}
            </p>
            {!apptPast && (
              <button type="button" onClick={onReschedule} className="mt-1.5 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted">
                <CalendarClock className="h-3.5 w-3.5" />Reschedule
              </button>
            )}
          </div>
          <div className="bg-card px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">TAT left</p>
            <p className={`text-sm font-semibold tabular-nums ${tatTone === 'urgent' ? 'text-urgent-strong' : tatTone === 'warning' ? 'text-warning-strong' : tatTone === 'success' ? 'text-success-strong' : ''}`}>
              {tatLabel}
            </p>
            <p className="text-xs text-muted-foreground">of {TAT_HOURS}h · due {tatDue}</p>
          </div>
          <div className="bg-card px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">SDA / OTA</p>
            <p className="flex flex-wrap gap-1">
              <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${apptMoved ? 'border-urgent bg-urgent-tint text-urgent-strong' : 'border-success bg-success-tint text-success-strong'}`}>
                {apptMoved ? 'SDA No' : 'SDA on track'}
              </span>
              <span className="inline-flex rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">OTA pending</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {/* The backend's own rules, stated so nobody has to guess what
                  the chips predict (services/mobile-performance.service.js):
                  SDA = check-in on the ORIGINAL appointment's date;
                  OTA = check-in within 60 min of the appointment time. */}
              {apptMoved
                ? `Check-in on ${formatDate(originalAppt).split(',')[0]} keeps SDA Yes`
                : 'SDA: check-in on this date · OTA: within 60 min of it'}
            </p>
          </div>
        </div>

      </div>

      {/* ── Who it is for, and who has it ──
          Three cards in one row, in the plain label/value style ops preferred:
          Customer, Client, and the Technician card — which is exactly as tall
          as the other two (see its wrapper). On an unallocated job there is
          never a technician, so that card is the offer replies — the list that
          grows (10+ technicians on a hard job) — and it scrolls inside itself. */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card icon={<User className="h-3.5 w-3.5" />} title="Customer">
          {/* Name = tbl_job.job_customer_name when the booking typed one, else
              tbl_customer.customer_name (via tbl_job.fk_customer_id) — the
              list's own expression, so row and console agree. */}
          <Row label="Name" value={job?.customer_name || <NotAdded />} />
          <Row
            label="Mobile"
            value={job?.customer_mob_no
              ? <CallableMobile jobId={job?.job_id} mobile={job.customer_mob_no} />
              : <NotAdded />}
          />
          {/* The ALTERNATE contact the booking captured (tbl_job
              additional_number / additional_name). Dialled through the useAlt
              route, which resolves the number from the job row. */}
          <Row
            label="Alt number"
            value={job?.additional_number
              ? (
                <span className="inline-flex flex-wrap items-center justify-end gap-x-1.5">
                  {job.additional_name && <span className="text-muted-foreground">{job.additional_name}</span>}
                  <CallableMobile jobId={job?.job_id} useAlt mobile={job.additional_number} hideWhenUnauthorized />
                </span>
              )
              : <NotAdded />}
          />
          <Row label="Email" value={job?.customer_email || <NotAdded />} />
          {/* tbl_job.collected_by through the SAME helper the Current tab's Job
              Details grid uses — NOT the BE's `payment_mode`, derived from
              paid_by alone and "Not Set" on ~96% of jobs. */}
          <Row label="Payment" value={collectedByText(job?.collected_by) ?? <NotAdded />} />
          <div className="mt-2 rounded-md border bg-muted/40 px-2.5 py-2 text-xs">
            <div className="flex items-start gap-1.5">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Service address</p>
                <p className="break-words">{job ? formatServiceAddress(job) : '—'}</p>
                {/* City + pin on their own line, larger: the two fields ops read
                    first to judge distance. */}
                <p className="mt-1 text-sm font-semibold">
                  {job?.city_name || '—'}{' '}
                  <span className="font-medium text-muted-foreground">{job?.pin_code || ''}</span>
                </p>
                {/* The zonal manager is decided by the address city
                    (tbl_city.state_user), so it sits with the address. A blank
                    means that city has no owner set. */}
                <p className="mt-0.5">
                  <span className="text-muted-foreground">Zonal manager </span>
                  {job?.zonal_manager_name
                    ? <span className="font-medium">{job.zonal_manager_name}</span>
                    : <span className="text-muted-foreground" title="tbl_city.state_user is not set for this job's city">Not set for this city</span>}
                </p>
              </div>
              {canEditAddress && (
                <button type="button" onClick={() => setAddressOpen(true)} className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium hover:bg-background">
                  <Pencil className="mr-1 inline h-3 w-3" />Edit
                </button>
              )}
            </div>
          </div>
        </Card>

        <ClientCard job={job} jobReference={probe?.job_reference_id ?? null} />

        {/*
          * EXACTLY AS TALL AS CUSTOMER AND CLIENT on a wide screen. The wrapper
          * is a grid item, so it stretches to the row — whose height those two
          * cards alone set, because the card inside is taken out of flow
          * (absolute, inset-0). The card fills it and its list scrolls in
          * whatever height is left, so 3 offers or 30 never change the page.
          * Stacked (narrow) it is an ordinary card with a capped list.
          */}
        <div className="relative">
        {technicianOverride ? (
          <Card icon={<Wrench className="h-3.5 w-3.5" />} title="Technician" className="lg:absolute lg:inset-0 lg:overflow-y-auto">
            {technicianOverride}
          </Card>
        ) : (
          <Card
            icon={<Send className="h-3.5 w-3.5" />}
            title="Offer replies"
            count={items.length}
            action={<span className="text-xs text-muted-foreground">{live.length} waiting · {closed.length} closed</span>}
            className="flex flex-col lg:absolute lg:inset-0"
          >
            {items.length === 0 ? (
              <p className="rounded-md border border-dashed px-2.5 py-3 text-center text-xs text-muted-foreground">
                No offers sent yet. The first technician to accept is assigned.
              </p>
            ) : (
              /* Fills the card's remaining height and scrolls. Waiting replies
                 first — they are the ones that can still change. */
              <ul className="max-h-80 min-h-0 flex-1 divide-y overflow-y-auto pr-1 lg:max-h-none">
                {[...live, ...closed].map((o) => (
                  <li key={o.efr_id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{o.efr_name}</span>
                      <span className="block text-xs text-muted-foreground">
                        Efr #{o.efr_id} · {relativeTime(o.offered_at)}
                        {(o.offer_count ?? 0) > 1 ? ` · offered ×${o.offer_count}` : ''}
                        {o.reject_reason ? ` · ${o.reject_reason}` : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-start gap-1.5">
                      <span className="flex flex-col items-end gap-0.5">
                        <span className={[
                          'rounded-full border px-2 py-0.5 text-xs font-medium',
                          (o.offer_status ?? 0) === 0 ? 'border-warning bg-warning-tint text-warning-strong'
                            : o.offer_status === 2 ? 'border-urgent bg-urgent-tint text-urgent-strong'
                              : 'border-border bg-muted text-muted-foreground',
                        ].join(' ')}>
                          {o.offer_status_label || ((o.offer_status ?? 0) === 0 ? 'Waiting' : 'Closed')}
                        </span>
                        {/* WHY it closed, under the chip. "Expired" alone reads as
                            "nobody answered" — but an offer also expires the moment
                            the job is rescheduled, reoffered or taken by someone
                            else. */}
                        {(o.offer_status ?? 0) !== 0 && o.closed_reason_label && (
                          <span className="text-xs text-muted-foreground">{o.closed_reason_label}</span>
                        )}
                      </span>
                      {/* Click-to-call the technician, without leaving the console. */}
                      <CallableMobile efrId={o.efr_id} jobContextId={jobId ?? undefined} mobile={o.mobile} iconOnly />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        </div>
      </div>

      {/* ── What the job is: services and notes, side by side ── */}
      <div className="grid gap-3 lg:grid-cols-[3fr_2fr]">
        <Card
          icon={<Box className="h-3.5 w-3.5" />}
          title={job?.job_type || 'Services'}
          count={job?.services?.length ?? 0}
          action={canEditServices ? (
            <button type="button" onClick={onEditServices} className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted">
              <Pencil className="mr-1 inline h-3 w-3" />Edit
            </button>
          ) : undefined}
        >
          {!job?.services?.length ? (
            <div className="rounded-md border border-urgent bg-urgent-tint px-3 py-2 text-xs text-urgent-strong">
              <p className="font-medium">No service on this job.</p>
              <p>At least one service is required before it can be offered.</p>
              {canEditServices && (
                <button type="button" onClick={onEditServices} className="mt-1.5 rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:opacity-90">
                  <Plus className="mr-1 inline h-3.5 w-3.5" />Add service
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Service</th>
                    <th className="py-1 pr-3 font-medium">Type</th>
                    <th className="py-1 pr-3 text-right font-medium">Qty</th>
                    <th className="py-1 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {job.services.map((s, i) => (
                    <tr key={i} className="border-t border-border/60 align-top">
                      <td className="py-1 pr-3">
                        <span className="block font-medium">{s.service_name || '—'}</span>
                        <span className="block text-muted-foreground">{s.service_catg || '—'}</span>
                      </td>
                      <td className="py-1 pr-3">{s.service_type || '—'}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{s.quantity ?? '—'}</td>
                      <td className="py-1 text-right tabular-nums">{lineTotal(s) == null ? '—' : `₹${Number(lineTotal(s)).toLocaleString('en-IN')}`}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t font-semibold">
                    <td className="py-1 pr-3" colSpan={3}>Total</td>
                    <td className="py-1 text-right tabular-nums">
                      ₹{job.services.reduce((n, s) => n + Number(lineTotal(s) ?? 0), 0).toLocaleString('en-IN')}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>

        <JobNotesCard job={job} canEdit={canEditDetails} onSave={onSaveDetails} pinnedNotes={pinnedNotes} onShowNotes={onShowNotes} />
      </div>

      {/* ── What was attached — one full-width row ── */}
      <MediaCard media={media} />

      {addressOpen && job && (
        <JobAddressEditDialog
          job={job as unknown as Parameters<typeof JobAddressEditDialog>[0]['job']}
          onClose={() => setAddressOpen(false)}
          onSaved={() => { setAddressOpen(false); onAddressSaved?.(); }}
        />
      )}
    </div>
  );
}

/*
 * Attachments as ONE full-width row of small tiles, at the bottom of the
 * console: they are looked at once, not worked from, so they no longer take a
 * column beside services and notes. When the row overflows it scrolls, with
 * arrows for the trackpad-less — shown only when there is somewhere to scroll.
 */
function MediaCard({ media }: {
  media: Array<{ id: string; kind: 'image' | 'video'; label: string; meta: string; url: string }>;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) { setOverflows(false); return; }
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [media.length]);
  const nudge = (dir: -1 | 1) => stripRef.current?.scrollBy({ left: dir * 320, behavior: 'smooth' });

  return (
    <Card
      icon={<ImageIcon className="h-3.5 w-3.5" />}
      title="Photos and videos"
      count={media.length}
      action={overflows ? (
        <span className="flex items-center gap-1">
          <button type="button" aria-label="Scroll attachments left" onClick={() => nudge(-1)} className="rounded-md border px-1.5 py-1 hover:bg-muted">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Scroll attachments right" onClick={() => nudge(1)} className="rounded-md border px-1.5 py-1 hover:bg-muted">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </span>
      ) : undefined}
    >
      {media.length === 0 ? (
        <p className="text-xs text-muted-foreground">No image attached.</p>
      ) : (
        <div ref={stripRef} className="flex gap-2 overflow-x-auto pb-1">
          {media.map((m) => (
            <a
              key={`${m.kind}-${m.id}`}
              href={m.url}
              target="_blank"
              rel="noreferrer"
              className="group w-20 shrink-0"
              title={`${m.label} · ${m.meta}`}
            >
              <span className="grid h-14 w-20 place-items-center overflow-hidden rounded-md border bg-muted/40 group-hover:border-foreground/30">
                {m.kind === 'video'
                  ? <Video className="h-4 w-4 text-warning-strong" />
                  : /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={m.url} alt={m.label} className="h-14 w-20 object-cover" loading="lazy" />}
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground group-hover:text-foreground">{m.label}</span>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}

/*
 * A service line's amount = price × quantity. tbl_job_services.total_charge is
 * the ONE-UNIT price by design (every writer stores it that way; total_cost is
 * the line total), so showing it as the line amount made a qty-2 line read
 * ₹1,000 here and ₹2,000 in Edit Services. Prefer the server's `line_total`;
 * fall back to unit × qty for a payload that predates it.
 */
function lineTotal(s: JobServiceRow & { line_total?: number | null; unit_price?: number | null }): number | null {
  if (s.line_total != null) return Number(s.line_total);
  const unit = s.unit_price ?? s.total_charge;
  if (unit == null) return null;
  return Number(unit) * Number(s.quantity ?? 1);
}

/* Seconds → "93h 07m" / "2d 3h" in the same compact units as the Age column. */
function hm(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h >= 1 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/*
 * The two technician-facing notes, editable in place. Calls the SAME
 * onSaveDetails the Current tab's panel calls (PATCH /admin/jobs/:id, then a
 * re-rank), so a note saved here and a note saved there are one code path.
 */
function JobNotesCard({ job, canEdit, onSave, pinnedNotes, onShowNotes }: {
  job: UpliftedJob;
  canEdit: boolean;
  onSave?: (patch: { job_desc?: string; efr_special_notes?: string }) => Promise<void>;
  pinnedNotes?: JobNote[];
  onShowNotes?: () => void;
}) {
  const pinned = pinnedNotes ?? [];
  const [desc, setDesc] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  // Re-seed when the job payload changes (open, re-rank, reschedule) — but
  // never mid-edit: the key is the SERVER's value pair, so a re-render with the
  // same values leaves a half-typed note alone.
  const seed = `${job?.job_desc ?? ''}|${job?.efr_special_notes ?? ''}`;
  useEffect(() => {
    setDesc(job?.job_desc ?? '');
    setNotes(job?.efr_special_notes ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const dirty = desc !== (job?.job_desc ?? '') || notes !== (job?.efr_special_notes ?? '');

  async function save() {
    if (!onSave || !dirty) return;
    setSaving(true);
    try {
      await onSave({ job_desc: desc, efr_special_notes: notes });
      /*
       * Back to the START of both boxes once saved. They are fixed-height and
       * scroll, so after editing the end of a long description the box was left
       * showing its last lines — and the operator re-reading "what did I just
       * save" landed mid-paragraph. The top is where a description is read from.
       */
      if (descRef.current) descRef.current.scrollTop = 0;
      if (notesRef.current) notesRef.current.scrollTop = 0;
      showToast({ variant: 'success', message: 'Job Notes Saved.' });
    } catch (e) {
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Failed to save job notes' }) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      icon={<FileText className="h-3.5 w-3.5" />}
      title="Job notes"
      action={(pinned.length > 0 || canEdit) ? (
        <span className="flex items-center gap-1.5">
          {/* A pinned internal note is something the next person must not
              miss — flag it here, where the job is read, and jump to it. */}
          {pinned.length > 0 && (
            <button
              type="button"
              onClick={onShowNotes}
              title={pinned[0]?.notes}
              className="inline-flex items-center gap-1 rounded-full border border-gold bg-gold-tint px-2 py-0.5 text-xs font-medium text-gold-strong hover:bg-gold-tint/70"
            >
              <Pin className="h-3 w-3" />{pinned.length} pinned {pinned.length === 1 ? 'note' : 'notes'}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </span>
      ) : undefined}
    >
      <div className="space-y-2">
        {pinned[0] && (
          <p className="line-clamp-2 rounded-md border border-gold bg-gold-tint px-2 py-1.5 text-xs text-ink-900" title={pinned[0].notes}>
            <Pin className="mr-1 inline h-3 w-3 text-gold-strong" />{pinned[0].notes}
          </p>
        )}
        <div>
          <label htmlFor="up-jd" className="text-xs font-medium">Job description</label>
          <textarea
            id="up-jd"
            ref={descRef}
            value={desc}
            maxLength={5000}
            disabled={!canEdit || saving}
            onChange={(e) => setDesc(e.target.value)}
            className="mt-1 h-16 max-h-40 w-full resize-y overflow-auto rounded-md border bg-background px-2 py-1.5 text-xs"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Technician and client see this</span><span className="tabular-nums">{desc.length} / 5000</span>
          </div>
        </div>
        <div>
          <label htmlFor="up-si" className="text-xs font-medium">Special instructions for technician</label>
          <textarea
            id="up-si"
            ref={notesRef}
            value={notes}
            maxLength={2000}
            disabled={!canEdit || saving}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 h-16 max-h-40 w-full resize-y overflow-auto rounded-md border bg-background px-2 py-1.5 text-xs"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Technician app only</span><span className="tabular-nums">{notes.length} / 2000</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

/*
 * The Client card — plain label/value rows like the Customer card beside it,
 * in three runs separated by a small heading:
 *   (client)          what the client sent — name, vertical, source, reference,
 *                     branch, helper — and who at the client to call (SPOC)
 *   EASYFIX           who at EasyFix owns it: the job's current owner
 *                     (tbl_job.job_owner) and the client's Primary / Secondary
 *                     SPOC (tbl_vertical_mapping user_type 1 / 2)
 *   CUSTOM PROPERTIES only the ones this job carries; the run is omitted when
 *                     there are none, since their number varies by client
 *
 * LOGO: nothing in this CRM stores a readable client logo (tbl_client.logo_id
 * has no upload or file route), so the mark is the client's initials until one
 * exists — a stable placeholder, not a fake image.
 */
function ClientCard({ job, jobReference }: { job: UpliftedJob; jobReference: string | null }) {
  const name = job?.client_name || '';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  const props = [
    ['Property / Building', job?.building_name ?? null] as [string, string | null],
    ['Product code', job?.product_code ?? null] as [string, string | null],
    ...((job?.custom_properties ?? []).map((p): [string, string | null] => [
      String(p.label || p.name || 'Property'),
      p.value == null || String(p.value).trim() === '' ? null : String(p.value),
    ])),
  ].filter((e): e is [string, string] => !!e[1]);
  const helper = job?.helper_req == null ? <NotAdded /> : Number(job.helper_req) === 1 ? 'Yes' : 'No';

  return (
    <Card icon={<Building2 className="h-3.5 w-3.5" />} title="Client">
      <Row
        label="Client"
        value={name ? (
          <span className="inline-flex items-center gap-1.5">
            {initials && (
              <span
                className="grid h-6 w-6 shrink-0 place-items-center rounded border border-info bg-info-tint text-xs font-semibold text-info-strong"
                title="Client logo is not stored in this CRM yet"
                aria-hidden
              >
                {initials}
              </span>
            )}
            {name}
          </span>
        ) : <NotAdded />}
      />
      <Row label="Vertical" value={job?.vertical_name || <NotAdded />} />
      <Row label="Source" value={job?.source_type || <NotAdded />} />
      <Row label="Client ref ID" value={job?.client_ref_id || <NotAdded />} />
      <Row label="Job ref" value={jobReference || <NotAdded />} />
      <Row label="Branch ID" value={job?.branch_details || <NotAdded />} />
      <Row label="Helper needed" value={helper} />
      <Row label="SPOC" value={job?.client_spoc_name || <NotAdded />} />
      <Row
        label="SPOC phone"
        value={job?.client_spoc
          ? <CallableMobile spocJobId={job?.job_id} mobile={job.client_spoc} />
          : <NotAdded />}
      />
      <Row label="SPOC email" value={job?.client_spoc_email || <NotAdded />} />

      <SubHeading>EasyFix</SubHeading>
      <Row label="Job owner" value={job?.owner_name || <NotAdded />} />
      <Row label="Primary SPOC" value={job?.client_primary_spoc_name || <NotAdded />} />
      <Row label="Secondary SPOC" value={job?.client_secondary_spoc_name || <NotAdded />} />

      {props.length > 0 && (
        <>
          <SubHeading>Custom properties</SubHeading>
          {props.map(([label, value]) => <Row key={label} label={label} value={value} />)}
        </>
      )}
    </Card>
  );
}

/* A run heading inside a card. No rule of its own: the next Row's top rule
   already separates the heading from its first value. */
function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

/* The empty value, said the same way on every row. */
function NotAdded() {
  return <span className="font-normal text-muted-foreground">Not added</span>;
}

function Card({ icon, title, count, action, className, children }: {
  icon: React.ReactNode; title: string; count?: number; action?: React.ReactNode; className?: string; children: React.ReactNode;
}) {
  return (
    <section className={`rounded-md border bg-card p-3 ${className ?? ''}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {icon}{title}
          {/* A count is a chip, never part of the title text. */}
          {count != null && (
            <span className="inline-flex min-w-[1.5rem] justify-center rounded-full border bg-muted px-1.5 py-0.5 text-xs font-medium normal-case tracking-normal tabular-nums">
              {count}
            </span>
          )}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-t py-1.5 text-xs first:border-t-0 first:pt-0">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-medium">{value}</span>
    </div>
  );
}
