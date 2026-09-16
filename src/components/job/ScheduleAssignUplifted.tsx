'use client';

import { useMemo } from 'react';
import {
  Send, Clock, AlertTriangle, CalendarClock, User, Building2, Wrench, MapPin, Image as ImageIcon, Video,
} from 'lucide-react';
import type { JobOffer } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/utils';
import { formatJobAge, jobAgeTitle } from '@/lib/job-age';
import { displaySlot } from '@/lib/job-slots';
import { CallableMobile } from '@/components/calls/CallButton';

/*
 * ScheduleAssignUplifted — the "Uplifted" tab of Schedule & Assign.
 *
 * WHAT IT IS: a re-presentation of the SAME job, offers and actions the Current
 * tab shows, arranged the way the queue is actually worked — what to do now at
 * the top, then when it happened, then who it is for, then who it was offered
 * to. It owns NO data fetching and NO mutations: the modal remains the single
 * owner of both, so the two tabs can never diverge in behaviour, only in layout.
 *
 * WHAT IT DELIBERATELY DOES NOT DUPLICATE: services, job notes, address and
 * remarks (with their editors) stay in <JobContextPanel>, which the modal keeps
 * rendering underneath this in the Uplifted tab — one implementation of every
 * edit, reachable from either tab.
 *
 * PHASE 1 scope (unallocated jobs): Not offered · Offered-waiting · No takers.
 * Accepted-job states (technician reschedule/cancel requests, missed
 * appointment, change technician, live location) are phase 2 and are not
 * modelled here — this modal only ever opens on a booked, unassigned job.
 */

type Bucket = 'not_offered' | 'offered' | 'no_takers';

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
} | null;

export type UpliftedProbe = {
  job_reference_id?: string | null;
  /*
   * The appointment as first booked. Stamped on tbl_job and already projected
   * by GET /admin/jobs/:id (the View modal reads the same two columns), so a
   * rescheduled job can still be judged against the date the customer was
   * originally promised — which is exactly what SDA is scored on.
   */
  original_appointment_date_time?: string | null;
  original_appointment_time?: string | null;
  images?: Array<Record<string, unknown>> | null;
  videos?: Array<{ media_id: number; content_type?: string | null; source?: string | null; created_at?: string | null }> | null;
} | null;

/** Offer lifecycle → the bucket the scheduling queue triages by. */
export function offerBucket(offers: JobOffer[] | null | undefined): Bucket {
  const items = offers ?? [];
  if (items.length === 0) return 'not_offered';
  if (items.some((o) => (o.offer_status ?? 0) === 0)) return 'offered';
  return 'no_takers';
}

const TONE: Record<Bucket, { wrap: string; icon: string; Icon: typeof Send; title: string }> = {
  not_offered: {
    wrap: 'border-info bg-info-tint text-info-strong', icon: 'bg-info text-white', Icon: Send,
    title: 'Offer this job to technicians',
  },
  offered: {
    wrap: 'border-warning bg-warning-tint text-warning-strong', icon: 'bg-warning text-white', Icon: Clock,
    title: 'Waiting for a technician to accept',
  },
  no_takers: {
    wrap: 'border-danger bg-danger-tint text-danger-strong', icon: 'bg-danger text-white', Icon: AlertTriangle,
    title: 'Nobody accepted — offer to more technicians',
  },
};

export function ScheduleAssignUplifted({
  job, probe, offers, offersLoading, offerable, onReschedule, onPickTechnicians, apiBase,
}: {
  job: UpliftedJob;
  probe: UpliftedProbe;
  offers: JobOffer[] | null;
  offersLoading?: boolean;
  offerable: boolean;
  onReschedule: () => void;
  /** Scrolls the Top-10 table into view — the table itself stays shared. */
  onPickTechnicians: () => void;
  apiBase: string;
}) {
  const bucket = offerBucket(offers);
  const tone = TONE[bucket];
  const items = offers ?? [];

  const live = items.filter((o) => (o.offer_status ?? 0) === 0);
  const declined = items.filter((o) => o.offer_status === 2);
  const expired = items.filter((o) => o.offer_status === 3);

  const appointment = job?.requested_date_time ?? null;
  const originalAppt = probe?.original_appointment_date_time ?? null;
  /*
   * Only worth showing when it DIFFERS from the appointment on the job — on a
   * never-rescheduled order the two are the same timestamp and a second line
   * saying so is noise. Compared on the rendered day+time, not the raw string,
   * because the two columns are stamped by different code paths.
   */
  const apptMoved = !!originalAppt && !!appointment && formatDate(originalAppt) !== formatDate(appointment);

  const media = useMemo(() => {
    const imgs = (probe?.images ?? []).map((raw) => {
      const id = String((raw as Record<string, unknown>).image_id ?? '');
      const cat = String((raw as Record<string, unknown>).image_category ?? '');
      return id ? { id, kind: 'image' as const, label: cat || 'Photo', url: `${apiBase}/admin/jobs/images/${id}/file` } : null;
    }).filter(Boolean) as Array<{ id: string; kind: 'image'; label: string; url: string }>;
    const vids = (probe?.videos ?? []).map((v) => ({
      id: String(v.media_id), kind: 'video' as const, label: v.source || 'Video',
      url: `${apiBase}/admin/jobs/videos/${v.media_id}/file`,
    }));
    return [...imgs, ...vids];
  }, [probe?.images, probe?.videos, apiBase]);

  const steps: Array<{ name: string; when: string; state: 'done' | 'now' | 'next' }> = [
    { name: 'Created', when: job?.created_date_time ? formatDate(job.created_date_time) : '—', state: 'done' },
    { name: 'Appointment', when: originalAppt ? formatDate(originalAppt) : appointment ? formatDate(appointment) : '—', state: 'done' },
    { name: 'Offered', when: items.length ? relativeTime(items[items.length - 1].offered_at) : '—', state: items.length ? 'done' : 'now' },
    { name: 'Accepted', when: '—', state: items.length ? 'now' : 'next' },
    { name: 'Check-in', when: '—', state: 'next' },
    { name: 'Audit', when: '—', state: 'next' },
    { name: 'Closed', when: '—', state: 'next' },
    { name: 'QC', when: '—', state: 'next' },
  ];

  return (
    <div className="space-y-4">
      {/* ── What to do now: one line, because the bucket already says it ── */}
      <div className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 ${tone.wrap}`}>
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md ${tone.icon}`}>
          <tone.Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{tone.title}</p>
          <p className="text-xs opacity-90">
            {bucket === 'not_offered' && <>Appointment {appointment ? formatDate(appointment) : 'not set'} · offers stay open 48h</>}
            {bucket === 'offered' && <>{live.length} waiting · {declined.length} declined · {expired.length} expired</>}
            {bucket === 'no_takers' && <>{declined.length} declined · {expired.length} expired · widen the search or reschedule with the customer</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onReschedule} className="rounded-md border border-current/30 bg-white/70 px-2.5 py-1 text-xs font-medium hover:bg-white">
            <CalendarClock className="mr-1 inline h-3.5 w-3.5" />Reschedule
          </button>
          {offerable && (
            <button type="button" onClick={onPickTechnicians} className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-white hover:opacity-90">
              {bucket === 'not_offered' ? 'Choose technicians' : 'Offer to more'}
            </button>
          )}
        </div>
      </div>

      {/* ── Timeline: horizontal, so the history costs one row, not a column ── */}
      <div className="rounded-md border">
        <div className="flex items-center justify-between px-3 pt-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Timeline</h3>
          {originalAppt && (
            <span className="text-xs text-muted-foreground">
              Original appointment <strong className="text-foreground">{formatDate(originalAppt)}</strong>
              {probe?.original_appointment_time ? ` · ${probe.original_appointment_time}` : ''}
            </span>
          )}
        </div>
        <div className="overflow-x-auto px-3 pb-3 pt-1">
          <div className="flex min-w-[640px]">
            {steps.map((s, i) => (
              <div key={s.name} className="relative flex flex-1 flex-col items-center gap-1 px-1 text-center">
                {i > 0 && (
                  <span className={`absolute left-[-50%] top-[7px] h-0.5 w-full ${s.state === 'next' ? 'bg-border' : 'bg-success'}`} />
                )}
                <span className={[
                  'relative z-[1] h-4 w-4 rounded-full border-2',
                  s.state === 'done' ? 'border-success bg-success'
                    : s.state === 'now' ? 'border-primary bg-background ring-4 ring-primary/20'
                      : 'border-border bg-background',
                ].join(' ')} />
                <span className={`text-[11px] leading-tight ${s.state === 'now' ? 'font-semibold text-primary' : s.state === 'next' ? 'text-muted-foreground' : 'font-medium'}`}>
                  {s.name}
                </span>
                <span className="text-[10px] leading-tight text-muted-foreground">{s.when}</span>
              </div>
            ))}
          </div>
        </div>
        {/* Status tiles — one row, same card, so the band costs no extra scroll. */}
        <div className="grid grid-cols-2 gap-px border-t bg-border sm:grid-cols-4">
          <Tile label="Job age" value={job ? formatJobAge(job) : '—'} title={job ? jobAgeTitle(job) : undefined} sub="Since ticket created" />
          <Tile
            label="Current state"
            value={bucket === 'not_offered' ? 'Not offered' : bucket === 'offered' ? 'Offered · waiting' : 'No takers'}
            sub={offersLoading ? 'Loading offers…' : `${items.length} technician${items.length === 1 ? '' : 's'} offered`}
          />
          <Tile
            label="Appointment"
            value={appointment ? formatDate(appointment) : 'Not set'}
            sub={apptMoved
              ? `Original ${formatDate(originalAppt)}`
              : (displaySlot(job?.requested_date_time, job?.time_slot) || 'Fixed at booking')}
            subStrong={apptMoved}
          />
          <Tile label="Offer replies" value={`${live.length} waiting`} sub={`${declined.length} declined · ${expired.length} expired`} />
        </div>
      </div>

      {/* ── Who it is for, and who has it ── */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card icon={<User className="h-3.5 w-3.5" />} title="Customer">
          <Row label="Name" value={job?.customer_name || '—'} />
          <Row
            label="Mobile"
            value={job?.customer_mob_no
              ? <CallableMobile jobId={job?.job_id ?? undefined} mobile={job.customer_mob_no} />
              : '—'}
          />
          <Row label="Job type" value={job?.job_type || '—'} />
          <Row label="Payment" value={job?.payment_mode || '—'} />
          <div className="mt-2 rounded-md border bg-muted/40 px-2.5 py-2 text-xs">
            <div className="flex items-start gap-1.5">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="break-words">{job?.address || 'No address'}</p>
                {/* City + pin on their own line, larger: the two fields ops read
                    first to judge distance were buried at the end of the address. */}
                <p className="mt-1 text-sm font-semibold">
                  {job?.city_name || '—'} <span className="font-medium text-muted-foreground">{job?.pin_code || ''}</span>
                </p>
              </div>
            </div>
          </div>
        </Card>

        <Card icon={<Building2 className="h-3.5 w-3.5" />} title="Client">
          <Row label="Client" value={job?.client_name || '—'} />
          <Row label="Client ref ID" value={job?.client_ref_id || '—'} />
          <Row label="SPOC" value={job?.client_spoc_name || job?.client_spoc || '—'} />
          <Row label="Job ref" value={probe?.job_reference_id || '—'} />
          <Row label="Booked by" value={job?.created_by_name || '—'} />
        </Card>

        <Card icon={<Wrench className="h-3.5 w-3.5" />} title="Technician">
          {/* No technician exists on an unallocated job — the box states that and
              then spends its space on the offer replies, which is the only
              technician information this bucket has. */}
          <div className="mb-2 rounded-md border border-dashed bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground">
            Not assigned. The first technician to accept appears here with their photo, Efr ID and phone.
          </div>
          {items.length === 0 ? (
            <p className="rounded-md border border-dashed px-2.5 py-2 text-center text-xs text-muted-foreground">
              No offers sent yet.
            </p>
          ) : (
            <ul className="divide-y">
              {[...live, ...declined, ...expired].map((o) => (
                <li key={o.efr_id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{o.efr_name}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {relativeTime(o.offered_at)}
                      {(o.offer_count ?? 0) > 1 ? ` · offered ×${o.offer_count}` : ''}
                      {o.reject_reason ? ` · ${o.reject_reason}` : ''}
                    </span>
                  </span>
                  <span className={[
                    'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                    (o.offer_status ?? 0) === 0 ? 'border-warning bg-warning-tint text-warning-strong'
                      : o.offer_status === 2 ? 'border-danger bg-danger-tint text-danger-strong'
                        : 'border-border bg-muted text-muted-foreground',
                  ].join(' ')}>
                    {o.offer_status_label || ((o.offer_status ?? 0) === 0 ? 'Waiting' : 'Closed')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ── Photos and videos attached when the job was created ── */}
      <div className="rounded-md border p-3">
        <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ImageIcon className="h-3.5 w-3.5" />Photos and videos
          <span className="font-mono text-[11px] normal-case tracking-normal">{media.length}</span>
        </h3>
        {media.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
            Nothing was attached to this order.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {media.map((m) => (
              <a
                key={`${m.kind}-${m.id}`}
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="group w-24 overflow-hidden rounded-md border bg-muted/40 hover:border-foreground/30"
                title={m.label}
              >
                <span className="grid h-16 w-full place-items-center bg-background">
                  {m.kind === 'video'
                    ? <Video className="h-5 w-5 text-muted-foreground" />
                    : /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={m.url} alt={m.label} className="h-16 w-full object-cover" loading="lazy" />}
                </span>
                <span className="block truncate px-1.5 py-1 text-[11px] text-muted-foreground group-hover:text-foreground">{m.label}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, title, subStrong }: {
  label: string; value: string; sub?: string; title?: string; subStrong?: boolean;
}) {
  return (
    <div className="bg-background px-3 py-2" title={title}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
      {sub && <p className={`text-[11px] ${subStrong ? 'font-medium text-warning-strong' : 'text-muted-foreground'}`}>{sub}</p>}
    </div>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border p-3">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}{title}
      </h3>
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
