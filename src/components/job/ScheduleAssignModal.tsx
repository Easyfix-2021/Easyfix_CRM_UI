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
 *   (c) SEARCH any technician by Efr Id / Name / Mobile and add them to the
 *       offer even if they fall outside the top-10 hard filters.
 *
 * COMMIT MODE is driven by the candidates response's `offerFlowEnabled` (the
 * BE's EFFECTIVE offer-flow gate = property flag AND tbl_job_offer exists). The
 * candidate LIST is identical in both modes — only how we commit differs:
 *
 *   offerFlowEnabled = TRUE  → OFFER-POOL: the operator multi-SELECTS technicians
 *     (row checkboxes) and OFFERS the job to all of them at once via
 *     POST /admin/jobs/:id/offer. The job stays job_status=0 (BOOKED) with no
 *     single owner; each selected tech gets a tbl_job_offer row + an FCM push,
 *     and whoever accepts first on the app wins (race-safe BE-side). The
 *     "Offered to" section lists current offerees with a live "offered N min ago".
 *
 *   offerFlowEnabled = FALSE → DIRECT-ASSIGN: single-SELECT one technician, the
 *     button reads "Assign", and PATCH /admin/jobs/:id/assign bumps the job
 *     BOOKED → SCHEDULED immediately (no offer row, no push, no "Offered to").
 *
 * Backend contract (see /my-orders task spec):
 *   GET  /admin/jobs/:id/candidates?limit=10&jobDate=<ISO>&timeSlot=<slot>
 *   GET  /admin/jobs/:id/candidates/search?term=<q>&jobDate=&timeSlot=
 *   POST /admin/jobs/:id/offer   { easyfixerIds: number[] }  (carries the
 *        proposed schedule too so date/time update + offer happen together)
 *   GET  /admin/jobs/:id/offers  → { items: { efr_id, efr_name, offered_at }[] }
 *
 * Live-location tracking is intentionally DEFERRED — no map / location
 * icon here. A follow-up adds it.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, XCircle, Info, Search, X, MapPin,
  Calendar, CalendarClock, Phone, Loader2, Clock, ChevronDown,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, ApiError, type JobOffersResponse } from '@/lib/api';
import { formatServiceAddress } from '@/lib/format';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { JobRemarksView } from './JobRemarksView';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { formatDate, relativeTime } from '@/lib/utils';
import { CallableMobile } from '@/components/calls/CallButton';
import { StatusChip } from '@/components/ui/StatusChip';
import { InfoTooltip } from '@/components/ui/tooltip';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import { showToast } from '@/components/ui/toast';
import { AddRemarksDialog } from './AddRemarksDialog';
import { CancelWithReasonDialog } from './CancelWithReasonDialog';
import { RescheduleDialog } from './RescheduleDialog';
import { ST } from './JobModal';

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
  /** Completed jobs (status 3/5) — mirrors Manage Easyfixers job_count. < 5 => "Fresher". */
  job_count?: number;
  // Existing ranking fields — optional so the search endpoint (which
  // skips ranking) can omit them.
  score?: number;
  grade?: 'A+' | 'A' | 'B' | 'C' | 'D' | 'E';
  avg_rating?: number;
};

type JobServiceRow = {
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
  // service_category / service_type / deep_skill_label are still projected by the
  // BE and kept on the type (other consumers read them) — but the Job Details
  // grid no longer renders them; `services[]` below is the authoritative
  // per-service breakdown. Don't re-add them to the grid.
  service_category: string | null;
  service_type: string | null;
  deep_skill_label: string | null;
  services?: JobServiceRow[] | null;
  /** Who collects payment — per JOB, not per service. 1=Easyfixer 2=Easyfix 3=Client. */
  collected_by?: number | string | null;
  /** Who pays — per JOB. 2 = the customer pays; anything else = not the customer. */
  paid_by?: number | string | null;
  /** Technician-facing note ("Anything Handyman should keep in mind?") — shown as Additional Comments. */
  efr_special_notes?: string | null;
  client_spoc?: string | null;
  client_spoc_name?: string | null;
  created_by_name?: string | null;
  created_date_time?: string | null;
  job_type: string | null;
  payment_mode: string | null;
  requested_date_time: string | null;
  time_slot: string | null;
  /** Legacy "H AM - H PM" cut-off window — shown as the read-only Time Slot. */
  booking_cut_off_time_slot: string | null;
  job_desc: string | null;
};

/** L1-eligible technician the ranker filtered out at L2, with the reason. */
type RejectedTech = { efr_id: number; efr_name: string | null; reason: string };

type CandidatesResponse = {
  job: ScheduleJob;
  candidates: ScheduleCandidate[];
  limit?: number;
  /** BE's effective offer-flow gate. TRUE → offer-pool; FALSE → direct-assign. */
  offerFlowEnabled?: boolean;
  /** Diagnostics for the empty state: why the Top-10 came back empty. */
  note?: string | null;
  l1Count?: number;
  l2Count?: number;
  rejected?: RejectedTech[];
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
  // Deep-link hardening: this modal opens from a shareable ?action=schedule URL
  // for ANY jobId. Scheduling/offering is only valid for a BOOKED (0) job; a
  // tampered link to any other status (e.g. a completed job) must NOT let the
  // operator schedule/offer. Probe the real status; while it loads we don't block.
  const statusGate = useFetch<{ job_status?: number }>(open && jobId ? `/admin/jobs/${jobId}` : null);
  const statusIneligible = statusGate.data?.job_status != null && Number(statusGate.data.job_status) !== 0;
  const canCommit = hasAction(me, 'isJobAssign') && !statusIneligible;
  // Cancel Job mirrors JobModal's ActionBar gate (the destructive
  // `isJobCancel` key). Add Remarks is NOT permission-gated in JobModal
  // (status-gated only), so we render it unconditionally here too.
  const canCancel = hasAction(me, 'isJobCancel');
  const confirmAction = useConfirm();

  // Footer action dialogs — reuse the SAME extracted dialogs JobModal uses.
  const [remarksOpen, setRemarksOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  // Reschedule dialog — the ONLY way to change the (now read-only) Job Date/Time.
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  // Bumped after a reschedule to REMOUNT JobRemarksView (its comment thread lives
  // in its own useFetch, which invalidateFetch alone can't re-run — see onDone).
  const [remarksReloadKey, setRemarksReloadKey] = useState(0);

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
  // Seeded baseline date — the job's stored date at seed time. Used to detect
  // whether the operator has EDITED the schedule (vs. just the one-time seed),
  // so the expensive Top-10 fetch doesn't re-fire on open.
  const [seedDate, setSeedDate] = useState('');
  const timeSlot = seeded ? deriveTimeSlot(jobDateLocal) : seedSlot;

  const [search, setSearch] = useState('');
  // Search-results paging. CLIENT-side only: the search endpoint hands back the
  // whole match set in one shot (BE caps it at 50), so paging is a pure view
  // slice over an already-fetched array — never a new round-trip. State lives
  // here (not in CandidateTable) because only this component knows when the
  // term changed and the page must go back to 1. The Top-10 is a fixed top-N
  // and is deliberately NOT paged.
  const [searchPage, setSearchPage] = useState(0);
  const [searchPageSize, setSearchPageSize] = useState<TablePageSize>(10);
  // Multi-select offer pool — set of efr_ids the operator has ticked across
  // the Top-10 + search rows. Reset on close.
  const [selected, setSelected] = useState<Map<number, 'top10' | 'search'>>(new Map());
  // True while the commit (offer POST or assign PATCH) is in flight — drives the
  // sticky footer button's spinner + disabled state.
  const [committing, setCommitting] = useState(false);
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
    // Runs on close AND on a job change — every value below is scoped to ONE
    // job, so none of it may survive either. The `jobId` dep was always here for
    // that, but an `if (!open)` guard used to swallow the job-change half:
    // switching straight from job A to job B (the deep-link swaps jobId while
    // `open` stays true) left `retainedJob` holding A, and since
    // `job = top.data?.job ?? retainedJob`, B rendered A's Job Details until the
    // new fetch landed. Worse, `selected` survived too — ops could carry a
    // technician ticked on job A into an offer on job B. retainedJob is a
    // fallback for a failed refetch of the SAME job; it must never outlive one.
    setSeeded(false); setJobDateLocal(''); setSeedSlot(''); setSeedDate('');
    setSearch(''); setCommitting(false); setErr(null); setPincodeModalFor(null);
    setRetainedJob(null); setSelected(new Map());
    setSearchPage(0); setSearchPageSize(10);
  }, [open, jobId]);

  // Toggle a technician's membership in the selection. OFFER mode = multi-select
  // pool; direct-ASSIGN mode (offer flow off) = single-select (picking one
  // replaces the prior pick, re-clicking clears it). `offerMode` is derived
  // below from the candidates response and read here at call time (closure).
  function toggleSelected(efrId: number, source: 'top10' | 'search') {
    setSelected((prev) => {
      if (!offerMode) {
        return prev.has(efrId) ? new Map<number, 'top10' | 'search'>() : new Map([[efrId, source]]);
      }
      const next = new Map(prev);
      if (next.has(efrId)) next.delete(efrId);
      else next.set(efrId, source);
      return next;
    });
  }

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

  // Has the operator EDITED the schedule away from the seeded (job's stored)
  // date? Only then do we append the schedule query. On open, jobDateLocal is
  // seeded to seedDate, so this stays false and the key is schedule-free —
  // preventing the fetch→seed→refetch double round-trip of the expensive
  // Top-10 endpoint. A genuine date edit flips it true and re-ranks (intended).
  const scheduleEdited = seeded && jobDateLocal !== seedDate;

  // (b) TOP 10 — keyed on jobId; the proposed schedule joins the key only
  // after a real edit (scheduleEdited) so the first open is a single fetch.
  const topKey = open && jobId
    ? `/admin/jobs/${jobId}/candidates?limit=10${scheduleEdited ? scheduleQs : ''}`
    : null;
  const top = useFetch<CandidatesResponse>(topKey, { enabled: !!topKey });

  /*
   * ⚠ NEVER read `top.data` directly — read `topData`.
   *
   * useFetch deliberately KEEPS the previous payload while a new key loads
   * (lib/hooks.ts: `s.data == null ? loading : refreshing`), which is what makes
   * param-change refreshes flicker-free. But the hook can't tell "same resource,
   * new params" from "a DIFFERENT ENTITY" — and this key carries the jobId. So
   * on switching job A → B, `top.data` still holds A's job AND A's ranked
   * technicians until B lands, and the modal renders another job's data under
   * B's title. (Ops reported exactly this: "shows the details of the 1st job for
   * a few seconds".) Clearing state on jobId change is NOT enough on its own —
   * the stale payload is re-served by the hook on the very next render.
   *
   * The hook can't fix this without reintroducing the skeleton flash app-wide;
   * the modal, unlike the hook, knows which job it asked for. So: trust the
   * payload only when it IS this job. Everything downstream (Job Details, the
   * Top-10 rows, offerFlowEnabled, the seed) flows from `topData`, so one guard
   * covers them all.
   */
  const topData = top.data && Number(top.data.job?.job_id) === Number(jobId) ? top.data : null;

  // Seed the proposed schedule from the loaded job exactly once.
  // seedSlot captures the job's stored time_slot for display during the seed
  // phase; once seeded, deriveTimeSlot() takes over from the picked date.
  useEffect(() => {
    if (seeded || !topData?.job) return;
    const seededLocal = isoToLocalInput(topData.job.requested_date_time);
    setJobDateLocal(seededLocal);
    setSeedDate(seededLocal);
    setSeedSlot(topData.job.time_slot ?? 'Anytime');
    setSeeded(true);
  }, [seeded, topData]);

  // Retain the last good job so Job Details survive a failed candidate
  // re-fetch (resilience — the flow must not break on a Top-10 error).
  // Scoped to THIS job by the topData guard, and cleared on jobId change.
  useEffect(() => {
    if (topData?.job) setRetainedJob(topData.job);
  }, [topData]);
  const job = topData?.job ?? retainedJob;

  // Job Details is collapsible but starts EXPANDED — ops read it on nearly every
  // open; collapsing is for reclaiming height once they've moved on to picking a
  // technician.
  const [jobDetailsOpen, setJobDetailsOpen] = useState(true);


  // Effective commit mode from the BE (mirrors its own assign-vs-offer gate).
  //   ON  → offer pool: multi-select, "Offer to N Technicians" → POST /offer.
  //   OFF → direct assign: single-select, "Assign" → PATCH /assign (→ SCHEDULED).
  // Defaults to offer mode if the field is absent (older BE) to preserve prior UI.
  const offerMode = topData?.offerFlowEnabled ?? true;

  // (c) SEARCH — debounced via the box; keyed so it re-fires on schedule
  // edits too (computed columns must match the proposed schedule).
  const term = search.trim();
  const searchKey = open && jobId && term
    ? `/admin/jobs/${jobId}/candidates/search?term=${encodeURIComponent(term)}${seeded ? scheduleQs : ''}`
    : null;
  const searchRes = useFetch<SearchResponse>(searchKey, { enabled: !!searchKey });

  // ── Offered-to section ──────────────────────────────────────────────
  // Who the job is currently offered to (open offers). Keyed on jobId so it
  // re-fetches on open; invalidated after a successful offer POST so the new
  // offerees appear immediately. Falls back to an empty list (e.g. when the
  // BE's tbl_job_offer table is absent → endpoint returns { items: [] }).
  const offersKey = open && jobId ? `/admin/jobs/${jobId}/offers` : null;
  const offers = useFetch<JobOffersResponse>(offersKey, { enabled: !!offersKey });

  // Live-time tick — bump a counter every 45s so the "offered N min ago"
  // labels re-render without re-fetching. Cleared on unmount / close.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((t) => t + 1), 45_000);
    return () => clearInterval(id);
  }, [open]);

  // Show search results when a term is present, otherwise the top-10.
  const showingSearch = !!term;
  const rows: ScheduleCandidate[] = showingSearch
    ? (searchRes.data?.candidates ?? [])
    : (topData?.candidates ?? []);
  // `top.loading` is FALSE while a stale payload is on screen (the hook reports
  // `refreshing` instead). Treat "no payload for THIS job yet" as loading, or the
  // list would render another job's technicians as if settled.
  const listLoading = showingSearch ? searchRes.loading : (top.loading || !topData);
  const listError = showingSearch ? searchRes.error : top.error;

  // A new term is a new result set — send the operator back to page 1 rather
  // than stranding them on a page that no longer exists.
  useEffect(() => { setSearchPage(0); }, [term]);

  // The slice actually rendered. `rows` stays whole: the capped-results hint,
  // offer() and assignSingle() all resolve efr_ids against the FULL match set,
  // so a technician ticked on page 1 is still resolvable while page 3 is shown.
  // Selection itself is immune to paging by construction — `selected` is keyed
  // by efr_id and owned here, so it never derives from what the table renders.
  const pageRows = useMemo(() => {
    if (!showingSearch || searchPageSize === 'all') return rows;
    const start = searchPage * searchPageSize;
    return rows.slice(start, start + searchPageSize);
  }, [rows, showingSearch, searchPage, searchPageSize]);

  // Offer the job to every selected technician at once (offer-pool model).
  async function offer() {
    if (!jobId) return;
    const ids = [...selected.keys()];
    if (ids.length === 0) return;
    const techCount = ids.length;
    const techLabel = `${techCount} technician${techCount === 1 ? '' : 's'}`;
    const ok = await confirmAction({
      title: `Offer Job #${jobId} to ${techLabel}?`,
      icon: <AlertTriangle className="h-5 w-5" />,
      iconAccent: 'sky',
      description: (
        <div className="space-y-3">
          <p>
            Job <b>#{jobId}</b> will be offered to <b>{techLabel}</b>.
          </p>
          <ul className="space-y-1.5 text-sm">
            <li>• Offered to <b>{techLabel}</b></li>
            <li>• Each gets a <b>push notification</b></li>
            <li>• <b>First to accept</b> is assigned the job</li>
            {job?.requested_date_time && (
              <li>
                • Schedule: <b>{formatDate(job.requested_date_time)}</b>
                {job.booking_cut_off_time_slot ? <> · {job.booking_cut_off_time_slot}</> : null}
              </li>
            )}
          </ul>
        </div>
      ),
      confirmLabel: `Yes, offer to ${techCount}`,
    });
    if (!ok) return;
    setCommitting(true); setErr(null);
    try {
      // Schedule is owned by the persisted job + the Reschedule flow now — the
      // offer only fans the job out to the pool; it never overwrites date/slot.
      await api.offerJob(jobId, ids, {
        // Per-tech origin (Top-10 list vs Search Result), captured at selection time.
        sourceByEfr: Object.fromEntries(selected),
      });
      // Bust the candidates + offers caches so reopening (and the Offered-to
      // section) reflect the new state.
      invalidateFetch((k) => k.startsWith(`/admin/jobs/${jobId}/candidates`));
      invalidateFetch((k) => k === `/admin/jobs/${jobId}/offers`);
      // Reuse the legacy assigned callback to refresh the caller's list — the
      // first selected technician's identity stands in for the offer (no single
      // owner yet under the offer-pool model).
      const first = rows.find((r) => r.efr_id === ids[0]);
      onAssigned?.(ids[0], first?.efr_name ?? `Efr #${ids[0]}`);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Offer failed');
    } finally {
      setCommitting(false);
    }
  }

  // Direct-assign the single selected technician (offer flow OFF). The BE bumps
  // the job BOOKED → SCHEDULED immediately — no offer row, no push.
  async function assignSingle() {
    if (!jobId) return;
    const id = [...selected.keys()][0];
    if (id == null) return;
    const cand = rows.find((r) => r.efr_id === id);
    const name = cand?.efr_name ?? `Efr #${id}`;
    const ok = await confirmAction({
      title: `Assign Job #${jobId} to ${name}?`,
      icon: <AlertTriangle className="h-5 w-5" />,
      iconAccent: 'sky',
      description: (
        <div className="space-y-3">
          <p>
            Job <b>#{jobId}</b> will be assigned to <b>{name}</b> and scheduled.
          </p>
          <ul className="space-y-1.5 text-sm">
            <li>• Assigned directly to <b>{name}</b> (Efr #{id})</li>
            <li>• Job moves to <b>Scheduled</b></li>
            {job?.requested_date_time && (
              <li>
                • Schedule: <b>{formatDate(job.requested_date_time)}</b>
                {job.booking_cut_off_time_slot ? <> · {job.booking_cut_off_time_slot}</> : null}
              </li>
            )}
          </ul>
        </div>
      ),
      confirmLabel: 'Yes, Assign',
    });
    if (!ok) return;
    setCommitting(true); setErr(null);
    try {
      // Schedule stays as persisted on the job (change it via Reschedule); assign
      // only sets the technician and moves the job to Scheduled.
      await api.assignJob(jobId, id);
      invalidateFetch((k) => k.startsWith(`/admin/jobs/${jobId}/candidates`));
      invalidateFetch((k) => k === `/admin/jobs/${jobId}/offers`);
      onAssigned?.(id, name);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Assign failed');
    } finally {
      setCommitting(false);
    }
  }

  // The modal has no inline-editable fields anymore — Job Date/Time move ONLY
  // through the Reschedule dialog (which persists immediately), so there is
  // nothing to guard on close. Kept wired (not removed) so the Dialog's
  // onOpenChange plumbing is unchanged.
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: () => false,
    when: () => !committing,
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
          {statusIneligible && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              This order isn’t in the “Pending for Scheduling” status — opened read-only. Schedule &amp; Assign is only available for booked, unassigned orders.
            </div>
          )}
          {/* ───────── (a) COMPLETE JOB DETAILS + editable schedule ───────── */}
          {/* Bordered card with an uppercase header button — same shell as
              JobRemarksView so the two collapsibles in this modal read as one
              family. Collapsible, expanded by default. A <button> (not a bare
              div) so it's keyboard-reachable; aria-expanded carries state to AT. */}
          <section className="rounded-md border bg-muted/30">
            <button
              type="button"
              onClick={() => setJobDetailsOpen((o) => !o)}
              aria-expanded={jobDetailsOpen}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-sky-700"
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
                {(job.job_desc || job.efr_special_notes) && (
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
                            {/* Widths keep each service on ONE line: the three text
                                columns truncate under pressure, while Qty / Amount /
                                Billing are content-sized and never wrap. */}
                            <th className="font-medium py-1 pr-3 w-[30%]">Service</th>
                            <th className="font-medium py-1 pr-3 w-[24%]">Category</th>
                            <th className="font-medium py-1 pr-3 w-[24%]">Type</th>
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
                    the Reschedule dialog. Time Slot shows the stored
                    booking_cut_off_time_slot (the customer's booked window). */}
                <div className="mt-3 pt-3 border-t">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div className="flex flex-wrap gap-x-8 gap-y-2">
                      <div className="space-y-0.5">
                        <div className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-3.5 w-3.5" /> Job Date &amp; Time
                        </div>
                        <div className="text-sm font-medium text-foreground">
                          {job.requested_date_time ? formatDate(job.requested_date_time) : '—'}
                        </div>
                      </div>
                      <div className="space-y-0.5">
                        <div className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" /> Time Slot
                        </div>
                        <div className="text-sm font-medium text-foreground">
                          {job.booking_cut_off_time_slot || '—'}
                        </div>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setRescheduleOpen(true)}
                      className="gap-1.5"
                    >
                      <CalendarClock className="h-4 w-4" /> Reschedule
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Job Date &amp; Time are locked. Use <b>Reschedule</b> to change the
                    appointment — a reason and remarks are mandatory, and technicians
                    are re-ranked against the new schedule.
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* Job comments to date. Sits BETWEEN Job Details and the technician
              list (moved up from the modal footer 2026-07-15) — it's context for
              choosing a technician, so it belongs before the choice, not after
              it. Collapsed by default so a long thread can't push the Top 10
              off-screen; the header carries the count so ops can tell at a glance
              whether it's worth opening. */}
          <JobRemarksView key={remarksReloadKey} jobId={jobId} collapsible defaultOpen={false} />

          {/* ───────── Offer history — live + rejected + expired — offer mode only ───────── */}
          {offerMode && (offers.data?.items?.length ?? 0) > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
                Offered To
                <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 border border-slate-200">
                  {offers.data!.items.length}
                </span>
              </h3>
              <p className="mb-2 text-[11px] text-muted-foreground">
                Technicians this job has been offered to — including those who
                declined or whose offer expired. Whoever accepts first on the app
                is assigned; open offers expire after 30 minutes.
              </p>
              <div className="flex flex-wrap gap-2">
                {offers.data!.items.map((o) => {
                  // Colour the status chip by offer_status: REJECTED=rose, EXPIRED=slate,
                  // OFFERED (live) / anything else = amber.
                  const chip =
                    o.offer_status === 2
                      ? 'bg-rose-100 text-rose-700 border-rose-200'
                      : o.offer_status === 3
                        ? 'bg-slate-100 text-slate-600 border-slate-200'
                        : 'bg-amber-100 text-amber-700 border-amber-200';
                  return (
                    <div
                      key={o.efr_id}
                      className="inline-flex items-center gap-2 rounded-full border bg-muted/30 pl-3 pr-3.5 py-1"
                    >
                      <span className="text-sm font-medium text-foreground">{o.efr_name}</span>
                      <span className="text-[10px] text-muted-foreground">#{o.efr_id}</span>
                      {o.offer_status_label && (
                        <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium border ${chip}`}>
                          {o.offer_status_label}
                        </span>
                      )}
                      {o.offer_status === 2 && o.reject_reason && (
                        <span className="text-[10px] text-rose-600" title="Reason given by technician">
                          &ldquo;{o.reject_reason}&rdquo;
                        </span>
                      )}
                      {o.offer_source && (
                        <span className="text-[10px] text-slate-500" title="Where this offer was made from">
                          {o.offer_source === 'top10' ? 'Top-10' : o.offer_source === 'search' ? 'Search' : 'Auto'}
                        </span>
                      )}
                      {(o.offer_count ?? 1) > 1 && (
                        <span className="text-[10px] text-slate-500" title="Times offered">×{o.offer_count}</span>
                      )}
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        offered {relativeTime(o.offered_at)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {err && (
            <div className="text-sm text-red-700 flex items-center gap-1">
              <AlertTriangle className="h-4 w-4" /> {err}
            </div>
          )}

          {/* ───────── (c) SEARCH TECHNICIAN ───────── */}
          <section>
            <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                {showingSearch ? 'Search Results' : 'Top 10 Technicians'}
                {showingSearch && (
                  <InfoTooltip label="What you can search by">
                    <div className="space-y-2">
                      <div className="font-semibold text-slate-900">What you can search by</div>
                      <div>One box — the term is matched against every field below.</div>
                      <ul className="list-disc ml-4 space-y-0.5">
                        <li><strong>Name</strong> — partial match</li>
                        <li><strong>Mobile Number</strong> — partial match</li>
                        <li><strong>City</strong> — partial match on the technician&apos;s registered city</li>
                        <li><strong>Pincode</strong> — the technician&apos;s current pincode, matched on a full 6 digits</li>
                        <li><strong>Technician Id</strong> — exact match</li>
                      </ul>
                      <div className="text-slate-500">Search ignores the Top 10 ranking filters, so it finds any <strong>Active</strong> &amp; <strong>Verified</strong> technician — including ones outside the job&apos;s area.</div>
                    </div>
                  </InfoTooltip>
                )}
                {!showingSearch && (
                  <InfoTooltip label="How the Top 10 is ranked">
                    <div className="space-y-2">
                      <div className="font-semibold text-slate-900">How the Top 10 is ranked</div>
                      <div>Technicians must clear every filter, then are ranked in priority order.</div>
                      <div className="font-medium text-slate-900">Filters</div>
                      <ul className="list-disc ml-4 space-y-0.5">
                        <li><strong>Active</strong> &amp; <strong>Verified</strong> profile</li>
                        <li>Not already <strong>rejected / rescheduled off</strong> this job</li>
                        <li>Holds an <strong>active Deep Skill</strong> matching the job&apos;s <strong>Service Category &amp; Type</strong> — if none match, all in-area technicians are shown instead</li>
                        <li>In the job&apos;s <strong>area</strong> — same <strong>city</strong>, widening to the pincode&apos;s <strong>zone(s)</strong> (by home zone, current pincode, or serviceable pincodes) when fewer than 10 qualify</li>
                        <li>No other <strong>booking in the same date &amp; time slot</strong></li>
                        <li><strong>COD</strong> jobs: account balance <strong>₹500+</strong></li>
                      </ul>
                      <div className="font-medium text-slate-900">Ranked in this order</div>
                      <ol className="list-decimal ml-4 space-y-0.5">
                        <li><strong>Present</strong> for the job date (attendance marked) — present technicians rank first; if fewer than 10 are present, the rest are still listed with a <strong>✗</strong> so the list is never empty</li>
                        <li>then <strong>Worked in this Vertical</strong> before — existing techs first</li>
                        <li>then <strong>Worked for this Client</strong> before</li>
                        <li>then <strong>Past performance</strong> — Rating, TAT &amp; Same-Day-Attempt (tiebreaker)</li>
                      </ol>
                      <div className="text-slate-500">New technicians get neutral default performance so they still compete fairly within each group. <strong>Concurrent-jobs count</strong> and <strong>account balance</strong> are shown as columns but don&apos;t filter the list.</div>
                    </div>
                  </InfoTooltip>
                )}
              </h3>
              <div className="relative w-80 max-w-full">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search Any Technician by Name, Id, City or Pincode"
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
            {/* Only when the BE genuinely truncated (raw matches > the 250 cap).
                Below that the footer pages through every match, so there is
                nothing to warn about — "Refine your search" would be a lie. */}
            {showingSearch && searchRes.data?.capped && (
              <p className="mb-2 text-[11px] text-amber-700">
                More than {rows.length} technicians match — showing the first {rows.length}. Refine your search to see the rest.
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
              showingSearch ? (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  No Technicians Match Your Search.
                </div>
              ) : (
                /* Empty Top-10 — surface WHY, using the ranker's diagnostics.
                   l1Count>0 with rejects ⇒ techs matched skill+area but every
                   one failed a hard gate (attendance / same-slot / balance) —
                   list them so ops can act (e.g. search + offer, or wait for
                   attendance). l1Count 0 ⇒ genuine supply gap. */
                <div className="py-8 px-4 text-sm">
                  <p className="text-center font-medium text-foreground">
                    No Technicians Available For This Job.
                  </p>
                  {(() => {
                    const rej = topData?.rejected ?? [];
                    const l1 = topData?.l1Count ?? 0;
                    // note=no_deep_skill_match ⇒ these techs were surfaced by the
                    // no-skill fallback (matched the AREA, not the exact skill) —
                    // word it accurately rather than claiming a skill match.
                    const noSkill = String(topData?.note ?? '').includes('no_deep_skill_match');
                    if (l1 > 0 && rej.length > 0) {
                      return (
                        <>
                          <p className="mt-1 text-center text-muted-foreground">
                            {noSkill
                              ? <>No technician has the exact deep skill for this job; the {l1} closest in this area {l1 === 1 ? 'is' : 'are'} also unavailable for the selected date &amp; time slot:</>
                              : <>{l1} technician{l1 === 1 ? '' : 's'} matched the required skill &amp; area, but {l1 === 1 ? 'is' : 'are'} unavailable for the selected date &amp; time slot:</>}
                          </p>
                          <ul className="mx-auto mt-3 max-w-md space-y-1">
                            {rej.map((r) => (
                              <li
                                key={r.efr_id}
                                className="flex items-center justify-between gap-3 rounded border bg-muted/20 px-3 py-1.5 text-xs"
                              >
                                <span className="font-medium">{r.efr_name || `Efr #${r.efr_id}`}</span>
                                <span className="text-right text-muted-foreground">{r.reason}</span>
                              </li>
                            ))}
                          </ul>
                          <p className="mt-3 text-center text-[11px] text-muted-foreground">
                            Change the Job Date/time above, or search by name/ID to offer a specific technician.
                          </p>
                        </>
                      );
                    }
                    return (
                      <p className="mt-1 text-center text-muted-foreground">
                        No active, verified technician with the required skill was found in this city
                        {String(topData?.note ?? '').includes('zone') ? ' or its nearby zones' : ''}.
                      </p>
                    );
                  })()}
                </div>
              )
            ) : (
              <>
                <CandidateTable
                  rows={pageRows}
                  loading={listLoading}
                  error={null}
                  showingSearch={showingSearch}
                  canCommit={canCommit}
                  multiSelect={offerMode}
                  selected={selected}
                  onToggleSelected={toggleSelected}
                  onOpenPincodes={setPincodeModalFor}
                  jobId={jobId}
                />
                {/* Search Results only — the Top 10 is a fixed top-N with
                    nothing to page through. `total` is the full match set, not
                    the slice. */}
                {showingSearch && rows.length > 0 && (
                  <TablePagination
                    className="mt-3"
                    page={searchPage}
                    pageSize={searchPageSize}
                    total={rows.length}
                    onPageChange={setSearchPage}
                    onPageSizeChange={(s) => { setSearchPageSize(s); setSearchPage(0); }}
                  />
                )}
              </>
            )}
          </section>

        </div>

        <DialogFooter className="px-6 sm:justify-between">
          {/* LEFT — Add Remarks. Reuses JobModal's extracted dialogs
              (./AddRemarksDialog, ./CancelWithReasonDialog) so behaviour
              stays identical. */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="bg-teal-500 hover:bg-teal-600 text-white border-teal-500 hover:text-white"
              onClick={() => setRemarksOpen(true)}
              disabled={!jobId || committing}
            >
              Add Remarks
            </Button>
          </div>
          {/* RIGHT — destructive Cancel, the primary Offer action, then Close.
              The Offer button replaces the old per-row Assign: it offers the
              job to every selected technician at once and is disabled until at
              least one is ticked. */}
          <div className="flex items-center gap-2">
            {canCancel && (
              <Button
                variant="destructive"
                onClick={() => setCancelOpen(true)}
                disabled={!jobId || committing}
              >
                Cancel
              </Button>
            )}
            <Button variant="outline" onClick={onClose} disabled={committing}>Close</Button>
            {canCommit && (
              <Button
                onClick={offerMode ? offer : assignSingle}
                disabled={!jobId || committing || (offerMode ? selected.size === 0 : selected.size !== 1)}
              >
                {committing
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : offerMode
                    ? (<>Offer to {selected.size} {selected.size === 1 ? 'Technician' : 'Technicians'}</>)
                    : 'Assign'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>

      {/* Serviceable-pincodes "view all" searchable modal. */}
      <PincodeListModal
        candidate={pincodeModalFor}
        onClose={() => setPincodeModalFor(null)}
      />

      {/* Add Remarks — legacy path (no optimistic callbacks); the dialog
          POSTs to /admin/jobs/:id/comments then calls onSaved. */}
      {jobId && (
        <AddRemarksDialog
          open={remarksOpen}
          jobId={jobId}
          onClose={() => setRemarksOpen(false)}
          onSaved={() => {
            showToast({ variant: 'success', message: 'Remark Added' });
            setRemarksOpen(false);
          }}
        />
      )}

      {/* Cancel Job — same PATCH /:id/status contract JobModal uses
          (status=ST.CANCELLED + reasonId + comment). */}
      {jobId && (
        <CancelWithReasonDialog
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          onSubmit={async (reasonId, comment) => {
            await api.patch(`/admin/jobs/${jobId}/status`, {
              status: ST.CANCELLED, reasonId, comment,
            });
            showToast({ variant: 'success', message: 'Job Cancelled' });
            setCancelOpen(false);
            onClose();
          }}
        />
      )}

      {/* Reschedule — the ONLY way to change the (read-only) Job Date/Time. The
          BE persists + audits, then onDone re-ranks candidates and refreshes the
          offer list (open offers get EXPIRED on reschedule) against the new date. */}
      {jobId && (
        <RescheduleDialog
          open={rescheduleOpen}
          jobId={jobId}
          onClose={() => setRescheduleOpen(false)}
          onDone={() => {
            // invalidateFetch only DROPS the cache — it does not re-run a hook
            // that's still mounted, which is why the reschedule used to need a
            // manual page reload. Actually refetch the two mounted queries so the
            // new Job Date + re-ranked candidates + expired offers show at once,
            // and remount JobRemarksView (key bump) so the reschedule comment and
            // any pending-request change appear too.
            top.refetch();
            offers.refetch();
            invalidateFetch((k) =>
              k.startsWith(`/admin/jobs/${jobId}/comments`)
              || k.startsWith(`/admin/jobs/${jobId}/customer-requests`));
            setRemarksReloadKey((n) => n + 1);
          }}
        />
      )}
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
  rows, loading, error, showingSearch, canCommit, multiSelect, selected, onToggleSelected, onOpenPincodes, jobId,
}: {
  rows: ScheduleCandidate[];
  loading: boolean;
  error: string | null;
  showingSearch: boolean;
  canCommit: boolean;
  /** TRUE → offer pool (checkboxes, many); FALSE → direct assign (radio, one). */
  multiSelect: boolean;
  selected: Map<number, 'top10' | 'search'>;
  onToggleSelected: (efrId: number, source: 'top10' | 'search') => void;
  onOpenPincodes: (c: ScheduleCandidate) => void;
  /** Job the candidates are for — tags click-to-call rows so a call to a
   *  candidate technician shows in this job's call history. */
  jobId: number | null;
}) {
  // +1 column when the operator can commit: the select control (checkbox in
  // offer mode, radio in direct-assign mode).
  const COLS = canCommit ? 14 : 13;
  return (
    // Horizontal scroll ONLY (the 13-14 columns can't fit any laptop). There is
    // deliberately no max-height: a capped inner scroller showed ~5 rows and
    // forced ops to scroll a nested area inside an already-scrolling modal. The
    // list is bounded instead — Top-10 by the BE's top-N, Search Results by the
    // page size — so it's the modal body that scrolls, once.
    <div className="border rounded overflow-x-auto thin-scroll">
      <table
        className="data-table text-xs whitespace-nowrap border-separate"
        style={{ borderSpacing: 0 }}
      >
        <thead className="sticky top-0 bg-background z-40 shadow-sm">
          <tr>
            {/* These two are FROZEN, so they need an opaque background or
                horizontally-scrolled cells bleed through. It must be `bg-muted`
                — the shade `.data-table th` already paints every other header
                cell (globals.css). They previously hard-coded `bg-white`, which
                made them read as two pale boxes cut out of the grey header row;
                the empty w-10 select cell in particular looked like a stray
                artifact next to "Technician", most visibly while loading, when
                the colSpan'd "Loading technicians…" row leaves nothing under it. */}
            {canCommit && (
              <th className="!text-center sticky top-0 left-0 bg-muted z-50 w-10" aria-label="Select" />
            )}
            <th
              className={
                '!text-left sticky top-0 bg-muted z-50 shadow-[2px_0_0_0_var(--border)] min-w-[190px] ' +
                (canCommit ? 'left-10' : 'left-0')
              }
            >
              Technician
            </th>
            <th className="!text-center">Attendance for Job Date</th>
            <th className="!text-center">Current Pincode</th>
            <th className="!text-left min-w-[160px]">Serviceable Pincodes</th>
            <th className="!text-center">
              <span className="inline-flex items-center gap-1">
                Distance
                <DistanceTierInfo />
              </span>
            </th>
            <th className="!text-left">Zone Name</th>
            <th className="!text-left min-w-[180px]">Deep Skill Status</th>
            <th className="!text-center">Deep Skill Match</th>
            <th className="!text-center">Worked in Category?</th>
            <th className="!text-center">Worked for Client?</th>
            <th className="!text-center">Concurrent Jobs Count</th>
            <th className="!text-right">Easyfixer Account Balance</th>
            <th className="!text-left">Masked Mobile</th>
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
          {!loading && !error && rows.map((c) => {
            const isSelected = selected.has(c.efr_id);
            return (
            <tr
              key={c.efr_id}
              className={'group hover:bg-muted/40 ' + (isSelected ? 'bg-primary/5' : '')}
            >
              {/* Offer-pool select checkbox — sticky left so it stays reachable
                  no matter how far the wide table is scrolled horizontally.
                  Toggling membership adds/removes the tech from the offer. */}
              {canCommit && (
                <td className={'!text-center sticky left-0 z-20 w-10 ' + (isSelected ? 'bg-primary/5' : 'bg-white group-hover:bg-slate-100')}>
                  <input
                    type={multiSelect ? 'checkbox' : 'radio'}
                    name={multiSelect ? undefined : 'assign-select'}
                    checked={isSelected}
                    onChange={() => onToggleSelected(c.efr_id, showingSearch ? 'search' : 'top10')}
                    aria-label={`Select ${c.efr_name}`}
                    className="h-4 w-4 cursor-pointer accent-primary align-middle"
                  />
                </td>
              )}
              {/* Technician (name + efr_id) — sticky left identifier, offset
                  past the checkbox column when present. */}
              <td className={'!text-left sticky z-20 group-hover:bg-slate-100 shadow-[2px_0_0_0_var(--border)] min-w-[190px] ' + (canCommit ? 'left-10' : 'left-0') + ' ' + (isSelected ? 'bg-primary/5' : 'bg-white')}>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium truncate" title={c.efr_name}>{c.efr_name}</span>
                    {c.job_count != null && c.job_count < 5 && (
                      <StatusChip tone="sky" size="sm" className="shrink-0" title="Completed Less Than 5 Jobs Till Now">Fresher</StatusChip>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground">Efr #{c.efr_id}</div>
                </div>
              </td>

              {/* Attendance for Job Date — green tick / red cross. */}
              <td className="!text-center">
                {c.attendance_for_job_date
                  ? <CheckCircle2 className="inline h-4 w-4 text-emerald-600" aria-label="Present on job date" />
                  : <XCircle className="inline h-4 w-4 text-red-500" aria-label="No attendance for job date" />}
              </td>

              {/* Current Pincode. */}
              <td className="!text-center">
                {c.current_pincode || <span className="text-muted-foreground">—</span>}
              </td>

              {/* Serviceable Pincodes — truncated, hover list, click-to-open. */}
              <td className="!text-left">
                <ServiceablePincodesCell candidate={c} onOpen={() => onOpenPincodes(c)} />
              </td>

              {/* Distance — km on top, tier label muted underneath. */}
              <td className="!text-center">
                <DistanceCell km={c.distance_km} tier={c.distance_tier} />
              </td>

              {/* Zone Name. */}
              <td className="!text-left">
                {c.zone_name || <span className="text-muted-foreground">—</span>}
              </td>

              {/* Deep Skill Status — 3-state enum → label. */}
              <td className="!text-left">{deepSkillStatusLabel(c.deep_skill_status)}</td>

              {/* Deep Skill Match. */}
              <td className="!text-center"><YesNo value={c.deep_skill_match} /></td>

              {/* Worked in Category? */}
              <td className="!text-center"><YesNo value={c.worked_in_category} /></td>

              {/* Worked for Client? */}
              <td className="!text-center"><YesNo value={c.worked_for_client} /></td>

              {/* Concurrent Jobs Count. */}
              <td className="!text-center tabular-nums">{c.concurrent_jobs_count ?? 0}</td>

              {/* Easyfixer Account Balance. */}
              <td className="!text-right font-mono">₹{(c.account_balance ?? 0).toLocaleString('en-IN')}</td>

              {/* Masked Mobile — click-to-call via the shared CallableMobile
                  (resolves unmasked digits server-side from efr_id). */}
              <td className="!text-left">
                {c.mobile
                  ? (
                    <span className="inline-flex items-center gap-1">
                      <CallableMobile efrId={c.efr_id} jobContextId={jobId ?? undefined} mobile={c.mobile} />
                    </span>
                  )
                  : <span className="text-muted-foreground inline-flex items-center gap-1"><Phone className="h-3 w-3" />—</span>}
              </td>
            </tr>
            );
          })}
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
