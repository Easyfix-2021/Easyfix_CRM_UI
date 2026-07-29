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
import { AlertTriangle, Search, X, Loader2 } from 'lucide-react';
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
import { JobContextPanel, type JobContextData } from './JobContextPanel';
import { CandidateTable, PincodeListModal, type ScheduleCandidate } from './CandidateTable';
import { AddRemarksDialog } from './AddRemarksDialog';
import { RescheduleDialog } from './RescheduleDialog';

/* Job context carried on the candidates response — the SAME enriched job object
   Schedule & Assign reads, rendered by the shared <JobContextPanel>. Typed as
   JobContextData (the panel's shape) so the full details / services / remarks
   scaffolding gets everything it needs; the BE returns a superset. */
type CandidatesResponse = {
  job: JobContextData;
  alreadyAssigned?: boolean;
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

export function AssignTechnicianModal({
  open, onClose, onAssigned,
  jobId, mode,
}: {
  open: boolean;
  onClose: () => void;
  onAssigned?: (efrId: number, efrName: string) => void;
  jobId: number | null;
  mode: AssignMode;
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
  const statusGate = useFetch<{ job_status?: number }>(open && jobId ? `/admin/jobs/${jobId}` : null);
  const allowedStatus = mode === 'reassign' ? 1 : 0;
  const statusIneligible = statusGate.data?.job_status != null && Number(statusGate.data.job_status) !== allowedStatus;
  const canCommit = (mode === 'reassign'
    ? hasAction(me, 'isJobReassign')
    : hasAction(me, 'isJobAssign')) && !statusIneligible;
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

  // Reset transient state whenever the modal closes / the job changes.
  useEffect(() => {
    setSearch(''); setSelected(new Map()); setCommitting(false); setErr(null);
    setPincodeModalFor(null); setSearchPage(0); setSearchPageSize(10);
    setRemarksOpen(false); setRescheduleOpen(false);
    setRemarksReloadKey(0); setRescheduling(false);
    rescheduleRefetchStarted.current = false;
  }, [open, jobId]);

  // Single-select toggle: picking one replaces the prior pick; re-clicking the
  // same row clears it. Never grows beyond one entry.
  function toggleSelected(efrId: number, source: 'top10' | 'search') {
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
  const rows: ScheduleCandidate[] = showingSearch
    ? (searchRes.data?.candidates ?? [])
    : (topData?.candidates ?? []);
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
    const cand = rows.find((r) => r.efr_id === id);
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
            <p className="text-amber-700">
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
          <DialogTitle className="flex items-center gap-2">
            {mode === 'reassign' ? 'Reassign Technician' : 'Assign Technician'}
            {jobId && <span className="text-sm font-normal text-slate-300">· Job #{jobId}</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-4">
          {statusIneligible && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              This order isn’t in the required status for {mode === 'reassign' ? 'reassignment' : 'assignment'} — opened read-only.
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
          <JobContextPanel
            job={job}
            jobId={jobId}
            remarksReloadKey={remarksReloadKey}
            showReschedule
            onReschedule={() => setRescheduleOpen(true)}
            rescheduling={rescheduling}
          />

          {/* Note banners. */}
          {note === 'no_deep_skill_match' && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <strong>No technician holds the deep-skill required for this job.</strong>{' '}
                Showing all candidates that pass the other eligibility checks. Pick someone with caution.
              </div>
            </div>
          )}

          {topData?.alreadyAssigned && mode === 'assign' && (
            <div className="rounded-md border border-blue-300 bg-blue-50 p-2 text-xs text-blue-900">
              This job is already assigned. Use Reassign to change the technician.
            </div>
          )}

          {err && (
            <div className="text-sm text-red-700 flex items-center gap-1">
              <AlertTriangle className="h-4 w-4" /> {err}
            </div>
          )}

          {/* ───────── Technician list + search ───────── */}
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
                        <li>In the job&apos;s <strong>area</strong> — same <strong>city</strong>, widening to the pincode&apos;s <strong>zone(s)</strong> when fewer than 10 qualify</li>
                        <li>No other <strong>booking in the same date &amp; time slot</strong></li>
                        <li><strong>COD</strong> jobs: account balance <strong>₹500+</strong></li>
                      </ul>
                      <div className="text-slate-500">New technicians get neutral default performance so they still compete fairly. <strong>Concurrent-jobs count</strong> and <strong>account balance</strong> are shown as columns but don&apos;t filter the list.</div>
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
              <p className="mb-2 text-[11px] text-amber-700">
                More than {rows.length} technicians match — showing the first {rows.length}. Refine your search to see the rest.
              </p>
            )}

            {/* Error + empty states render as a MODAL-WIDTH centered message —
                NOT inside the wide, horizontally scrolling table. */}
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
                          <p className="mt-3 text-center text-[11px] text-muted-foreground">
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
        </div>

        <DialogFooter className="px-6 sm:justify-between">
          {/* LEFT — Add Remarks. Reuses JobModal's extracted AddRemarksDialog, in
              the SAME bottom-left position / variant / label as Schedule & Assign. */}
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
          {/* RIGHT — Close, then the single-technician (Re)Assign commit. */}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={committing}>Close</Button>
            {canCommit && (
              <Button
                onClick={commitAssign}
                disabled={!jobId || committing || selected.size !== 1}
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

      {/* Reschedule — persists + audits the new schedule, then onDone re-ranks
          the Top-10 against the job's now-updated PERSISTED schedule. This
          modal's candidate key carries no jobDate/timeSlot params, so a plain
          refetch re-ranks correctly — no proposed-schedule preview needed. */}
      {jobId && (
        <RescheduleDialog
          open={rescheduleOpen}
          jobId={jobId}
          onClose={() => setRescheduleOpen(false)}
          onDone={() => {
            // Veil the stale date / list until the refetch settles.
            rescheduleRefetchStarted.current = false;
            setRescheduling(true);
            // Drop the cached candidate lists (Top-10 + any active search) so the
            // next fetch re-ranks against the new schedule, then actually re-run
            // the mounted Top-10 query — invalidateFetch only DROPS the cache, it
            // can't re-run a still-mounted hook.
            invalidateFetch((k) => k.startsWith(`/admin/jobs/${jobId}/candidates`));
            top.refetch();
            // Remount the remarks thread so the reschedule comment + any actioned
            // customer request appear.
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
