'use client';

/*
 * Assign / Reassign Technician.
 *
 * Used on:
 *   - /my-orders via ?action=assign   → mode='assign'   (BOOKED / status 0)
 *   - /my-orders via ?action=reassign → mode='reassign' (SCHEDULED / status 1,
 *     opened from the Pending-to-Start rows)
 *
 * This modal now presents the SAME technician-picking experience as
 * Schedule & Assign: it renders the shared <CandidateTable> (distance /
 * current pincode / serviceable pincodes / zone / deep-skill status /
 * worked-for-client … columns) fed by the ranked Top-10, plus the SAME
 * server-side technician search (GET /admin/jobs/:id/candidates/search) so
 * ops can pick anyone outside the Top-10 hard filters.
 *
 * The ONLY difference from Schedule & Assign is the COMMIT: this is always a
 * single-technician direct assign — PATCH /admin/jobs/:id/assign
 * { easyfixerId } — never an offer pool. That path fires (fire-and-forget):
 *   - RescheduleTech webhook (reassign, existing tech ≠ new) OR TechAssigned
 *     (fresh assign) — the BE picks by the job's DB state, not a client flag.
 *   - FCM push to the chosen technician.
 *   - Failure-notification email if anything errors before commit.
 * All gated by per-client running_frequency + global NOTIFICATIONS_DISABLE,
 * exactly the way auto-assign honours them — nothing extra is passed here.
 *
 * Backend contract (shared with ScheduleAssignModal — one endpoint, one row
 * shape built by candidate-ranking.service.js `buildCandidateRow`):
 *   GET /admin/jobs/:id/candidates?limit=10           → ranked Top-10
 *   GET /admin/jobs/:id/candidates/search?term=<q>     → match-anyone search
 * In Reassign mode the BE pins the currently-assigned technician first with
 * `is_current=true`; <CandidateTable> highlights that row and makes it
 * non-selectable (you can't reassign a job to the technician already on it).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Search, X, Loader2, CalendarClock } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { useFetch, invalidateFetch, useDebouncedValue } from '@/lib/hooks';
import { InfoTooltip } from '@/components/ui/tooltip';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import { showToast } from '@/components/ui/toast';
import {
  candidateJobOfferEligibility,
  candidateVisibleOnRankedSurface,
  mergeCandidatesByActiveSurface,
} from '@/lib/easyfixer-lifecycle';
import { JobContextPanel, type JobContextData } from './JobContextPanel';
import { CandidateTable, PincodeListModal, type ScheduleCandidate } from './CandidateTable';
import { AddRemarksDialog } from './AddRemarksDialog';
import { RescheduleDialog } from './RescheduleDialog';
import { useCancelJob } from './CancelJob';
import { pendingRescheduleRequest, rescheduleRequestPrefill, type AppRequestDetail } from '@/lib/job-app-request';
import { istNowWallClock, appointmentIsPast, formatDate } from '@/lib/utils';
import { PendingStartConsoleBody } from './PendingStartConsole';
import { JobRemarksView } from './JobRemarksView';
import { JobInternalNotes, type JobNote } from './JobInternalNotes';

/* Job context carried on the candidates response — the SAME enriched job object
   Schedule & Assign reads, rendered by the shared <JobContextPanel>. Typed as
   JobContextData (the panel's shape) so the full details / services / remarks
   scaffolding gets everything it needs; the BE returns a superset. */
type CandidatesResponse = {
  job: JobContextData;
  alreadyAssigned?: boolean;
  /*
   * Server-computed ASSIGNABILITY, from job.jobAssignability — the predicate
   * PATCH /admin/jobs/:id/assign actually enforces. NOT `offerable`: /offer
   * requires BOOKED while /assign refuses only the closed states, so a
   * SCHEDULED job (every reassign) is assignable and never offerable. Reading
   * the offer flag here would make every reassign look refused.
   *
   * ABSENT on an older BE, hence the fallback at every read.
   */
  assignable?: boolean;
  /** Why not, when assignable is false. Currently 'job_closed' / 'unknown_status'. */
  assignBlockReason?: string | null;
  note?: 'no_deep_skill_match' | 'no_eligible_techs' | string | null;
  l1Count?: number;
  l2Count?: number;
  candidates: ScheduleCandidate[];
  rejected?: Array<{ efr_id: number; efr_name: string | null; reason: string }>;
  /* Server-computed explanation of an EMPTY candidate list — see the same
     field on ScheduleAssignModal's TopResponse. */
  emptyReason?: {
    code: string;
    message: string;
    counts?: Record<string, number>;
    declined?: Array<{ efr_id: number; efr_name: string | null; reason: string | null }>;
  } | null;
};

type SearchResponse = {
  job?: JobContextData;
  candidates: ScheduleCandidate[];
  capped?: boolean;
};

export type AssignMode = 'assign' | 'reassign';
/*
 * CURRENT vs UPLIFTED — Reassign only (2026-09-17), the same arrangement as
 * Schedule & Assign. Current is this popup as it has always been. Uplifted
 * swaps the Job Details panel for the Pending to Start job console
 * (PendingStartConsoleBody) and puts remarks + internal notes under the
 * technician list. Everything that ASSIGNS — the ranked list, search, the
 * single selection, the Reassign commit, Cancel, Add Remarks — is shared, so
 * the two tabs can differ in layout but never in what Reassign does.
 */
export type AssignView = 'current' | 'uplifted';

export function AssignTechnicianModal({
  open, onClose, onAssigned, onChanged,
  jobId, mode, initialView = 'current',
}: {
  open: boolean;
  onClose: () => void;
  onAssigned?: (efrId: number, efrName: string) => void;
  /* Any OTHER mutation this modal commits that moves the job out of the
   * caller's list — today just Cancel Job. Separate from onAssigned because
   * that one carries the technician it assigned, and a cancel assigns nobody.
   * Mirrors ScheduleAssignModal, which already splits them the same way. */
  onChanged?: () => void;
  jobId: number | null;
  mode: AssignMode;
  /** Which tab a Reassign opens on: the row's reassign icon → Current, its console icon → Uplifted. */
  initialView?: AssignView;
}) {
  // Modal-internal permission gate. Each per-row select maps to the same legacy
  // action key as the entry icon on my-orders, so a user who can open this modal
  // but not actually commit sees a read-only view with the select column and
  // commit button hidden.
  const { me } = useMe();
  // Deep-link hardening: this modal opens from a shareable ?action=assign|reassign
  // URL for ANY jobId. Assign is valid only for a BOOKED (0) job, Reassign only
  // for a SCHEDULED (1) job — a tampered link to any other status (e.g. a
  // completed job) must NOT let the operator (re)assign. Probe the real status;
  // while it loads (status unknown) we don't block — the modal shows its loader.
  // The same full read also carries `appRequest`, which feeds the
  // "Reschedule Requested" row under Job Date & Time — no second fetch.
  const statusGate = useFetch<{ job_id?: number; job_status?: number; appRequest?: AppRequestDetail | null }>(open && jobId ? `/admin/jobs/${jobId}` : null);
  /*
   * ⚠ IDENTITY-GUARDED, like `topData` below. useFetch RETAINS the previous
   * key's payload (a key change sets `refreshing`, not `loading`; `key = null`
   * makes its effect early-return without clearing) and this modal never
   * unmounts, so working down a list the PREVIOUS job's row stays live for the
   * whole of the next job's request — and this probe is the full getById, the
   * slowest read on the page. Unguarded, the read-only banner answered about
   * the wrong job for about a second.
   */
  const probe = statusGate.data && Number(statusGate.data.job_id) === Number(jobId)
    ? statusGate.data
    : null;
  /*
   * The MODE rule, and it stays local on purpose: Assign applies to a BOOKED
   * job and Reassign to a SCHEDULED one. That is a product decision about which
   * entry point applies, and it is STRICTER than the server — /assign itself
   * refuses only the closed states, so it would happily reassign an IN_PROGRESS
   * job. Widening this to match the server would be a product change nobody
   * asked for, so the narrowing stays; what it must not do is stand in for the
   * server's own refusal, which is what `assignable` below supplies.
   */
  // The technician's open reschedule ask, if any — the panel's highlighted row
  // and the Reschedule dialog's pre-fill both read this one value.
  const rescheduleAsk = pendingRescheduleRequest(probe);
  const allowedStatus = mode === 'reassign' ? 1 : 0;
  const wrongStatusForMode = probe?.job_status != null && Number(probe.job_status) !== allowedStatus;
  const confirmAction = useConfirm();

  const [search, setSearch] = useState('');
  // Single-select pool — at most one technician (direct-assign, never an offer
  // pool). Kept as a Map to satisfy <CandidateTable>'s selection contract; the
  // toggle below enforces the single-entry invariant.
  const [selected, setSelected] = useState<Map<number, 'top10' | 'search'>>(new Map());
  const [committing, setCommitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pincodeModalFor, setPincodeModalFor] = useState<ScheduleCandidate | null>(null);
  // Search-results paging — CLIENT-side slice over the (BE-capped) match set,
  // mirroring Schedule & Assign. The Top-10 is a fixed top-N and is not paged.
  const [searchPage, setSearchPage] = useState(0);
  const [searchPageSize, setSearchPageSize] = useState<TablePageSize>(10);

  // Footer "Add Remarks" + panel "Reschedule" — reuse JobModal's extracted
  // dialogs so both behave exactly as they do in Schedule & Assign.
  const [remarksOpen, setRemarksOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  // Bump to REMOUNT the JobContextPanel's remarks thread after a remark or a
  // reschedule (JobRemarksView owns its own useFetch, which cache-invalidation
  // alone can't re-run — see the onSaved / onDone handlers below).
  const [remarksReloadKey, setRemarksReloadKey] = useState(0);
  // True from reschedule-submit until the candidate refetch settles — veils the
  // schedule row + Top-10 so ops never sees the pre-reschedule date / ranking.
  const [rescheduling, setRescheduling] = useState(false);
  // Guards the veil clear: only fire once the refetch has actually STARTED
  // (top went refreshing) and then SETTLED — not on the render before it kicks in.
  const rescheduleRefetchStarted = useRef(false);

  /*
   * REASSIGN IS UPLIFTED, FULL STOP (ops, 2026-09-25) — the same call made for
   * Schedule & Assign, and for the same reason: two arrangements of one job
   * mean every fix is made and checked twice, and an operator describing a
   * screen has to say which one they are on first. `initialView` is ignored
   * rather than removed from the props, so the caller keeps compiling; it has
   * nothing left to choose.
   */
  const view: AssignView = 'uplifted';
  const uplifted = mode === 'reassign';
  const techRef = useRef<HTMLElement | null>(null);
  const notesRef = useRef<HTMLDivElement | null>(null);
  const [pinnedNotes, setPinnedNotes] = useState<JobNote[]>([]);
  /*
   * REASSIGN ON A PASSED APPOINTMENT → RESCHEDULE FIRST (ops, 2026-09-17).
   * A reassign offers the job to the new technician, and an offer for a time
   * that has gone is refused (the backend's /assign gate says so too). So the
   * Reassign / Change / "Reassign technician" buttons first ask to reschedule;
   * once the reschedule has landed and the list is re-ranked, a popup says the
   * new time and "Proceed to reassign" jumps to the technician list.
   *   reassignIntentRef   the operator asked to reassign and agreed to reschedule
   *   rescheduleSignal    opens the Uplifted body's Reschedule popup
   *   promptReassign      show the "Order rescheduled" popup once re-ranked
   */
  const reassignIntentRef = useRef(false);
  const [rescheduleSignal, setRescheduleSignal] = useState(0);
  const [promptReassign, setPromptReassign] = useState(false);
  /* When the prompt was armed — a prompt still waiting for a readable future
     time after this long is dropped, so a much later, unrelated change can
     never surface "Order rescheduled" out of nowhere. */
  const promptSetAtRef = useRef(0);
  /* The Uplifted body's read of the appointment (undefined until it reports). */
  const [bodyAppointment, setBodyAppointment] = useState<string | null | undefined>(undefined);

  // Reset transient state whenever the modal closes / the job changes.
  useEffect(() => {
    setSearch(''); setSelected(new Map()); setCommitting(false); setErr(null);
    setPincodeModalFor(null); setSearchPage(0); setSearchPageSize(10);
    setRemarksOpen(false); setRescheduleOpen(false);
    setRemarksReloadKey(0); setRescheduling(false);
    reassignIntentRef.current = false; setPromptReassign(false); setBodyAppointment(undefined);
    rescheduleRefetchStarted.current = false;
  }, [open, jobId]);

  // Single-select toggle: picking one replaces the prior pick; re-clicking the
  // same row clears it. Never grows beyond one entry.
  function toggleSelected(efrId: number, source: 'top10' | 'search') {
    const candidate = knownCandidatesById.get(efrId);
    if (candidate) {
      const eligibility = candidateJobOfferEligibility(candidate);
      if (!eligibility.canOffer) {
        setErr(eligibility.explanation);
        return;
      }
    }
    setErr(null);
    setSelected((prev) => (prev.has(efrId) ? new Map() : new Map([[efrId, source]])));
  }

  // (b) TOP 10 — ranked against the job's stored schedule (no date/slot editing
  // here; reassign/assign keep the persisted appointment).
  const topKey = open && jobId ? `/admin/jobs/${jobId}/candidates?limit=10` : null;
  const top = useFetch<CandidatesResponse>(topKey, { enabled: !!topKey });

  // Trust the payload only when it is THIS job — useFetch keeps the previous
  // payload while a new key loads, so on a jobId swap `top.data` briefly holds
  // the old job (see the same guard in ScheduleAssignModal).
  const topData = top.data && Number(top.data.job?.job_id) === Number(jobId) ? top.data : null;

  /*
   * The SERVER's refusal, from the same predicate PATCH /assign enforces.
   * Fail-OPEN only when the field is ABSENT (older BE, payload not in yet) — a
   * present `false` wins, the shape lib/easyfixer-lifecycle.ts already uses for
   * per-technician eligibility. Declared here rather than beside the probe
   * because it reads a payload that is only declared on the line above.
   */
  const serverAssignable = topData?.assignable ?? true;
  const assignBlockReason = topData?.assignBlockReason ?? null;
  const commitBlocked = wrongStatusForMode || !serverAssignable;
  /*
   * Cancel Job — the escape hatch ops asked for (owner, 2026-09-15): they open
   * Reassign to find a replacement, discover there is nobody to send, and had
   * to close the modal and go hunting for another surface to kill the order.
   * Gated on its own legacy key, NOT on canCommit: a user who may cancel a job
   * but not reassign one should still get the button, and vice versa.
   *
   * It IS fenced on `wrongStatusForMode`, which canCommit also carries, and it
   * additionally waits for the probe to answer. This modal opens from a
   * shareable ?action=assign|reassign URL for ANY jobId, and the server's
   * setStatus would cancel a COMPLETED job without complaint unless its
   * completion is already posted to the ledger. A destructive control must not
   * render on a status this modal was never meant to be open at, nor on a
   * status nobody has confirmed yet — which is why this is stricter than the
   * commit button beside it.
   */
  const canCancel = hasAction(me, 'isJobCancel')
    && probe?.job_status != null && !wrongStatusForMode;
  /* The shared cancel control — one label, one write, four surfaces. Refresh
     the caller's list BEFORE closing so the cancelled row leaves without a
     flash; onChanged is awaited by the hook, so that order holds. */
  const cancel = useCancelJob({
    jobId,
    disabled: committing,
    onCancelled: () => { onChanged?.(); onClose(); },
  });
  const canCommit = (mode === 'reassign'
    ? hasAction(me, 'isJobReassign')
    : hasAction(me, 'isJobAssign')) && !commitBlocked;

  // Clear the post-reschedule veil once the candidate refetch has both STARTED
  // (top.refreshing went true) and SETTLED (back to false) — so the new date +
  // re-ranked list are in before we drop the veil. Keyed on the refetch
  // lifecycle (not on the date changing) so it can't get stuck if ops
  // reschedules to a coincidentally-identical time.
  useEffect(() => {
    if (!rescheduling) return;
    if (top.loading || top.refreshing) { rescheduleRefetchStarted.current = true; return; }
    if (rescheduleRefetchStarted.current) setRescheduling(false);
  }, [rescheduling, top.loading, top.refreshing]);

  // (c) SEARCH — match-anyone, keyed on the trimmed term. No schedule params:
  // computed columns match the job's persisted schedule.
  const term = search.trim();
  // Debounce the FETCHED term so the ranking-heavy /candidates/search endpoint
  // fires once the operator pauses typing, not on every keystroke. The search
  // Input stays bound to `search` (instant), so typing itself never lags; only
  // the request (and the top-10↔search toggle) waits for the pause.
  const debouncedTerm = useDebouncedValue(term, 300);
  const searchKey = open && jobId && debouncedTerm
    ? `/admin/jobs/${jobId}/candidates/search?term=${encodeURIComponent(debouncedTerm)}`
    : null;
  const searchRes = useFetch<SearchResponse>(searchKey, { enabled: !!searchKey });

  const showingSearch = !!debouncedTerm;
  const searchData = searchRes.data
    && (!searchRes.data.job || Number(searchRes.data.job.job_id) === Number(jobId))
    ? searchRes.data
    : null;
  const responseRows = useMemo<ScheduleCandidate[]>(() => (
    showingSearch
      ? (searchData?.candidates ?? [])
      : (topData?.candidates ?? [])
  ), [showingSearch, searchData?.candidates, topData?.candidates]);
  // Search intentionally keeps blocked lifecycle states visible (with the
  // reason and a disabled control). Top-10 is the actionable ranking surface,
  // so a defensive client check also hides any non-offerable row should an old
  // or partially deployed backend accidentally return one.
  const rows = useMemo<ScheduleCandidate[]>(() => (
    showingSearch
      ? responseRows
      : responseRows.filter(candidateVisibleOnRankedSurface)
  ), [responseRows, showingSearch]);
  // Keep the latest copy of every candidate already fetched by either bounded
  // endpoint. This lets a lifecycle refresh revoke a prior selection without a
  // per-row request, even after the operator switches between Top-10 and Search.
  const knownCandidatesById = useMemo(() => mergeCandidatesByActiveSurface(
    topData?.candidates ?? [],
    searchData?.candidates ?? [],
    showingSearch,
  ), [searchData?.candidates, showingSearch, topData?.candidates]);

  const blockedSelectedCandidate = useMemo(() => {
    for (const id of selected.keys()) {
      const candidate = knownCandidatesById.get(id);
      if (candidate && !candidateJobOfferEligibility(candidate).canOffer) return candidate;
    }
    return null;
  }, [knownCandidatesById, selected]);

  useEffect(() => {
    if (!blockedSelectedCandidate) return;
    setSelected((previous) => {
      if (!previous.has(blockedSelectedCandidate.efr_id)) return previous;
      const next = new Map(previous);
      next.delete(blockedSelectedCandidate.efr_id);
      return next;
    });
    setErr(candidateJobOfferEligibility(blockedSelectedCandidate).explanation);
  }, [blockedSelectedCandidate]);
  // `top.loading` is FALSE while a stale payload is on screen (the hook reports
  // `refreshing` instead) — treat "no payload for THIS job yet" as loading.
  // `rescheduling` forces the loading state during the post-reschedule refetch
  // so the Top-10 doesn't show the OLD ranking (ranked against the old date).
  const listLoading = showingSearch ? searchRes.loading : (top.loading || !topData || rescheduling);
  const listError = showingSearch ? searchRes.error : top.error;

  // A new (debounced) term is a new result set — reset to page 1.
  useEffect(() => { setSearchPage(0); }, [debouncedTerm]);

  const pageRows = useMemo(() => {
    if (!showingSearch || searchPageSize === 'all') return rows;
    const start = searchPage * searchPageSize;
    return rows.slice(start, start + searchPageSize);
  }, [rows, showingSearch, searchPage, searchPageSize]);

  const job = topData?.job ?? null;
  /*
   * The appointment the "reschedule first" check reads. On Uplifted, the body's
   * /header read — it arrives long before the ranked /candidates payload and is
   * re-read after every action there — so the check is right from first paint
   * and after a request approval. Current falls back to the ranked job.
   */
  const appointmentForGate = uplifted && bodyAppointment !== undefined
    ? bodyAppointment
    : (job?.requested_date_time ?? null);
  /* Both modes: /assign refuses a passed appointment for assign AND reassign. */
  const apptPast = appointmentIsPast(appointmentForGate);
  const scrollToTechnicians = () => techRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  async function startReassign() {
    if (!apptPast) { scrollToTechnicians(); return; }
    const ok = await confirmAction({
      title: 'Reschedule first',
      icon: <AlertTriangle className="h-5 w-5" />,
      iconAccent: 'amber',
      description: (
        <ul className="space-y-1.5 text-sm">
          <li>• The appointment{appointmentForGate ? <> (<b>{formatDate(appointmentForGate)}</b>)</> : null} has already passed.</li>
          <li>• A technician can’t be given a job for a time that has gone.</li>
          <li>• Set a new date and time, then choose the technician.</li>
        </ul>
      ),
      confirmLabel: 'Reschedule now',
      cancelLabel: 'Not now',
    });
    if (!ok) return;
    reassignIntentRef.current = true;
    if (uplifted) setRescheduleSignal((n) => n + 1);
    else setRescheduleOpen(true);
  }

  /*
   * The reschedule has landed and the list re-ranked (the veil is down): say
   * the new time and hand over to the technician list — but only once the
   * appointment we can read is actually in the FUTURE. A refetch that has not
   * caught up yet keeps waiting; on Current (whose only source is /candidates)
   * a failed refetch says so instead of announcing the old, passed time.
   */
  useEffect(() => {
    if (!promptReassign || rescheduling) return;
    if (Date.now() - promptSetAtRef.current > 30_000) { setPromptReassign(false); return; }
    const when = appointmentForGate;
    if (!when || appointmentIsPast(when)) {
      if (!uplifted && top.error) {
        setPromptReassign(false);
        showToast({ variant: 'error', message: 'Rescheduled, but the technician list could not refresh — reopen the popup to reassign.' });
      }
      return;
    }
    setPromptReassign(false);
    void confirmAction({
      title: 'Order rescheduled',
      icon: <CalendarClock className="h-5 w-5" />,
      iconAccent: 'sky',
      description: (
        <div className="space-y-1.5 text-sm">
          <p>Order rescheduled for <b>{formatDate(when)}</b>.</p>
          <p>Now choose the technician to {mode === 'reassign' ? 'reassign it to' : 'assign'}.</p>
        </div>
      ),
      confirmLabel: mode === 'reassign' ? 'Proceed to reassign' : 'Proceed to assign',
      cancelLabel: 'Later',
    }).then((go) => { if (go) scrollToTechnicians(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptReassign, rescheduling, appointmentForGate, top.error, uplifted]);
  const note = topData?.note ?? null;
  const verb = mode === 'reassign' ? 'Reassign' : 'Assign';

  // Commit — single-technician direct assign. PATCH /admin/jobs/:id/assign with
  // the correct `easyfixerId` (the Joi assignBody's required field); the BE
  // fires RescheduleTech (reassign) / TechAssigned (assign) + FCM off the job's
  // DB state, so no notification flags are passed from here.
  async function commitAssign() {
    if (!jobId) return;
    const id = [...selected.keys()][0];
    if (id == null) return;
    const cand = knownCandidatesById.get(id);
    if (cand) {
      const eligibility = candidateJobOfferEligibility(cand);
      if (!eligibility.canOffer) {
        setSelected(new Map());
        setErr(eligibility.explanation);
        return;
      }
    }
    const name = cand?.efr_name ?? `Efr #${id}`;
    const noSkill = cand ? cand.deep_skill_match !== true : false;
    const ok = await confirmAction({
      title: `${verb} Job #${jobId} to ${name}?`,
      icon: <AlertTriangle className="h-5 w-5" />,
      iconAccent: 'sky',
      description: (
        <div className="space-y-3">
          <p>
            Job <b>#{jobId}</b> will be {mode === 'reassign' ? 'reassigned' : 'assigned'} to{' '}
            <b>{name}</b> (Efr #{id}){cand?.mobile ? <> · {cand.mobile}</> : null}.
          </p>
          <ul className="space-y-1.5 text-sm">
            <li>• The technician gets a <b>push notification</b></li>
            <li>• The <b>{mode === 'reassign' ? 'RescheduleTech' : 'TechAssigned'}</b> client webhook fires</li>
            <li>• Failure notifications route per the auto-allocation settings</li>
          </ul>
          {noSkill && (
            <p className="text-warning-strong">
              ⚠ This technician does not hold the deep skill required for this job.
            </p>
          )}
        </div>
      ),
      confirmLabel: `Yes, ${verb}`,
    });
    if (!ok) return;
    setCommitting(true); setErr(null);
    try {
      await api.assignJob(jobId, id);
      onAssigned?.(id, name);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : `${verb} failed`);
    } finally {
      setCommitting(false);
    }
  }

  /*
   * After a reschedule from EITHER tab: veil the stale date / list until the
   * refetch settles, re-rank against the new schedule, and remount the remarks
   * thread so the reschedule comment appears.
   */
  function afterReschedule() {
    reRank();
    reloadRemarks();
    // Only a reschedule the operator started FROM a reassign asks to proceed.
    if (reassignIntentRef.current) {
      reassignIntentRef.current = false;
      promptSetAtRef.current = Date.now();
      setPromptReassign(true);
    }
  }
  /* Veil the stale list and re-rank against the job as it is now. */
  function reRank() {
    rescheduleRefetchStarted.current = false;
    setRescheduling(true);
    // Drop the cached candidate lists (Top-10 + any active search) so the
    // next fetch re-ranks against the new schedule, then actually re-run
    // the mounted Top-10 query — invalidateFetch only DROPS the cache, it
    // can't re-run a still-mounted hook. The job's /header and detail reads
    // are dropped too: the Uplifted body (mounted now or after a tab switch)
    // must not be served the pre-reschedule appointment from the 30s cache.
    invalidateFetch((k) => k.startsWith(`/admin/jobs/${jobId}/candidates`)
      || k === `/admin/jobs/${jobId}/header` || k === `/admin/jobs/${jobId}`);
    top.refetch();
    if (searchKey) searchRes.refetch();
    setBodyAppointment(undefined);
  }
  function reloadRemarks() {
    invalidateFetch((k) =>
      k.startsWith(`/admin/jobs/${jobId}/comments`)
      || k.startsWith(`/admin/jobs/${jobId}/customer-requests`));
    setRemarksReloadKey((n) => n + 1);
  }

  // No inline-editable fields — selecting a technician is not "dirty form data"
  // to guard, so the discard prompt is skipped; the guard only blocks close
  // while a commit is in flight.
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: () => false,
    when: () => !committing,
  });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent
        noPadding
        // Near-full-viewport per ops spec — this modal is data-dense (the wide
        // technician candidate table), so the extra real estate gives it room.
        className="!max-w-none w-[calc(100vw-48px)] h-[calc(100vh-48px)] overflow-hidden flex flex-col"
      >
        <DialogHeader className="px-6 py-4">
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {mode === 'reassign' ? 'Reassign Technician' : 'Assign Technician'}
            {jobId && <span className="text-sm font-normal text-ink-300">· Job #{jobId}</span>}
            {/* The Current / Uplifted switch went on 2026-09-25 with Schedule
                & Assign's: Uplifted is the layout, so there is nothing to
                choose between. */}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-4">
          {commitBlocked && (
            <div className="rounded-md border border-warning bg-warning-tint px-4 py-2 text-sm text-warning-strong">
              {/* Two different refusals wore one sentence. A completed or
                  cancelled job is not "the wrong status for reassignment", it
                  is closed — and that is the server's reason, not ours. */}
              {!serverAssignable && assignBlockReason === 'job_closed'
                ? <>This order is completed or cancelled — opened read-only. A closed order can’t be {mode === 'reassign' ? 'reassigned' : 'assigned'}.</>
                : !serverAssignable
                  ? <>This order can’t be {mode === 'reassign' ? 'reassigned' : 'assigned'} right now — opened read-only.</>
                  : <>This order isn’t in the required status for {mode === 'reassign' ? 'reassignment' : 'assignment'} — opened read-only.</>}
            </div>
          )}

          {/* Full job context — the collapsible Job Details grid + Services
              table + Remarks/Comments thread, shared with Schedule & Assign via
              <JobContextPanel> so both modals present identical job / services /
              remarks information. Like Schedule & Assign it enables the
              Reschedule button + post-reschedule veil (showReschedule /
              onReschedule / rescheduling); only the offer-pool "Offered To" chips
              stay Schedule-&-Assign-only. The currently-assigned technician is
              highlighted by the CandidateTable's amber `is_current` row below,
              not here. */}
          {uplifted ? (
            <PendingStartConsoleBody
              active={open}
              jobId={jobId}
              onChanged={() => { reloadRemarks(); onChanged?.(); }}
              onJobCancelled={() => { onChanged?.(); onClose(); }}
              onRescheduled={() => { statusGate.refetch(); afterReschedule(); }}
              onChangeTechnician={() => { void startReassign(); }}
              openRescheduleSignal={rescheduleSignal}
              onRescheduleClosed={() => { reassignIntentRef.current = false; }}
              /* An approved/rejected technician request can clear the
                 "Reschedule Requested" ask server-side — re-read the probe too. */
              onJobMoved={() => { statusGate.refetch(); reRank(); reloadRemarks(); }}
              onAppointment={setBodyAppointment}
              pinnedNotes={pinnedNotes}
              onShowNotes={() => notesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />
          ) : (
          <JobContextPanel
            job={job}
            jobId={jobId}
            remarksReloadKey={remarksReloadKey}
            showReschedule
            onReschedule={() => setRescheduleOpen(true)}
            rescheduling={rescheduling}
            rescheduleRequest={rescheduleAsk}
            /* /assign refuses a passed appointment (2026-09-17): the notice is
               the blocking strip, not the old "you can still reassign" hint. */
            pastBlocksAction
          />
          )}

          {/* Note banners. */}
          {note === 'no_deep_skill_match' && (
            <div className="rounded-md border border-warning bg-warning-tint p-2 text-xs text-warning-strong flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <strong>No technician holds the deep-skill required for this job.</strong>{' '}
                Showing all candidates that pass the other eligibility checks. Pick someone with caution.
              </div>
            </div>
          )}

          {topData?.alreadyAssigned && mode === 'assign' && (
            <div className="rounded-md border border-info bg-info-tint p-2 text-xs text-info-deep">
              This job is already assigned. Use Reassign to change the technician.
            </div>
          )}

          {err && (
            <div className="text-sm text-urgent-strong flex items-center gap-1">
              <AlertTriangle className="h-4 w-4" /> {err}
            </div>
          )}

          {/* ───────── Technician list + search ─────────
              The ref is the scroll target for Uplifted's "Reassign technician". */}
          <section ref={techRef} className="scroll-mt-4">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                {showingSearch ? 'Search Results' : 'Top 10 Technicians'}
                {showingSearch && (
                  <InfoTooltip label="What you can search by">
                    <div className="space-y-2">
                      <div className="font-semibold text-ink-900">What you can search by</div>
                      <div>One box — the term is matched against every field below.</div>
                      <ul className="list-disc ml-4 space-y-0.5">
                        <li><strong>Name</strong> — partial match</li>
                        <li><strong>Mobile Number</strong> — partial match</li>
                        <li><strong>City</strong> — partial match on the technician&apos;s registered city</li>
                        <li><strong>Pincode</strong> — the technician&apos;s current pincode, matched on a full 6 digits</li>
                        <li><strong>Technician Id</strong> — exact match</li>
                      </ul>
                      <div className="text-ink-500">Search can find technicians outside the Top 10 and in any lifecycle status. Each result shows its status and reason; only rows marked eligible can be assigned.</div>
                    </div>
                  </InfoTooltip>
                )}
                {!showingSearch && (
                  <InfoTooltip label="How the Top 10 is ranked">
                    <div className="space-y-2">
                      <div className="font-semibold text-ink-900">How the Top 10 is ranked</div>
                      <div>Technicians must clear every filter, then are ranked in priority order.</div>
                      <div className="font-medium text-ink-900">Filters</div>
                      <ul className="list-disc ml-4 space-y-0.5">
                        <li>Lifecycle is eligible to <strong>receive new jobs</strong> and the profile is <strong>verified</strong></li>
                        <li>Not already <strong>rejected / rescheduled off</strong> this job</li>
                        <li>Holds an <strong>active Deep Skill</strong> matching the job&apos;s <strong>Service Category &amp; Type</strong> — if none match, all in-area technicians are shown instead</li>
                        <li>In the job&apos;s <strong>area</strong> — same <strong>city</strong>, widening to the pincode&apos;s <strong>zone(s)</strong> when fewer than 10 qualify</li>
                        <li>No other <strong>booking in the same date &amp; time slot</strong></li>
                        <li><strong>Cash</strong> jobs (Paid By Customer): account balance <strong>₹500 or more</strong></li>
                      </ul>
                      <div className="text-ink-500">New technicians get neutral default performance so they still compete fairly. <strong>Concurrent-jobs count</strong> and <strong>account balance</strong> are shown as columns; only the balance filters, and only on cash jobs.</div>
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

            {showingSearch && searchRes.data?.capped && (
              <p className="mb-2 text-xs text-warning-strong">
                More than {rows.length} technicians match — showing the first {rows.length}. Refine your search to see the rest.
              </p>
            )}

            {/* Error + empty states render as a MODAL-WIDTH centered message —
                NOT inside the wide, horizontally scrolling table. */}
            {!listLoading && listError ? (
              <div className="py-12 text-center text-sm text-urgent-strong">
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
                <div className="py-8 px-4 text-sm">
                  <p className="text-center font-medium text-foreground">
                    No Technicians Available For This Job.
                  </p>
                  {(() => {
                    const rej = topData?.rejected ?? [];
                    const l1 = topData?.l1Count ?? 0;
                    if (l1 > 0 && rej.length > 0) {
                      return (
                        <>
                          <p className="mt-1 text-center text-muted-foreground">
                            {l1} technician{l1 === 1 ? '' : 's'} matched the required skill &amp; area, but {l1 === 1 ? 'is' : 'are'} unavailable for this job&apos;s date &amp; time slot:
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
                          <p className="mt-3 text-center text-xs text-muted-foreground">
                            Search by name / ID to pick a specific technician.
                          </p>
                        </>
                      );
                    }
                    // Server diagnosis first — it knows which stage emptied the
                    // pool. The sentence below is the pre-emptyReason fallback.
                    if (topData?.emptyReason?.message) {
                      const declined = topData.emptyReason.declined ?? [];
                      return (
                        <>
                          <p className="mt-1 text-center text-muted-foreground">
                            {topData.emptyReason.message}
                          </p>
                          {/* Decline reasons — see ScheduleAssignModal for the why. */}
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
                        No active, verified technician with the required skill was found in this city or its nearby zones.
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
                  multiSelect={false}
                  selected={selected}
                  onToggleSelected={toggleSelected}
                  onOpenPincodes={setPincodeModalFor}
                  jobId={jobId}
                />
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

          {/* Uplifted: remarks two thirds, internal notes one third, under the
              technician list at one fixed height — the same bottom row as
              Schedule & Assign. Current keeps remarks inside its Job Details. */}
          {uplifted && (
            <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
              <div className="h-96 min-h-0">
                <JobRemarksView key={`${jobId}-${remarksReloadKey}`} jobId={jobId} fill />
              </div>
              <div ref={notesRef} className="h-96 min-h-0 scroll-mt-4">
                <JobInternalNotes key={jobId ?? 'none'} jobId={jobId} canAdd onPinnedChange={setPinnedNotes} fill />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="px-6 sm:justify-between">
          {/* LEFT — Add Remarks. Reuses JobModal's extracted AddRemarksDialog, in
              the SAME bottom-left position / variant / label as Schedule & Assign. */}
          <div className="flex items-center gap-2">
            {/*
              * (c) HOVER-ONLY FIX — green CTA hover pinned to one dark green in
              * BOTH themes, the same idiom the nine buttons on
              * easyfixers/[id]/verification carry.
              *
              * Resting is fine: `--success` is STABLE — 148.85 70.81% 36.27% in
              * `:root` and in `.dark` — so `bg-success text-white` holds either
              * way. Only the hover inverted. `--success-strong` and
              * `--success-tint` swap WITH EACH OTHER between themes, so a bare
              * `hover:bg-success-strong` measured
              *
              *   light  --success-strong  20.78%  rgb(14,92,52)     8.08:1 vs white ✓
              *   dark   --success-strong  92.35%  rgb(226,245,234)  1.14:1 vs white ✗
              *
              * i.e. Add Remarks went near-white under its white label the moment
              * the pointer touched it in dark mode. Because the pair swaps, dark
              * `--success-tint` IS rgb(14,92,52) — bit-identical to the
              * light-mode hover — so naming both halves pins that one dark green
              * everywhere. `dark:hover:` compiles to two classes against
              * `hover:`'s one, so it wins on specificity regardless of order.
              *
              * LIGHT THEME IS UNCHANGED: the `dark:` half never applies there.
              */}
            <Button
              variant="outline"
              className="bg-success hover:bg-success-strong dark:hover:bg-success-tint text-white border-success hover:text-white"
              onClick={() => setRemarksOpen(true)}
              disabled={!jobId || committing}
            >
              Add Remarks
            </Button>
          </div>
          {/* RIGHT — destructive Cancel, then Close, then the single-technician
              (Re)Assign commit. Cancel-first matches the job-modal footer
              convention (Add Remarks left; Cancel · lifecycle · Close right)
              and Schedule & Assign's identical cluster. */}
          <div className="flex items-center gap-2">
            {canCancel && cancel.button}
            <Button variant="outline" onClick={onClose} disabled={committing}>Close</Button>
            {canCommit && (
              <Button
                /* On a passed appointment Reassign asks to reschedule first
                   instead of committing — clickable even with nobody picked,
                   so the operator is told what to do rather than stuck. */
                onClick={apptPast ? () => { void startReassign(); } : commitAssign}
                disabled={!jobId || committing
                  || (!apptPast && (selected.size !== 1 || blockedSelectedCandidate != null))}
                title={apptPast
                  ? 'The appointment has passed — reschedule first, then reassign'
                  : blockedSelectedCandidate
                    ? candidateJobOfferEligibility(blockedSelectedCandidate).explanation
                    : undefined}
              >
                {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : verb}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>

      {/* Serviceable-pincodes "view all" searchable modal (shared). */}
      <PincodeListModal
        candidate={pincodeModalFor}
        onClose={() => setPincodeModalFor(null)}
      />

      {/* Add Remarks — legacy path (no optimistic callbacks): the dialog POSTs
          to /admin/jobs/:id/comments then calls onSaved. On save we bust the
          comments cache and bump remarksReloadKey so the JobContextPanel remarks
          thread remounts and shows the new remark. */}
      {jobId && (
        <AddRemarksDialog
          open={remarksOpen}
          jobId={jobId}
          onClose={() => setRemarksOpen(false)}
          onSaved={() => {
            showToast({ variant: 'success', message: 'Remark Added' });
            setRemarksOpen(false);
            invalidateFetch((k) => k.startsWith(`/admin/jobs/${jobId}/comments`));
            setRemarksReloadKey((n) => n + 1);
          }}
        />
      )}

      {/* Sibling of DialogContent, where every dialog in this estate is mounted. */}
      {cancel.dialog}

      {/* Reschedule — persists + audits the new schedule, then onDone re-ranks
          the Top-10 against the job's now-updated PERSISTED schedule. This
          modal's candidate key carries no jobDate/timeSlot params, so a plain
          refetch re-ranks correctly — no proposed-schedule preview needed. */}
      {jobId && !uplifted && (
        <RescheduleDialog
          open={rescheduleOpen}
          jobId={jobId}
          // Pre-fill from the technician's open ask (future time + remarks).
          {...rescheduleRequestPrefill(rescheduleAsk, istNowWallClock())}
          /* RescheduleDialog calls onDone BEFORE onClose, so a save consumes the
             reassign intent first and a plain close (no save) drops it. */
          onClose={() => { setRescheduleOpen(false); reassignIntentRef.current = false; }}
          onDone={() => {
            // A reschedule clears the technician's reschedule ask server-side
            // (resolveAppRequests), so re-read the detail probe or the
            // "Reschedule Requested" row outlives the ask it answered.
            statusGate.refetch();
            afterReschedule();
          }}
        />
      )}
    </Dialog>
  );
}
