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

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Search, X, Loader2, Clock,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, ApiError, type JobOffersResponse } from '@/lib/api';
import { useFetch, invalidateFetch, useDebouncedValue } from '@/lib/hooks';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { formatDate, relativeTime, appointmentIsPast } from '@/lib/utils';
import { InfoTooltip } from '@/components/ui/tooltip';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import { showToast } from '@/components/ui/toast';
import { AddRemarksDialog } from './AddRemarksDialog';
import { CancelWithReasonDialog } from './CancelWithReasonDialog';
import { RescheduleDialog } from './RescheduleDialog';
import { ST } from './JobModal';
import { JobContextPanel, type JobServiceRow } from './JobContextPanel';
import {
  CandidateTable, PincodeListModal, type ScheduleCandidate,
} from './CandidateTable';

/*
 * ── Time slot: PASS THROUGH, NEVER DERIVE ──────────────────────────────────
 *
 * The Job Date/Time in this modal is READ-ONLY (the Reschedule dialog is the
 * only way to move it), so there is no hour for the modal to derive a slot
 * from that isn't already the job's own hour. The slot shipped on the
 * candidate-search request is therefore the job's STORED `time_slot`, verbatim.
 *
 * This used to run the picked hour through a 4-band legacy derivation
 * ('Morning 9 to 2' / 'Afternoon 12 to 5' / 'Evening 2 to 7' / 'Anytime') and
 * send THAT. Jobs hold a dozen different slot spellings across the years —
 * today's four bands ('9AM to 12PM' …, see src/lib/job-slots.ts), the backend's
 * own legacy vocabulary, and 1-hour frames like '3 PM–4 PM' written by the
 * WhatsApp confirmation flow — so a locally derived band matched nothing on
 * most rows: the BE overrides `job.time_slot` with whatever we send
 * (candidate-ranking.service searchTechniciansForJob) and then runs the
 * same-day conflict probe as `AND time_slot = ?`. Every technician in the
 * SEARCH table came back conflict-free while the Top-10 table — which never
 * sent the param — correctly flagged the same technicians as double-booked.
 * Two lists in one modal, opposite verdicts, and the operator offering a job
 * to someone already committed to that hour.
 *
 * Empty/absent stays EMPTY (not a fabricated 'Anytime'): the BE only overrides
 * on a non-empty value, so an unslotted job keeps its own NULL and the conflict
 * probe correctly skips rather than matching the literal string 'Anytime'.
 */

/*
 * The technician-row shape (`ScheduleCandidate`) + the CandidateTable /
 * PincodeListModal that render it now live in ./CandidateTable, shared with
 * AssignTechnicianModal so both surfaces present an identical picking table.
 */

/* The per-service row shape (JobServiceRow) + the Services table + Job Details
   grid it feeds now live in ./JobContextPanel, shared with AssignTechnicianModal
   so both surfaces present identical job / services / remarks context. */

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
  /*
   * Server-computed explanation of an EMPTY candidate list (null when there are
   * candidates). Replaces the old catch-all "no verified technician with the
   * required skill in this city", which was shown for every cause — including
   * ones that had nothing to do with skills or the city.
   */
  emptyReason?: {
    code: string;
    message: string;
    counts?: Record<string, number>;
    /* Technicians who DECLINED this job, with the reason each gave — the
       actionable half of "1 declined it". Latest offer per tech, max 10. */
    declined?: Array<{ efr_id: number; efr_name: string | null; reason: string | null }>;
  } | null;
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
  open, onClose, onAssigned, onChanged, jobId,
}: {
  open: boolean;
  onClose: () => void;
  onAssigned?: (efrId: number, efrName: string) => void;
  // Fired for a non-assign change that still mutates the list (e.g. Cancel Job).
  // `onAssigned` carries (efrId, efrName) for the assign path; cancel has neither,
  // so it gets its own arg-less refresh signal the parent wires to its list load.
  onChanged?: () => void;
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
  // True from the moment a reschedule is submitted until the refetch settles.
  // Drives a LOADING state over the schedule row + technician list so ops never
  // sees the stale (pre-reschedule) date/candidates for even a frame — the
  // useFetch hook keeps the old data on screen during a background refetch, which
  // is right for a silent poll but wrong right after ops changed the appointment.
  const [rescheduling, setRescheduling] = useState(false);
  // Guards the clear: only fire once the refetch has actually STARTED (top went
  // refreshing) and then SETTLED — not on the render before refetch kicks in.
  const rescheduleRefetchStarted = useRef(false);

  // Proposed schedule — seeded from the job's current values once it
  // loads. `seeded` guards the one-time seed so a re-fetch doesn't clobber it.
  const [jobDateLocal, setJobDateLocal] = useState('');
  const [seeded, setSeeded] = useState(false);

  // The job's STORED time_slot, captured at seed. Shipped verbatim as the
  // candidate-search `timeSlot` param — never re-derived from the hour. See the
  // "PASS THROUGH, NEVER DERIVE" note at the top of this file.
  const [seedSlot, setSeedSlot] = useState('');
  // Seeded baseline date — the job's stored date at seed time. Used to detect
  // whether the operator has EDITED the schedule (vs. just the one-time seed),
  // so the expensive Top-10 fetch doesn't re-fire on open.
  const [seedDate, setSeedDate] = useState('');
  const timeSlot = seedSlot;

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

  // Clear the post-reschedule loading state once the candidate refetch has both
  // STARTED (top.refreshing went true) and SETTLED (back to false) — so the new
  // date + re-ranked list are in before we drop the loading veil. Keyed on the
  // refetch lifecycle (not on the date changing) so it can't get stuck if ops
  // reschedules to a coincidentally-identical time.
  useEffect(() => {
    if (!rescheduling) return;
    if (top.loading || top.refreshing) { rescheduleRefetchStarted.current = true; return; }
    if (rescheduleRefetchStarted.current) setRescheduling(false);
  }, [rescheduling, top.loading, top.refreshing]);

  // Seed the proposed schedule from the loaded job exactly once.
  // seedSlot captures the job's stored time_slot VERBATIM — including the empty
  // string when the job has none, so the request omits the param entirely and
  // the BE's conflict probe keeps skipping instead of matching a fabricated
  // 'Anytime' literal that no job row holds.
  useEffect(() => {
    if (seeded || !topData?.job) return;
    const seededLocal = isoToLocalInput(topData.job.requested_date_time);
    setJobDateLocal(seededLocal);
    setSeedDate(seededLocal);
    setSeedSlot(topData.job.time_slot ?? '');
    setSeeded(true);
  }, [seeded, topData]);

  // Retain the last good job so Job Details survive a failed candidate
  // re-fetch (resilience — the flow must not break on a Top-10 error).
  // Scoped to THIS job by the topData guard, and cleared on jobId change.
  useEffect(() => {
    if (topData?.job) setRetainedJob(topData.job);
  }, [topData]);
  const job = topData?.job ?? retainedJob;

  // Effective commit mode from the BE (mirrors its own assign-vs-offer gate).
  //   ON  → offer pool: multi-select, "Offer to N Technicians" → POST /offer.
  //   OFF → direct assign: single-select, "Assign" → PATCH /assign (→ SCHEDULED).
  // Defaults to offer mode if the field is absent (older BE) to preserve prior UI.
  const offerMode = topData?.offerFlowEnabled ?? true;

  // (c) SEARCH — debounced via the box; keyed so it re-fires on schedule
  // edits too (computed columns must match the proposed schedule).
  const term = search.trim();
  // Debounce the FETCHED term so the ranking-heavy /candidates/search endpoint
  // fires once the operator pauses typing, not on every keystroke. The search
  // Input stays bound to `search` (instant), so typing itself never lags; only
  // the request (and the top-10↔search toggle) waits for the pause.
  const debouncedTerm = useDebouncedValue(term, 300);
  const searchKey = open && jobId && debouncedTerm
    ? `/admin/jobs/${jobId}/candidates/search?term=${encodeURIComponent(debouncedTerm)}${seeded ? scheduleQs : ''}`
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

  // Show search results when a (debounced) term is present, otherwise the
  // top-10. Keying off the debounced value avoids a flash of the empty search
  // table while the operator is still mid-word.
  const showingSearch = !!debouncedTerm;
  const rows: ScheduleCandidate[] = showingSearch
    ? (searchRes.data?.candidates ?? [])
    : (topData?.candidates ?? []);
  // `top.loading` is FALSE while a stale payload is on screen (the hook reports
  // `refreshing` instead). Treat "no payload for THIS job yet" as loading, or the
  // list would render another job's technicians as if settled.
  // `rescheduling` forces the loading state during the post-reschedule refetch
  // so the Top-10 doesn't show the OLD ranking (ranked against the old date).
  const listLoading = showingSearch ? searchRes.loading : (top.loading || !topData || rescheduling);
  const listError = showingSearch ? searchRes.error : top.error;

  // A new term is a new result set — send the operator back to page 1 rather
  // than stranding them on a page that no longer exists.
  useEffect(() => { setSearchPage(0); }, [debouncedTerm]);

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
          {/* ───────── (a) COMPLETE JOB DETAILS + read-only schedule + remarks ─────────
              Shared with the Assign / Reassign modals via <JobContextPanel>. The
              Reschedule button + "locked" helper + the post-reschedule "Updating…"
              veil are Schedule-&-Assign-only, wired via the flags below. The
              collapsible Job Details starts expanded and Remarks starts collapsed —
              byte-for-byte the same as before the extraction. */}
          <JobContextPanel
            job={job}
            jobId={jobId}
            remarksReloadKey={remarksReloadKey}
            showReschedule
            onReschedule={() => setRescheduleOpen(true)}
            rescheduling={rescheduling}
            /*
             * Only the OFFER path is gated server-side, and the footer button is
             * disabled to match. In assign/reassign mode the action stays
             * available by design, so the notice must not tell the operator to
             * reschedule first — same condition as the button's own `disabled`.
             */
            pastBlocksAction={offerMode}
          />

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
                    /*
                       Prefer the SERVER's diagnosis — it knows which stage
                       emptied the pool (nobody in the city / everyone already
                       offered or declined / all filtered out / no skill match).
                       The old sentence below is the last-resort fallback for a
                       backend that predates emptyReason; it blamed skill+city
                       for every cause, which actively misdirected ops. */
                    if (topData?.emptyReason?.message) {
                      const declined = topData.emptyReason.declined ?? [];
                      return (
                        <>
                          <p className="mt-1 text-center text-muted-foreground">
                            {topData.emptyReason.message}
                          </p>
                          {/* The decline reasons. "1 declined it" is a dead end;
                              WHY they declined is what decides the next move
                              (re-offer / widen / escalate). */}
                          {declined.length > 0 && (
                            <ul className="mx-auto mt-3 max-w-md space-y-1">
                              {declined.map((d) => (
                                <li
                                  key={d.efr_id}
                                  className="flex items-start justify-between gap-3 rounded border bg-muted/20 px-3 py-1.5 text-xs"
                                >
                                  <span className="font-medium shrink-0">
                                    {d.efr_name || `Efr #${d.efr_id}`}
                                  </span>
                                  <span className="text-right text-muted-foreground break-words">
                                    {d.reason || 'Declined — no reason given'}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
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
                /*
                 * A stale appointment blocks OFFERING only — the server refuses
                 * it, so disabling here turns a 400 into an explained control.
                 * Direct Assign stays enabled on purpose: swapping the tech on a
                 * job that is already running late is a legitimate recovery, and
                 * the server does not gate it either.
                 */
                disabled={!jobId || committing
                  || (offerMode ? selected.size === 0 : selected.size !== 1)
                  || (offerMode && appointmentIsPast(job?.requested_date_time))}
                title={offerMode && appointmentIsPast(job?.requested_date_time)
                  ? 'The appointment time has passed — reschedule the job before offering it.'
                  : undefined}
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
            // Refresh the underlying list FIRST (a cancelled job leaves this
            // Pending-for-Scheduling tab), then close. onChanged triggers the
            // parent's in-place `load()` (revalidates without a skeleton flash).
            onChanged?.();
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
            rescheduleRefetchStarted.current = false;
            setRescheduling(true); // veil the stale date/list until the refetch settles
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
