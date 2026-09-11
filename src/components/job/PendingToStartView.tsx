'use client';

/*
 * PendingToStartView — dedicated view for My Orders ?tab=pending-start
 * (job_status = 1 SCHEDULED, "Pending to Start"). Legacy-CRM parity.
 *
 * Why this is its own component (not the shared /my-orders table):
 *   The Pending-to-Start page has a DISTINCT shape vs the other lifecycle
 *   tabs — a Project-Manager / Zonal-Manager / Client / City filter bar plus
 *   three appointment-bucketed, independently-paginated sections (Over Due /
 *   Action Today / Future). The shared table in my-orders/page.tsx is used by
 *   ~9 other tabs and must stay untouched, so this mirrors how the Unconfirmed
 *   tab renders <UnconfirmedJobsTable/> and Pending-for-Scheduling renders its
 *   own custom branch.
 *
 * Date-bucket semantics (the crux — see EasyFix_Backend/services/job.service.js
 * DATE_TYPE_COLUMN + its `startDate`/`endDate` application):
 *   - dateType='requested' maps the range onto j.requested_date_time.
 *   - startDate → `col >= ?`, endDate → `col <= ?` — BOTH INCLUSIVE.
 *   - The validator types both as Joi.date().iso() with convert:true, so the
 *     value is parsed into a JS Date; mysql2's pool `timezone: '+05:30'` then
 *     serialises that Date back to an IST wall-clock string, which is exactly
 *     how DATETIME columns store their value (IST verbatim). So we send ISO
 *     strings WITH the +05:30 offset and the comparison lands on the right IST
 *     wall-clock instant regardless of the browser's local timezone.
 *   - "Today" is computed in Asia/Kolkata (reusing istNowWallClock), NEVER
 *     naive UTC, per the project's IST-storage convention.
 *
 * Buckets (mutually exclusive & exhaustive over requested_date_time, second
 * granularity):
 *   Over Due     → requested_date_time <= yesterday 23:59:59 IST  (unbounded past)
 *   Action Today → today 00:00:00 IST <= requested_date_time <= today 23:59:59 IST
 *   Future       → requested_date_time >= tomorrow 00:00:00 IST   (unbounded future)
 *
 * ─── THE FOURTH SECTION: TECHNICIAN REQUESTS (top of the page) ───────────
 *
 * A technician can ask, from the mobile app, for a pending order to be
 * CANCELLED or its appointment MOVED. Neither ask changes job_status, so the
 * row keeps sitting in whichever appointment bucket its CURRENT appointment
 * puts it in — a request raised on a job due next month lands at the bottom of
 * Future and nobody sees it. The three buckets answer "when is this due"; a
 * request is the question of whether it is due at all, so it needs its own
 * section, and it renders FIRST because it is the only thing on this page that
 * is waiting on an operator rather than on a clock. The predicate and the
 * cancel-vs-reschedule discrimination live in `@/lib/job-app-request` (tested;
 * see tests/job-app-request.test.js) — this file only renders them.
 *
 * It is the SAME <PendingSection/> as the three buckets, under `appRequests`,
 * because the row grammar (icons, click-to-call, chips, pagination) has to be
 * identical to the buckets below it — a second table would drift.
 *
 * TWO WAYS IT DIFFERS, both forced by the backend:
 *
 *   1. NO DATE WINDOW. A request is orthogonal to the appointment date, so the
 *      section queries every pending order and narrows client-side.
 *   2. CLIENT-SIDE FILTER AND PAGINATION. `/admin/jobs` projects the request
 *      flags but has no filter for them (no entry in the service's WHERE
 *      builder, and none in SORTABLE_COLUMNS either), so `total` and the page
 *      slice are computed here over one bounded page of rows.
 *
 * CEILING, stated plainly: that bounded page is JOBS_MAX_LIMIT (500) rows —
 * `/admin/jobs`'s own Joi cap — ordered by appointment ascending. Production
 * carries ~19 pending requests against a pending-to-start queue well inside
 * 500, so the window holds today; if that queue ever exceeds 500 rows, the
 * requests sitting on the LATEST appointments fall outside it and stop being
 * listed. The fix is a server-side filter (an `appRequest` LIST param beside
 * `offerState`), not a bigger limit here.
 *
 * Reuses (never re-implements): the parent's openView / openReassign /
 * quickStatusChange handlers + canJob permission flags, the shared fetch hooks
 * (useFetch / useFetchOnce), SearchMultiSelect, StatusChip + statusLabel/statusTone,
 * CallableMobile (Client SPOC spocJobId pattern), formatDate, formatEasyfixerName.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, RefreshCw, MapPin, Eye, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { type SearchOption } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
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
import { ShareChip } from '@/components/job/JobShareControls';
import { useFetch, invalidateFetch, useDebouncedValue } from '@/lib/hooks';
import { formatJobAge, jobAgeTitle, type JobAgeFields } from '@/lib/job-age';
import { appRequestOf, type AppRequestFields } from '@/lib/job-app-request';
import type { JobShare } from '@/lib/job-share';
import { useLookup } from '@/lib/use-lookup';
import { buildJobsKey } from '@/lib/jobs-query';
import { useJobActionParams } from '@/lib/job-action-url';
import {
  formatDate,
  formatEasyfixerName,
  istNowWallClock,
  statusLabel,
  statusTone,
} from '@/lib/utils';
import type { Me } from '@/lib/auth-context';

// `/admin/jobs` Joi caps limit at 500 — pass to pageSizeToLimit so "All"
// sends 500 instead of the default 1000 (which would 400). Mirrors the value
// used by /my-orders + /jobs.
const JOBS_MAX_LIMIT = 500;

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

type ManagerLite = { user_id: number; user_name: string };

// Applied filter-bar state. All four are MULTI-select — each holds an array of
// selected ids that is serialised to a comma-separated string on the /admin/jobs
// query (clientId / cityId / projectManagerId / zonalManagerId). The service
// layer splits the CSV into an IN (...) clause; a single id still validates for
// back-compat. Empty array → the param is omitted entirely.
type Filters = {
  clientId: number[];
  cityId: number[];
  projectManagerId: number[];
  zonalManagerId: number[];
};
const EMPTY_FILTERS: Filters = {
  clientId: [],
  cityId: [],
  projectManagerId: [],
  zonalManagerId: [],
};

// Coerce the multi-select widget's (string|number)[] into a clean number[].
// Mirrors the QuickSight filter bar's toNums helper.
function toNums(v: Array<string | number>): number[] {
  return v
    .map((x) => (typeof x === 'number' ? x : Number(x)))
    .filter((n) => Number.isFinite(n));
}

// ── IST day-boundary helpers ────────────────────────────────────────
const IST_OFFSET = '+05:30';

// Shift a 'YYYY-MM-DD' calendar date by N days. Uses UTC math on a
// date-only value so it never drifts with the browser's local timezone
// (India has no DST, so plain calendar arithmetic is exact).
function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

type DateRange = { startDate?: string; endDate?: string };

/* The requests section is orthogonal to the appointment date, so it sends no
 * window at all. Module-level so the identity is stable — `filters`/`q` drive a
 * page-reset effect and a fresh `{}` on every render would retrigger it. */
const NO_DATE_RANGE: DateRange = {};

// Compute the three appointment buckets' inclusive IST boundaries as ISO
// strings carrying the +05:30 offset (see the file header for why the offset
// matters end-to-end).
function istBuckets(): { overDue: DateRange; actionToday: DateRange; future: DateRange } {
  const today = istNowWallClock().slice(0, 10); // 'YYYY-MM-DD' in Asia/Kolkata
  const yesterday = shiftYmd(today, -1);
  const tomorrow = shiftYmd(today, 1);
  return {
    overDue: { endDate: `${yesterday}T23:59:59${IST_OFFSET}` },
    actionToday: {
      startDate: `${today}T00:00:00${IST_OFFSET}`,
      endDate: `${today}T23:59:59${IST_OFFSET}`,
    },
    future: { startDate: `${tomorrow}T00:00:00${IST_OFFSET}` },
  };
}


export type PendingToStartViewProps = {
  me: Me | null | undefined;
  isAdmin: boolean;
  // Permission flags from the page's actionFlags(me, …) — we only read
  // isJobReassign (Reassign) here.
  canJob: Record<string, boolean>;
  /* Reused page handlers — do NOT re-implement their logic. */
  /* Read-only viewer, same page-owned modal the other tabs' Eye opens. */
  openView: (jobId: number) => void;
  openReassign: (jobId: number) => void;
  // Opens the page-owned LiveLocationPopover for a row's assigned technician.
  // The popover only polls (every 15s) WHILE OPEN, so this stays on-demand —
  // there's no eager per-row location fetch on this unified backend.
  onShowLocation: (row: { job_id: number; easyfixer_name: string | null }) => void;
};

export function PendingToStartView({
  me,
  isAdmin,
  canJob,
  openView,
  openReassign,
  onShowLocation,
}: PendingToStartViewProps) {
  // Role-aware owner scope — mirror the page: admins see everyone's queue,
  // everyone else only their own owned jobs.
  const ownerId = isAdmin ? undefined : me?.user.user_id;

  // Draft (in-progress) vs applied (committed on Search) filter state so the
  // sections only refetch when the operator clicks Search — matching the
  // legacy "filter then Search" flow.
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);

  // Free-text search across all three sections. Debounced so it queries the BE
  // `q` (multi-field: Job #, customer, mobile, client, city, technician, owner,
  // SPOC) once the operator pauses, not per keystroke. Instant-apply — unlike
  // the PM/ZM/Client/City filters, which commit on the Search button.
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  // reloadKey bumps after a mutation to force every section to refetch (the
  // shared fetch cache is module-level; each section watches this signal).
  const [reloadKey, setReloadKey] = useState(0);
  const bumpReload = () => {
    invalidateFetch((k) => k.startsWith('/admin/jobs'));
    setReloadKey((k) => k + 1);
  };

  /*
   * Every row action here opens a page-owned modal: ?action=reassign or
   * ?action=view (the read-only Eye). When one of those closes the row may have
   * left this bucket — a reassign committed, or the technician checked in from
   * the app meanwhile — so refetch as the action param clears. ?action=checkin
   * has had no row icon since 2026-09-11 (no CRM Check In); an old link still
   * opens the view workspace under it, so it stays in the set. Any action added
   * to the row must be added here too.
   */
  const { action } = useJobActionParams();
  const prevAction = useRef<typeof action>(action);
  useEffect(() => {
    if (
      (prevAction.current === 'reassign' || prevAction.current === 'assign'
        || prevAction.current === 'checkin' || prevAction.current === 'view') &&
      action !== prevAction.current
    ) {
      bumpReload();
    }
    prevAction.current = action;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  // ── Lookups for the filter bar ──────────────────────────────────
  const lookup = useLookup();
  const clientOpts = useMemo<SearchOption[]>(
    () => [...lookup.toOpts.clients].sort((a, b) => a.label.localeCompare(b.label)),
    [lookup.toOpts.clients],
  );
  const cityOpts = useMemo<SearchOption[]>(
    () => [...lookup.toOpts.cities].sort((a, b) => a.label.localeCompare(b.label)),
    [lookup.toOpts.cities],
  );
  // PM / ZM lookups are admin-only server-side (role(['admin'])); a null key
  // disables the fetch so non-admins don't fire a guaranteed 403.
  const pmRes = useFetch<ManagerLite[]>(isAdmin ? '/shared/lookup/project-managers?userType=1' : null);
  const zmRes = useFetch<ManagerLite[]>(isAdmin ? '/shared/lookup/zonal-managers' : null);
  const pmOpts = useMemo<SearchOption[]>(
    () => (pmRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [pmRes.data],
  );
  const zmOpts = useMemo<SearchOption[]>(
    () => (zmRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [zmRes.data],
  );

  // The three bucket boundaries — recomputed once per mount (they only change
  // at IST midnight, and this view is short-lived).
  const buckets = useMemo(() => istBuckets(), []);

  const filtersDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(applied),
    [draft, applied],
  );
  const anyFilterSet = useMemo(
    () => Object.values(draft).some((v) => v.length > 0),
    [draft],
  );

  return (
    <div className="space-y-5">
      {/* ── Filter bar ────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3 space-y-3">
          {/* Free-text search — filters all three sections server-side (BE `q`
              matches Job #, customer, mobile, client, city, technician, owner,
              SPOC). Debounced; instant (no Search button needed). */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by Job #, Customer, Mobile, Client, City, Technician, SPOC…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Project Manager">
              <SearchMultiSelect
                value={draft.projectManagerId}
                onChange={(v) => setDraft((d) => ({ ...d, projectManagerId: toNums(v) }))}
                options={pmOpts}
                placeholder="All Project Managers"
                selectedLabel="managers"
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Zonal Manager">
              <SearchMultiSelect
                value={draft.zonalManagerId}
                onChange={(v) => setDraft((d) => ({ ...d, zonalManagerId: toNums(v) }))}
                options={zmOpts}
                placeholder="All Zonal Managers"
                selectedLabel="managers"
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Clients">
              <SearchMultiSelect
                value={draft.clientId}
                onChange={(v) => setDraft((d) => ({ ...d, clientId: toNums(v) }))}
                options={clientOpts}
                placeholder="All Clients"
                selectedLabel="clients"
              />
            </Field>
            <Field label="Cities">
              <SearchMultiSelect
                value={draft.cityId}
                onChange={(v) => setDraft((d) => ({ ...d, cityId: toNums(v) }))}
                options={cityOpts}
                placeholder="All Cities"
                selectedLabel="cities"
              />
            </Field>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            {anyFilterSet && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraft(EMPTY_FILTERS);
                  setApplied(EMPTY_FILTERS);
                }}
              >
                Clear
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => setApplied(draft)}
              disabled={!filtersDirty}
            >
              <Search className="mr-1.5 h-4 w-4" />
              Search
            </Button>
          </div>
        </CardContent>
      </Card>

      {/*
        * ── Technician requests, ABOVE the buckets ─────────────────
        * Renders nothing at all when there are none (see PendingSection's
        * `appRequests` branch), so an empty queue costs no vertical space.
        */}
      <PendingSection
        appRequests
        title="Technician Requests"
        subtitle="Cancellation or reschedule raised from the app"
        dateRange={NO_DATE_RANGE}
        filters={applied}
        q={debouncedSearch}
        ownerId={ownerId}
        reloadKey={reloadKey}
        isAdmin={isAdmin}
        canJob={canJob}
        onView={openView}
        onReassign={openReassign}
        onShowLocation={onShowLocation}
      />

      {/* ── Three appointment buckets ─────────────────────────────── */}
      <PendingSection
        title="Over Due"
        subtitle="Appointment before today"
        dateRange={buckets.overDue}
        filters={applied}
        q={debouncedSearch}
        ownerId={ownerId}
        reloadKey={reloadKey}
        isAdmin={isAdmin}
        canJob={canJob}
        onView={openView}
        onReassign={openReassign}
        onShowLocation={onShowLocation}
      />
      <PendingSection
        title="Action Today"
        subtitle="Appointment is today"
        dateRange={buckets.actionToday}
        filters={applied}
        q={debouncedSearch}
        ownerId={ownerId}
        reloadKey={reloadKey}
        isAdmin={isAdmin}
        canJob={canJob}
        onView={openView}
        onReassign={openReassign}
        onShowLocation={onShowLocation}
      />
      <PendingSection
        title="Future"
        subtitle="Appointment tomorrow or later"
        dateRange={buckets.future}
        filters={applied}
        q={debouncedSearch}
        ownerId={ownerId}
        reloadKey={reloadKey}
        isAdmin={isAdmin}
        canJob={canJob}
        onView={openView}
        onReassign={openReassign}
        onShowLocation={onShowLocation}
      />
    </div>
  );
}

/* Small labelled wrapper so every filter shares the same Title-Case label
 * treatment without repeating markup (mirrors QuickSightFilterBar). */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

type PendingSectionProps = {
  /*
   * The technician-requests variant. ONE flag because it is ONE concept —
   * "this section lists app requests rather than an appointment window" — and
   * every difference below follows from it: no date window on the query, a
   * client-side filter + page slice (the endpoint cannot filter on the flags),
   * the extra Request column, the attention styling, and rendering nothing at
   * all when the set is empty. See the file header for the ceiling.
   */
  appRequests?: boolean;
  title: string;
  subtitle: string;
  dateRange: DateRange;
  filters: Filters;
  q: string;
  ownerId: number | undefined;
  reloadKey: number;
  isAdmin: boolean;
  canJob: Record<string, boolean>;
  onView: (jobId: number) => void;
  onReassign: (jobId: number) => void;
  onShowLocation: (row: { job_id: number; easyfixer_name: string | null }) => void;
};

// One appointment bucket — its OWN /admin/jobs?status=1 call + pagination.
function PendingSection({
  appRequests = false,
  title,
  subtitle,
  dateRange,
  filters,
  q,
  ownerId,
  reloadKey,
  isAdmin,
  canJob,
  onView,
  onReassign,
  onShowLocation,
}: PendingSectionProps) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  const limit = pageSizeToLimit(pageSize, JOBS_MAX_LIMIT);
  const offset = page * limit;

  const key = buildJobsKey({
    status: 1,
    // No window on the requests section — a request is orthogonal to the
    // appointment date. buildJobsKey drops undefined, so the three params
    // simply never reach the query string.
    dateType: appRequests ? undefined : 'requested',
    startDate: appRequests ? undefined : dateRange.startDate,
    endDate: appRequests ? undefined : dateRange.endDate,
    // Multi-select → comma-separated string; empty selection omits the param
    // (buildJobsKey drops undefined). The BE splits the CSV into an IN (...).
    clientId: filters.clientId.length ? filters.clientId.join(',') : undefined,
    cityId: filters.cityId.length ? filters.cityId.join(',') : undefined,
    projectManagerId: filters.projectManagerId.length ? filters.projectManagerId.join(',') : undefined,
    zonalManagerId: filters.zonalManagerId.length ? filters.zonalManagerId.join(',') : undefined,
    // Free-text search → BE `q` (multi-field LIKE). Empty string omitted.
    q: q || undefined,
    ownerId,
    // Soonest appointment first within each bucket — the order ops triage in.
    sortBy: 'requested_date_time',
    sortDir: 'asc',
    // The requests section filters client-side, so it pulls ONE bounded page
    // and pages within it — the server's limit/offset would slice the wrong
    // population. See the file header for what "bounded" costs.
    limit: appRequests ? JOBS_MAX_LIMIT : limit,
    offset: appRequests ? 0 : offset,
  });

  const { data, loading, refreshing, refetch } = useFetch<Resp>(key);

  // Reset to the first page whenever the applied filters change so we don't
  // strand the operator on a now-out-of-range page.
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    setPage(0);
  }, [filters, q]);

  // Refetch on an external reload signal (post Reassign).
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
   * The requests section derives BOTH its count and its page slice from the
   * same appRequestOf() call the row renders through, so the number in the
   * header and the rows under it can never describe different sets. An
   * appointment bucket keeps the server's own paging untouched.
   */
  const items = data?.items ?? [];
  const matched = appRequests ? items.filter((j) => appRequestOf(j) !== null) : items;
  const rows = appRequests ? matched.slice(offset, offset + limit) : matched;
  const total = appRequests ? matched.length : (data?.total ?? 0);

  /*
   * An empty requests section occupies NO space — not a header, not an empty
   * state. It is an exception queue: on most days it is empty, and a permanent
   * "no requests" card above Over Due would be a standing distraction. This
   * also covers the first paint (no data yet → no matches → nothing), so the
   * section appears only once there is something to action.
   */
  if (appRequests && total === 0) return null;

  /* Column count — the Request column exists only on the requests section, and
   * the skeleton and the empty-state colSpan both have to agree with <thead>. */
  const colCount = appRequests ? 13 : 12;

  return (
    <Card className={appRequests ? 'border-warning/40' : undefined}>
      {/* pb-3 adds breathing room between the section header (title + subtitle)
          and the table below it. The requests variant tints the whole header
          strip: `bg-warning-tint` / `text-warning-strong` is the estate's
          attention pair (StatusChip's `warning` tone, the bulk-upload and
          auto-allocation notices), and the two tokens SWAP lightness between
          the light and dark themes — so it stays a dark-on-light block in one
          and a light-on-dark block in the other, never a 1.08-contrast smear
          the way an `ink` surface with fixed white text would. */}
      <div
        className={
          'flex items-center justify-between px-4 pt-3 pb-3'
          + (appRequests ? ' bg-warning-tint text-warning-strong rounded-t-lg' : '')
        }
      >
        <div className="flex items-start gap-2">
          {appRequests && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className={appRequests ? 'text-xs' : 'text-xs text-muted-foreground'}>
              {subtitle} · {data ? total.toLocaleString() : '…'} order
              {total === 1 ? '' : 's'}
            </p>
          </div>
        </div>
      </div>
      <RefreshBar active={refreshing} />
      <CardContent className="p-0 overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="stick-col-head stick-left">Job ID</th>
              {/* Request — the reason this row is in this section, so it reads
                  immediately after the Job ID rather than at the far right. */}
              {appRequests && <th>Request</th>}
              {/* Age — read-only here. This view has NO sort state: each of the
                  three appointment buckets pins sortBy=requested_date_time asc
                  ("soonest appointment first" is the order ops triage in), so a
                  clickable Age header would have nothing to drive. */}
              <th className="w-16">Age</th>
              <th>Job Ref</th>
              <th>Technician</th>
              <th>City</th>
              <th>Client</th>
              <th>Location</th>
              <th>Date &amp; Time of Booking</th>
              <th>Date &amp; Time of Appointment</th>
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
                  No orders in this bucket{!isAdmin ? ' owned by you' : ''}.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((j) => {
              /* Same call that filtered and counted this row — never a second
                 reading of the flags. Null on an appointment bucket's rows. */
              const req = appRequests ? appRequestOf(j) : null;
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
                   * here — it belongs beside the live appointment, three
                   * columns along, where ops can compare the two.
                   */}
                  {appRequests && (
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
                    <StatusChip tone={statusTone(j.job_status)}>
                      {statusLabel(j.job_status, { assigned: j.fk_easyfixter_id != null })}
                    </StatusChip>
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
                        * Live Technician Location (📍). Opens the page-owned
                        * LiveLocationPopover on demand — it polls only while open
                        * (every 15s), so there's no eager per-row location fetch.
                        * Only meaningful once a technician is assigned.
                        */}
                      {j.fk_easyfixter_id != null && (
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
                      {/* View — read-only, ungated, first in the row so the
                          icon order matches the other tabs. Restored
                          2026-09-04: it had been removed because Check-In and
                          Reassign "both surface full job detail", which is true
                          but makes LOOKING at an order require opening a WRITE
                          modal. Do not re-remove it on that reasoning. */}
                      <button
                        type="button"
                        onClick={() => onView(j.job_id)}
                        className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                        title="View details"
                        aria-label="View details"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      {/* No Check-In (2026-09-11, per ops): the technician
                          checks in from the app. See JobModal's ActionBar. */}
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
                        * Resend Customer PIN — last icon in the row, matching
                        * /my-orders. The technician's escape hatch when the
                        * customer never got (or lost) the closing code. Same
                        * row-icon grammar as its neighbours; gated on its own
                        * permission, confirms before texting a real customer,
                        * and never reveals the code to staff. It self-gates on
                        * job_status too, so no status test is duplicated here.
                        */}
                      <ResendPinButton
                        jobId={j.job_id}
                        jobStatus={j.job_status}
                        customerName={j.customer_name}
                        customerMobile={j.customer_mob_no}
                        allowed={!!canJob[RESEND_PIN_ACTION]}
                      />
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
