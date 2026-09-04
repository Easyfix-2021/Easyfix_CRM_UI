'use client';

/*
 * JobContextPanel — the rich, read-only job-context scaffolding shown ABOVE the
 * technician-picking table in BOTH the Schedule & Assign and the Assign /
 * Reassign Technician modals.
 *
 * Extracted (2026-07-28) from ScheduleAssignModal so the two surfaces present
 * IDENTICAL job / services / remarks information — the only difference being
 * that Reassign highlights the currently-assigned technician's row (handled by
 * the shared CandidateTable's `is_current` amber row, NOT here).
 *
 * It renders, as a fragment (so a host's `space-y-*` still applies between the
 * two blocks as if they were written inline):
 *
 *   1. A collapsible **Job Details** card — customer / client / SPOC / address
 *      grid, the free-text Job Description + Additional Comments, the per-service
 *      **Services** table with the Job-Skill-Matrix columns, and a read-only
 *      schedule row (Job Date & Time · Time Slot).
 *   2. The **Remarks / Comments** thread (<JobRemarksView>, collapsed by default).
 *
 * Schedule-only extras are opt-in flags so Reassign can omit them:
 *   - `showReschedule` + `onReschedule` — the Reschedule button + "date is
 *     locked" helper text (Schedule & Assign only).
 *   - `rescheduling` — veils the schedule row with an "Updating…" spinner while
 *     a post-reschedule refetch is in flight (Schedule & Assign only).
 *   - `onSaveDetails` — makes Job Description + Additional Comments EDITABLE
 *     in place (Schedule & Assign only). Absent ⇒ both stay read-only, so
 *     every other consumer is untouched.
 *
 * This component is PURELY PRESENTATIONAL for the job object: the host owns the
 * candidates fetch (the `/candidates` response carries `job`) and passes the
 * resolved job down, so the host's reschedule/refetch lifecycle stays exactly
 * where it was. Only <JobRemarksView> fetches its own comment thread (as it
 * always did); pass a changing `remarksReloadKey` to remount it after a
 * reschedule.
 */

import { useEffect, useState } from 'react';
import {
  MapPin, Calendar, Loader2, Clock, ChevronDown, Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/ui/toast';
import { formatApiError } from '@/lib/api-errors';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { formatServiceAddress } from '@/lib/format';
import { formatDate, appointmentIsPast } from '@/lib/utils';
import { displaySlot } from '@/lib/job-slots';
import { CallableMobile } from '@/components/calls/CallButton';
import { StatusChip } from '@/components/ui/StatusChip';
import { JobRemarksView } from './JobRemarksView';
/* The SAME dialog the job detail modal and the Unconfirmed transaction view
   open, so Edit Address behaves identically wherever ops reach it. Importing
   it here does NOT create a cycle: JobModal has no import of this panel. */
import { JobAddressEditDialog } from './JobModal';

export type JobServiceRow = {
  service_name: string | null;
  service_catg: string | null;
  service_type: string | null;
  quantity: number | null;
  total_charge: number | null;
  /**
   * Free/Paid for THIS service line. Derived BE-side in job.service.js getById
   * from `effective_charge` (null/0 → Free, else Paid) using the same rule as
   * the customer job-completion form, so both surfaces always agree.
   * NOT the same thing as the job-level `collected_by` (who collects).
   */
  billing_label?: 'Free' | 'Paid' | null;
  /**
   * Deep skill(s) the Job Skill Matrix (tbl_service_skill_mapping, built from
   * the Admin Action) says THIS service requires. A service legitimately maps
   * to SEVERAL skills — the matrix stores one row per (service, skill) pair —
   * so this is an array and every entry is rendered. An EMPTY array (or an
   * absent field on an older BE) means the matrix holds no mapping for this
   * service, which is what the "—" in the Job Skill column means.
   *
   * Display-only: candidate matching does NOT use this yet.
   */
  job_skills?: { deep_skill_id: number; deepskill_name: string | null; confidence: string | number | null; source?: string | null }[];
  /**
   * Highest `confidence` among `job_skills`. Typed to allow string because the
   * column is DECIMAL(3,2) and mysql2 returns decimals verbatim as strings
   * ('0.90' / '0.00') — passed through unformatted so this reads identically to
   * the Confidence column on the Skill Matrix page. `null` ⇒ no mapping (or the
   * matrix recorded no confidence); a real 0 arrives as '0.00', never null, so
   * the two can't be confused.
   */
  job_skill_score?: string | number | null;
};

/*
 * The subset of the BE's enriched job object this panel renders. Both hosts'
 * candidates responses carry the full object; each declares its own richer job
 * type and passes it here (structurally assignable — this shape is a subset).
 */
export type JobContextData = {
  job_id: number;
  customer_name?: string | null;
  customer_mob_no?: string | null;
  client_name?: string | null;
  client_ref_id?: string | null;
  address?: string | null;
  city_name?: string | null;
  client_spoc?: string | null;
  client_spoc_name?: string | null;
  created_by_name?: string | null;
  created_date_time?: string | null;
  job_type?: string | null;
  /**
   * tbl_job.product_quantity — how many units the CLIENT asked for on the
   * booking. Written by the legacy Bulk Upload and Dashboard stacks (16,372 of
   * 16,395 uploaded jobs carry it); every other source leaves it NULL, which is
   * why ReadField's em-dash is the right rendering rather than a hidden field.
   *
   * Already on the wire: the job detail query is `SELECT j.*`, so this needed
   * no backend change — it was returned and simply never read.
   */
  product_quantity?: number | null;
  payment_mode?: string | null;
  requested_date_time?: string | null;
  /**
   * The stored appointment window (tbl_job.time_slot). Every current write path
   * maintains it — the Confirm & Schedule modal, `reschedule()`, and the
   * WhatsApp confirmation flow (whatsapp-conversation.service finaliseConfirmed
   * → jml.writeCustomerOrderDetails) — but always through `resolveTimeSlot`,
   * which RE-DERIVES it from `requested_date_time`.
   *
   * So it is a FALLBACK here, not the answer: the Time Slot field runs it
   * through `displaySlot` alongside `requested_date_time`, and the stored string
   * only wins for a date-only booking where there is no hour to derive from.
   * Do not render it raw — that is what put '3pm to 7pm' next to an 05:30
   * appointment on job #482491.
   */
  time_slot?: string | null;
  job_desc?: string | null;
  /** Technician-facing note ("Anything Handyman should keep in mind?") — shown as Additional Comments. */
  efr_special_notes?: string | null;
  /** Who pays — per JOB. 2 = the customer pays; anything else = not the customer. */
  paid_by?: number | string | null;
  services?: JobServiceRow[] | null;
};

/*
 * Job Skill Matrix cell text. A service can require SEVERAL deep skills, so all
 * mapped names are joined; unnamed rows (deleted deep skill) are dropped. Empty
 * string ⇒ the matrix has no mapping for this service and the cell shows "—".
 */
function jobSkillNames(s: JobServiceRow): string {
  return (s.job_skills ?? []).map((k) => k.deepskill_name).filter(Boolean).join(', ');
}

/* True when ANY mapped skill for this service was hand-made in the Job Skill
 * Matrix (tbl_service_skill_mapping.source='Manual'). Case-insensitive to match
 * the column's utf8mb4_0900_ai_ci collation and any un-normalised legacy rows. */
function jobSkillIsManual(s: JobServiceRow): boolean {
  return (s.job_skills ?? []).some((k) => String(k.source ?? '').toLowerCase() === 'manual');
}

export function JobContextPanel({
  job,
  jobId,
  defaultDetailsOpen = true,
  remarksReloadKey,
  remarksDefaultOpen = false,
  showReschedule = false,
  onReschedule,
  rescheduling = false,
  pastBlocksAction = false,
  onSaveDetails,
  onAddressSaved,
}: {
  job: JobContextData | null;
  jobId: number | null;
  /** Job Details starts expanded by default (ops read it on nearly every open). */
  defaultDetailsOpen?: boolean;
  /** Bump to REMOUNT <JobRemarksView> (its comment thread lives in its own
      useFetch, which cache-invalidation alone can't re-run). */
  remarksReloadKey?: number | string;
  remarksDefaultOpen?: boolean;
  /** Schedule & Assign only — renders the Reschedule button + "locked" helper. */
  showReschedule?: boolean;
  onReschedule?: () => void;
  /** Schedule & Assign only — veils the schedule row while a reschedule refetch runs. */
  rescheduling?: boolean;
  /*
   * Opt-in EDITING of Job Description + Additional Comments. Absent (the
   * default) ⇒ both render read-only exactly as before — the panel is shared
   * with Assign / Reassign and must not sprout write affordances there just
   * because it sprouted them here.
   *
   * The host owns the PATCH *and the refetch*: the job object this panel
   * renders comes from the host's `/candidates` response, and invalidateFetch
   * only DROPS the cache — it cannot re-run a still-mounted hook. Only the host
   * holds that hook, which is why this is a callback and not a fetch in here.
   * Receives ONLY the changed fields.
   */
  onSaveDetails?: (patch: { job_desc?: string; efr_special_notes?: string }) => Promise<void>;
  /*
   * Opt-in EDITING of the service address, on the same terms as onSaveDetails:
   * absent (the default) ⇒ the address is read-only, so Assign / Reassign —
   * which share this panel — do not sprout a write affordance they never asked
   * for. Fires AFTER a successful save so the host can re-run its own fetch;
   * the dialog PATCHes by itself, so this really is refresh-only.
   */
  onAddressSaved?: () => void;
  /*
   * Does a PAST appointment actually block this host modal's primary action?
   * true  → offering (the server 400s), so the notice is red + imperative.
   * false → assign / reassign, which the server permits on purpose, so the
   *         notice is an amber advisory instead of an instruction the operator
   *         does not have to follow.
   * Defaults to false: an advisory shown where a block applies is a smaller
   * error than a block claimed where none exists (which is what produced the
   * "message says stop, button says go" report).
   */
  pastBlocksAction?: boolean;
}) {
  // Job Details is collapsible but starts EXPANDED — ops read it on nearly every
  // open; collapsing is for reclaiming height once they've moved on to picking a
  // technician.
  const [jobDetailsOpen, setJobDetailsOpen] = useState(defaultDetailsOpen);

  // Editing needs BOTH the host's opt-in and the same permission that gates the
  // Description pencil in JobModal. hasAction fails CLOSED while /me loads, and
  // the PATCH route itself carries no action check — this flag is the whole
  // guard, so it must not be inferred from the host's identity.
  const { me } = useMe();
  const canEditDetails = !!onSaveDetails && hasAction(me, 'isJobEdit');
  const canEditAddress = !!onAddressSaved && hasAction(me, 'isJobEdit');
  const [addressOpen, setAddressOpen] = useState(false);

  return (
    <>
      {/* ───────── (a) COMPLETE JOB DETAILS + read-only schedule ───────── */}
      {/* Bordered card with an uppercase header button — same shell as
          JobRemarksView so the two collapsibles in the host modal read as one
          family. Collapsible, expanded by default. A <button> (not a bare
          div) so it's keyboard-reachable; aria-expanded carries state to AT. */}
      <section className="rounded-md border bg-muted/30">
        <button
          type="button"
          onClick={() => setJobDetailsOpen((o) => !o)}
          aria-expanded={jobDetailsOpen}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-primary"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${jobDetailsOpen ? '' : '-rotate-90'}`}
          />
          Job Details
        </button>
        {jobDetailsOpen && !job && (
          <div className="border-t px-3 text-sm text-muted-foreground py-4">Loading job details…</div>
        )}
        {jobDetailsOpen && job && (
          <div className="border-t p-3">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-sm">
              <ReadField label="Customer" value={job.customer_name} />
              <ReadField
                label="Customer Mobile"
                value={
                  <CallableMobile jobId={job.job_id} mobile={job.customer_mob_no} />
                }
              />
              <ReadField label="Client" value={job.client_name} />
              <ReadField label="Client Ref Id" value={job.client_ref_id} />
              {/* client_spoc IS the mobile (raw string on tbl_job, no SPOC id);
                  it arrives masked. Dialling routes through the spocJobId
                  target, which re-resolves the real number BE-side. */}
              <ReadField
                label="Client SPOC"
                value={
                  job.client_spoc_name || job.client_spoc ? (
                    <span className="inline-flex flex-col items-start">
                      <span>{job.client_spoc_name || '—'}</span>
                      {job.client_spoc && (
                        <CallableMobile spocJobId={job.job_id} mobile={job.client_spoc} />
                      )}
                    </span>
                  ) : null
                }
              />
              <ReadField
                label="Service Address"
                value={
                  <span className="inline-flex items-start gap-1">
                    <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                    {/* formatServiceAddress resolves to tbl_address.address ALONE
                        (see lib/format.ts), so City is a separate field — it is
                        not folded into the address string. */}
                    <span>{formatServiceAddress(job)}</span>
                    {canEditAddress && (
                      <button
                        type="button"
                        onClick={() => setAddressOpen(true)}
                        className="text-muted-foreground hover:text-primary shrink-0 mt-0.5"
                        title="Edit Address"
                        aria-label="Edit Address"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                }
              />
              <ReadField label="City" value={job.city_name} />
              {/* Service Category / Service Type / Deep Skill deliberately NOT
                  here (removed 2026-07-15) — the Services table below is the
                  authoritative, per-service breakdown of exactly that, and the
                  job-level copies were both redundant and wrong for
                  multi-service jobs. */}
              <ReadField label="Job Type" value={job.job_type} />
              {/* Beside Job Type, because both answer "what was booked". A
                  quantity is only meaningful as a positive count, so 0 and a
                  negative read as absent rather than as a figure an operator
                  might quote back to a client. */}
              <ReadField
                label="Quantity"
                value={
                  typeof job.product_quantity === 'number' && job.product_quantity > 0
                    ? job.product_quantity.toLocaleString('en-IN')
                    : null
                }
              />
              <ReadField label="Payment Mode" value={job.payment_mode} />
              <ReadField label="Booked By" value={job.created_by_name} />
              {/* formatDate renders date + IST time — no separate datetime helper. */}
              <ReadField label="Booked On" value={formatDate(job.created_date_time)} />
            </div>

            {/* Job Description + Additional Comments — full-width under the
                grid because they're free text and wrap badly in a 3-col cell.
                `job_desc` is the ACTUAL tbl_job.job_desc; `efr_special_notes`
                is the technician-facing note ("Anything Handyman should keep
                in mind?" in the Book-New-Call form) surfaced here as
                "Additional Comments". */}
            {canEditDetails && onSaveDetails ? (
              /* ⚠ Rendered OUTSIDE the `job_desc || efr_special_notes` guard
                 below: that guard hides the whole block when both are empty,
                 which would make it impossible to ADD a description to a job
                 that has none — the exact case an operator most needs. */
              <EditableJobDetails job={job} onSave={onSaveDetails} />
            ) : (job.job_desc || job.efr_special_notes) && (
              <div className="mt-3 pt-3 border-t grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <ReadField label="Job Description" value={job.job_desc} />
                <ReadField label="Additional Comments" value={job.efr_special_notes} />
              </div>
            )}

            {job.services && job.services.length > 0 && (
              <div className="mt-3 pt-3 border-t">
                <div className="text-xs font-semibold text-muted-foreground mb-1.5">Services</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        {/* Widths keep each service on ONE line: the four text
                            columns truncate under pressure, while Qty / Amount /
                            Score / Billing are content-sized and never wrap.
                            The percentages were rebalanced (was 30/24/24) to fit
                            Job Skill WITHOUT widening the modal. */}
                        <th className="font-medium py-1 pr-3 w-[22%]">Service</th>
                        <th className="font-medium py-1 pr-3 w-[17%]">Category</th>
                        <th className="font-medium py-1 pr-3 w-[17%]">Type</th>
                        {/* Job Skill / Job Matrix Score — what the Job Skill Matrix
                            (Admin Actions → Job Skill Matrix) says this service
                            needs, and how sure it is. Display-only: candidate
                            matching still runs on category/deep-skill. */}
                        <th className="font-medium py-1 pr-3 w-[22%]">Job Skill</th>
                        <th className="font-medium py-1 pr-3 text-right whitespace-nowrap w-16">Job Matrix Score</th>
                        <th className="font-medium py-1 pr-3 text-right whitespace-nowrap w-12">Qty</th>
                        <th className="font-medium py-1 pr-3 text-right whitespace-nowrap w-20">Amount</th>
                        {/* Does the customer pay? Driven by tbl_job.paid_by. */}
                        <th className="font-medium py-1 whitespace-nowrap">Payment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {job.services.map((s, i) => (
                        <tr key={i} className="border-t border-border/60">
                          {/* truncate + title: long rate-card names stay on one
                              line and reveal in full on hover. */}
                          <td className="py-1 pr-3 max-w-0 truncate" title={s.service_name || undefined}>{s.service_name || '—'}</td>
                          <td className="py-1 pr-3 max-w-0 truncate" title={s.service_catg || undefined}>{s.service_catg || '—'}</td>
                          <td className="py-1 pr-3 max-w-0 truncate" title={s.service_type || undefined}>{s.service_type || '—'}</td>
                          {/*
                           * JOB SKILL — every deep skill the matrix maps this
                           * service to, comma-joined. "—" means the matrix has
                           * NO mapping for this service (not "zero skills
                           * needed"); the tooltip says so out loud.
                           */}
                          <td className="py-1 pr-3 max-w-0">
                            <div className="flex items-center gap-1 min-w-0">
                              <span className="truncate" title={jobSkillNames(s) || 'No mapping in the Job Skill Matrix'}>
                                {jobSkillNames(s) || '—'}
                              </span>
                              {jobSkillIsManual(s) && (
                                <span
                                  className="shrink-0 inline-flex items-center rounded-full border border-info bg-info-tint px-1.5 py-0 text-xs font-medium leading-tight text-info-strong"
                                  title="This skill mapping was made manually in the Job Skill Matrix"
                                >
                                  Manual
                                </span>
                              )}
                            </div>
                          </td>
                          {/*
                           * JOB MATRIX SCORE — the HIGHEST confidence among the
                           * mapped skills, printed verbatim to match the
                           * Confidence column on the Skill Matrix page.
                           * ⚠ Strict `!= null`, never a truthiness check: a real
                           * score of 0 arrives as '0.00' and must render as
                           * "0.00", visibly different from the "—" that means
                           * the matrix has no mapping at all.
                           */}
                          <td
                            className="py-1 pr-3 text-right whitespace-nowrap"
                            title={
                              s.job_skill_score != null
                                ? 'Job Skill Matrix confidence (highest of the mapped skills)'
                                : jobSkillNames(s)
                                  ? 'Mapped, but the matrix recorded no confidence'
                                  : 'No mapping in the Job Skill Matrix'
                            }
                          >
                            {s.job_skill_score != null ? s.job_skill_score : '—'}
                          </td>
                          <td className="py-1 pr-3 text-right whitespace-nowrap">{s.quantity ?? '—'}</td>
                          <td className="py-1 pr-3 text-right whitespace-nowrap">{s.total_charge != null ? `₹${s.total_charge}` : '—'}</td>
                          {/*
                           * PAYMENT — does the customer pay for this job?
                           * Driven solely by tbl_job.paid_by (2 = the customer
                           * pays; anything else = they don't), per ops.
                           *
                           * ⚠ paid_by is per-JOB, so every service line shows the
                           * SAME chip — it sits per-row because that's where ops
                           * read it, not because the data varies. Deliberately NOT
                           * keyed on the per-service `billing_label` (which only
                           * says whether a CHARGE exists) nor on `collected_by`
                           * (who physically collects): a line can carry ₹1000 and
                           * still be free to the customer when the client is billed.
                           * paid_by is the only column that answers who pays.
                           */}
                          <td className="py-1 whitespace-nowrap">
                            {Number(job.paid_by) === 2 ? (
                              <StatusChip tone="amber" title="The customer pays for this job — collect on site.">
                                Paid by Customer
                              </StatusChip>
                            ) : (
                              <StatusChip tone="emerald" title="Nothing to collect from the customer — the client is billed.">
                                Free for Customer
                              </StatusChip>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* READ-ONLY schedule row — Date/Time are locked; change only via
                the Reschedule dialog (Schedule & Assign).

                Time Slot shows the BAND, deliberately — the promise to the
                customer is a window, not "the technician arrives at 5:30". But
                it is the band the appointment beside it actually falls in
                (`displaySlot`), not the raw stored string: `tbl_job.time_slot`
                is DERIVED from `requested_date_time` and re-derived on every
                write, so a stored value that disagrees with the date on the
                left is one the next save will discard. Job #482491 stored
                '3pm to 7pm' against an 05:30 appointment and this row printed
                the two side by side.

                The `|| booking_cut_off_time_slot` fallback is GONE. That column
                is a second derivation of the same appointment time in a
                different legacy vocabulary ('3 PM - 7 PM' / 'AfterHours'), so
                it could only ever fire in the one case `displaySlot` already
                covers — no readable time AND no stored band — and in exactly
                that case reschedule() stamps it 'AfterHours' off the 00:00
                midnight sentinel (job.service.js deriveBookingCutoffSlot). It
                could therefore contribute a wrong band or nothing at all. */}
            <div className="mt-3 pt-3 border-t">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-wrap gap-x-8 gap-y-2">
                  <div className="space-y-0.5">
                    <div className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <Calendar className="h-3.5 w-3.5" /> Job Date &amp; Time
                    </div>
                    <div className="text-sm font-medium text-foreground">
                      {/* While the post-reschedule refetch is in flight, show a
                          spinner rather than the stale pre-reschedule date. */}
                      {rescheduling
                        ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Updating…</span>
                        : (job.requested_date_time ? formatDate(job.requested_date_time) : '—')}
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" /> Time Slot
                    </div>
                    <div className="text-sm font-medium text-foreground">
                      {rescheduling
                        ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Updating…</span>
                        : (displaySlot(job.requested_date_time, job.time_slot) || '—')}
                    </div>
                  </div>
                </div>
                {/* Standardised (2026-07-28) to the shared job-modal look —
                    a plain `<Button size="sm" variant="outline">Reschedule</Button>`,
                    identical to the ActionBar footer button, so Reschedule
                    reads the same across Schedule & Assign, Reassign and the
                    job-detail modal. (Was an icon button: CalendarClock + gap-1.5.) */}
                {showReschedule && onReschedule && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onReschedule}
                  >
                    Reschedule
                  </Button>
                )}
              </div>
              {/*
                * Past-appointment notice — WORDED BY WHAT THE HOST MODAL CAN DO.
                *
                * The server refuses to OFFER a job whose slot has gone
                * (routes/admin/jobs.js) but deliberately still permits a direct
                * ASSIGN / REASSIGN: swapping the technician on a job that is
                * already running late is a legitimate recovery, and the assign
                * route is exempt from the gate on purpose.
                *
                * So a single blocking sentence was wrong half the time. In
                * Reassign it told the operator to reschedule "before offering
                * the job to technicians" while the Reassign button — correctly —
                * stayed enabled, which read as a contradiction. Blocking copy
                * now renders only where the action is actually blocked; the
                * assign/reassign surfaces get the same FACT as a non-blocking
                * advisory.
                */}
              {!rescheduling && appointmentIsPast(job.requested_date_time) && (
                pastBlocksAction ? (
                  <p className="mt-2 text-xs font-medium text-urgent-strong">
                    This appointment time has already passed. Reschedule it to a future
                    slot before offering the job to technicians.
                  </p>
                ) : (
                  <p className="mt-2 text-xs font-medium text-warning-strong">
                    This appointment time has already passed. You can still reassign,
                    or use Reschedule to move it to a future slot.
                  </p>
                )
              )}
              {showReschedule && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Job Date &amp; Time are locked. Use <b>Reschedule</b> to change the
                  appointment — a reason and remarks are mandatory, and technicians
                  are re-ranked against the new schedule.
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Job comments to date. Sits BETWEEN Job Details and the technician
          list — it's context for choosing a technician, so it belongs before
          the choice, not after it. Collapsed by default so a long thread can't
          push the list off-screen; the header carries the count so ops can tell
          at a glance whether it's worth opening. */}
      <JobRemarksView key={remarksReloadKey} jobId={jobId} collapsible defaultOpen={remarksDefaultOpen} />

      {/* Mounted only while open so the form re-seeds from the CURRENT job on
          every open — a persistently mounted dialog would keep the draft from
          the previous open and quietly re-save stale values.
          Cast through `unknown` for the same reason JobTransactionView does:
          the dialog reads a handful of address fields, and this panel's job is
          the /candidates subset rather than the full Job row. */}
      {addressOpen && job && (
        <JobAddressEditDialog
          job={job as unknown as Parameters<typeof JobAddressEditDialog>[0]['job']}
          onClose={() => setAddressOpen(false)}
          onSaved={() => { setAddressOpen(false); onAddressSaved?.(); }}
        />
      )}
    </>
  );
}

/* ── Read-only labelled field for the Job Details grid. ───────────────── */
function ReadField({ label, value }: { label: string; value: React.ReactNode }) {
  const empty = value == null || value === '';
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground break-words">
        {empty ? <span className="text-muted-foreground">—</span> : value}
      </dd>
    </div>
  );
}

/* ── Editable Job Description + Additional Comments ──────────────────────────
 *
 * EXPLICIT save only — never on blur, never on keystroke. The host modal's
 * primary action is "Offer to N Technicians"; a field that saved itself when
 * the operator tabbed past it would be committed by accident on the way to a
 * different button. The Save / Cancel row therefore appears only once a draft
 * actually differs from the stored value, so an untouched panel reads exactly
 * like the read-only one it replaced.
 *
 * Only CHANGED fields are sent. That is not just economy: `job_desc` is a
 * STRUCTURAL column on the BE, and writing it re-stamps `created_date_time` —
 * which this very panel prints two rows up as "Booked On". Sending an
 * unchanged job_desc alongside a comments edit would silently move it.
 */
function EditableJobDetails({ job, onSave }: {
  job: JobContextData;
  onSave: (patch: { job_desc?: string; efr_special_notes?: string }) => Promise<void>;
}) {
  const storedDesc = job.job_desc ?? '';
  const storedNotes = job.efr_special_notes ?? '';
  const [desc, setDesc] = useState(storedDesc);
  const [notes, setNotes] = useState(storedNotes);
  const [saving, setSaving] = useState(false);
  /*
   * What the server is believed to hold — the baseline "dirty" is measured
   * against. Seeded from the job, and advanced OPTIMISTICALLY on a successful
   * save so the Save row clears at once instead of lingering for the whole
   * candidates refetch (a ranking query that can take seconds), during which a
   * Cancel would have thrown the just-saved text away.
   */
  const [saved, setSaved] = useState({ desc: storedDesc, notes: storedNotes });
  /*
   * Re-seed from the STORED values (and on a job swap). A failed save changes
   * nothing stored, so this does not fire and the operator's text stays on
   * screen — silently reverting to the old value is what makes a failure look
   * like a success.
   */
  useEffect(() => {
    setSaved({ desc: storedDesc, notes: storedNotes });
    setDesc(storedDesc);
    setNotes(storedNotes);
  }, [job.job_id, storedDesc, storedNotes]);

  const descDirty = desc !== saved.desc;
  const notesDirty = notes !== saved.notes;

  async function save() {
    const patch: { job_desc?: string; efr_special_notes?: string } = {};
    if (descDirty) patch.job_desc = desc.trim();
    if (notesDirty) patch.efr_special_notes = notes.trim();
    /*
     * The BE's updateBody carries no `.allow('', null)` on either column, so an
     * emptied field is a guaranteed 400. Say so here rather than firing a
     * request we know is refused — and leave the operator's text untouched.
     */
    if (patch.job_desc === '' || patch.efr_special_notes === '') {
      showToast({ variant: 'error', message: 'This field can’t be left blank. Enter some text, or use Cancel to restore the saved value.' });
      return;
    }
    setSaving(true);
    try {
      await onSave(patch);
      const nextDesc = patch.job_desc ?? saved.desc;
      const nextNotes = patch.efr_special_notes ?? saved.notes;
      setSaved({ desc: nextDesc, notes: nextNotes });
      setDesc(nextDesc);
      setNotes(nextNotes);
      showToast({ variant: 'success', message: 'Job details saved.' });
    } catch (e) {
      // Visible failure, and the draft is deliberately NOT reverted.
      showToast({ variant: 'error', message: formatApiError(e, { fallback: 'Could not save job details' }) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 pt-3 border-t space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {/* Textareas, not inputs: job_desc runs to 5000 characters and
            efr_special_notes to 2000 — the BE's own limits, so the counter and
            the validator agree instead of the box truncating typing early. */}
        <EditField
          label="Job Description"
          value={desc}
          onChange={setDesc}
          maxLength={5000}
          disabled={saving}
          placeholder="Describe the work to be done…"
        />
        <EditField
          label="Additional Comments"
          value={notes}
          onChange={setNotes}
          maxLength={2000}
          disabled={saving}
          placeholder="Anything the technician should keep in mind…"
        />
      </div>
      {(descDirty || notesDirty) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs font-medium text-warning-strong">Unsaved Changes</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => { setDesc(saved.desc); setNotes(saved.notes); }}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  );
}

/* Editable twin of <ReadField> — same label typography so the block still
   reads as part of the Job Details grid. */
function EditField({ label, value, onChange, maxLength, disabled, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
  disabled: boolean;
  placeholder: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-label={label}
          className="mt-0.5 w-full rounded border bg-background px-2 py-1 text-sm min-h-[72px] disabled:opacity-60"
        />
        <div className="text-right text-xs text-muted-foreground">{value.length} / {maxLength}</div>
      </dd>
    </div>
  );
}
