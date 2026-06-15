'use client';

/*
 * Schedule & Assign — the My Orders "Pending for Scheduling" flow.
 *
 * Opened from /my-orders rows (status=0, unassigned) via the
 * `?action=schedule&jobId=N` deep-link. Replaces the old two-step
 * "Schedule (open JobModal) + Assign (open AssignTechnicianModal)"
 * dance with a single modal that lets ops:
 *
 *   (a) review COMPLETE job details, with an EDITABLE Job Date + Time
 *       Slot. Editing either re-requests the candidate list against the
 *       PROPOSED schedule so attendance / concurrent-jobs / same-slot
 *       conflict all recompute for the date the operator is about to
 *       commit (not the job's stale requested date).
 *   (b) pick from the TOP 10 ranked technicians for that schedule.
 *   (c) SEARCH any technician by Efr Id / Name / Mobile and assign them
 *       even if they fall outside the top-10 hard filters.
 *
 * Assigning fires PATCH /admin/jobs/:id/assign with the (possibly edited)
 * schedule so the date/time update + assignment happen atomically in one
 * BE transaction (preserving the existing assign webhooks + FCM push).
 *
 * Backend contract (see /my-orders task spec):
 *   GET  /admin/jobs/:id/candidates?limit=10&jobDate=<ISO>&timeSlot=<slot>
 *   GET  /admin/jobs/:id/candidates/search?term=<q>&jobDate=&timeSlot=
 *   PATCH /admin/jobs/:id/assign  { easyfixerId, requestedDateTime?, timeSlot? }
 *
 * Live-location tracking is intentionally DEFERRED — no map / location
 * icon here. A follow-up adds it.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, XCircle, Info, Search, X, MapPin,
  Calendar, Phone,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { formatDate } from '@/lib/utils';
import { CallableMobile } from '@/components/calls/CallButton';

/* ── Time-slot options — mirror the values used in JobModal's Confirm
   form so a re-fetch against an edited slot keys on the same labels the
   BE already stores in tbl_job.time_slot.
   The slot is AUTO-DERIVED from the Job Date's hour — NOT user-selectable.
   This array is the single source of truth for slot labels used by the
   derivation logic below. ─────────────────────────────────────────────── */
const TIME_SLOT_OPTIONS = [
  { value: 'Morning 9 to 2', label: 'Morning 9 to 2' },
  { value: 'Afternoon 12 to 5', label: 'Afternoon 12 to 5' },
  { value: 'Evening 2 to 7', label: 'Evening 2 to 7' },
  { value: 'Anytime', label: 'Anytime' },
] as const;

/*
 * Derive the time slot from the Job Date's wall-clock hour (IST, since the
 * picker value is always an IST wall-clock string).
 *
 *   Morning 9 to 2   → 09:00–11:59  (hours 9–11)
 *   Afternoon 12 to 5 → 12:00–13:59 (hours 12–13)
 *   Evening 2 to 7   → 14:00–18:59  (hours 14–18)
 *   Anytime          → fallback for anything outside the above ranges
 *
 * Overlap resolution: Morning ends before Afternoon starts (we split at 12);
 * Afternoon ends before Evening (we split at 14). Hours ≥ 19 → Anytime.
 *
 * Input: the datetime-local picker string 'YYYY-MM-DDTHH:mm' (IST wall-clock).
 * Returns one of the TIME_SLOT_OPTIONS values, never null.
 */
function deriveTimeSlot(datetimeLocal: string): string {
  if (!datetimeLocal) return 'Anytime';
  const m = datetimeLocal.match(/T(\d{2}):/);
  if (!m) return 'Anytime';
  const hour = Number(m[1]);
  if (hour >= 9 && hour <= 11) return 'Morning 9 to 2';
  if (hour >= 12 && hour <= 13) return 'Afternoon 12 to 5';
  if (hour >= 14 && hour <= 18) return 'Evening 2 to 7';
  return 'Anytime';
}

/* ── BE row shape (exact contract). ──────────────────────────────────── */
type DistanceTier =
  | 'same_pincode' | 'current_pincode' | 'in_zone' | 'out_of_zone' | 'unknown';
type DeepSkillStatus =
  | 'both_available' | 'job_skill_not_available' | 'easyfixer_skills_not_available';

export type ScheduleCandidate = {
  efr_id: number;
  efr_name: string;
  /** Already masked by the BE mask-mobile middleware. */
  mobile: string | null;
  current_pincode: string | null;
  zone_name: string | null;
  serviceable_pincodes: string[];
  distance_km: number | null;
  distance_tier: DistanceTier;
  attendance_for_job_date: boolean;
  deep_skill_status: DeepSkillStatus;
  deep_skill_match: boolean;
  worked_in_category: boolean;
  worked_for_client: boolean;
  payment_mode: string | null;
  account_balance: number;
  concurrent_jobs_count: number;
  same_slot_conflict: boolean;
  // Existing ranking fields — optional so the search endpoint (which
  // skips ranking) can omit them.
  score?: number;
  grade?: 'A+' | 'A' | 'B' | 'C' | 'D' | 'E';
  avg_rating?: number;
};

type ScheduleJob = {
  job_id: number;
  customer_name: string | null;
  customer_mob_no: string | null;
  client_name: string | null;
  client_ref_id: string | null;
  address: string | null;
  city_name: string | null;
  pin_code: string | null;
  service_category: string | null;
  service_type: string | null;
  deep_skill_label: string | null;
  job_type: string | null;
  payment_mode: string | null;
  requested_date_time: string | null;
  time_slot: string | null;
  job_desc: string | null;
};

type CandidatesResponse = {
  job: ScheduleJob;
  candidates: ScheduleCandidate[];
  limit?: number;
};

type SearchResponse = {
  job?: ScheduleJob;
  candidates: ScheduleCandidate[];
  capped?: boolean;
};

/* ── IST wall-clock ⇄ datetime-local helpers. ───────────────────────────
 * The BE delivers requested_date_time as an IST WALL-CLOCK string
 * ('YYYY-MM-DD HH:MM:SS' — db.js uses dateStrings:true) and EXPECTS an IST
 * wall-clock string back: the jobDate query param + assign's
 * requestedDateTime are validated against
 *   /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/
 * so an ISO 'Z'/millisecond form (e.g. 2026-06-09T08:30:00.000Z) is
 * REJECTED with a 400. We therefore NEVER go through a UTC Date round-trip
 * here — we only reshape the wall-clock STRING between the picker's
 * 'YYYY-MM-DDTHH:mm' and the BE's 'YYYY-MM-DD HH:mm:ss'. This is also
 * timezone-independent (the old Date-based version only worked when the
 * browser TZ happened to be IST). */
function isoToLocalInput(v: string | null | undefined): string {
  if (!v) return '';
  // Accept both 'YYYY-MM-DD HH:MM[:SS]' and ISO 'YYYY-MM-DDTHH:mm[...]'.
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : '';
}
function localInputToWallClock(local: string): string {
  // Picker value is 'YYYY-MM-DDTHH:mm' IST wall-clock. Send it verbatim as
  // 'YYYY-MM-DD HH:mm:ss' — NO timezone conversion, NO 'Z'.
  if (!local) return '';
  const withSecs = local.length === 16 ? `${local}:00` : local;
  return withSecs.replace('T', ' ');
}

export function ScheduleAssignModal({
  open, onClose, onAssigned, jobId,
}: {
  open: boolean;
  onClose: () => void;
  onAssigned?: (efrId: number, efrName: string) => void;
  jobId: number | null;
}) {
  const { me } = useMe();
  // Schedule & Assign maps to the same legacy assign permission as the
  // entry icon on /my-orders. View-only users see the table but no
  // Assign buttons.
  const canCommit = hasAction(me, 'isJobAssign');
  const confirmAction = useConfirm();

  // Proposed schedule — seeded from the job's current values once it
  // loads, then operator-editable. `seeded` guards the one-time seed so
  // a re-fetch (triggered BY editing) doesn't clobber the operator's edit.
  // timeSlot is AUTO-DERIVED from jobDateLocal — not user-settable.
  const [jobDateLocal, setJobDateLocal] = useState('');
  const [seeded, setSeeded] = useState(false);

  // Derived time slot — recomputed whenever the Job Date changes.
  // Falls back to the job's stored slot ONLY during the seed phase (before
  // the operator has set a date). Once seeded the hour-based rule always wins.
  const [seedSlot, setSeedSlot] = useState('');
  const timeSlot = seeded ? deriveTimeSlot(jobDateLocal) : seedSlot;

  const [search, setSearch] = useState('');
  const [assigning, setAssigning] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Serviceable-pincodes "view all" modal target (the clicked candidate).
  const [pincodeModalFor, setPincodeModalFor] = useState<ScheduleCandidate | null>(null);
  // Last successfully-loaded job. The candidates endpoint returns BOTH the
  // job and the ranked list, so if a re-fetch fails (e.g. a transient error
  // while the operator edits the schedule) we keep showing Job Details +
  // the search/assign flow instead of blanking the whole modal.
  const [retainedJob, setRetainedJob] = useState<ScheduleJob | null>(null);

  // Reset transient state whenever the modal closes / the job changes.
  useEffect(() => {
    if (!open) {
      setSeeded(false); setJobDateLocal(''); setSeedSlot('');
      setSearch(''); setAssigning(null); setErr(null); setPincodeModalFor(null);
      setRetainedJob(null);
    }
  }, [open, jobId]);

  // The proposed-schedule query suffix. Once seeded, ALWAYS send the
  // operator's chosen date/slot so the BE recomputes attendance /
  // concurrent / same-slot against the proposed schedule (falls back to
  // the job's stored values BE-side when omitted, but we send explicitly).
  const proposedWallClock = jobDateLocal ? localInputToWallClock(jobDateLocal) : '';
  const scheduleQs = useMemo(() => {
    const p = new URLSearchParams();
    if (proposedWallClock) p.set('jobDate', proposedWallClock);
    if (timeSlot) p.set('timeSlot', timeSlot);
    const s = p.toString();
    return s ? `&${s}` : '';
  }, [proposedWallClock, timeSlot]);

  // (b) TOP 10 — keyed on jobId + proposed schedule so editing the date
  // re-fetches. `enabled` waits until the modal is open AND the schedule
  // has been seeded (so the first fetch reflects the job's real date).
  const topKey = open && jobId
    ? `/admin/jobs/${jobId}/candidates?limit=10${seeded ? scheduleQs : ''}`
    : null;
  const top = useFetch<CandidatesResponse>(topKey, { enabled: !!topKey });

  // Seed the proposed schedule from the loaded job exactly once.
  // seedSlot captures the job's stored time_slot for display during the seed
  // phase; once seeded, deriveTimeSlot() takes over from the picked date.
  useEffect(() => {
    if (seeded || !top.data?.job) return;
    setJobDateLocal(isoToLocalInput(top.data.job.requested_date_time));
    setSeedSlot(top.data.job.time_slot ?? 'Anytime');
    setSeeded(true);
  }, [seeded, top.data]);

  // Retain the last good job so Job Details survive a failed candidate
  // re-fetch (resilience — the flow must not break on a Top-10 error).
  useEffect(() => {
    if (top.data?.job) setRetainedJob(top.data.job);
  }, [top.data]);
  const job = top.data?.job ?? retainedJob;

  // (c) SEARCH — debounced via the box; keyed so it re-fires on schedule
  // edits too (computed columns must match the proposed schedule).
  const term = search.trim();
  const searchKey = open && jobId && term
    ? `/admin/jobs/${jobId}/candidates/search?term=${encodeURIComponent(term)}${seeded ? scheduleQs : ''}`
    : null;
  const searchRes = useFetch<SearchResponse>(searchKey, { enabled: !!searchKey });

  // Show search results when a term is present, otherwise the top-10.
  const showingSearch = !!term;
  const rows: ScheduleCandidate[] = showingSearch
    ? (searchRes.data?.candidates ?? [])
    : (top.data?.candidates ?? []);
  const listLoading = showingSearch ? searchRes.loading : top.loading;
  const listError = showingSearch ? searchRes.error : top.error;

  async function assign(c: ScheduleCandidate) {
    if (!jobId) return;
    const scheduleNote = proposedWallClock
      ? `\n\nSchedule: ${formatDate(proposedWallClock)}${timeSlot ? ` · ${timeSlot}` : ''}.`
      : '';
    const ok = await confirmAction({
      title: `Assign Job #${jobId} to ${c.efr_name}?`,
      description:
        `Job #${jobId} will be scheduled and assigned to ${c.efr_name} ` +
        `(${c.mobile ?? '—'}).` + scheduleNote +
        `\n\nThe technician receives a push notification and the configured ` +
        `client webhook (TechAssigned) fires.` +
        (!c.deep_skill_match
          ? '\n\n⚠ This technician does NOT hold the deep-skill required for this job.'
          : '') +
        (c.same_slot_conflict
          ? '\n\n⚠ This technician already has a job in the same slot on this date.'
          : ''),
      confirmLabel: 'Yes, schedule & assign',
    });
    if (!ok) return;
    setAssigning(c.efr_id); setErr(null);
    try {
      await api.patch(`/admin/jobs/${jobId}/assign`, {
        easyfixerId: c.efr_id,
        // Atomic schedule edit — BE updates date/time in the same txn.
        ...(proposedWallClock ? { requestedDateTime: proposedWallClock } : {}),
        ...(timeSlot ? { timeSlot } : {}),
      });
      // Bust the candidates cache so reopening reflects the new state.
      invalidateFetch((k) => k.startsWith(`/admin/jobs/${jobId}/candidates`));
      onAssigned?.(c.efr_id, c.efr_name);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Assign failed');
    } finally {
      setAssigning(null);
    }
  }

  // Read-only modal otherwise, but the editable schedule fields make it
  // "dirty" once touched — guard close so an accidental Esc after editing
  // the date prompts. Skip while an assign is in flight.
  // Only the Job Date is user-editable; timeSlot is derived so not part of dirty check.
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: () =>
      seeded && job != null &&
      jobDateLocal !== isoToLocalInput(job.requested_date_time),
    when: () => assigning == null,
  });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent
        noPadding
        className="!max-w-none w-[calc(100vw-48px)] h-[calc(100vh-48px)] overflow-hidden flex flex-col"
      >
        <DialogHeader className="px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            Schedule &amp; Assign
            {jobId && <span className="text-sm font-normal text-slate-300">· Job #{jobId}</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-5">
          {/* ───────── (a) COMPLETE JOB DETAILS + editable schedule ───────── */}
          <section>
            <h3 className="text-sm font-semibold mb-2">Job Details</h3>
            {top.loading && !job && (
              <div className="text-sm text-muted-foreground py-4">Loading job details…</div>
            )}
            {job && (
              <div className="rounded-lg border bg-muted/20 p-3">
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
                  <ReadField
                    label="Address"
                    value={
                      <span className="inline-flex items-start gap-1">
                        <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                        <span>{job.address || '—'}</span>
                      </span>
                    }
                  />
                  <ReadField label="City" value={job.city_name} />
                  <ReadField label="Job Pincode" value={job.pin_code} />
                  <ReadField label="Service Category" value={job.service_category} />
                  <ReadField label="Service Type" value={job.service_type} />
                  <ReadField
                    label="Deep Skill"
                    value={job.deep_skill_label || job.service_category}
                  />
                  <ReadField label="Job Type" value={job.job_type} />
                  <ReadField label="Payment Mode" value={job.payment_mode} />
                  <ReadField label="Description" value={job.job_desc} />
                </div>

                {/* EDITABLE scheduling row — drives the candidate re-fetch. */}
                <div className="mt-3 pt-3 border-t">
                  <div className="space-y-1.5 max-w-xs">
                    <label className="text-xs font-medium text-foreground flex items-center gap-1">
                      <Calendar className="h-3.5 w-3.5 text-muted-foreground" /> Job Date *
                    </label>
                    <Input
                      type="datetime-local"
                      value={jobDateLocal}
                      onChange={(e) => setJobDateLocal(e.target.value)}
                    />
                  </div>
                  {/* Auto-derived Time Slot chip — read-only; derived from the Job Date's hour. */}
                  {timeSlot && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <span className="text-[11px] text-muted-foreground">Time Slot:</span>
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-700 border border-slate-200">
                        {timeSlot}
                      </span>
                    </div>
                  )}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Editing the Job Date re-ranks technicians and recomputes
                  attendance, concurrent jobs and same-slot conflicts against the proposed schedule.
                  The Time Slot is automatically derived from the selected time.
                </p>
              </div>
            )}
          </section>

          {err && (
            <div className="text-sm text-red-700 flex items-center gap-1">
              <AlertTriangle className="h-4 w-4" /> {err}
            </div>
          )}

          {/* ───────── (c) SEARCH TECHNICIAN ───────── */}
          <section>
            <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
              <h3 className="text-sm font-semibold">
                {showingSearch ? 'Search Results' : 'Top 10 Technicians'}
              </h3>
              <div className="relative w-80 max-w-full">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search Any Technician by Efr Id / Name / Mobile…"
                  className="pl-9 pr-9"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 hover:bg-muted"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
            </div>
            {showingSearch && searchRes.data?.capped && (
              <p className="mb-2 text-[11px] text-amber-700">
                Showing the first {rows.length} matches. Refine your search to narrow the list.
              </p>
            )}

            {/* (b)/(c) Technician list. Error + empty states render as a
                MODAL-WIDTH centered message — NOT inside the wide, horizontally
                scrolling table, where a colSpan-centered cell lands off to the
                right rather than at the modal's centre. The Job Details panel
                and the search box above stay usable regardless, so a Top-10
                failure never blocks searching + assigning a technician. */}
            {!listLoading && listError ? (
              <div className="py-12 text-center text-sm text-red-700">
                {showingSearch
                  ? 'Something Went Wrong!! Search Failed'
                  : 'Something Went Wrong!! Top Technicians Not Available'}
              </div>
            ) : !listLoading && rows.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {showingSearch
                  ? 'No Technicians Match Your Search.'
                  : 'No Technicians Available For This Job.'}
              </div>
            ) : (
              <CandidateTable
                rows={rows}
                loading={listLoading}
                error={null}
                showingSearch={showingSearch}
                canCommit={canCommit}
                assigning={assigning}
                onAssign={assign}
                onOpenPincodes={setPincodeModalFor}
              />
            )}
          </section>
        </div>

        <DialogFooter className="px-6">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>

      {/* Serviceable-pincodes "view all" searchable modal. */}
      <PincodeListModal
        candidate={pincodeModalFor}
        onClose={() => setPincodeModalFor(null)}
      />
    </Dialog>
  );
}

/* ── Read-only labelled field for section (a). ───────────────────────── */
function ReadField({ label, value }: { label: string; value: React.ReactNode }) {
  const empty = value == null || value === '';
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground break-words">
        {empty ? <span className="text-muted-foreground">—</span> : value}
      </dd>
    </div>
  );
}

/* ───────────────────────── Technician table ─────────────────────────── */
function CandidateTable({
  rows, loading, error, showingSearch, canCommit, assigning, onAssign, onOpenPincodes,
}: {
  rows: ScheduleCandidate[];
  loading: boolean;
  error: string | null;
  showingSearch: boolean;
  canCommit: boolean;
  assigning: number | null;
  onAssign: (c: ScheduleCandidate) => void;
  onOpenPincodes: (c: ScheduleCandidate) => void;
}) {
  const COLS = 15;
  return (
    <div className="border rounded max-h-[48vh] overflow-auto thin-scroll">
      <table
        className="data-table text-xs whitespace-nowrap border-separate"
        style={{ borderSpacing: 0 }}
      >
        <thead className="sticky top-0 bg-background z-20 shadow-sm">
          <tr>
            <th className="!text-left sticky left-0 bg-white z-40 shadow-[2px_0_0_0_var(--border)] min-w-[170px]">
              Technician
            </th>
            <th className="!text-center">Attendance for Job Date</th>
            <th className="!text-center">
              <span className="inline-flex items-center gap-1">
                Distance
                <DistanceTierInfo />
              </span>
            </th>
            <th className="!text-left min-w-[160px]">Serviceable Pincodes</th>
            <th className="!text-center">Current Pincode</th>
            <th className="!text-left">Zone Name</th>
            <th className="!text-left">Masked Mobile</th>
            <th className="!text-left min-w-[180px]">Deep Skill Status</th>
            <th className="!text-center">Deep Skill Match</th>
            <th className="!text-center">Worked in Category?</th>
            <th className="!text-center">Payment Mode</th>
            <th className="!text-right">Easyfixer Account Balance</th>
            <th className="!text-center">Concurrent Jobs Count</th>
            <th className="!text-center">Worked for Client</th>
            <th className="!text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={COLS} className="!text-center text-muted-foreground py-6">Loading technicians…</td></tr>
          )}
          {!loading && error && (
            <tr><td colSpan={COLS} className="!text-center text-red-700 py-6">{error}</td></tr>
          )}
          {!loading && !error && rows.length === 0 && (
            <tr>
              <td colSpan={COLS} className="!text-center text-muted-foreground py-6">
                {showingSearch
                  ? 'No technicians match your search.'
                  : 'No eligible technicians for this schedule.'}
              </td>
            </tr>
          )}
          {!loading && !error && rows.map((c) => (
            <tr key={c.efr_id} className="group hover:bg-muted/40">
              {/* Technician (efr_id - name) — sticky left identifier. */}
              <td className="!text-left sticky left-0 z-20 bg-white group-hover:bg-slate-100 shadow-[2px_0_0_0_var(--border)] min-w-[170px]">
                <div className="font-medium" title={c.efr_name}>{c.efr_name}</div>
                <div className="text-[10px] text-muted-foreground">Efr #{c.efr_id}</div>
              </td>

              {/* Attendance for Job Date — green tick / red cross. */}
              <td className="!text-center">
                {c.attendance_for_job_date
                  ? <CheckCircle2 className="inline h-4 w-4 text-emerald-600" aria-label="Present on job date" />
                  : <XCircle className="inline h-4 w-4 text-red-500" aria-label="No attendance for job date" />}
              </td>

              {/* Distance — km on top, tier label muted underneath. */}
              <td className="!text-center">
                <DistanceCell km={c.distance_km} tier={c.distance_tier} />
              </td>

              {/* Serviceable Pincodes — truncated, hover list, click-to-open. */}
              <td className="!text-left">
                <ServiceablePincodesCell candidate={c} onOpen={() => onOpenPincodes(c)} />
              </td>

              <td className="!text-center">
                {c.current_pincode || <span className="text-muted-foreground">—</span>}
              </td>
              <td className="!text-left">
                {c.zone_name || <span className="text-muted-foreground">—</span>}
              </td>

              {/* Masked Mobile — click-to-call via the shared CallableMobile
                  (resolves unmasked digits server-side from efr_id). */}
              <td className="!text-left">
                {c.mobile
                  ? (
                    <span className="inline-flex items-center gap-1">
                      <CallableMobile efrId={c.efr_id} mobile={c.mobile} />
                    </span>
                  )
                  : <span className="text-muted-foreground inline-flex items-center gap-1"><Phone className="h-3 w-3" />—</span>}
              </td>

              {/* Deep Skill Status — 3-state enum → label. */}
              <td className="!text-left">{deepSkillStatusLabel(c.deep_skill_status)}</td>

              <td className="!text-center"><YesNo value={c.deep_skill_match} /></td>
              <td className="!text-center"><YesNo value={c.worked_in_category} /></td>
              <td className="!text-center">
                {c.payment_mode || <span className="text-muted-foreground">—</span>}
              </td>
              <td className="!text-right font-mono">₹{(c.account_balance ?? 0).toLocaleString('en-IN')}</td>
              <td className="!text-center tabular-nums">{c.concurrent_jobs_count ?? 0}</td>
              <td className="!text-center"><YesNo value={c.worked_for_client} /></td>

              <td className="!text-right">
                {canCommit ? (
                  <Button size="sm" disabled={assigning != null} onClick={() => onAssign(c)}>
                    {assigning === c.efr_id ? 'Assigning…' : 'Assign'}
                  </Button>
                ) : (
                  <span className="text-[10px] text-muted-foreground">view-only</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Distance km + tier label cell. ─────────────────────────────────── */
const TIER_LABEL: Record<DistanceTier, string | null> = {
  same_pincode: 'Same as Job Pincode',
  current_pincode: 'Current Pincode',
  in_zone: 'In Job Zone',
  out_of_zone: 'Out of Zone',
  unknown: null,
};
function DistanceCell({ km, tier }: { km: number | null; tier: DistanceTier }) {
  const label = TIER_LABEL[tier];
  return (
    <div className="leading-tight">
      <div className="font-medium tabular-nums">
        {km == null ? <span className="text-muted-foreground">—</span> : `${km.toFixed(1)} km`}
      </div>
      {label && <div className="text-[10px] text-muted-foreground">({label})</div>}
    </div>
  );
}

/* ── (i) info tooltip explaining the 3-tier distance criteria. CSS
   group-hover popover — no shared Tooltip primitive exists in this repo
   (the convention is native title= / details / hover popovers). ───────── */
function DistanceTierInfo() {
  return (
    <span className="group/info relative inline-flex">
      <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 hidden w-64 -translate-x-1/2 rounded-md border bg-white p-2 text-left text-[11px] font-normal normal-case leading-snug text-foreground shadow-lg group-hover/info:block"
      >
        <strong className="block mb-1">How distance is matched</strong>
        <span className="block"><strong>Same as Job Pincode</strong> — a serviceable pincode equals the job pincode.</span>
        <span className="block mt-0.5"><strong>Current Pincode</strong> — the technician&apos;s current pincode compared to the job pincode.</span>
        <span className="block mt-0.5"><strong>In Job Zone</strong> — a serviceable pincode in the same zone as the job pincode.</span>
        <span className="block mt-1 text-muted-foreground">Distance is the real road-distance estimate between geocoded pincode centroids.</span>
      </span>
    </span>
  );
}

/* ── Serviceable-pincodes cell: truncated CSV + hover ordered list +
   click-to-open searchable modal. "Not Available" when empty. ─────────── */
function ServiceablePincodesCell({
  candidate, onOpen,
}: {
  candidate: ScheduleCandidate;
  onOpen: () => void;
}) {
  const list = candidate.serviceable_pincodes ?? [];
  if (list.length === 0) {
    return <span className="text-muted-foreground">Not Available</span>;
  }
  const TRUNCATE = 3;
  const shown = list.slice(0, TRUNCATE).join(', ');
  const extra = list.length - TRUNCATE;
  return (
    <span className="group/pin relative inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onOpen}
        className="text-left text-primary hover:underline"
        title="Click to view and filter all serviceable pincodes"
      >
        {shown}
        {extra > 0 && <span className="text-muted-foreground"> +{extra} more</span>}
      </button>
      {extra > 0 && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden max-h-48 w-44 overflow-auto rounded-md border bg-white p-2 text-left shadow-lg group-hover/pin:block"
        >
          <span className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            All Serviceable Pincodes
          </span>
          <ol className="list-decimal list-inside space-y-0.5 text-[11px] text-foreground">
            {list.map((p) => <li key={p}>{p}</li>)}
          </ol>
        </span>
      )}
    </span>
  );
}

/* ── Click-to-open searchable pincode modal (filter box + full list). ─── */
function PincodeListModal({
  candidate, onClose,
}: {
  candidate: ScheduleCandidate | null;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  useEffect(() => { if (!candidate) setFilter(''); }, [candidate]);

  const list = candidate?.serviceable_pincodes ?? [];
  const filtered = filter.trim()
    ? list.filter((p) => p.includes(filter.trim()))
    : list;

  // Read-only list modal — purely a filter-and-read view of pincodes,
  // it captures NO user input that could be lost, so the discard-changes
  // guard is intentionally skipped here (documented disable per the
  // house rule for read-only modals).
  return (
    // eslint-disable-next-line no-restricted-syntax -- read-only pincode viewer: no dirty state to guard
    <Dialog open={!!candidate} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Serviceable Pincodes
            {candidate && (
              <span className="text-sm font-normal text-slate-300">· {candidate.efr_name}</span>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter pincodes…"
            className="pl-9"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="mt-3 max-h-72 overflow-auto rounded border thin-scroll">
          {filtered.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {list.length === 0 ? 'Not Available' : 'No pincodes match the filter.'}
            </div>
          ) : (
            <ol className="list-decimal list-inside divide-y text-sm">
              {filtered.map((p) => (
                <li key={p} className="px-3 py-1.5">{p}</li>
              ))}
            </ol>
          )}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {filtered.length} of {list.length} pincode{list.length === 1 ? '' : 's'}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Deep Skill Status enum → display label. ─────────────────────────── */
function deepSkillStatusLabel(status: DeepSkillStatus): React.ReactNode {
  switch (status) {
    case 'both_available':
      return <span className="text-emerald-700">Both Job and Easyfixer Skills Available</span>;
    case 'job_skill_not_available':
      return <span className="text-amber-700">Job Skill Not Available</span>;
    case 'easyfixer_skills_not_available':
      return <span className="text-red-700">Easyfixer Skills Not Available</span>;
    default:
      return <span className="text-muted-foreground">—</span>;
  }
}

/* ── Yes/No cell. ────────────────────────────────────────────────────── */
function YesNo({ value }: { value: boolean }) {
  return value
    ? <span className="text-emerald-700 font-medium">Yes</span>
    : <span className="text-muted-foreground">No</span>;
}
