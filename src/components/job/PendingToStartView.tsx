'use client';

/*
 * PendingToStartView — dedicated view for My Orders ?tab=pending-start
 * (job_status = 1 SCHEDULED, "Pending to Start"). Legacy-CRM parity.
 *
 * Why this is its own component (not the shared /my-orders table):
 *   Pending to Start has a DISTINCT shape vs the other lifecycle tabs — its own
 *   state tabs, the scheduling filter bar and a row grammar (technician
 *   click-to-call, request decisions, live location, Resend PIN) that none of
 *   them share. The shared table in my-orders/page.tsx is used by ~9 other tabs
 *   and must stay untouched, so this mirrors how the Unconfirmed tab renders
 *   <UnconfirmedSections/> and Pending-for-Scheduling renders its own branch.
 *
 * ─── THE TABS MODEL (2026-09-16) ─────────────────────────────────────────
 *
 * This view used to stack four reorderable, independently-paged sections —
 * Technician Requests / Over Due / Action Today / Future — each its own
 * /admin/jobs call, three of them with an IST date window computed here. It is
 * now what Pending for Scheduling became the same day: ONE tab strip
 * (<PendingStartTabs/>) over ONE server-paged table.
 *
 *   All · Slots missed · Reschedule request · Cancel request · Today · Future
 *
 * Two reasons. The sections OVERLAPPED — a job with an open request was listed
 * under Technician Requests and again under its appointment bucket, so the four
 * totals never summed to the queue. And the two queues ops work through back
 * to back now look and behave alike: same strip, same filter bar, same URL.
 *
 * THE SERVER OWNS THE PARTITION. Each tab is one `ptsState` on GET /admin/jobs
 * (status=1 pinned; no ptsState = All), mutually exclusive by priority
 *   cancel / reschedule → the technician's pending app request of that kind
 *   missed              → no request, appointment before today (IST)
 *   today               → no request, appointment today (IST)
 *   future              → no request, appointment tomorrow or later
 * so this file computes no day boundary at all. The old startDate/endDate
 * windows, and the +05:30 serialisation they needed to survive a browser in
 * another timezone, are gone with the sections.
 *
 * A request outranks the clock because it is the question of whether the job
 * is due at all, and the only thing here waiting on an operator rather than on
 * a date: a missed slot the technician has asked to move is a reschedule ask.
 * The per-row predicate and the cancel-vs-reschedule discrimination still live
 * in `@/lib/job-app-request` (tested; see tests/job-app-request.test.js) —
 * this file only renders them.
 *
 * ─── FILTERS, SEARCH AND THE URL ─────────────────────────────────────────
 *
 * The filter bar IS Pending for Scheduling's <PendingSchedulingFilters/> with
 * `hideOfferState` (Service Category, City, Client, Zonal Manager), persisted
 * under the SAME `ps*` params through the same helpers — one param contract,
 * not a lookalike. The selected tab is `ptsTab`. Both hydrate in a useState
 * initializer, so the first request already carries a bookmarked view.
 *
 * Search stays this view's own: debounced, instant, not written to the URL
 * (the page already writes `q` from its own box, and two writers of one param
 * would clobber each other).
 *
 * Reuses (never re-implements): the parent's openView / openReassign handlers +
 * canJob permission flags, useFetch, PendingSchedulingFilters and its ps* URL
 * helpers, StatusChip + PendingStartLiveStatus, CallableMobile (Client SPOC
 * spocJobId pattern), TechRequestActions, ResendPinButton, TablePagination,
 * formatDate, formatEasyfixerName.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, RefreshCw, MapPin, Eye, PanelsTopLeft } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { StatusChip } from '@/components/ui/StatusChip';
import { RefreshBar } from '@/components/ui/refresh-bar';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { CallableMobile } from '@/components/calls/CallButton';
import { CallHistoryButton } from '@/components/calls/CallHistoryButton';
import { ResendPinButton, RESEND_PIN_ACTION } from '@/components/job/ResendPinButton';
import { TechRequestActions, APP_REQUEST_ACTION } from '@/components/job/TechRequestActions';
import { ShareChip } from '@/components/job/JobShareControls';
import {
  PendingSchedulingFilters,
  psFiltersFromParams,
  writePsFilterParams,
  psFilterKey,
  psAnyFilterSet,
  psQueryParams,
  type PsFilters,
} from '@/components/job/PendingSchedulingFilters';
import { PendingStartTabs, toPtsState, type PtsState } from '@/components/job/PendingStartTabs';
import { PendingStartLiveStatus, useMinuteClock } from '@/components/job/PendingStartLiveStatus';
import { useFetch, invalidateFetch, useDebouncedValue } from '@/lib/hooks';
import { formatJobAge, jobAgeTitle, type JobAgeFields } from '@/lib/job-age';
import { appRequestOf, type AppRequestFields } from '@/lib/job-app-request';
import type { JobShare } from '@/lib/job-share';
import { buildJobsKey } from '@/lib/jobs-query';
import { SortHeader, type SortDir } from '@/lib/use-sort';
import { useJobActionParams } from '@/lib/job-action-url';
import {
  formatDate,
  formatEasyfixerName,
} from '@/lib/utils';
import type { Me } from '@/lib/auth-context';

// `/admin/jobs` Joi caps limit at 500 — pass to pageSizeToLimit so "All"
// sends 500 instead of the default 1000 (which would 400). Mirrors the value
// used by /my-orders + /jobs.
const JOBS_MAX_LIMIT = 500;

/*
 * The selected tab's URL param. Exported so a host that clears this view's
 * scope (the page's "Show All Orders") can drop it along with the ps* filters,
 * instead of leaving a `?ptsTab=` behind that reads like an applied state.
 */
export const PTS_TAB_PARAM = 'ptsTab';

/*
 * The tabs whose rows can carry an open app request — All and the two request
 * tabs — and therefore the only ones that show the Request column. On Slots
 * missed / Today / Future the server has already excluded every request row, so
 * the column would be a full-height stack of dashes.
 */
const REQUEST_COLUMN_TABS: ReadonlySet<PtsState> = new Set<PtsState>(['', 'reschedule', 'cancel']);

/* What an empty tab says. Keyed by the state so a new tab cannot ship without one. */
const EMPTY_COPY: Record<PtsState, string> = {
  '': 'No orders pending to start',
  missed: 'No orders with a missed slot',
  reschedule: 'No reschedule requests',
  cancel: 'No cancel requests',
  today: 'No orders due today',
  future: 'No orders due tomorrow or later',
};

/*
 * `offerState` is Pending-for-Scheduling's sub-state (the offer lifecycle of a
 * status-0 job). Every row here is status 1, past that lifecycle, so the value
 * is pinned to '' on the way in from the URL AND on every change: the ps*
 * params are shared with the scheduling tab, and a `?psOfferState=` carried
 * over from it must never narrow this queue to a filter it has no control for.
 */
function withoutOfferState(f: PsFilters): PsFilters {
  return f.offerState ? { ...f, offerState: '' } : f;
}

// Row projection — the subset of the shared LIST columns this view renders.
// Kept local (not imported from the page) to avoid a circular import; the
// fields all come from the same /admin/jobs LIST projection.
type PendingJobRow = JobAgeFields & AppRequestFields & {
  job_id: number;
  job_status: number;
  /*
   * Delegation. `fk_easyfixter_id` NEVER moves on a share, so every technician
   * column below keeps naming the original while somebody else does the work —
   * the chip is the only thing on the row that says so. Optional: a BE deploy
   * predating the share feature simply yields no chip. Same shape and the same
   * `<ShareChip share={j.share} className="ml-1" />` placement as /my-orders,
   * /jobs and JobModal.
   */
  share?: JobShare | null;
  // Family reference shared across sibling jobs of a multi-category booking —
  // already on the shared /admin/jobs LIST projection; surfaced so ops can spot
  // linked orders. Optional so older API responses don't break the type narrow.
  job_reference_id?: string | null;
  fk_easyfixter_id: number | null;
  easyfixer_name: string | null;
  // Assigned technician's mobile (ef.efr_no AS easyfixer_mobile) — masked in
  // transit by the mask middleware (first-4-then-bullets); dialled via
  // CallableMobile targeting fk_easyfixter_id, so the FE never holds the clear
  // number. Null on unassigned rows.
  easyfixer_mobile: string | null;
  city_name: string | null;
  client_name: string | null;
  // Customer identity — already on the shared /admin/jobs LIST projection
  // (JOB_CUSTOMER_NAME_EXPR AS customer_name, cu.customer_mob_no). Not rendered
  // as a column here; read only for the Resend Customer PIN confirmation copy,
  // so the operator sees WHO is about to be texted. The mobile arrives masked
  // (first-4-then-bullets) from middleware/mask-mobile.js.
  customer_name: string | null;
  customer_mob_no: string | null;
  address: string | null;
  scheduled_date_time: string | null;
  requested_date_time: string | null;
  client_spoc: string | null;
  client_spoc_name: string | null;
};
type Resp = { items: PendingJobRow[]; total: number; limit: number; offset: number };

export type PendingToStartViewProps = {
  me: Me | null | undefined;
  isAdmin: boolean;
  // Permission flags from the page's actionFlags(me, …) — read here for
  // isJobReassign, RESEND_PIN_ACTION and APP_REQUEST_ACTION.
  canJob: Record<string, boolean>;
  /* Reused page handlers — do NOT re-implement their logic. */
  /* Read-only viewer, same page-owned modal the other tabs' Eye opens. */
  openView: (jobId: number) => void;
  openReassign: (jobId: number) => void;
  // Opens the page-owned LiveLocationPopover for a row's assigned technician.
  // The popover only polls (every 15s) WHILE OPEN, so this stays on-demand —
  // there's no eager per-row location fetch on this unified backend.
  onShowLocation: (row: { job_id: number; easyfixer_name: string | null }) => void;
  /*
   * The strip's way back to every order, exactly as on Pending for Scheduling.
   * Optional: without it the strip simply offers no way out rather than a
   * button that does nothing.
   */
  onShowAll?: () => void;
  /* Job Stage Access keeps this user inside the bucket — the strip then says so
   * instead of offering "Show All Orders". */
  scopeClamped?: boolean;
  /* Opens the job console for a row. The row icon renders only when provided. */
  onOpenConsole?: (jobId: number) => void;
};

export function PendingToStartView({
  me,
  isAdmin,
  canJob,
  openView,
  openReassign,
  onShowLocation,
  onShowAll,
  scopeClamped = false,
  onOpenConsole,
}: PendingToStartViewProps) {
  // Role-aware owner scope — mirror the page: admins see everyone's queue,
  // everyone else only their own owned jobs.
  const ownerId = isAdmin ? undefined : me?.user.user_id;

  /*
   * Tab + filters hydrate from the URL on first render (useSearchParams() is
   * stable at first render in the App Router), so a shared or bookmarked link
   * fires its FIRST request already narrowed, instead of an unfiltered one that
   * a follow-up effect corrects.
   */
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [ptsTab, setPtsTab] = useState<PtsState>(() => toPtsState(searchParams.get(PTS_TAB_PARAM)));
  const [filters, setFilters] = useState<PsFilters>(() => withoutOfferState(psFiltersFromParams(searchParams)));
  // A string beats an object identity as a dependency: it changes on real
  // value changes only, never on every setState.
  const filterKey = psFilterKey(filters);

  // Free-text search. Debounced so it queries the BE `q` (multi-field: Job #,
  // customer, mobile, client, city, technician, owner, SPOC) once the operator
  // pauses, not per keystroke. Instant-apply, like the filters beside it.
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  /*
   * reloadKey bumps after anything that can move a job between tabs, and
   * reaches BOTH the table and the strip: the counts are a separate request, so
   * without it the strip keeps last minute's numbers over a fresh table. The
   * eviction covers /admin/jobs/pending-start/counts too (same prefix).
   */
  const [reloadKey, setReloadKey] = useState(0);
  const bumpReload = () => {
    invalidateFetch((k) => k.startsWith('/admin/jobs'));
    setReloadKey((k) => k + 1);
  };

  /*
   * Every row action here opens a page-owned modal: ?action=reassign,
   * ?action=view (the read-only Eye) or ?action=console (the accepted-job
   * console — the host opens onOpenConsole through it, and it can approve or
   * reject a technician request, or reschedule). When one of those closes the row may have changed tab — a
   * reassign committed, or the technician checked in from the app meanwhile —
   * so refetch and recount as the action param clears. ?action=checkin has had
   * no row icon since 2026-09-11 (the technician checks in from the app only);
   * an old link still opens the view workspace under it, so it stays in the
   * set. Any action added to the row must be added here too.
   */
  const { action } = useJobActionParams();
  const prevAction = useRef<typeof action>(action);
  useEffect(() => {
    if (
      (prevAction.current === 'reassign' || prevAction.current === 'assign'
        || prevAction.current === 'checkin' || prevAction.current === 'view'
        || prevAction.current === 'console') &&
      action !== prevAction.current
    ) {
      bumpReload();
    }
    prevAction.current = action;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  /*
   * Mirror tab + filters into the URL. Seeded from the live params so
   * everything this view does not own (tab, q, sort, jobId/action) survives,
   * and written through the shared ps* serialiser so the retired psStatus /
   * psVertical are scrubbed here exactly as on the scheduling tab. Deps
   * deliberately EXCLUDE searchParams, so a replace can never loop back into
   * another one; the equality guard skips a no-op replace on mount.
   */
  useEffect(() => {
    const p = new URLSearchParams(searchParams);
    if (ptsTab) p.set(PTS_TAB_PARAM, ptsTab); else p.delete(PTS_TAB_PARAM);
    writePsFilterParams(p, filters);
    const next = p.toString();
    if (next !== searchParams.toString()) {
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptsTab, filterKey]);

  /*
   * The filter set as /admin/jobs params, built once and shared by the table
   * and the strip so the two can never describe different populations.
   * offerState is dropped again here — defence in depth for the pin above.
   */
  const filterParams = useMemo(() => {
    const p = psQueryParams(filters);
    delete p.offerState;
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  /*
   * The counts request — every param the list sends EXCEPT ptsState (the tabs
   * ARE the state, so the endpoint returns one total per state) and except
   * paging/sort, which cannot change a count.
   */
  const countParams = useMemo(
    () => ({ ...filterParams, ownerId, q: debouncedSearch || undefined }),
    [filterParams, ownerId, debouncedSearch],
  );

  return (
    <div className="space-y-5">
      <PendingStartTabs
        value={ptsTab}
        onChange={setPtsTab}
        params={countParams}
        reloadKey={reloadKey}
        clamped={scopeClamped}
        onShowAll={onShowAll}
      />

      <Card>
        <CardContent className="p-3 space-y-3">
          {/*
            * The SAME arrangement as Pending for Scheduling (my-orders page):
            * search on its own full-width line, the shared filter bar — which
            * ends in its own Clear Filters — on the line below. Squeezing the
            * search in beside the four filters made the two buckets look like
            * different screens (ops, 2026-09-17).
            */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by Job #, Customer, Mobile, Client, City, Technician, SPOC…"
              title="Searches Job #, Customer, Mobile, Client, City, Technician, Owner and SPOC"
              aria-label="Search pending to start orders"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <PendingSchedulingFilters
            value={filters}
            onChange={(next) => setFilters(withoutOfferState(next))}
            hideOfferState
          />
        </CardContent>
      </Card>

      <PendingStartTable
        ptsState={ptsTab}
        filterParams={filterParams}
        narrowed={psAnyFilterSet(filters) || debouncedSearch !== ''}
        q={debouncedSearch}
        ownerId={ownerId}
        reloadKey={reloadKey}
        isAdmin={isAdmin}
        canJob={canJob}
        onView={openView}
        onReassign={openReassign}
        onShowLocation={onShowLocation}
        onRequestActioned={bumpReload}
        onOpenConsole={onOpenConsole}
      />
    </div>
  );
}

type PendingStartTableProps = {
  /* The selected tab. '' = All, which sends no ptsState. */
  ptsState: PtsState;
  filterParams: Record<string, string>;
  /* Any filter or search applied — picks the empty-state copy. */
  narrowed: boolean;
  q: string;
  ownerId: number | undefined;
  reloadKey: number;
  isAdmin: boolean;
  canJob: Record<string, boolean>;
  onView: (jobId: number) => void;
  onReassign: (jobId: number) => void;
  onShowLocation: (row: { job_id: number; easyfixer_name: string | null }) => void;
  /* View-wide reload after an Approve / Reject. Not this table's own
   * refetch(): an approved cancellation leaves the tab entirely and the tab
   * counts move with it, so the signal has to be the view's. */
  onRequestActioned: () => void;
  onOpenConsole?: (jobId: number) => void;
};

// The selected tab's rows — ONE /admin/jobs?status=1 call + pagination.
function PendingStartTable({
  ptsState,
  filterParams,
  narrowed,
  q,
  ownerId,
  reloadKey,
  isAdmin,
  canJob,
  onView,
  onReassign,
  onShowLocation,
  onRequestActioned,
  onOpenConsole,
}: PendingStartTableProps) {
  /*
   * Everything that decides WHICH rows exist, as one string — paging excluded.
   * buildJobsKey drops undefined, so All (ptsState '') simply sends no
   * ptsState, and an unset filter never reaches the query string.
   */
  const scope = {
    status: 1,
    ptsState: ptsState || undefined,
    // cityId / clientId / zonalManagerId as CSV, categoryId single — the
    // shared psQueryParams contract, identical to the scheduling tab's.
    ...filterParams,
    // Free-text search → BE `q` (multi-field LIKE). Empty string omitted.
    q: q || undefined,
    ownerId,
  };
  const scopeKey = buildJobsKey(scope);

  /*
   * The page belongs to ONE scope. It is stored beside the scope it was chosen
   * under and reads back as 0 the moment the scope changes, so switching tab,
   * filter or search lands on page 1 in the SAME render. Resetting it in an
   * effect instead first fires a request for page N of the new scope — one
   * nobody sees, and quite possibly past its end.
   */
  const [paging, setPaging] = useState({ scopeKey, page: 0 });
  const page = paging.scopeKey === scopeKey ? paging.page : 0;
  const setPage = (next: number) => setPaging({ scopeKey, page: next });
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  const limit = pageSizeToLimit(pageSize, JOBS_MAX_LIMIT);
  const offset = page * limit;

  /*
   * Appointment order, the one sort this view offers. Soonest first by default
   * — the order ops triage in (on All that puts the longest-missed slots on
   * top); the column header flips it. Kept out of `scope`, so flipping the
   * order keeps the page the operator is on.
   */
  const [apptDir, setApptDir] = useState<SortDir>('asc');
  const key = buildJobsKey({
    ...scope,
    sortBy: 'requested_date_time',
    sortDir: apptDir,
    limit,
    offset,
  });

  const { data, loading, refreshing, error, refetch } = useFetch<Resp>(key);

  // Refetch on the view's reload signal (post Reassign / Approve / Reject).
  const firstReload = useRef(true);
  useEffect(() => {
    if (firstReload.current) {
      firstReload.current = false;
      return;
    }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  /*
   * ONE SOURCE: the server's page and the server's total. appRequestOf() still
   * runs PER ROW below to render the chip and pick the row's actions — it is
   * the predicate the server partitions on, so it cannot disagree with the tab
   * the row arrived under.
   */
  const rows = data?.items ?? [];
  /* One clock for the whole page, so every timing chip moves together. */
  const now = useMinuteClock();
  const total = data?.total ?? 0;

  const showRequest = REQUEST_COLUMN_TABS.has(ptsState);
  /* Column count — the Request column exists only on some tabs, and the
   * skeleton and the empty-state colSpan both have to agree with <thead>. */
  const colCount = showRequest ? 13 : 12;

  return (
    <Card>
      <RefreshBar active={refreshing} />
      <CardContent className="p-0 overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="stick-col-head stick-left">Job ID</th>
              {/* Request — why this row is on a request tab, so it reads
                  immediately after the Job ID rather than at the far right. */}
              {showRequest && <th>Request</th>}
              {/* Age — read-only here. The only sort is the appointment
                  column's (soonest first by default, click to flip), so a
                  clickable Age header would have nothing to drive. */}
              <th className="w-16">Age</th>
              <th>Job Ref</th>
              <th>Technician</th>
              <th>City</th>
              <th>Client</th>
              <th>Location</th>
              <th>Date &amp; Time of Booking</th>
              <SortHeader<string>
                col="requested_date_time"
                sortBy="requested_date_time"
                sortDir={apptDir}
                onSort={() => setApptDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
              >
                Date &amp; Time of Appointment
              </SortHeader>
              <th>Current Status of Job</th>
              <th>Client SPOC</th>
              <th className="stick-col-head stick-right text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: colCount }).map((_, c) => (
                    <td key={c}>
                      <div className="h-3 w-24 rounded bg-muted animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="text-center text-muted-foreground py-8">
                  {/* A failed first load must not read as an empty queue.
                      After a successful one, useFetch keeps those rows through
                      a failed refresh, so this only ever replaces nothing. */}
                  {error && !data
                    ? `Could not load orders: ${error}`
                    : narrowed
                      ? 'No orders match these filters.'
                      : `${EMPTY_COPY[ptsState]}${!isAdmin ? ' owned by you' : ''}.`}
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((j) => {
              /* The row's own ask, read once — the Request column, the
                 Requested line and the actions below all render from this one
                 object. Null on an ordinary pending order. */
              const req = appRequestOf(j);
              return (
                <tr key={j.job_id} className="hover:bg-muted/40">
                  <td className="stick-col stick-left font-medium">
                    <span className="inline-flex items-center gap-1">
                      #{j.job_id}
                      <CallHistoryButton jobId={j.job_id} />
                    </span>
                  </td>
                  {/*
                   * The request itself: WHAT was asked (chip), WHY (the
                   * resolved action_taken_reason description) and WHEN it was
                   * raised. The requested new appointment is deliberately NOT
                   * here — it belongs beside the live appointment, further
                   * along, where ops can compare the two.
                   */}
                  {showRequest && (
                    <td className="min-w-[13rem] max-w-[20rem] align-top">
                      {req ? (
                        <div className="space-y-0.5">
                          <StatusChip tone={req.tone} size="sm">{req.label}</StatusChip>
                          <div className="text-xs break-words">{req.reason ?? 'No reason given'}</div>
                          <div className="text-xs text-muted-foreground whitespace-nowrap">
                            Raised {formatDate(req.raisedAt)}
                          </div>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                  )}
                  <td className="text-xs whitespace-nowrap tabular-nums align-top" title={jobAgeTitle(j)}>
                    {formatJobAge(j)}
                  </td>
                  <td className="text-xs whitespace-nowrap align-top">{j.job_reference_id ?? '—'}</td>
                  {/*
                    * Technician — name on top (may wrap to multiple lines) and,
                    * below it, the masked mobile as a single-line click-to-call.
                    * CallableMobile targets the technician (efrId) with the job as
                    * context (jobContextId) so the call lands in this job's
                    * history; the BE resolves the unmasked number, the FE only
                    * holds the masked digits. Widened (min-w-[12rem]) so the mobile
                    * fits on one line. Unassigned rows show a plain label.
                    */}
                  <td className="min-w-[12rem] align-top">
                    {j.fk_easyfixter_id != null ? (
                      <div className="space-y-0.5">
                        <div className="break-words">
                          {formatEasyfixerName(j.easyfixer_name) || '—'}
                        </div>
                        <div className="text-xs text-muted-foreground whitespace-nowrap">
                          <CallableMobile
                            efrId={j.fk_easyfixter_id}
                            jobContextId={j.job_id}
                            mobile={j.easyfixer_mobile}
                          />
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">unassigned</span>
                    )}
                  </td>
                  <td>{j.city_name ?? '—'}</td>
                  <td className="min-w-[16rem] max-w-[24rem] break-words">
                    {j.client_name ?? '—'}
                  </td>
                  {/*
                   * Location — the booked address text (tbl_address.address),
                   * added to the shared LIST_COLUMNS projection. Falls back to
                   * city when a row has no address string. Matches legacy's
                   * "Location = addressObj.address" column.
                   */}
                  <td className="min-w-[14rem] max-w-[22rem] break-words text-xs" title={j.address ?? undefined}>
                    {j.address || j.city_name || '—'}
                  </td>
                  <td className="text-xs whitespace-nowrap">
                    {j.scheduled_date_time ? formatDate(j.scheduled_date_time) : '—'}
                  </td>
                  <td className="text-xs whitespace-nowrap">
                    {j.requested_date_time ? formatDate(j.requested_date_time) : '—'}
                    {/*
                     * The reschedule ask, directly under the appointment it
                     * would replace — the comparison is the decision, so the
                     * two dates have to be one glance apart. A cancellation
                     * proposes no new time, so requestedFor is null there and
                     * this line never renders.
                     */}
                    {req?.requestedFor && (
                      <div className="mt-0.5">
                        <span className="rounded bg-warning-tint px-1.5 py-0.5 text-warning-strong">
                          Requested: {formatDate(req.requestedFor)}
                        </span>
                      </div>
                    )}
                  </td>
                  <td>
                    {/* Live status, not the raw job_status: every row in this
                        bucket is status 1, so "Scheduled" said nothing. The
                        status is the tab rule (what is waiting), the chip under
                        it is the appointment timing — see
                        lib/pending-start-status.ts. */}
                    <PendingStartLiveStatus job={j} now={now} />
                    {/* Delegation pill — same component, same placement as
                        /my-orders, /jobs and JobModal. Renders nothing unless a
                        share is LIVE, so no surrounding guard. */}
                    <ShareChip share={j.share} className="ml-1" />
                  </td>
                  {/*
                   * Client SPOC — client_spoc IS the SPOC's mobile (a raw string
                   * on tbl_job; there is no SPOC id), masked in transit. Dialling
                   * targets the spocJobId, which re-reads the clear number BE-side
                   * — the FE never holds it. Same pattern as the pending-scheduling
                   * branch.
                   */}
                  <td className="whitespace-nowrap">
                    <div>{j.client_spoc_name || '—'}</div>
                    {j.client_spoc && (
                      <div className="text-xs text-muted-foreground">
                        <CallableMobile spocJobId={j.job_id} mobile={j.client_spoc} />
                      </div>
                    )}
                  </td>
                  <td className="stick-col stick-right text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1 justify-end">
                      {/*
                        * Job console — first in the cell, and only when the host
                        * wired it: an icon that opens nothing is worse than no
                        * icon. Ungated here; whatever the console lets an
                        * operator do is gated inside it.
                        */}
                      {onOpenConsole && (
                        <button
                          type="button"
                          onClick={() => onOpenConsole(j.job_id)}
                          className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                          title="Open job console"
                          aria-label="Open job console"
                        >
                          <PanelsTopLeft className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {/*
                        * Live Technician Location (📍). Opens the page-owned
                        * LiveLocationPopover on demand — it polls only while open
                        * (every 15s), so there's no eager per-row location fetch.
                        * Only meaningful once a technician is assigned.
                        */}
                      {/*
                        * Not on a row carrying a request (owner, 2026-09-15).
                        * That row is a DECISION — approve or reject an ask —
                        * and Location / Resend PIN are day-to-day chasing tools
                        * for a job that is proceeding. Only View Job and
                        * Reassign survive there, beside the decision pair.
                        * Fenced on the ROW's ask rather than the tab since the
                        * tabs replaced the sections: a request row on All is
                        * the same decision it is on its own tab, and Slots
                        * missed / Today / Future carry no request rows at all.
                        */}
                      {!req && j.fk_easyfixter_id != null && (
                        <button
                          type="button"
                          onClick={() => onShowLocation(j)}
                          className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                          title="Live technician location"
                          aria-label="Live technician location"
                        >
                          <MapPin className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {/* View — read-only and ungated. Restored 2026-09-04: it
                          had been removed because the old workspace icon and
                          Reassign "both surface full job detail", which is true
                          but makes LOOKING at an order require opening a WRITE
                          modal. Do not re-remove it on that reasoning. */}
                      <button
                        type="button"
                        onClick={() => onView(j.job_id)}
                        className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                        title="View Job"
                        aria-label="View Job"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      {/* Since 2026-09-11 (per ops) the technician checks in
                          from the app; this row has no control for it. */}
                      {canJob.isJobReassign && (
                        <button
                          type="button"
                          onClick={() => onReassign(j.job_id)}
                          className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                          title="Reassign Technician — pick a different tech from the ranked list"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {/*
                        * Resend Customer PIN — matching /my-orders. The
                        * technician's escape hatch when the customer never got
                        * (or lost) the closing code. Same row-icon grammar as
                        * its neighbours; gated on its own permission, confirms
                        * before texting a real customer, and never reveals the
                        * code to staff. It self-gates on job_status too, so no
                        * status test is duplicated here.
                        */}
                      {!req && (
                        <ResendPinButton
                          jobId={j.job_id}
                          jobStatus={j.job_status}
                          customerName={j.customer_name}
                          customerMobile={j.customer_mob_no}
                          allowed={!!canJob[RESEND_PIN_ACTION]}
                        />
                      )}
                      {/*
                        * Approve / Reject, last in the row so the two
                        * irreversible controls sit furthest from the read-only
                        * ones. Rendered from `req` — the same object the
                        * Request column painted — so the buttons can never act
                        * on a different ask than the chip names.
                        */}
                      {req && (
                        <TechRequestActions
                          jobId={j.job_id}
                          request={req}
                          allowed={!!canJob[APP_REQUEST_ACTION]}
                          onActioned={onRequestActioned}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
              })}
          </tbody>
        </table>
      </CardContent>
      {data && (
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(s) => {
            setPageSize(s);
            setPage(0);
          }}
        />
      )}
    </Card>
  );
}
