'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useJobActionParams, useJobActionNav } from '@/lib/job-action-url';
import {
  Plus, Upload, ChevronDown, ChevronUp, Repeat,
  // Row-level quick-action icons (mirror the legacy Manage Jobs action column)
  Eye, CalendarClock, PlayCircle, CheckCircle2, CalendarCheck, MapPin,
} from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { SearchSelect } from '@/components/ui/search-select';
import { CitySelect } from '@/components/ui/city-select';
import { StatusChip } from '@/components/ui/StatusChip';
import { DownloadButton } from '@/components/ui/download-button';
import { downloadXlsx } from '@/lib/download-xlsx';
import { api } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { formatDate, formatEasyfixerName, statusLabel, statusTone } from '@/lib/utils';
import {
  TABS, type CountsResp, countFor, filterJobRows, makeQuickStatusChange,
  JOB_SEARCH_PLACEHOLDER, JOB_SEARCH_HINT,
} from '@/lib/job-tabs';
import { JobModal, type JobModalMode } from '@/components/job/JobModal';
import { TransferJobOwnershipDialog } from '@/components/job/TransferJobOwnershipDialog';
import { UnconfirmedJobsTable } from '@/components/job/UnconfirmedJobsTable';
import { CallableMobile } from '@/components/calls/CallButton';
import { cycleSort, SortHeader, type SortDir } from '@/lib/use-sort';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { RefreshBar } from '@/components/ui/refresh-bar';
import { LiveLocationPopover } from '@/components/location/LiveLocationPopover';

// `/admin/jobs` Joi caps limit at 500 — pass to pageSizeToLimit so
// "All" sends 500 instead of the default 1000 (which would 400).
const JOBS_MAX_LIMIT = 500;

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
  fk_customer_id: number; customer_name: string; customer_mob_no: string;
  fk_client_id: number; client_name: string;
  fk_easyfixter_id: number | null; easyfixer_name: string | null;
  job_owner: number | null; owner_name: string | null;
  fk_address_id: number; city_name: string | null;
  // service_count surfaced on the LIST projection (2026-05-28) so the FE
  // can flag rows that landed in BOOKED with no services attached — a
  // legacy gap (Job #482453 etc.) where ops promoted a job before
  // adding service rows. Renders as a small "No Services" pill in the
  // Status cell, mirroring the Draft-pill pattern.
  service_count?: number;
  // last_update_time already used by the Unconfirmed Draft pill — keep
  // here for the row type completeness in case other indicators need it.
  last_update_time?: string | null;
};
type Resp = { items: JobRow[]; total: number; limit: number; offset: number };

// TABS / TabDef / CountsResp / countFor now live in lib/job-tabs.ts and are
// shared with /my-orders. Any change to the lifecycle mapping lands in both
// places automatically.

// Default rows-per-page; operator-controlled via the TablePagination
// footer. "All" maps to JOBS_MAX_LIMIT (the BE Joi cap on /admin/jobs).
const DEFAULT_PAGE_SIZE: TablePageSize = 10;

/*
 * Bucket Status mapping — the legacy CRM's 3-way categorical view
 * over job_status. Wider than the per-status tabs; the rule (verified
 * 2026-05-19):
 *   closed    → 3 (COMPLETED), 5 (COMPLETED_ALT)
 *   cancelled → 6 (CANCELLED), 7 (ENQUIRY)
 *   open      → everything else valid (0,1,2,9,10,15,20,21)
 * `open` is the complement, so adding a new active status only
 * requires adding it here.
 */
const BUCKET_STATUS_MAP: Record<string, number[]> = {
  open:      [0, 1, 2, 9, 10, 15, 20, 21],
  closed:    [3, 5],
  cancelled: [6, 7],
};

export default function JobsPage() {
  const lk = useLookup();
  const { me } = useMe();
  // Permission gating. View remains open; create + bulk upload require
  // explicit actions. The View-modal opened on row-click handles its own
  // internal Edit/Save buttons separately — gate those when the modal
  // ships a permission-aware refactor.
  const can = actionFlags(me, ['isJobAddNew', 'isJobUpload', 'isJobEdit']);
  // Per-row action gates — same keys /my-orders uses. Manage Jobs was
  // previously ungated, so Confirm/Schedule/Check-In/Check-Out icons
  // showed regardless of permission. That asymmetry let Admin appear to
  // "have" actions on /jobs that My Orders correctly hid (because Admin's
  // `role_menu_action` rows for these keys weren't seeded). With both
  // pages gated identically, the migration
  // `2026-05-13-seed-new-action-permissions.sql` is the single source of
  // truth: grant in DB → button appears on both pages; revoke → hidden
  // on both.
  const canJob = actionFlags(me, [
    'isJobConfirm',
    'isJobAssign',
    'isJobStatusChange',
    // Drives the "Transfer Job Ownership" button gating. The BE
    // bulk-transfer route is roleByName(['Admin']); we use the
    // existing permission key so the seed migration controls
    // visibility.
    'isTransferJobOwnership',
    // Gates the per-row Trigger/Retrigger button on the Unconfirmed
    // tab — seeded by the 2026-05-28 magic-link migration for Admin
    // (role 2) + Executive Supply (role 3). Combines with the row's
    // `client_opted_in` flag inside UnconfirmedJobsTable.
    'isJobMagicLinkSend',
  ]);
  const [tab, setTab] = useState('all');
  // Counts are fetched once on mount + re-fetched after any save from the
  // modal (so badges stay fresh). Null = still loading; populated = ready.
  const [counts, setCounts] = useState<CountsResp | null>(null);
  // `q` is UI-only — filters the currently-loaded page in memory rather than
  // firing a backend request per keystroke. Searching feels instant. Fetches
  // still happen on tab switch, filter changes, and pagination.
  const [q, setQ] = useState('');
  /*
   * `filters` mirrors the legacy CRM "Filter Job" panel. Every key
   * round-trips to the backend as a query param of the same name; the
   * service layer applies them as additive WHERE clauses on top of the
   * tab-selected status bucket. Empty string = "not set" (stripped
   * before the fetch via `|| undefined`).
   *
   * Filters NOT included (deferred until BE support lands):
   *   rating, reopen, dueTo, zonal — these need new joins
   *   (tbl_easyfixer_rating_by_customer, no_of_escalations,
   *   tbl_job_comments.user_type, tbl_city.zone_id) and were left out
   *   of this pass to ship the high-value set first.
   */
  const [filters, setFilters] = useState({
    clientId: '', cityId: '', stateId: '',
    ownerId: '', easyfixerId: '',
    startDate: '', endDate: '', dateType: '',
    customerQ: '', clientRef: '', efrMobile: '', pin: '',
    categoryId: '', verticalId: '',
    // Job Status — single-code narrowing. `filters.status` now ALWAYS
    // wins over the tab's status (the load() builder uses it first),
    // so picking "Booked" while on the "Pending to Start" tab actually
    // narrows to status=0 instead of silently keeping status=1.
    status: '',
    // Bucket Status — the LEGACY 3-way categorical (Open / Closed /
    // Cancelled). Distinct from Job Status:
    //   open      → job_status IN (0,1,2,9,10,15,20,21)
    //   closed    → job_status IN (3,5)        (Completed)
    //   cancelled → job_status IN (6,7)        (Cancelled + Enquiry)
    // The mapping lives in BUCKET_STATUS_MAP near load(); the
    // dropdown options pull from there too.
    bucketStatus: '',
    // Phase-2 filters wired 2026-05-19.
    rating: '', reopen: '', dueTo: '', zonalId: '',
  });
  // page is 0-indexed at the API boundary (offset = page * pageSize),
  // but TablePagination displays it 1-indexed. Switching pageSize
  // resets page to 0 so the operator always lands on the first row.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(DEFAULT_PAGE_SIZE);
  const limit = pageSizeToLimit(pageSize, JOBS_MAX_LIMIT);
  const offset = page * limit;
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  // `refreshing` = a silent/poll reload while data is already on screen. Never
  // gates the table (that's `loading`, first-paint only) — keeps refreshes
  // flicker-free. Optionally surfaced as a subtle indicator.
  const [refreshing, setRefreshing] = useState(false);
  // Server-side sort state (whitelisted BE-side) — declared here with the other
  // query state so load() and the poll effect can depend on it. `toggle` + the
  // sort refetch effect live near the render below.
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [showFilters, setShowFilters] = useState(false);

  /*
   * Result cache keyed by `${tab}|${offset}|${filters+q}`. Switching back to a
   * tab you've already visited is instant + DB-free. Search/filter changes bust
   * their portion of the key. TTL is 30 s — long enough to make tab switching
   * feel snappy, short enough that a freshly-assigned tech is reflected when
   * the ops user returns to the Scheduled tab.
   */
  const cacheRef = useRef<Map<string, { at: number; data: Resp }>>(new Map());
  /*
   * In-flight request dedupe. Multiple useEffects (tab / page /
   * filters / focusParam) plus React Strict Mode's double-invoke
   * in dev fan out to 4-8 concurrent calls for the same query key
   * on /jobs page load. Without this Map we get N round-trips
   * where 1 would do. The Promise sits in the Map only while the
   * request is in flight; any caller that resolves the same key
   * while it's there reuses the same Promise. Cleared in the
   * `finally` block once the response (or error) lands.
   */
  const inflightRef = useRef<Map<string, Promise<Resp>>>(new Map());
  /*
   * Monotonic load sequence. Each load() invocation claims the latest
   * number; only the most recent invocation may commit UI state. Stops
   * a slow response for a previous tab/filter from overwriting the
   * rows (and spinner) of the request the operator actually wants.
   */
  const loadSeqRef = useRef(0);
  /*
   * Same dedupe pattern for /counts. The dashboard's `refreshCounts`
   * effect fires twice in Strict Mode; with this guard the second
   * call attaches to the in-flight Promise instead of starting a
   * fresh request.
   */
  const inflightCountsRef = useRef<Promise<CountsResp> | null>(null);
  const TAB_CACHE_TTL = 30_000;

  function filterKey() {
    // `q` intentionally excluded — it's a UI-only filter, doesn't change the
    // backend request, so we cache the same underlying result regardless of query.
    return [
      filters.clientId, filters.cityId, filters.stateId,
      filters.ownerId, filters.easyfixerId,
      filters.startDate, filters.endDate, filters.dateType,
      filters.customerQ, filters.clientRef, filters.efrMobile, filters.pin,
      filters.categoryId, filters.verticalId, filters.status, filters.bucketStatus,
      filters.rating, filters.reopen, filters.dueTo, filters.zonalId,
    ].join('|');
  }

  async function load(reset = false, force = false, silent = false) {
    const seq = ++loadSeqRef.current;
    const tabDef = TABS.find((t) => t.value === tab);
    const off = reset ? 0 : offset;
    // Cache key includes pageSize so changing rows-per-page doesn't
    // serve a stale fixed-50 payload.
    const key = `${tab}|${off}|${limit}|${sortKey || ''}|${sortDir}|${filterKey()}`;

    // First paint (no data yet) raises the skeleton; every later reload —
    // pagination, sort, post-mutation — is silent so the table body never
    // flashes "Loading…".
    //
    // Raised BEFORE the cache/in-flight short-circuits, and cleared in the single
    // `finally` that every exit path below funnels through. When those
    // short-circuits had their own `return`s they skipped the cleanup entirely:
    // on mount BOTH effects call load(), the second bumps `seq` (staling the
    // first) and then short-circuits onto the first's in-flight promise — so the
    // first was stale-guarded out of its own `finally` and the second never
    // reached one. Nobody cleared `loading` and the table showed the skeleton
    // until a tab change fired an un-raced load.
    if (data == null && !silent) setLoading(true); else setRefreshing(true);
    try {
      if (!force) {
        const hit = cacheRef.current.get(key);
        if (hit && Date.now() - hit.at < TAB_CACHE_TTL) {
          if (seq === loadSeqRef.current) {
            setData(hit.data);
            if (reset) setPage(0);
          }
          return;
        }
      }

      // In-flight dedupe: if a request for this exact key is already
      // mid-air (Strict Mode double-fire, or two effects landing in
      // the same tick), attach to it instead of starting a fresh one.
      // The Promise hasn't settled yet, so the cache isn't populated —
      // but the response is on the way; we just await it.
      const inflight = inflightRef.current.get(key);
      if (inflight) {
        try {
          const r = await inflight;
          if (seq === loadSeqRef.current) {
            setData(r);
            if (reset) setPage(0);
          }
        } catch { /* ignore — the originating call will surface the error */ }
        return;
      }

      /*
       * Pass the tab's filter payload to the backend:
       *   - `statuses` (CSV) wins when set (multi-status tabs: Pending to Close,
       *     Audit & Complete).
       *   - `status` for single-code tabs.
       *   - `assigned` splits the BOOKED bucket for the two Pending-for-
       *     Scheduling / Pending-App-Ack tabs.
       * `undefined` values are stripped by `api.get` — no empty query params.
       */
      // `?focus=escalated` drives the legacy CRM header's "Escalated
      // Jobs" link — narrows the list to rows where tbl_job.is_escalated=1
      // regardless of which tab is active. Implemented as a separate
      // backend filter (not a tab) because escalation is a cross-cutting
      // flag, not a status bucket. When focus is unset, isEscalated is
      // omitted so the list behaves exactly as before.
      const isEscalated = searchParams.get('focus') === 'escalated' ? 'true' : undefined;
      // `noServices=true` (2026-05-28) is the deep-link from the
      // AttentionSummary "Booked With No Services" tile. The BE list
      // pins status=0 + anti-joins tbl_job_services internally — we
      // just forward the param. URL drives the request directly so
      // ops can share/bookmark the filtered view.
      const noServices = searchParams.get('noServices') === 'true' ? 'true' : undefined;
      // Status precedence (highest → lowest):
      //   1. filters.bucketStatus (Open/Closed/Cancelled) — sends
      //      `statuses` as a CSV of the matching IN-set. WINS over
      //      everything else: an explicit categorical pick should
      //      never be silently overridden by a tab or a single-status
      //      dropdown.
      //   2. filters.status (legacy "Job Status" dropdown) — single
      //      code, also wins over the tab.
      //   3. tab.statuses / tab.status — applied when neither
      //      filter is set.
      // The BE service prefers `statuses` over `status` when both
      // arrive, so we deliberately send only one of the two.
      const bucketStatuses = filters.bucketStatus
        ? BUCKET_STATUS_MAP[filters.bucketStatus]
        : null;
      const explicitStatus = filters.status ? Number(filters.status) : undefined;
      // Build the request promise and register it in the in-flight
      // Map before awaiting — so a Strict-Mode replay of this effect
      // in the same tick can attach. Cleared in `finally`.
      const reqPromise = api.get<Resp>('/admin/jobs', {
        status:    bucketStatuses
          ? undefined
          : (explicitStatus
              ?? (tabDef?.statuses ? undefined : tabDef?.status)),
        statuses:  bucketStatuses
          ? bucketStatuses.join(',')
          : (explicitStatus != null
              ? undefined
              : (tabDef?.statuses ? tabDef.statuses.join(',') : undefined)),
        // `assigned` is a per-tab refinement (assigned/unassigned
        // split of BOOKED). Bucket Status doesn't address it, so we
        // keep the tab's assigned flag UNLESS the operator overrode
        // status via bucket/job dropdowns — in those cases the tab's
        // assigned hint is no longer semantically aligned.
        assigned:  (bucketStatuses || explicitStatus != null)
          ? undefined
          : (tabDef?.assigned === undefined ? undefined : String(tabDef.assigned)),
        isEscalated,
        noServices,
        limit, offset: off,
        // Server-side sort (whitelisted BE-side). Only sent when a column is
        // active; absent → BE default job_id DESC.
        sortBy: sortKey || undefined,
        sortDir: sortKey ? sortDir : undefined,
        clientId: filters.clientId || undefined,
        cityId: filters.cityId || undefined,
        stateId: filters.stateId || undefined,
        ownerId: filters.ownerId || undefined,
        easyfixerId: filters.easyfixerId || undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
        // dateType is meaningless without a date range; only ship it
        // when at least one of from/to is present. Saves a no-op
        // refetch when the operator toggles Date Type with no dates.
        dateType: (filters.dateType && (filters.startDate || filters.endDate))
          ? filters.dateType
          : undefined,
        customerQ: filters.customerQ || undefined,
        clientRef: filters.clientRef || undefined,
        efrMobile: filters.efrMobile || undefined,
        pin: filters.pin || undefined,
        categoryId: filters.categoryId || undefined,
        verticalId: filters.verticalId || undefined,
        rating: filters.rating || undefined,
        reopen: filters.reopen || undefined,
        dueTo:  filters.dueTo  || undefined,
        zonalId: filters.zonalId || undefined,
        // Dashboard AttentionSummary drill-down tabs carry these.
        // BE list endpoint clamps the result to "still actionable"
        // for the chosen quotation status (see service.list()).
        quotationStatus: tabDef?.quotationStatus,
        requestedBefore: tabDef?.requestedBefore,
      });
      inflightRef.current.set(key, reqPromise);
      try {
        const r = await reqPromise;
        // Cache unconditionally — the payload is correct for its own key
        // regardless of whether this invocation is still the latest.
        cacheRef.current.set(key, { at: Date.now(), data: r });
        if (seq === loadSeqRef.current) {
          setData(r);
          if (reset) setPage(0);
        }
      } finally {
        // Only THIS call owns the entry it registered — the cache/dedupe
        // short-circuits above must not evict a promise another call awaits.
        inflightRef.current.delete(key);
      }
    } catch (e) {
      setErrorMsg(`Failed to load jobs: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      if (seq === loadSeqRef.current) { setLoading(false); setRefreshing(false); }
    }
  }

  useEffect(() => { setPage(0); load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab]);
  // Refetch on page or pageSize change. pageSize change resets page
  // via the onPageSizeChange handler below, so an explicit reset isn't
  // needed here.
  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page, pageSize]);
  // NOTE: no interval polling — data refreshes on ACTION (post-mutation
  // load(false, true) after saves/row-actions), which is now SILENT + flicker-
  // free thanks to the data-null loading guard above. Event-driven is cheaper
  // than a 15s poll and never surprises an operator mid-task.
  // Reload when ?focus=… changes — drives the Escalated Jobs deep-link
  // from the navbar.
  const focusParam = useSearchParams().get('focus');
  useEffect(() => { setPage(0); load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [focusParam]);

  /*
   * Counts fetch — runs once on mount and again after a save from the modal.
   * Same endpoint the dashboard uses, so it's already warm in the pool.
   * Null-safe: if the request fails, badges simply don't render, no toast.
   */
  async function refreshCounts() {
    // In-flight dedupe: if another caller is already waiting on
    // /counts (Strict Mode replay, or a mid-effect Save callback),
    // attach to the same Promise. Single-key dedupe (counts has no
    // query params worth keying on) keeps this simpler than the
    // Map-keyed dedupe used for the LIST endpoint.
    if (inflightCountsRef.current) {
      try { setCounts(await inflightCountsRef.current); }
      catch { /* swallow — the tab bar is still functional without badges */ }
      return;
    }
    const promise = api.get<CountsResp>('/admin/jobs/counts');
    inflightCountsRef.current = promise;
    try {
      setCounts(await promise);
    } catch { /* swallow — the tab bar is still functional without badges */ }
    finally {
      inflightCountsRef.current = null;
    }
  }
  useEffect(() => { refreshCounts(); }, []);
  // Filter changes refetch (backend-driven); the search box doesn't — see below.
  /*
   * Refetch trigger. `filters.dateType` is included in the deps so
   * that changing OR clearing Date Type while a date range is set
   * triggers a fresh load (the previous "manual setTimeout in
   * onChange" approach race'd against React's stale-closure
   * semantics — see 2026-05-19 bug report).
   *
   * The trade-off: changing Date Type while BOTH dates are empty
   * fires one no-op refetch (the BE drops the dateType param when
   * no dates are present, returning the same rows). One wasted
   * query per dropdown change beats a broken filter.
   */
  useEffect(() => { setPage(0); load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [
      filters.clientId, filters.cityId, filters.stateId,
      filters.ownerId, filters.easyfixerId,
      filters.startDate, filters.endDate, filters.dateType,
      filters.customerQ, filters.clientRef, filters.efrMobile, filters.pin,
      filters.categoryId, filters.verticalId, filters.status, filters.bucketStatus,
      filters.rating, filters.reopen, filters.dueTo, filters.zonalId,
    ]);

  /*
   * Auto-clear the Transfer Job Ownership alert whenever ANY filter
   * changes. Operators dismissing the cue by adjusting the form
   * shouldn't have to wait the full 3s for it to fade. Same dep
   * shape as the refetch effect; we just discard the page reload.
   */
  useEffect(() => {
    setTransferAlert(null);
    if (transferAlertTimerRef.current != null) {
      window.clearTimeout(transferAlertTimerRef.current);
      transferAlertTimerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters.clientId, filters.cityId, filters.stateId,
    filters.ownerId, filters.easyfixerId,
    filters.startDate, filters.endDate, filters.dateType,
    filters.customerQ, filters.clientRef, filters.efrMobile, filters.pin,
    filters.categoryId, filters.verticalId, filters.status, filters.bucketStatus,
    filters.rating, filters.reopen, filters.dueTo, filters.zonalId,
  ]);

  // Modal state is derived from the URL — every row-level action
  // (View / Confirm / Book New Call / Assign / Reassign) pushes its
  // intent into `?jobId=&action=` so the URL is shareable. Direct
  // navigation to a deep-link URL lands the recipient straight on the
  // matching dialog. Legacy `?view=N` / `?new=1` URLs are auto-promoted
  // by `useJobActionParams` so old shared links keep working.
  const searchParams = useSearchParams();
  const { jobId: urlJobId, action: urlAction } = useJobActionParams();
  const { openJobAction, closeJobAction } = useJobActionNav();
  const modal = useMemo<{ open: boolean; mode: JobModalMode; id?: number }>(() => {
    if (!urlAction || urlAction === 'assign' || urlAction === 'reassign') {
      // Assign / reassign open a different dialog (AssignTechDialog),
      // not JobModal — handled separately below. Hide JobModal here.
      return { open: false, mode: 'create' };
    }
    if (urlAction === 'create') return { open: true, mode: 'create' };
    if (urlJobId == null)        return { open: false, mode: 'create' };
    return { open: true, mode: urlAction as JobModalMode, id: urlJobId };
  }, [urlAction, urlJobId]);

  /*
   * Deep-link tab support: /jobs?tab=<value> preselects that tab on mount.
   * Invalid / stale values silently ignored (don't kick users off for a
   * stray URL). My-Orders lives on /my-orders now — `scope=mine` on /jobs
   * no longer does anything.
   */
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && TABS.some((x) => x.value === t) && t !== tab) {
      setTab(t);
      setPage(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function closeModal() { closeJobAction(); }
  function openCreate() { openJobAction('create'); }
  function openView(id: number)    { openJobAction('view',    id); }
  function openConfirm(id: number) { openJobAction('confirm', id); }

  /*
   * Filter-respecting XLSX export. Mirrors the EscalatedJobsModal
   * download recipe: build the same query string the LIST endpoint
   * sees, then fetch with the Bearer header, blob-download. Reuses the
   * `DownloadButton` shared component for the green CTA styling and
   * loading state.
   */
  const [downloading, setDownloading] = useState(false);
  // Transfer Job Ownership dialog (admin-only). Gated by
  // `isTransferJobOwnership`. The dialog reads `currentFilters` so
  // "Apply to filtered jobs" mode targets exactly what's on screen.
  const [transferOpen, setTransferOpen] = useState(false);
  /*
   * Local "pick a Job Owner first" alert for the Transfer Job
   * Ownership button. Kept INLINE next to the button (rather than the
   * page-level errorMsg banner) so the cue is right at the action
   * site. Auto-clears after 3s + on any filter change. The timer ref
   * is kept on a useRef so we can cancel the pending clear when the
   * operator dismisses early via filter interaction.
   */
  const [transferAlert, setTransferAlert] = useState<string | null>(null);
  const transferAlertTimerRef = useRef<number | null>(null);
  async function exportXlsx() {
    if (downloading) return;
    setDownloading(true);
    try {
      const qs = new URLSearchParams();
      // Re-emit every active filter — keep this list in sync with the
      // load() call so the export is a true mirror of what's on screen.
      const tabDef = TABS.find((t) => t.value === tab);
      // Status precedence — same rule as load(): bucket-status >
      // job-status > tab.
      const bucketStatuses = filters.bucketStatus
        ? BUCKET_STATUS_MAP[filters.bucketStatus]
        : null;
      if (bucketStatuses) qs.set('statuses', bucketStatuses.join(','));
      else if (filters.status) qs.set('status', filters.status);
      else if (tabDef?.statuses) qs.set('statuses', tabDef.statuses.join(','));
      else if (tabDef?.status != null) qs.set('status', String(tabDef.status));
      if (!bucketStatuses && !filters.status && tabDef?.assigned !== undefined) {
        qs.set('assigned', String(tabDef.assigned));
      }
      const isEscalated = searchParams.get('focus') === 'escalated' ? 'true' : null;
      if (isEscalated) qs.set('isEscalated', 'true');
      // Mirror the same `dateType` gate as load() so the export
      // reflects exactly what's on screen.
      const effectiveDateType = (filters.dateType && (filters.startDate || filters.endDate))
        ? filters.dateType : '';
      Object.entries({
        clientId: filters.clientId, cityId: filters.cityId, stateId: filters.stateId,
        ownerId: filters.ownerId, easyfixerId: filters.easyfixerId,
        startDate: filters.startDate, endDate: filters.endDate, dateType: effectiveDateType,
        customerQ: filters.customerQ, clientRef: filters.clientRef,
        efrMobile: filters.efrMobile, pin: filters.pin,
        categoryId: filters.categoryId, verticalId: filters.verticalId,
        rating: filters.rating, reopen: filters.reopen, dueTo: filters.dueTo,
        zonalId: filters.zonalId,
      }).forEach(([k, v]) => { if (v) qs.set(k, String(v)); });
      const today = new Date().toISOString().slice(0, 10);
      try {
        await downloadXlsx({
          url: `/admin/jobs/export.xlsx?${qs.toString()}`,
          filename: `jobs_${today}.xlsx`,
        });
      } catch (e) {
        setErrorMsg(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally { setDownloading(false); }
  }

  /*
   * Quick status transition from the row action column — lets ops advance
   * a job through the flow (Check-In, Check-Out) without opening the modal.
   * Mirrors the legacy Manage Jobs page's inline icon actions.
   *
   * Schedule (status 0 → assign tech) is NOT handled here — it needs
   * operator choice, so clicking the calendar icon on a row opens the
   * modal and the operator uses the Auto-assign / Manual pick buttons
   * inside. That keeps the tech-selection flow in one place.
   */
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Live-location popover — the job whose technician location is being viewed
  // (null = closed). Shown for "Pending App Ack" (status 0, assigned) and
  // "Pending to Close" (status 2/20) rows, which always carry a tech.
  const [locationJob, setLocationJob] = useState<JobRow | null>(null);
  const confirmAction = useConfirm();
  // Shared factory (lib/job-tabs.ts). /jobs keeps the short confirm copy and
  // refreshes the dashboard counts after reload (afterReload: refreshCounts).
  const quickStatusChange = makeQuickStatusChange({
    confirmAction,
    api,
    description: `The job's status will be updated.`,
    setRowBusy,
    setErrorMsg,
    clearCache: () => cacheRef.current.clear(),
    reload: async () => { await load(false, true); },
    afterReload: refreshCounts,
  });

  // Instant client-side search filter over the current (server-sorted,
  // server-paginated) page — shared filterJobRows in lib/job-tabs.ts. Sorting
  // itself is now server-side (see below), so this only narrows what's already
  // ordered; it preserves the server's row order.
  const filteredItems = useMemo(() => filterJobRows(data?.items ?? [], q), [data, q]);
  // Server-side sort — sortKey/sortDir state is declared up in the state block
  // (load()/the poll effect depend on it); here we wire the header-click cycle.
  const toggle = (col: string) => {
    const next = cycleSort(col, { sortBy: sortKey, sortDir });
    setSortKey(next.sortBy);
    setSortDir(next.sortDir);
  };
  // Server already returns the page in sort order; keep the name `sorted` for the
  // render. filteredItems = the instant client q-filter over the current page.
  const sorted = filteredItems;
  // Refetch when the sort changes (skip the initial mount — the tab effect
  // already loads). Resets to page 1 so the operator sees the top of the new
  // ordering.
  const sortMountRef = useRef(true);
  useEffect(() => {
    if (sortMountRef.current) { sortMountRef.current = false; return; }
    setPage(0);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey, sortDir]);

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
          <h1 className="text-2xl font-semibold">Jobs</h1>
          <p className="text-sm text-muted-foreground">{data?.total.toLocaleString() ?? '…'} matching jobs</p>
        </div>
        <div className="flex gap-2">
          {can.isJobUpload && (
            <Button variant="outline" asChild>
              <Link href="/jobs/upload"><Upload className="h-4 w-4 mr-1" /> Upload Excel</Link>
            </Button>
          )}
          {can.isJobAddNew && (
            <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> Add New Job</Button>
          )}
        </div>
      </div>

      {/* Tab-pills row removed 2026-05-19 — the Bucket Status dropdown
          inside the Filter Job card now drives the same `tab` state.
          Counts are still tracked (refreshCounts() on mount + after
          modal saves) and exposed inline alongside the dropdown option
          so operators retain the per-bucket scan-affordance without
          the double-row chrome. */}

      {/* Filter Job — placement faithful to the legacy CRM panel.
          Rows 1 + 2 are always visible (10 filters); "Show More
          Filters" reveals rows 3 + 4 (10 more). Action row at the
          bottom mirrors legacy: Search + Reset + Show/Hide-Filters
          link on the LEFT, DownloadButton on the RIGHT.
          A separate top quick-search bar above the card keeps the
          in-memory `q` UX for narrowing the currently-loaded page;
          the panel below is the BE-driven filter set. */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="space-y-3">
            {/* Row 1 — Job ID / Customer / Client / Bucket / Job Status.
                `q` is the in-memory page-narrower (client-side filter
                over the rows already loaded for this tab + filter
                combo). The Job ID / RefID input is the ONLY writer to
                `q` — the legacy global search bar was dropped to
                eliminate the dual-input confusion. */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
              <div>
                {/* Relabelled from "Job ID / RefID" (2026-07-23): `q` feeds
                    filterJobRows, which matches 19 fields — the old label named
                    2 of them, so operators had no idea this box also narrows by
                    technician, client SPOC, city, status or date. Placeholder +
                    hint derive from JOB_SEARCH_FIELDS so the copy can't drift
                    from the filter again. Distinct from the "Customer Name / No."
                    box beside it: that one is a SERVER-side filter, this only
                    narrows rows already loaded for the current tab. */}
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Quick Search (This Page)</label>
                <Input
                  placeholder={JOB_SEARCH_PLACEHOLDER}
                  title={JOB_SEARCH_HINT}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Customer Name / No.</label>
                <Input placeholder="-- All --" value={filters.customerQ} onChange={(e) => setFilters({ ...filters, customerQ: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Client</label>
                <SearchSelect placeholder="All" value={filters.clientId} onChange={(v) => setFilters({ ...filters, clientId: v })} options={lk.toOpts.clients.map((o) => ({ value: o.value, label: String(o.label) }))} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Bucket Status</label>
                {/* Bucket Status — legacy categorical view over
                    job_status (Open / Closed / Cancelled). Distinct
                    from Job Status (single-code dropdown to the
                    right). The 3 values map to multi-status IN-sets
                    in load() via BUCKET_STATUS_MAP — picking "Closed"
                    sends statuses=3,5 to the BE. Wins over Job Status
                    + tab when set. */}
                <SearchSelect
                  placeholder="--All--"
                  value={filters.bucketStatus}
                  onChange={(v) => setFilters({ ...filters, bucketStatus: v })}
                  options={[
                    { value: 'open',      label: 'Open' },
                    { value: 'closed',    label: 'Closed / Completed' },
                    { value: 'cancelled', label: 'Cancelled' },
                  ]}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Job Status</label>
                {/* Single-code status — narrows within the current
                    bucket. When the tab already enforces a status, this
                    is a no-op; when tab='all' it sends `status=N` to BE. */}
                <SearchSelect
                  placeholder="-- All --"
                  value={filters.status ?? ''}
                  onChange={(v) => setFilters({ ...filters, status: v })}
                  options={[
                    { value: '0',  label: 'Booked' },
                    { value: '1',  label: 'Scheduled' },
                    { value: '2',  label: 'In Progress' },
                    { value: '3',  label: 'Completed' },
                    { value: '6',  label: 'Cancelled' },
                    { value: '7',  label: 'Enquiry' },
                    { value: '9',  label: 'Unconfirmed' },
                    { value: '10', label: 'Revisit' },
                    { value: '15', label: 'Estimate Pending' },
                    { value: '20', label: 'Pending to Close' },
                    { value: '21', label: 'Followup' },
                  ]}
                />
              </div>
            </div>
            {/* Row 2 — Client Ref / EFR ID / Job Owner / Date Type / Date Range. */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Client Ref</label>
                <Input placeholder="-- All --" value={filters.clientRef} onChange={(e) => setFilters({ ...filters, clientRef: e.target.value })} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide" title="EasyFixer ID — technician identifier from tbl_easyfixer">EFR ID</label>
                <Input
                  placeholder="EasyFixer (Technician) ID"
                  type="number"
                  min={1}
                  value={filters.easyfixerId}
                  onChange={(e) => setFilters({ ...filters, easyfixerId: e.target.value.replace(/[^0-9]/g, '') })}
                  // Mouse-wheel on a focused number input would otherwise
                  // increment/decrement the value — common UX trap when
                  // operators scroll the filter card. blur() on wheel
                  // is the standard de-armer.
                  onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Job Owner</label>
                <SearchSelect placeholder="Select Job Owner" value={filters.ownerId} onChange={(v) => setFilters({ ...filters, ownerId: v })} options={lk.toOpts.adminUsers.map((o) => ({ value: o.value, label: String(o.label) }))} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Date Type</label>
                <SearchSelect
                  placeholder="All"
                  value={filters.dateType}
                  onChange={(v) => setFilters({ ...filters, dateType: v })}
                  options={[
                    { value: 'booked',    label: 'Booked Date' },
                    { value: 'scheduled', label: 'Scheduled Date' },
                    { value: 'completed', label: 'Completed Date' },
                    { value: 'requested', label: 'Appointment Date' },
                    { value: 'ticket',    label: 'Ticket Created' },
                  ]}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Date Range</label>
                <div className="flex gap-1">
                  <Input type="date" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} className="min-w-0" />
                  <Input type="date" value={filters.endDate}   onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}   className="min-w-0" />
                </div>
              </div>
            </div>
            {/* Show More Filters reveal — rows 3 + 4. */}
            {showFilters && (
              <>
                {/* Row 3 — State / City / Category / Vertical / EFR Mobile. */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">State</label>
                    <SearchSelect placeholder="All" value={filters.stateId} onChange={(v) => setFilters({ ...filters, stateId: v })} options={lk.toOpts.states.map((o) => ({ value: o.value, label: String(o.label) }))} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">City</label>
                    <CitySelect placeholder="All" value={filters.cityId} onChange={(id) => setFilters({ ...filters, cityId: id })} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Category</label>
                    <SearchSelect placeholder="All" value={filters.categoryId} onChange={(v) => setFilters({ ...filters, categoryId: v })} options={lk.toOpts.serviceCategories.map((o) => ({ value: o.value, label: String(o.label) }))} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Vertical</label>
                    <SearchSelect
                      placeholder="All"
                      value={filters.verticalId}
                      onChange={(v) => setFilters({ ...filters, verticalId: v })}
                      options={lk.verticals.map((v) => ({ value: v.vertical_id, label: v.vertical_name }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">EFR Mobile</label>
                    <Input placeholder="-- All --" value={filters.efrMobile} onChange={(e) => setFilters({ ...filters, efrMobile: e.target.value.replace(/[^0-9]/g, '') })} className="font-mono" />
                  </div>
                </div>
                {/* Row 4 — Rating / Reopen / Open Due To / PIN / Zonal.
                    All four are now wired to backend filters:
                      rating  → tbl_easyfixer_rating_by_customer.customer_rating
                      reopen  → tbl_job.job_reopen_flag
                      dueTo   → LIKE on j.remarks structured prefix
                      zonalId → JOIN tbl_zone_city_mapping */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Rating</label>
                    <SearchSelect
                      placeholder="-- All --"
                      value={filters.rating}
                      onChange={(v) => setFilters({ ...filters, rating: v })}
                      options={[
                        { value: '5', label: '★★★★★ (5)' },
                        { value: '4', label: '★★★★ (4)' },
                        { value: '3', label: '★★★ (3)' },
                        { value: '2', label: '★★ (2)' },
                        { value: '1', label: '★ (1)' },
                      ]}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Reopen</label>
                    <SearchSelect
                      placeholder="All"
                      value={filters.reopen}
                      onChange={(v) => setFilters({ ...filters, reopen: v })}
                      options={[
                        { value: 'true',  label: 'Reopened' },
                        { value: 'false', label: 'Not Reopened' },
                      ]}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Open Due To</label>
                    <SearchSelect
                      placeholder="All"
                      value={filters.dueTo}
                      onChange={(v) => setFilters({ ...filters, dueTo: v })}
                      options={[
                        { value: 'customer',   label: 'Customer' },
                        { value: 'client',     label: 'Client' },
                        { value: 'easyfix',    label: 'EasyFix' },
                        { value: 'technician', label: 'Technician' },
                      ]}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">PIN</label>
                    <Input placeholder="-- All --" value={filters.pin} onChange={(e) => setFilters({ ...filters, pin: e.target.value.replace(/[^0-9]/g, '') })} className="font-mono" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Zonal</label>
                    <SearchSelect
                      placeholder="All"
                      value={filters.zonalId}
                      onChange={(v) => setFilters({ ...filters, zonalId: v })}
                      options={lk.zones.map((z) => ({ value: z.zone_id, label: z.zone_name }))}
                    />
                  </div>
                </div>
              </>
            )}
            {/* Action row — legacy layout: Search + Reset + Show/Hide
                Filters link on the LEFT, Export on the RIGHT. The
                Search button is largely cosmetic in the new CRM
                (filters auto-refetch on change) but kept for legacy
                parity — clicking it triggers a fresh load. */}
            <div className="flex items-center justify-between pt-2 border-t">
              <div className="flex items-center gap-2">
                {/* Search button intentionally removed — every filter
                    change already triggers a real-time refetch via the
                    useEffect dep array. A redundant button only invites
                    duplicate fetches without changing the result. */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setQ('');
                    setFilters({
                      clientId: '', cityId: '', stateId: '',
                      ownerId: '', easyfixerId: '',
                      startDate: '', endDate: '', dateType: '',
                      customerQ: '', clientRef: '', efrMobile: '', pin: '',
                      categoryId: '', verticalId: '',
                      status: '', bucketStatus: '',
                      rating: '', reopen: '', dueTo: '', zonalId: '',
                    });
                  }}
                >
                  Reset
                </Button>
                {/* Transfer Job Ownership — admin-only bulk reassign
                    of job_owner across the current filter set OR an
                    explicit list of Job IDs. BE re-enforces the
                    admin-role gate, this is just the UI affordance.
                    Uses the default Button variant so the colour
                    inherits from the theme's primary palette —
                    matches every other primary CTA in the CRM (Add
                    New Job, Save, Apply, etc.) for visual
                    consistency. The outline Reset to its left + the
                    emerald Export on the right give it a clear
                    visual shelf without a custom hue. */}
                {canJob.isTransferJobOwnership && (
                  <>
                    <Button
                      type="button"
                      onClick={() => {
                        // Job Owner filter is mandatory — the dialog
                        // locks From Owner to this value. Without it
                        // the operator could accidentally bulk-transfer
                        // jobs they didn't intend.
                        if (!filters.ownerId) {
                          setTransferAlert('Pick a Job Owner in the filter card first — that becomes the source owner for the transfer.');
                          // Auto-hide after 3s. Cancel any prior
                          // pending clear so a second click before
                          // the first 3s elapses doesn't get a
                          // half-life dismissal.
                          if (transferAlertTimerRef.current != null) {
                            window.clearTimeout(transferAlertTimerRef.current);
                          }
                          transferAlertTimerRef.current = window.setTimeout(() => {
                            setTransferAlert(null);
                            transferAlertTimerRef.current = null;
                          }, 3000);
                          return;
                        }
                        setTransferAlert(null);
                        setTransferOpen(true);
                      }}
                    >
                      <Repeat className="h-4 w-4 mr-1" /> Transfer Job Ownership
                    </Button>
                    {/* Inline alert sits right next to the button so
                        the eye lands on the cue without a viewport
                        scan. Amber (warning-ish, not error-red) keeps
                        it non-alarming — this is a missing
                        precondition, not a failure. */}
                    {transferAlert && (
                      <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 max-w-md">
                        {transferAlert}
                      </span>
                    )}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setShowFilters((s) => !s)}
                  className="inline-flex items-center gap-1 text-sm text-sky-700 hover:text-sky-900"
                >
                  {showFilters
                    ? <><ChevronUp className="h-4 w-4" /> Hide Filters</>
                    : <><ChevronDown className="h-4 w-4" /> Show More Filters</>}
                </button>
              </div>
              <DownloadButton
                onClick={exportXlsx}
                downloading={downloading}
                disabled={!data || data.total === 0}
                label="Export"
                loadingLabel="Exporting…"
                title={!data || data.total === 0
                  ? 'No rows to export — narrow your filters.'
                  : `Export ${data.total.toLocaleString('en-IN')} matching job(s)`}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <RefreshBar active={refreshing} />
        <CardContent className="p-0 overflow-x-auto">
          {tab === 'unconfirmed' ? (
            <UnconfirmedJobsTable
              rows={sorted}
              loading={loading}
              canConfirm={!!canJob.isJobConfirm}
              canSendMagicLink={!!canJob.isJobMagicLinkSend}
              // Force Send (Override) is keyed on the literal role_name
              // = 'Admin' (matches the BE override gate). `me.role.group`
              // is broader (admin-class roles) so we use `role_name`
              // here for exact parity. Case-insensitive guards against
              // any future seed-data inconsistency.
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
          ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <SortHeader col="job_id"             sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="stick-col-head stick-left">Job #</SortHeader>
                    <SortHeader col="job_reference_id"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Job Ref</SortHeader>
                    <SortHeader col="client_ref_id"      sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Client Ref</SortHeader>
                    <SortHeader col="client_name"        sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Client</SortHeader>
                    <SortHeader col="customer_name"      sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Customer</SortHeader>
                    <SortHeader col="customer_mob_no"    sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Mobile</SortHeader>
                    <SortHeader col="city_name"          sortBy={sortKey} sortDir={sortDir} onSort={toggle}>City</SortHeader>
                    <SortHeader col="job_type"           sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Type</SortHeader>
                    <SortHeader col="source_type"        sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Source</SortHeader>
                    <SortHeader col="easyfixer_name"     sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Technician</SortHeader>
                    <SortHeader col="owner_name"         sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Owner</SortHeader>
                    <SortHeader col="created_date_time"  sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Created</SortHeader>
                    <SortHeader col="requested_date_time" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Requested</SortHeader>
                    <SortHeader col="scheduled_date_time" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Scheduled</SortHeader>
                    <SortHeader col="checkin_date_time"  sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Check-in</SortHeader>
                    <SortHeader col="checkout_date_time" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Check-out</SortHeader>
                    <SortHeader col="job_status"         sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Status</SortHeader>
                    <th className="stick-col-head stick-right text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <tr><td colSpan={18} className="text-center py-8 text-muted-foreground">Loading…</td></tr>}
                  {!loading && sorted.map((j) => (
                <tr key={j.job_id}>
                  <td className="font-medium whitespace-nowrap stick-col stick-left">#{j.job_id}</td>
                  <td className="text-xs">{j.job_reference_id ?? '—'}</td>
                  <td className="text-xs">{j.client_ref_id ?? '—'}</td>
                  <td className="whitespace-nowrap">{j.client_name ?? '—'}</td>
                  <td className="whitespace-nowrap">{j.customer_name ?? '—'}</td>
                  <td className="text-xs">
                    {/* Click-to-call lives on the mobile cell itself. The
                        component never receives unmasked digits — only the
                        jobId. BE resolves customer mobile server-side. */}
                    <CallableMobile jobId={j.job_id} mobile={j.customer_mob_no} />
                  </td>
                  <td>{j.city_name ?? '—'}</td>
                  <td className="text-xs">{j.job_type}</td>
                  <td className="text-xs text-muted-foreground">{j.source_type ?? '—'}</td>
                  <td className="whitespace-nowrap">{j.easyfixer_name ? formatEasyfixerName(j.easyfixer_name) : <span className="text-muted-foreground">unassigned</span>}</td>
                  <td className="text-xs text-muted-foreground whitespace-nowrap">{j.owner_name ?? '—'}</td>
                  <td className="text-xs whitespace-nowrap">{formatDate(j.created_date_time)}</td>
                  <td className="text-xs whitespace-nowrap">{formatDate(j.requested_date_time)}</td>
                  <td className="text-xs whitespace-nowrap">{j.scheduled_date_time ? formatDate(j.scheduled_date_time) : '—'}</td>
                  <td className="text-xs whitespace-nowrap">{j.checkin_date_time ? formatDate(j.checkin_date_time) : '—'}</td>
                  <td className="text-xs whitespace-nowrap">{j.checkout_date_time ? formatDate(j.checkout_date_time) : '—'}</td>
                  <td>
                    <StatusChip tone={statusTone(j.job_status)}>
                      {statusLabel(j.job_status, { assigned: j.fk_easyfixter_id != null })}
                    </StatusChip>
                    {/*
                     * "No Services" pill (added 2026-05-28). Surfaces the
                     * legacy data-quality gap where a BOOKED job has zero
                     * active tbl_job_services rows — typically caused by
                     * ops promoting an Unconfirmed job before adding any
                     * service line items (see ref Job #482453). Mirrors
                     * the amber Draft-pill pattern from
                     * UnconfirmedJobsTable so operators can spot stragglers
                     * at a glance and click into the Services tab to fix.
                     *
                     * Showing it ONLY on status=0 keeps the signal high —
                     * a CALL_LATER / Unconfirmed row with no services is
                     * expected; a BOOKED one is the anomaly.
                     */}
                    {j.job_status === 0 && (j.service_count ?? 0) === 0 && (
                      <button
                        type="button"
                        // Clickable pill (2026-05-28). Opens the job's
                        // Services tab directly — saves the operator
                        // from row→modal→tab click chains. stopPropagation
                        // so this doesn't fire any parent row click
                        // handler that might exist now or later.
                        onClick={(e) => {
                          e.stopPropagation();
                          openJobAction('view', j.job_id, { tab: 'services' });
                        }}
                        className="ml-1 inline-flex items-center rounded-full bg-amber-100 hover:bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 whitespace-nowrap cursor-pointer transition-colors"
                        title="Booked but no services attached. Click to open the Services tab and add line items."
                      >
                        No Services
                      </button>
                    )}
                  </td>
                  <td className="stick-col stick-right text-right whitespace-nowrap">
                    {/*
                      * Status-driven row actions — mirrors legacy jobList.vm:
                      *   status 0     → View + Schedule (opens modal for auto/manual pick)
                      *   status 1     → View + Check-In (direct status 1→2)
                      *   status 2, 20 → View + Check-Out (direct status 2→3)
                      *   others       → View only
                      * The quickStatusChange() handler confirms + PATCHes /status
                      * + refreshes both list + counts so badges stay coherent.
                      */}
                    <div className="inline-flex items-center gap-0.5 justify-end">
                      <IconButton
                        icon={Eye}
                        intent="default"
                        label="View details"
                        onClick={() => openView(j.job_id)}
                      />
                      {/*
                        * Live Technician Location (📍). Shown where a tech is
                        * already assigned + en-route / on-site:
                        *   - Pending App Ack  → status 0 + fk_easyfixter_id
                        *   - Pending to Close → status 2 or 20
                        * Opens LiveLocationPopover (polls /admin/jobs/:id/location
                        * every 15s while open). Read-only — screen access only.
                        */}
                      {((j.job_status === 0 && j.fk_easyfixter_id != null) ||
                        j.job_status === 2 || j.job_status === 20) && (
                        <IconButton
                          icon={MapPin}
                          intent="primary"
                          label="Live technician location"
                          onClick={() => setLocationJob(j)}
                        />
                      )}
                      {/* Outbound call lives on the customer mobile cell (Mobile column). */}
                      {/* Unconfirmed (status=9) → Confirm & Schedule. Gate: isJobConfirm. */}
                      {j.job_status === 9 && canJob.isJobConfirm && (
                        <IconButton
                          icon={CalendarCheck}
                          intent="primary"
                          label="Confirm — fill details, pick services, and move to Scheduled"
                          onClick={() => openConfirm(j.job_id)}
                        />
                      )}
                      {/* Schedule (status=0): assign a technician. Gate: isJobAssign. */}
                      {j.job_status === 0 && canJob.isJobAssign && (
                        <IconButton
                          icon={CalendarClock}
                          intent="primary"
                          label="Schedule — opens modal to assign a technician"
                          onClick={() => openView(j.job_id)}
                        />
                      )}
                      {/* Check-In + Check-Out are status mutations → isJobStatusChange. */}
                      {j.job_status === 1 && canJob.isJobStatusChange && (
                        <IconButton
                          icon={PlayCircle}
                          intent="primary"
                          label="Check-In — technician on-site, move to In Progress"
                          busy={rowBusy === j.job_id}
                          onClick={() => quickStatusChange(j.job_id, 2, 'Check in')}
                        />
                      )}
                      {(j.job_status === 2 || j.job_status === 20) && canJob.isJobStatusChange && (
                        <IconButton
                          icon={CheckCircle2}
                          intent="success"
                          label="Check-Out — close the job"
                          busy={rowBusy === j.job_id}
                          onClick={() => quickStatusChange(j.job_id, 3, 'Check out & complete')}
                        />
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
        onSaved={() => { cacheRef.current.clear(); load(false, true); refreshCounts(); }}
        // Honour `?viewTab=` so the "No Services" pill (and any future
        // deep-link) can land the operator straight on a specific tab.
        // See useJobActionNav.openJobAction(_, _, { tab }).
        initialTab={searchParams.get('viewTab') || undefined}
      />

      {/*
        * Live technician location — Pending App Ack / Pending to Close rows.
        * Polls GET /admin/jobs/:id/location every 15s while open; the interval
        * cleanup lives inside LiveLocationPopover.
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

      {canJob.isTransferJobOwnership && (
        <TransferJobOwnershipDialog
          open={transferOpen}
          onClose={() => setTransferOpen(false)}
          // The Manage Jobs button gates the open on filters.ownerId
          // being set, so this is guaranteed non-empty when the
          // dialog is showing. Dialog locks From Owner to this value.
          lockedFromOwnerId={filters.ownerId || null}
          currentFilters={{
            // Mirrors load()'s param shape so the BE filters mode
            // sees exactly what the operator sees on screen. Bucket
            // Status is exploded into the equivalent `statuses` CSV
            // so the BE applies the same IN-set the list endpoint
            // used to populate the operator's view.
            clientId: filters.clientId,
            cityId: filters.cityId,
            stateId: filters.stateId,
            easyfixerId: filters.easyfixerId,
            startDate: filters.startDate,
            endDate: filters.endDate,
            dateType: (filters.dateType && (filters.startDate || filters.endDate)) ? filters.dateType : undefined,
            customerQ: filters.customerQ,
            clientRef: filters.clientRef,
            efrMobile: filters.efrMobile,
            pin: filters.pin,
            categoryId: filters.categoryId,
            verticalId: filters.verticalId,
            status: filters.bucketStatus ? undefined : filters.status,
            statuses: filters.bucketStatus
              ? BUCKET_STATUS_MAP[filters.bucketStatus].join(',')
              : undefined,
            rating: filters.rating,
            reopen: filters.reopen,
            dueTo: filters.dueTo,
            zonalId: filters.zonalId,
          }}
          onApplied={() => { cacheRef.current.clear(); load(true); refreshCounts(); }}
        />
      )}

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
