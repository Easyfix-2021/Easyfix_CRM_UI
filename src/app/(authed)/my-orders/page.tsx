'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useJobActionParams, useJobActionNav } from '@/lib/job-action-url';
import {
  Search, Eye,
  CalendarClock, PlayCircle, CheckCircle2, CalendarCheck,
  RefreshCw, MapPin,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { formatDate, formatEasyfixerName, statusLabel, statusTone } from '@/lib/utils';
import { StatusChip } from '@/components/ui/StatusChip';
import { TABS, filterJobRows, makeQuickStatusChange } from '@/lib/job-tabs';
import { JobModal, type JobModalMode } from '@/components/job/JobModal';
import { UnconfirmedJobsTable } from '@/components/job/UnconfirmedJobsTable';
import { AssignTechnicianModal, type AssignMode } from '@/components/job/AssignTechnicianModal';
import { ScheduleAssignModal } from '@/components/job/ScheduleAssignModal';
import { CallableMobile } from '@/components/calls/CallButton';
import { CallHistoryButton } from '@/components/calls/CallHistoryButton';
import { cycleSort, SortHeader, type SortDir } from '@/lib/use-sort';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { useDebouncedValue } from '@/lib/hooks';
import { LiveLocationPopover } from '@/components/location/LiveLocationPopover';

// `/admin/jobs` Joi caps limit at 500 — pass to pageSizeToLimit so
// "All" sends 500 instead of the default 1000 (which would 400).
const JOBS_MAX_LIMIT = 500;

/*
 * MY ORDERS — user-scoped view of tbl_job.
 *
 * Data model parity with legacy CRM:
 *   - Legacy `userOwnerJob` + `dashboardChecking?enumDesc=<value>` actions
 *     both call `sp_ef_user_owner_job_list(userId, roleId, …)`. The SP does
 *     role-aware visibility expansion — admin + supervisor-style roles see
 *     their whole team's jobs, regular users see only their own.
 *   - We approximate that behaviour in the app layer:
 *       role.group === 'admin' → no owner filter (see everything — matches
 *                                 how a project manager / ops admin uses it)
 *       otherwise               → filter by ownerId = me.user.user_id
 *     This preserves the "I can see unconfirmed orders my team owns" flow
 *     for admins while keeping regular users focused on their own queue.
 *
 * UI-wise this is intentionally its own page (not /jobs with a scope pill):
 *   - Distinct title "My Orders" so ops know which flow they're in.
 *   - Same 11-tab lifecycle nav as /jobs (imported from lib/job-tabs.ts so
 *     the two pages never drift on bucket definitions).
 *   - Same row-level quick actions as /jobs (View / Schedule / Check-In /
 *     Check-Out) so muscle memory carries across.
 *   - Reuses JobModal for create/view/edit/assign/change-owner.
 *
 * Reusable pieces:
 *   - TABS, countFor, CountsResp from lib/job-tabs
 *   - JobModal + all its internal dialogs (Assign, AutoAssign, ChangeOwner)
 *   - Card / Button / Input / SortHeader / LoadBtn
 *   - statusLabel + statusColorClass
 */

type JobRow = {
  job_id: number; job_reference_id: string | null; client_ref_id: string | null;
  job_status: number; job_type: string; source_type: string | null;
  job_desc: string | null;
  created_date_time: string; requested_date_time: string; scheduled_date_time: string | null;
  checkin_date_time: string | null; checkout_date_time: string | null;
  // Extra fields surfaced on the Unconfirmed tab — see UnconfirmedJobsTable.
  ticket_created_date_time: string | null; time_slot: string | null;
  client_spoc: string | null; client_spoc_name: string | null;
  remarks: string | null;
  fk_customer_id: number; customer_name: string | null; customer_mob_no: string | null;
  fk_client_id: number; client_name: string | null;
  fk_easyfixter_id: number | null; easyfixer_name: string | null;
  job_owner: number | null; owner_name: string | null;
  fk_address_id: number; city_name: string | null;
  // service_category surfaced on the LIST projection for the
  // Pending-for-Scheduling custom column set (BE list now returns it).
  service_category?: string | null;
  // service_count surfaced on the LIST projection — counts only
  // job_service_status = 1 so soft-deleted services don't mask the
  // "Booked with no active services" anomaly. Same usage pattern as
  // /jobs and /customers/[id].
  service_count?: number;
  // Offer-model fields (the offer flow keeps the job at status 0 BOOKED
  // with an OFFERED tbl_job_offer row while the technician decides).
  // is_offered is truthy when an active OFFERED offer row exists;
  // offered_efr_name is that technician's name (may be null).
  is_offered?: number | boolean;
  offered_efr_name?: string | null;
};
type Resp = { items: JobRow[]; total: number; limit: number; offset: number };

// Operator-controlled via the TablePagination footer. "All" maps to
// JOBS_MAX_LIMIT (the BE Joi cap on /admin/jobs).
const DEFAULT_PAGE_SIZE: TablePageSize = 10;

export default function MyOrdersPage() {
  const { me } = useMe();
  // Permission gating for the per-row action icons. View (Eye) stays open
  // for everyone with access to this screen — it's read-only. Every other
  // icon corresponds to a mutation and gets gated. Granular keys mirror
  // legacy CRM convention: assign/reassign/status are three distinct
  // permissions because operations teams often grant some but not others.
  const canJob = actionFlags(me, [
    'isJobConfirm',       // Confirm unconfirmed (status 9 → 0)
    'isJobAssign',        // Assign / Schedule (status 0 → 1)
    'isJobReassign',      // Reassign already-scheduled (status 1)
    'isJobStatusChange',  // Check-In / Check-Out / Completion
    // Gates the Trigger/Retrigger button on the Unconfirmed tab — see
    // the parallel block in (authed)/jobs/page.tsx for the rationale.
    'isJobMagicLinkSend',
  ]);
  // Read the URL's ?tab=<slug> synchronously so the FIRST load fires with the
  // right filter. Previously tab initialised to 'all', and a follow-up
  // useEffect read the URL after mount — so the initial fetch returned every
  // job, then a second fetch overwrote it with the unconfirmed list. On slow
  // networks that caused a flash of "all jobs" on the Unconfirmed page.
  // useSearchParams() is stable at first render in Next.js 15's App Router,
  // so we can safely hydrate state from it inside useState's initializer.
  const searchParams = useSearchParams();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get('tab');
    return t && TABS.some((x) => x.value === t) ? t : 'all';
  });
  const [q, setQ] = useState('');
  /*
   * Global server-side search across ALL tabs (2026-07-03). Ops want to
   * "find any job by id / ref / customer / client / city / technician /
   * owner regardless of page". The old client-side `filterJobRows` only
   * matched within the currently-loaded page, so on any tab with more
   * than one page (e.g. Pending for Scheduling with its default 10-row
   * page) search appeared to "only work on the first 10 results". We now
   * forward `q` to the BE's /admin/jobs search on EVERY tab (the BE
   * search covers all those columns — see services/job.service.js). The
   * client-side filter still runs on top for instant same-page feedback
   * while the debounced (300ms) server refetch is in flight.
   */
  const debouncedQ = useDebouncedValue(q, 300);
  const serverQ = debouncedQ.trim();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(DEFAULT_PAGE_SIZE);
  const limit = pageSizeToLimit(pageSize, JOBS_MAX_LIMIT);
  const offset = page * limit;
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);

  /*
   * Role-aware owner filter: admin-group users see all jobs here (matches
   * legacy SP behaviour where role_id determines visibility expansion);
   * everyone else gets their own jobs only. Computed fresh each render from
   * auth — no extra state needed.
   */
  const isAdmin = me?.role?.group === 'admin';
  const scopedOwnerId = isAdmin ? undefined : me?.user.user_id;

  // Cache keyed by tab+offset so switching tabs back feels instant. Bust
  // every key on any mutation (modal save, row quick-action) — simpler than
  // per-tab invalidation and the list is small enough that a refetch is cheap.
  const cacheRef = useRef<Map<string, { at: number; data: Resp }>>(new Map());
  /*
   * In-flight request dedupe — same pattern as /jobs. Multiple
   * useEffects (tab+scope, page+pageSize) plus React Strict Mode's
   * double-invoke fan out to 4+ concurrent calls for the same key
   * on /my-orders page load. This Map collapses them to one
   * round-trip; later callers attach to the same Promise.
   */
  const inflightRef = useRef<Map<string, Promise<Resp>>>(new Map());
  const TAB_CACHE_TTL = 30_000;

  async function load(reset = false, force = false) {
    const tabDef = TABS.find((t) => t.value === tab);
    const off = reset ? 0 : offset;
    // Cache key includes pageSize so changing rows-per-page doesn't
    // serve a stale 50-row payload. Also includes serverQ so the
    // Unconfirmed-tab search results don't collide with the
    // unfiltered cache entry for the same offset.
    const key = `${tab}|${off}|${limit}|${scopedOwnerId ?? 'admin-all'}|q=${serverQ}|s=${sortKey || ''}:${sortDir}`;

    if (!force) {
      const hit = cacheRef.current.get(key);
      if (hit && Date.now() - hit.at < TAB_CACHE_TTL) {
        setData(hit.data);
        if (reset) setPage(0);
        return;
      }
    }

    // In-flight dedupe — see comment on inflightRef.
    const inflight = inflightRef.current.get(key);
    if (inflight) {
      try {
        const r = await inflight;
        setData(r);
        if (reset) setPage(0);
      } catch { /* originator surfaces the error */ }
      return;
    }

    setLoading(true);
    try {
      const reqPromise = api.get<Resp>('/admin/jobs', {
        status:    tabDef?.statuses ? undefined : tabDef?.status,
        statuses:  tabDef?.statuses ? tabDef.statuses.join(',') : undefined,
        assigned:  tabDef?.assigned === undefined ? undefined : String(tabDef.assigned),
        limit, offset: off,
        // Server-side sort (whitelisted BE-side); absent → BE default job_id DESC.
        sortBy: sortKey || undefined,
        sortDir: sortKey ? sortDir : undefined,
        ownerId: scopedOwnerId,
        // Global search (Unconfirmed tab only). BE's /admin/jobs accepts
        // `q` and searches across id / customer / address. Empty string
        // ⇒ undefined so we don't send a no-op param on other tabs or
        // when the box is cleared.
        q: serverQ || undefined,
      });
      inflightRef.current.set(key, reqPromise);
      const r = await reqPromise;
      setData(r);
      cacheRef.current.set(key, { at: Date.now(), data: r });
      if (reset) setPage(0);
    } finally {
      inflightRef.current.delete(key);
      setLoading(false);
    }
  }

  // Refetch on tab/scope change AND on page/pageSize change. pageSize
  // change resets page via the onPageSizeChange handler below.
  // `serverQ` triggers a fresh page-0 refetch — typing in the search
  // box on Unconfirmed re-queries the BE with `q` (debounced 300ms via
  // `useDebouncedValue` above) and clearing the box falls back to the
  // unfiltered paginated list.
  useEffect(() => { setPage(0); load(true, true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab, scopedOwnerId, serverQ]);
  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, pageSize]);

  // (refreshCounts removed with the pill bar — each sub-menu is its own page
  // so we don't need cross-tab counts; `data.total` in the subtitle covers
  // the "how many in this bucket" question.)

  // Deep-link tab support: dashboard cards + sidebar My Orders sub-menus link
  // to /my-orders?tab=<slug>. Initial hydration happens in useState above; this
  // effect handles SUBSEQUENT URL changes (sidebar click while already on
  // /my-orders) so switching between My Orders sub-items updates the filter.
  useEffect(() => {
    const t = searchParams.get('tab');
    const resolved = t && TABS.some((x) => x.value === t) ? t : 'all';
    if (resolved !== tab) {
      setTab(resolved);
      setPage(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  /*
   * Modal state is derived from the URL — every row-level action
   * (View / Confirm / Assign / Reassign) pushes its intent into
   * `?jobId=&action=` so teammates can share the URL and land
   * directly on the dialog. Legacy `?view=N` URLs are promoted to
   * the canonical schema by `useJobActionParams`. Other params
   * (e.g. `?tab=scheduled`) are preserved across pushes.
   */
  const { jobId: urlJobId, action: urlAction } = useJobActionParams();
  const { openJobAction, closeJobAction } = useJobActionNav();

  // JobModal opens for view / edit / confirm / create. Assign &
  // Reassign open AssignTechDialog instead — derived separately
  // from the same URL state below.
  const modal = useMemo<{ open: boolean; mode: JobModalMode; id?: number }>(() => {
    if (!urlAction || urlAction === 'assign' || urlAction === 'reassign') {
      return { open: false, mode: 'create' };
    }
    if (urlAction === 'create') return { open: true, mode: 'create' };
    if (urlJobId == null)        return { open: false, mode: 'create' };
    return { open: true, mode: urlAction as JobModalMode, id: urlJobId };
  }, [urlAction, urlJobId]);

  // AssignTechDialog state — derived from `?action=assign|reassign`.
  const assignModal = useMemo<{ open: boolean; jobId: number | null; mode: AssignMode }>(() => {
    if ((urlAction === 'assign' || urlAction === 'reassign') && urlJobId != null) {
      return { open: true, jobId: urlJobId, mode: urlAction === 'reassign' ? 'reassign' : 'assign' };
    }
    return { open: false, jobId: null, mode: 'assign' };
  }, [urlAction, urlJobId]);

  // ScheduleAssignModal state — derived from `?action=schedule`. This is
  // the Pending-for-Scheduling flow (status=0, unassigned): pick a date +
  // slot AND a technician in one atomic step.
  const scheduleModal = useMemo<{ open: boolean; jobId: number | null }>(() => {
    if (urlAction === 'schedule' && urlJobId != null) {
      return { open: true, jobId: urlJobId };
    }
    return { open: false, jobId: null };
  }, [urlAction, urlJobId]);

  function closeModal()                { closeJobAction(); }
  function openView(id: number)        { openJobAction('view',     id); }
  // Unconfirmed orders open the dedicated confirm form (edit layout +
  // services basket + "Confirm & Schedule" footer), mirroring the
  // legacy addEditJob flow.
  function openConfirm(id: number)     { openJobAction('confirm',  id); }
  function openAssign(id: number)      { openJobAction('assign',   id); }
  function openReassign(id: number)    { openJobAction('reassign', id); }
  // Pending-for-Scheduling rows → combined Schedule & Assign modal.
  function openSchedule(id: number)    { openJobAction('schedule', id); }

  // Row-level quick action — same pattern as /jobs. Confirms, PATCHes status,
  // busts cache, refetches list + counts so badges stay coherent.
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Live-location popover state — the job whose technician location is being
  // viewed (null = closed). Shown for "Pending App Ack" (status 0, assigned)
  // and "Pending to Close" (status 2/20) rows, which always have a tech.
  const [locationJob, setLocationJob] = useState<JobRow | null>(null);
  const confirmAction = useConfirm();
  // Shared factory (lib/job-tabs.ts). /my-orders keeps its longer "continue
  // working" confirm copy and does NOT refresh counts (no pill bar here — see
  // the refreshCounts-removed note above), so no afterReload is passed.
  const quickStatusChange = makeQuickStatusChange({
    confirmAction,
    api,
    description: `The job's status will be updated. You can continue working while the update applies.`,
    setRowBusy,
    setErrorMsg,
    clearCache: () => cacheRef.current.clear(),
    reload: async () => { await load(false, true); },
  });

  // Client-side search over the currently-loaded page (shared filterJobRows
  // in lib/job-tabs.ts — see there for the column/label/date matching rationale).
  //
  // 2026-06-10 fix: client filter now runs for the Unconfirmed tab TOO.
  // Earlier this short-circuited to `return true` because BE was assumed
  // to be the only source of truth, but that meant typing a job_id in
  // the search box did NOTHING for the first 300ms (until the debounced
  // server-q refetch fired). Now: client filter shows current-page
  // matches INSTANTLY; the debounced server-q refetch in parallel
  // expands the result to off-page matches when it lands.
  const filteredItems = filterJobRows(data?.items ?? [], q);
  // Server-side sort — order the WHOLE result set in SQL before LIMIT/OFFSET so
  // sorting reaches off-page rows (a client reorder only touched the current
  // page). A header click cycles the state and refetches.
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const toggle = (col: string) => {
    const next = cycleSort(col, { sortBy: sortKey, sortDir });
    setSortKey(next.sortBy);
    setSortDir(next.sortDir);
  };
  // Server returns the page already ordered; keep the name `sorted` for render.
  const sorted = filteredItems;
  const sortMountRef = useRef(true);
  useEffect(() => {
    if (sortMountRef.current) { sortMountRef.current = false; return; }
    setPage(0);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey, sortDir]);

  // Resolve the current tab's human label for the page header — each sidebar
  // sub-menu is a standalone status page, so the tab name IS the page title.
  const activeTab = TABS.find((t) => t.value === tab);

  // Pending-for-Scheduling tab (status=0, unassigned) gets a DISTINCT
  // column set + a stripped-down action menu (Schedule & Assign only —
  // no generic View; the modal already shows full job detail). All other
  // tabs keep the shared table below unchanged.
  const isPendingScheduling = tab === 'pending-scheduling';

  // Whole days between a ticket-created timestamp and now, e.g. "12d".
  // Null/invalid → '—'. Negative clamps to 0d (future-dated guard).
  function jobAgeLabel(d: string | null | undefined): string {
    if (!d) return '—';
    const t = new Date(d).getTime();
    if (Number.isNaN(t)) return '—';
    const days = Math.floor((Date.now() - t) / 86_400_000);
    return `${days < 0 ? 0 : days}d`;
  }

  return (
    <div className="space-y-5">
      {errorMsg && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)} className="text-xs hover:underline">Dismiss</button>
        </div>
      )}
      <div className="flex items-end justify-between">
        <div>
          {/*
            * Page title = "My Orders · <lifecycle phase>" when a tab is set,
            * plain "My Orders" for the 'all' default. Ops land here directly
            * from a sidebar sub-menu so the tab context is already baked into
            * their click — no need for an in-page tab selector.
            */}
          <h1 className="text-2xl font-semibold">
            My Orders
            {activeTab && activeTab.value !== 'all' && (
              <span className="text-muted-foreground font-normal"> · {activeTab.label}</span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {data?.total.toLocaleString() ?? '…'} matching orders
            {!isAdmin && me?.user && <span> owned by <strong>{me.user.user_name}</strong></span>}
            {isAdmin && <span className="text-xs text-muted-foreground"> · viewing all (admin)</span>}
          </p>
        </div>
      </div>

      {/*
        * Pill-bar tab selector removed — each My Orders sidebar sub-menu is
        * already a dedicated status page (Unconfirmed, Pending Scheduling,
        * etc.), so an in-page tab bar would duplicate that navigation.
        * Users switch buckets via the sidebar; the URL's ?tab= param drives
        * the filter under the hood, unchanged.
        */}

      {/* Search bar */}
      <Card>
        <CardContent className="p-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search job ref / client ref / customer name or mobile…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {tab === 'unconfirmed' ? (
            <UnconfirmedJobsTable
              rows={sorted}
              loading={loading}
              canConfirm={!!canJob.isJobConfirm}
              canSendMagicLink={!!canJob.isJobMagicLinkSend}
              // Force Send (Override) is keyed on the literal role_name
              // = 'Admin' (matches the BE override gate). `isAdmin`
              // above uses `role.group` which is broader (admin-class
              // roles), so we recompute here against the exact role
              // name. Case-insensitive for seed-data safety.
              userIsAdmin={me?.role?.role_name?.toLowerCase() === 'admin'}
              openView={openView}
              openConfirm={openConfirm}
              // Server-side sort: forward the page's sort state + toggle so the
              // Unconfirmed column headers sort the WHOLE list (not just page).
              sortBy={sortKey}
              sortDir={sortDir}
              onSort={toggle}
              // Force-refetch (skip TAB_CACHE) so the "Link Sent" pill
              // appears immediately after the popup closes successfully.
              onMagicLinkSent={() => load(false, true)}
            />
          ) : isPendingScheduling ? (
          /*
            * Pending-for-Scheduling custom layout. Distinct columns vs the
            * shared table: surfaces ticket age, service category, appointment
            * date + slot, and the open reason — the signals ops need to
            * triage the scheduling queue. Sole row action is Schedule &
            * Assign (no generic View — the modal shows full job detail).
            */
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader<string> col="job_id" sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="stick-col-head stick-left">Job ID</SortHeader>
                <SortHeader<string> col="created_date_time" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Ticket Created Date / Job Age</SortHeader>
                <SortHeader<string> col="client_name" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Client</SortHeader>
                <SortHeader<string> col="city_name" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>City</SortHeader>
                <th>Service Category</th>
                <SortHeader<string> col="requested_date_time" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Appointment Date &amp; Time</SortHeader>
                <SortHeader<string> col="customer_name" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Customer</SortHeader>
                <SortHeader<string> col="job_status" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Current Status</SortHeader>
                <th>Open Reason / Remarks</th>
                <th className="stick-col-head stick-right text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: 10 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-24 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!loading && sorted.length === 0 && (
                <tr><td colSpan={10} className="text-center text-muted-foreground py-8">
                  No orders in this bucket{!isAdmin ? ' owned by you' : ''}.
                </td></tr>
              )}
              {!loading && sorted.map((j) => (
                <tr key={j.job_id} className="hover:bg-muted/40">
                  <td className="stick-col stick-left font-medium">
                    <span className="inline-flex items-center gap-1">
                      #{j.job_id}
                      <CallHistoryButton jobId={j.job_id} />
                    </span>
                  </td>
                  <td className="whitespace-nowrap">
                    <div className="text-xs">{formatDate(j.ticket_created_date_time)}</div>
                    <div className="text-[10px] text-muted-foreground">{jobAgeLabel(j.ticket_created_date_time)}</div>
                  </td>
                  <td className="min-w-[18rem] max-w-[26rem] break-words">{j.client_name ?? '—'}</td>
                  <td>{j.city_name ?? '—'}</td>
                  <td>{j.service_category ?? '—'}</td>
                  <td className="whitespace-nowrap">
                    <div className="text-xs">{j.requested_date_time ? formatDate(j.requested_date_time) : '—'}</div>
                    {j.time_slot && <div className="text-[10px] text-muted-foreground">· {j.time_slot}</div>}
                  </td>
                  <td>
                    <div>{j.customer_name ?? '—'}</div>
                    <div className="text-xs text-muted-foreground">
                      {/* Click-to-call + masking handled by CallableMobile.
                          Call history moved to the Job # cell (job-scoped). */}
                      <CallableMobile jobId={j.job_id} mobile={j.customer_mob_no} />
                    </div>
                  </td>
                  <td>
                    {j.job_status === 0 && (j.is_offered === 1 || j.is_offered === true) ? (
                      <StatusChip
                        tone="orange"
                        title={j.offered_efr_name ? `Offered to ${j.offered_efr_name}` : 'Offered to technician'}
                      >
                        Offered to Tx
                      </StatusChip>
                    ) : (
                      <StatusChip tone={statusTone(j.job_status)}>
                        {statusLabel(j.job_status, { assigned: j.fk_easyfixter_id != null })}
                      </StatusChip>
                    )}
                  </td>
                  <td className="max-w-[16rem] truncate" title={j.remarks ?? undefined}>{j.remarks || '—'}</td>
                  <td className="stick-col stick-right text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1 justify-end">
                      {/* Sole action: Schedule & Assign (no View — modal shows detail). */}
                      {canJob.isJobAssign && (
                        <button
                          type="button"
                          onClick={() => openSchedule(j.job_id)}
                          className="inline-flex items-center gap-1 text-indigo-700 text-xs hover:underline"
                          title="Schedule & Assign — set the date/slot and pick a technician"
                        >
                          <CalendarClock className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader col="job_id"             sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="stick-col-head stick-left">Job #</SortHeader>
                <SortHeader col="client_name"        sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Client</SortHeader>
                <SortHeader col="customer_name"      sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Customer</SortHeader>
                <SortHeader col="customer_mob_no"    sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Mobile</SortHeader>
                <SortHeader col="city_name"          sortBy={sortKey} sortDir={sortDir} onSort={toggle}>City</SortHeader>
                <SortHeader col="easyfixer_name"     sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Technician</SortHeader>
                <SortHeader col="requested_date_time" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Requested</SortHeader>
                <SortHeader col="job_status"         sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Status</SortHeader>
                <th className="stick-col-head stick-right text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: 9 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-24 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!loading && sorted.length === 0 && (
                <tr><td colSpan={9} className="text-center text-muted-foreground py-8">
                  No orders in this bucket{!isAdmin ? ' owned by you' : ''}.
                </td></tr>
              )}
              {!loading && sorted.map((j) => (
                <tr key={j.job_id} className="hover:bg-muted/40">
                  <td className="stick-col stick-left font-medium">
                    <span className="inline-flex items-center gap-1">
                      #{j.job_id}
                      <CallHistoryButton jobId={j.job_id} />
                    </span>
                  </td>
                  <td className="min-w-[18rem] max-w-[26rem] break-words">{j.client_name ?? '—'}</td>
                  <td>{j.customer_name ?? '—'}</td>
                  <td className="text-xs text-muted-foreground">
                    {/* Click-to-call lives on the mobile cell itself.
                        Call history moved to the Job # cell (job-scoped). */}
                    <CallableMobile jobId={j.job_id} mobile={j.customer_mob_no} />
                  </td>
                  <td>{j.city_name ?? '—'}</td>
                  <td>{j.easyfixer_name ? formatEasyfixerName(j.easyfixer_name) : <span className="text-muted-foreground">unassigned</span>}</td>
                  <td className="text-xs whitespace-nowrap">{j.requested_date_time ? formatDate(j.requested_date_time) : '—'}</td>
                  <td>
                    <StatusChip tone={statusTone(j.job_status)}>
                      {statusLabel(j.job_status, { assigned: j.fk_easyfixter_id != null })}
                    </StatusChip>
                    {/*
                     * "No Services" pill — shared anomaly indicator for
                     * BOOKED jobs with zero active services (counts only
                     * job_service_status=1 server-side). Same chip
                     * pattern as /jobs and /customers/[id]. Helps techs
                     * spot scheduling slots that need ops attention
                     * before they start travelling.
                     */}
                    {j.job_status === 0 && (j.service_count ?? 0) === 0 && (
                      <button
                        type="button"
                        // Clickable deep-link to the Services tab — same
                        // pattern as /jobs. stopPropagation guards
                        // against any future row-level click handlers.
                        onClick={(e) => {
                          e.stopPropagation();
                          openJobAction('view', j.job_id, { tab: 'services' });
                        }}
                        className="ml-1 inline-flex items-center rounded-full bg-amber-100 hover:bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 whitespace-nowrap cursor-pointer transition-colors"
                        title="Booked but no services attached. Click to open the Services tab."
                      >
                        No Services
                      </button>
                    )}
                  </td>
                  <td className="stick-col stick-right text-right whitespace-nowrap">
                    {/* Row actions follow legacy Manage Jobs + our /jobs page convention */}
                    <div className="inline-flex items-center gap-1 justify-end">
                      {/*
                        * Generic View (Eye) shows on every tab EXCEPT
                        * Pending-for-Scheduling, whose Schedule & Assign
                        * modal already surfaces full job detail. (That tab
                        * also renders its own custom table above, so this
                        * branch is unreached there — the guard documents the
                        * intent and is defensive against future refactors.)
                        */}
                      {!isPendingScheduling && (
                        <button
                          type="button"
                          onClick={() => openView(j.job_id)}
                          className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                          title="View details"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {/*
                        * Live Technician Location (📍). Shown for the two
                        * buckets where a technician is already assigned and
                        * actively heading to / on the job:
                        *   - Pending App Ack  → status 0 + fk_easyfixter_id
                        *   - Pending to Close → status 2 or 20
                        * Opens LiveLocationPopover (polls the job-location
                        * endpoint every 15s while open). Read-only — no
                        * permission gate beyond screen access.
                        */}
                      {((j.job_status === 0 && j.fk_easyfixter_id != null) ||
                        j.job_status === 2 || j.job_status === 20) && (
                        <button
                          type="button"
                          onClick={() => setLocationJob(j)}
                          className="inline-flex items-center gap-1 text-sky-700 text-xs hover:underline"
                          title="Live technician location"
                          aria-label="Live technician location"
                        >
                          <MapPin className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {/* Outbound call now lives on the customer mobile cell
                          (see Mobile column above) — clicking the number
                          dials it. */}
                      {/* Unconfirmed (status=9): legacy flow was "open addEditJob
                          modal, complete details, click Book Call → status 0".
                          We mirror that: click the icon → JobModal opens; the
                          action bar there shows Edit + Confirm & Schedule so
                          ops can fill any missing fields before promoting. */}
                      {j.job_status === 9 && canJob.isJobConfirm && (
                        <button
                          type="button"
                          onClick={() => openConfirm(j.job_id)}
                          className="inline-flex items-center gap-1 text-purple-700 text-xs hover:underline"
                          title="Confirm — fill details, pick services, and move to Scheduled"
                        >
                          <CalendarCheck className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {/*
                        * Pending for Scheduling (status=0, unassigned):
                        * EXACTLY two actions — View (the generic Eye above,
                        * read-only) + Schedule & Assign. The latter opens
                        * ScheduleAssignModal, which edits the Job Date/Slot
                        * AND assigns a technician atomically. The old
                        * separate Schedule (→JobModal) and Assign
                        * (→AssignTechnicianModal) buttons are folded into
                        * this one combined flow.
                        */}
                      {j.job_status === 0 && canJob.isJobAssign && (
                        <button
                          type="button"
                          onClick={() => openSchedule(j.job_id)}
                          className="inline-flex items-center gap-1 text-indigo-700 text-xs hover:underline"
                          title="Schedule & Assign — set the date/slot and pick a technician"
                        >
                          <CalendarClock className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {j.job_status === 1 && (
                        <>
                          {canJob.isJobStatusChange && (
                            <button
                              type="button"
                              disabled={rowBusy === j.job_id}
                              onClick={() => quickStatusChange(j.job_id, 2, 'Check in')}
                              className="inline-flex items-center gap-1 text-amber-700 text-xs hover:underline disabled:opacity-50"
                              title="Check-In — technician on-site, move to In Progress"
                            >
                              <PlayCircle className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {/*
                            * Reassign Technician — same modal, mode=reassign.
                            * Backend candidates query already excludes anyone
                            * who's previously rejected/rescheduled this job.
                            */}
                          {canJob.isJobReassign && (
                            <button
                              type="button"
                              onClick={() => openReassign(j.job_id)}
                              className="inline-flex items-center gap-1 text-indigo-700 text-xs hover:underline"
                              title="Reassign Technician — pick a different tech from the ranked list"
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </>
                      )}
                      {(j.job_status === 2 || j.job_status === 20) && canJob.isJobStatusChange && (
                        <button
                          type="button"
                          disabled={rowBusy === j.job_id}
                          onClick={() => quickStatusChange(j.job_id, 3, 'Check out & complete')}
                          className="inline-flex items-center gap-1 text-emerald-700 text-xs hover:underline disabled:opacity-50"
                          title="Check-Out — close the job"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </CardContent>
      </Card>

      <JobModal
        open={modal.open}
        mode={modal.mode}
        jobId={modal.id}
        onClose={closeModal}
        onSaved={(job) => {
          cacheRef.current.clear();
          load(false, true);
          // Book New Call (create) → jump straight into the NEW Schedule &
          // Assign modal for the freshly-booked job, replacing the legacy
          // view-mode step with its Auto-assign / Manual-pick buttons.
          if (modal.mode === 'create' && job?.job_id) {
            openSchedule(Number(job.job_id));
          }
        }}
        // Same `?viewTab=` deep-link plumbing as /jobs. Powers the
        // clickable "No Services" pill on each row.
        initialTab={searchParams.get('viewTab') || undefined}
      />

      <AssignTechnicianModal
        open={assignModal.open}
        jobId={assignModal.jobId}
        mode={assignModal.mode}
        onClose={() => closeJobAction()}
        onAssigned={() => { cacheRef.current.clear(); load(false, true); }}
      />

      {/*
        * Schedule & Assign — Pending-for-Scheduling combined flow. Edits
        * the Job Date/Slot and assigns a technician in one atomic step,
        * then refreshes the list so the row moves to "Pending App Ack".
        */}
      <ScheduleAssignModal
        open={scheduleModal.open}
        jobId={scheduleModal.jobId}
        onClose={() => closeJobAction()}
        onAssigned={() => { cacheRef.current.clear(); load(false, true); }}
      />

      {/*
        * Live technician location — Pending App Ack / Pending to Close rows.
        * Polls GET /admin/jobs/:id/location every 15s while open; stops on
        * close (interval cleanup lives in LiveLocationPopover).
        */}
      <LiveLocationPopover
        open={locationJob != null}
        onClose={() => setLocationJob(null)}
        source="job"
        id={locationJob?.job_id ?? null}
        title={locationJob
          ? `Job #${locationJob.job_id}${locationJob.easyfixer_name ? ` · ${formatEasyfixerName(locationJob.easyfixer_name)}` : ''}`
          : undefined}
      />

      {data && (
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={data.total}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
        />
      )}
    </div>
  );
}
