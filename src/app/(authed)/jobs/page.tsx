'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildStatusParams, jobStageOptionsFor } from '@/lib/job-buckets';
import Link from 'next/link';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useJobActionParams, useJobActionNav } from '@/lib/job-action-url';
import { useDebouncedValue, useFetchOnce } from '@/lib/hooks';
import {
  Plus, Upload, ChevronDown, ChevronUp, Repeat, Globe,
  // Row-level quick-action icons (mirror the legacy Manage Jobs action column)
  Eye, CalendarClock, PlayCircle, CheckCircle2, CalendarCheck, MapPin,
} from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { SearchSelect } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { CitySelect } from '@/components/ui/city-select';
import { StatusChip } from '@/components/ui/StatusChip';
import { DownloadButton } from '@/components/ui/download-button';
import { downloadXlsx } from '@/lib/download-xlsx';
import { api } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { formatDate, formatEasyfixerName, statusLabel, statusTone } from '@/lib/utils';
import {
  formatJobAge, jobAgeTitle, JOB_AGE_SORT_KEY, type JobAgeFields,
} from '@/lib/job-age';
import {
  TABS, type CountsResp, countFor, filterJobRows, filterTabsForStages, makeQuickStatusChange,
  JOB_SEARCH_PLACEHOLDER, JOB_SEARCH_HINT,
} from '@/lib/job-tabs';
import { transitionAllowed } from '@/lib/job-stages';
import { JobModal, type JobModalMode } from '@/components/job/JobModal';
import {
  PendingSchedulingFilters, psFiltersFromParams, writePsFilterParams,
  psFilterKey, psQueryParams, type PsFilters,
} from '@/components/job/PendingSchedulingFilters';
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

/*
 * ── "Unmapped Website Bookings" preset (2026-08-07) ───────────────────────
 *
 * The public booking flow on the marketing website (BE
 * routes/public/website-booking.js) creates jobs with
 * `tbl_job.source_type = 'website'`. When the customer's QR link carries a
 * valid `tbl_client.reference_code` the job is attributed to that client;
 * when it does NOT, it falls back to the catch-all RETAIL client
 * (`tbl_client.client_id = 1`) with a blank SPOC. Those are the rows ops must
 * re-map to the real client BEFORE the technician visit — previously findable
 * only by grepping server logs.
 *
 * The preset pins exactly the three columns that define that set:
 *   job_status   = 9         ← supplied by the Unconfirmed tab itself
 *   source_type  = 'website' ← BE `sourceType` filter (added 2026-08-07)
 *   fk_client_id = 1         ← BE `clientId` filter (already existed)
 *
 * Deliberately a SAVED FILTER over the existing Unconfirmed list rather than a
 * new page: a new page would drag in permission seeding + menu wiring for what
 * is fundamentally one pinned query. It inherits the jobs list's RBAC as-is.
 */
const WEBSITE_SOURCE_TYPE = 'website';
// tbl_client.client_id 1 = "Retail" — the hard-coded catch-all the BE booking
// route falls back to (its FALLBACK_CLIENT_ID). Kept as a string because every
// other value in the filter/query layer here is a string.
const RETAIL_CLIENT_ID = '1';

type JobRow = JobAgeFields & {
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

export default function JobsPage() {
  const lk = useLookup();
  /*
   * Zonal MANAGERS — tbl_user rows owning at least one city (tbl_city.state_user).
   * Not in useLookup() because no other page needed them; fetched here with the
   * shared once-only hook rather than a raw effect.
   */
  const zonalManagersRes = useFetchOnce<Array<{ user_id: number; user_name: string }>>(
    '/shared/lookup/zonal-managers',
  );
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
  // Declared up here (ahead of the state block) so the `q`/`sort` state
  // lazy-initializers below can hydrate from the URL, and the write-effect
  // can persist them back. useSearchParams() is stable at first render in
  // Next.js 15's App Router.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState('all');
  // Counts are fetched once on mount + re-fetched after any save from the
  // modal (so badges stay fresh). Null = still loading; populated = ready.
  const [counts, setCounts] = useState<CountsResp | null>(null);
  /*
   * `q` is the search box. It drives TWO things:
   *   - `serverQ`, debounced 300ms, which is sent to the backend and searches
   *     every matching job — not just the loaded page;
   *   - filterJobRows over the rows already on screen, which gives instant
   *     feedback while the debounce settles.
   *
   * `serverQ` is declared HERE rather than beside its effect because dependency
   * arrays are evaluated during render: referencing it further down the
   * component put it in the temporal dead zone.
   */
  const [q, setQ] = useState(() => searchParams.get('q') || '');
  const serverQ = useDebouncedValue(q, 300).trim();
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
    /*
     * Job Status (stages) — legacy parity, 2026-08-18. The legacy CRM filters
     * by workflow STAGE, multi-select, not by raw job_status code, so the two
     * dropdowns could never agree: they filter different axes under the same
     * label. Resolved into the backend's `statuses` + `assigned` pair by
     * buildStatusParams(). The old single-code `status` field is gone: it was
     * never hydrated from the URL, so once the numeric dropdown was replaced
     * it could only ever hold '' — dead state rather than a deep-link.
     */
    stages: [] as string[],
    // Bucket Status — the LEGACY 3-way categorical (Open / Closed /
    // Cancelled). Distinct from Job Status:
    //   open      → job_status IN (0,1,2,9,10,15,20,21)
    //   closed    → job_status IN (3,5)        (Completed)
    //   cancelled → job_status IN (6,7)        (Cancelled + Enquiry)
    // The mapping lives in BUCKET_STATUS_MAP (lib/job-buckets); the dropdown
    // options and buildStatusParams() both read it, so the categorical view
    // and the request can never disagree.
    bucketStatus: '',
    // Phase-2 filters wired 2026-05-19.
    rating: '', reopen: '', dueTo: '', zonalId: '', zonalManagerId: '',
  });
  /*
   * ── Pending-for-Scheduling filter bar (2026-07-31) ────────────────────────
   *
   * The SAME bar /my-orders hosts (components/job/PendingSchedulingFilters) —
   * both pages share the bucket definition via lib/job-tabs.ts, so the triage
   * capability has to be shared too rather than living on one surface only.
   *
   * Scoped to the `pending-scheduling` tab: `psActive` gates BOTH the render and
   * the request params, so every other tab's request shape is byte-for-byte
   * unchanged. Hydrated from the URL on first render (useSearchParams() is
   * stable at first render in the App Router) using the SAME `ps*` param names
   * /my-orders writes, so a filtered link is portable between the two pages.
   */
  const [psFilters, setPsFilters] = useState<PsFilters>(() => psFiltersFromParams(searchParams));
  const psKey = psFilterKey(psFilters);
  const psActive = tab === 'pending-scheduling';
  /*
   * "Unmapped Website Bookings" quick-filter (see the preset block up top).
   * Scoped to the Unconfirmed tab — that tab supplies the `job_status = 9` half
   * of the definition — so `uwActive` gates BOTH the render and the request
   * params and every other tab's request shape stays byte-for-byte unchanged
   * (same discipline as `psActive` above). Hydrated from the URL on first
   * render so the filtered view is shareable and survives a refresh;
   * useSearchParams() is stable at first render in the App Router.
   */
  const [unmappedWebsite, setUnmappedWebsite] = useState(
    () => searchParams.get('unmappedWebsite') === 'true',
  );
  const uwActive = tab === 'unconfirmed' && unmappedWebsite;
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
  const [sortKey, setSortKey] = useState<string | null>(() => {
    const s = searchParams.get('sort'); return s ? (s.split(':')[0] || null) : null;
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    const s = searchParams.get('sort'); return s && s.split(':')[1] === 'asc' ? 'asc' : 'desc';
  });
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
    /*
     * `serverQ` is part of the key (2026-08-18). It used to be excluded on the
     * grounds that `q` "doesn't change the backend request" — true only while
     * search was an in-memory narrowing of the loaded page. Now that `q` is
     * sent, omitting it here would serve a cached page built under a different
     * search and the results would silently not match what was typed.
     */
    return [
      filters.clientId, filters.cityId, filters.stateId,
      filters.ownerId, filters.easyfixerId,
      filters.startDate, filters.endDate, filters.dateType,
      filters.customerQ, filters.clientRef, filters.efrMobile, filters.pin,
      filters.categoryId, filters.verticalId, filters.bucketStatus,
      filters.stages.join(','),
      filters.rating, filters.reopen, filters.dueTo, filters.zonalId, filters.zonalManagerId,
    filters.stages, filters.zonalManagerId,
      filters.stages,
      serverQ,
    ].join('|');
  }

  async function load(reset = false, force = false, silent = false) {
    const seq = ++loadSeqRef.current;
    const tabDef = TABS.find((t) => t.value === tab);
    const off = reset ? 0 : offset;
    // Cache key includes pageSize so changing rows-per-page doesn't
    // serve a stale fixed-50 payload, and the Pending-for-Scheduling filter
    // signature so two different filter sets never share an entry.
    // `uw=` keeps the preset's two extra pins out of the un-presetted entry —
    // without it, toggling the chip would serve the unfiltered Unconfirmed page
    // straight from cache.
    const key = `${tab}|${off}|${limit}|${sortKey || ''}|${sortDir}|${filterKey()}|f=${psActive ? psKey : ''}|uw=${uwActive ? 1 : 0}`;

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
      //      `statuses` as a CSV of the matching IN-set.
      //   2. filters.stages (legacy multi-select Job Status) — OUTRANKS
      //      Bucket Status, matching legacy resolveJobStatus(), where a
      //      stage pick REPLACES the Open/Closed/Cancelled group rather
      //      than intersecting it.
      //   3. tab.statuses / tab.status — applied when neither
      //      filter is set.
      // The BE service prefers `statuses` over `status` when both
      // arrive, so we deliberately send only one of the two.
      //
      // ...EXCEPT on Pending for Scheduling. That tab IS the bucket
      // `job_status = 0 AND fk_easyfixter_id IS NULL`; its pins are
      // UNCONDITIONAL and no filter may widen or replace them (the exact
      // inversion fixed on /my-orders — picking a status there listed jobs
      // outside the bucket entirely). So the two status overrides are
      // neutralised while `psActive`, which drops `status`/`statuses`/`assigned`
      // straight through to the tab definition. Both dropdowns are hidden on
      // that tab too, so this is unreachable in normal use — it is the
      // structural guarantee behind the UI, and it also disarms a stale
      // selection left over from another tab.
      /*
       * Stage selection OUTRANKS Bucket Status — legacy's own precedence.
       * resolveJobStatus() returns the Open/Closed/Cancelled group ONLY when no
       * stage is ticked; the moment one is, the stage ids replace the group
       * rather than intersecting it. Since the backend takes a single
       * `statuses` list, reproducing that ordering is also the only way to send
       * one coherent set.
       */
      const statusParams = buildStatusParams({
        psActive,
        stages: filters.stages,
        bucketStatus: filters.bucketStatus,
        tab: tabDef,
      });
      // Build the request promise and register it in the in-flight
      // Map before awaiting — so a Strict-Mode replay of this effect
      // in the same tick can attach. Cleared in `finally`.
      const reqPromise = api.get<Resp>('/admin/jobs', {
        /*
         * Server-side search (2026-08-18). `q` used to be withheld deliberately
         * — it narrowed only the rows already on screen, so searching for a job
         * on page 3 from page 1 found nothing. The backend has always accepted
         * `q` (job_id, reference id, client ref, customer name + mobile), so
         * this is a wiring fix, not a new capability.
         */
        q: serverQ || undefined,
        /*
         * status / statuses / assigned — derived once by buildStatusParams and
         * spread, never re-implemented here. Export and the bulk-action prop
         * call the same function; when three copies of this precedence existed,
         * two of them drifted.
         */
        ...statusParams,
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
        zonalManagerId: filters.zonalManagerId || undefined,
        // Dashboard AttentionSummary drill-down tabs carry these.
        // BE list endpoint clamps the result to "still actionable"
        // for the chosen quotation status (see service.list()).
        quotationStatus: tabDef?.quotationStatus,
        requestedBefore: tabDef?.requestedBefore,
        /*
         * Pending-for-Scheduling bar → server-side WHERE clauses that NARROW
         * the pinned bucket (never widen it). Spread LAST and emitting ONLY the
         * controls that are set, so:
         *   - an unset control leaves the Filter Job card's value above intact
         *     (a bare `undefined` key would otherwise blank it), and
         *   - a set control wins over the card's equivalent — on this tab the
         *     bar is the triage surface the operator is looking at.
         * Sent only while the tab is active; every other tab's request shape is
         * unchanged.
         */
        ...(psActive ? psQueryParams(psFilters) : {}),
        /*
         * "Unmapped Website Bookings" preset — spread LAST so its two pins WIN
         * over the Filter Job card's Client dropdown above. That precedence is
         * deliberate and matches the Pending-for-Scheduling bar's rule: the
         * preset IS "client = RETAIL", so a stale Client pick left over from
         * another view must not silently widen it. The chip's helper text names
         * both pins so nothing is hidden from the operator.
         *
         * Emitted only while the chip is on AND the Unconfirmed tab is active.
         */
        ...(uwActive
          ? { sourceType: WEBSITE_SOURCE_TYPE, clientId: RETAIL_CLIENT_ID }
          : {}),
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
   * Pending-for-Scheduling filter change → page-0 refetch. Skips the initial
   * mount (the tab effect above already fired the first load, including any
   * URL-hydrated filters). `psKey` is a string, so this fires on real value
   * changes only — not on every setState object identity.
   */
  const psMountRef = useRef(true);
  useEffect(() => {
    if (psMountRef.current) { psMountRef.current = false; return; }
    setPage(0);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [psKey]);

  /*
   * "Unmapped Website Bookings" toggle → page-0 refetch. Mirrors the psKey
   * effect exactly, including the initial-mount skip: the tab effect above
   * already fires the first load, and it does so with `uwActive` derived from
   * the URL-hydrated state, so a shared link lands pre-filtered without this
   * effect firing a second identical request. Depends on `uwActive` (not the
   * raw flag) so leaving the Unconfirmed tab with the chip still on also
   * refetches — the pins have to come back off.
   */
  const uwMountRef = useRef(true);
  useEffect(() => {
    if (uwMountRef.current) { uwMountRef.current = false; return; }
    setPage(0);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uwActive]);

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
  // Filter changes AND the search box both refetch (all backend-driven).
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
      filters.categoryId, filters.verticalId, filters.bucketStatus,
      filters.rating, filters.reopen, filters.dueTo, filters.zonalId, filters.zonalManagerId,
      filters.stages,
      /*
       * `serverQ` belongs here, not just in the request payload (2026-08-18).
       * Wiring `q` into api.get without this dep left the search box unable to
       * trigger anything: the effect never re-ran, the table kept the page it
       * already had, and filterJobRows narrowed those rows in memory — the
       * exact pre-fix symptom, which is why it looked unchanged. The effect
       * also setPage(0), so a new search always lands on page 1 rather than
       * searching from whatever page the operator was on.
       */
      serverQ,
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
    filters.categoryId, filters.verticalId, filters.bucketStatus,
    filters.rating, filters.reopen, filters.dueTo, filters.zonalId, filters.zonalManagerId,
    filters.stages, serverQ,
  ]);

  // Modal state is derived from the URL — every row-level action
  // (View / Confirm / Book New Call / Assign / Reassign) pushes its
  // intent into `?jobId=&action=` so the URL is shareable. Direct
  // navigation to a deep-link URL lands the recipient straight on the
  // matching dialog. Legacy `?view=N` / `?new=1` URLs are auto-promoted
  // by `useJobActionParams` so old shared links keep working.
  // (`searchParams`/`router`/`pathname` are declared up in the state block.)
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

  /*
   * Job Stage Access clamp (UX + defense-in-depth). A stage-restricted user
   * must never sit on a tab outside their allowed stages — including the
   * default cross-stage 'all'. filterTabsForStages drops tabs whose
   * status(es) fall outside the allowed set; if the current tab isn't
   * allowed, snap to the first allowed one. Admin / Finance (mode 'all') and
   * a still-loading `me` are no-ops (the server LIST endpoint stays
   * authoritative and row-filters regardless).
   */
  useEffect(() => {
    if (!me?.allowedStages || me.allowedStages.mode === 'all') return;
    const allowedTabs = filterTabsForStages(TABS, me.allowedStages);
    if (allowedTabs.length === 0) return;
    if (!allowedTabs.some((x) => x.value === tab)) {
      setTab(allowedTabs[0].value);
      setPage(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.allowedStages, tab]);

  // Transient sibling family for the Unconfirmed grouped view — set when a
  // grouped (multi-category) row is opened so JobModal can render a tab per
  // category. Not URL-backed (arrays don't belong in the query string); a fresh
  // deep-link without it shows the single job. JobModal guards against staleness.
  const [familySiblings, setFamilySiblings] = useState<Array<{ job_id: number; service_category: string | null }> | null>(null);
  function closeModal() { closeJobAction(); }
  function openCreate() { openJobAction('create'); }
  function openView(id: number, siblings?: Array<{ job_id: number; service_category: string | null }>)    { setFamilySiblings(siblings ?? null); openJobAction('view',    id); }
  function openConfirm(id: number, siblings?: Array<{ job_id: number; service_category: string | null }>) { setFamilySiblings(siblings ?? null); openJobAction('confirm', id); }

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
      // job-status > tab, with both overrides neutralised on Pending for
      // Scheduling so the exported rows are the same bucket the table shows.
      Object.entries(buildStatusParams({
        psActive,
        stages: filters.stages,
        bucketStatus: filters.bucketStatus,
        tab: tabDef,
      })).forEach(([k, v]) => qs.set(k, String(v)));
      // Search is server-side now, so the sheet must be narrowed by it too —
      // otherwise Export silently returns more rows than the screen shows.
      if (serverQ) qs.set('q', serverQ);
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
        zonalManagerId: filters.zonalManagerId,
      }).forEach(([k, v]) => { if (v) qs.set(k, String(v)); });
      // Pending-for-Scheduling bar last, mirroring load()'s spread order so a
      // set control wins over the Filter Job card's equivalent. The export route
      // validates with the SAME listQuery schema, so `offerState` is accepted.
      if (psActive) {
        Object.entries(psQueryParams(psFilters)).forEach(([k, v]) => qs.set(k, v));
      }
      /*
       * "Unmapped Website Bookings" pins last — same precedence as load(), so
       * the exported file is a true mirror of what's on screen. `qs.set`
       * (not append) overwrites any clientId the filter loop above emitted.
       * The export route validates with the SAME listQuery schema, so
       * `sourceType` is accepted there too.
       */
      if (uwActive) {
        qs.set('sourceType', WEBSITE_SOURCE_TYPE);
        qs.set('clientId', RETAIL_CLIENT_ID);
      }
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

  // Debounced view of the in-memory search box, used ONLY for the URL write
  // below (the instant client-side `filterJobRows` above still reads raw `q`).
  // Persist search + sort + the Pending-for-Scheduling filters into the URL
  // (tab already lives there) so they survive any remount/navigation after a
  // modal action, and so a PM can share the exact filtered view. Debounced via
  // serverQ so typing doesn't spam history. Guard prevents redundant
  // replaces; deps deliberately EXCLUDE searchParams so this never loops
  // with the tab-sync effect (which reads searchParams).
  useEffect(() => {
    const p = new URLSearchParams(searchParams);
    if (serverQ) p.set('q', serverQ); else p.delete('q');
    if (sortKey) p.set('sort', `${sortKey}:${sortDir}`); else p.delete('sort');
    // Shared serialiser — same `ps*` names /my-orders writes, so a filtered
    // link is portable between the two surfaces.
    writePsFilterParams(p, psFilters);
    // "Unmapped Website Bookings" preset. Persisted from the RAW flag, not
    // `uwActive`: the operator's choice should survive a hop to another tab and
    // back, exactly like `q` and `sort` do. Combined with `?tab=unconfirmed`
    // this makes the whole view a single shareable/bookmarkable URL.
    if (unmappedWebsite) p.set('unmappedWebsite', 'true'); else p.delete('unmappedWebsite');
    const nextStr = p.toString();
    if (nextStr !== searchParams.toString()) {
      router.replace(nextStr ? `${pathname}?${nextStr}` : pathname, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverQ, sortKey, sortDir, psKey, unmappedWebsite]);

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

      {/*
        * Pending-for-Scheduling filter bar — the SAME shared component
        * /my-orders hosts, so both lifecycle surfaces triage this bucket with
        * identical controls. Rendered ONLY on that tab (which /jobs selects via
        * the URL's ?tab= param — there is no visible tab bar here); its params
        * are likewise sent only while the tab is active, so every other tab is
        * untouched. Kept in its own card ABOVE the Filter Job panel: that panel
        * carries its own Client / City / Category fields, and interleaving two
        * sets of same-named pickers in one card would read as duplicates.
        */}
      {psActive && (
        <Card>
          <CardContent className="p-3">
            <PendingSchedulingFilters
              value={psFilters}
              onChange={setPsFilters}
              title="Pending For Scheduling Filters"
            />
          </CardContent>
        </Card>
      )}

      {/*
        * "Unmapped Website Bookings" quick-filter — Unconfirmed tab only.
        *
        * Rendered ONLY on that tab because the tab supplies the `job_status = 9`
        * half of the definition; the chip adds the other two pins
        * (source_type = 'website', client = Retail). Kept in its own slim card
        * ABOVE the Filter Job panel for the same reason the Pending-for-
        * Scheduling bar is: this is a preset that OVERRIDES a field in that
        * panel, so nesting it inside would read as just another filter of equal
        * weight. The helper text names both pins explicitly, so the override of
        * the Client dropdown is stated rather than silent.
        */}
      {tab === 'unconfirmed' && (
        <Card>
          <CardContent className="p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                type="button"
                size="sm"
                variant={unmappedWebsite ? 'default' : 'outline'}
                aria-pressed={unmappedWebsite}
                onClick={() => setUnmappedWebsite((v) => !v)}
                title={unmappedWebsite
                  ? 'Showing only unconfirmed website bookings on the Retail catch-all client. Click to clear.'
                  : "Show unconfirmed orders booked from the website whose QR link carried no valid client code — they land on the Retail catch-all client and need re-mapping."}
              >
                <Globe className="h-4 w-4 mr-1" /> Unmapped Website Bookings
              </Button>
              <span className="text-xs text-muted-foreground max-w-3xl">
                {unmappedWebsite
                  ? 'Pinned to Source = website and Client = Retail (the catch-all). These bookings arrived without a valid client code — assign the real client before the visit. This overrides the Client filter below.'
                  : 'Website bookings whose QR link carried no valid client code land on the Retail catch-all client with a blank SPOC. Turn this on to list them.'}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

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
                {/* Searches ALL matching jobs, not just the loaded page
                    (2026-08-18) — the label said "(This Page)" and meant it,
                    so an operator searching a job id from page 1 found nothing
                    unless they happened to already be on the page holding it.
                    `q` now goes to the backend (job id, reference id, client
                    ref, customer name + mobile) and resets to page 1.
                    filterJobRows still runs over the loaded rows for instant
                    feedback during the 300ms debounce; it matches a superset of
                    the backend's fields, so it never hides a server match. */}
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Quick Search</label>
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
              {/*
                * Bucket Status + Job Status are HIDDEN on Pending for
                * Scheduling. Every row in that bucket is job_status = 0 by
                * definition, so both controls are meaningless there — and
                * load() neutralises them anyway to keep the bucket pin
                * unconditional. Rendering dead controls that silently do
                * nothing is worse than not rendering them; the Scheduling
                * Status picker in the bar above is the real axis on that tab.
                */}
              {!psActive && (
              <>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1 uppercase tracking-wide">Bucket Status</label>
                {/* Bucket Status — legacy categorical view over job_status
                    (Open / Closed / Cancelled). Distinct from Job Status, the
                    stage multi-select to the right. The 3 values map to
                    multi-status IN-sets via BUCKET_STATUS_MAP — picking
                    "Closed" sends statuses=3,5. Beats the tab, but LOSES to a
                    stage selection: legacy's resolveJobStatus() returns this
                    group only while no stage is ticked. */}
                <SearchSelect
                  placeholder="--All--"
                  value={filters.bucketStatus}
                  /*
                   * Changing the bucket RESETS Job Status. Clearing it must,
                   * because the status the operator picked was chosen from a
                   * list this bucket produced — leaving it behind hides a
                   * still-active narrowing under a filter that now reads
                   * "--All--". Switching buckets must too: the old status is
                   * usually outside the new one, which ANDs to zero rows.
                   */
                  onChange={(v) => setFilters({ ...filters, bucketStatus: v, stages: [] })}
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
                <SearchMultiSelect
                  placeholder="-- All --"
                  value={filters.stages}
                  onChange={(next) => setFilters({ ...filters, stages: next.map(String) })}
                  /* Scoped to the selected bucket — see jobStageOptionsFor. */
                  options={jobStageOptionsFor(filters.bucketStatus)}
                  selectedLabel="stages"
                />
              </div>
              </>
              )}
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
                    {/*
                      * Zonal MANAGERS, not zones (fixed 2026-08-18). Legacy binds
                      * this control to $zonalUsers — getNDMListByCityStatus(1),
                      * i.e. tbl_user rows that own at least one city — and the
                      * new CRM was listing tbl_zone_master rows instead. Both
                      * shipped the selection as a parameter called `zonalId`, so
                      * a zone id arrived where a user id was expected and the
                      * list filtered by the wrong entity in silence rather than
                      * erroring. Now sends `zonalManagerId`, which the backend
                      * resolves against tbl_city.state_user — the same column
                      * legacy uses.
                      */}
                    <SearchSelect
                      placeholder="All"
                      value={filters.zonalManagerId}
                      onChange={(v) => setFilters({ ...filters, zonalManagerId: v })}
                      options={(zonalManagersRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name }))}
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
                      bucketStatus: '',
                      rating: '', reopen: '', dueTo: '', zonalId: '', zonalManagerId: '', stages: [],
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
              // Confirm promotes an Unconfirmed order (status 9 → 0); gate it
              // by the stage-transition rule too, not just the permission.
              canConfirm={!!canJob.isJobConfirm && transitionAllowed(me?.allowedStages, 9, 0)}
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
                    {/* Age — ticket-created → terminal event (or now, while open).
                        Server-computed + server-sorted; the header sends the
                        shared JOB_AGE_SORT_KEY so ordering is by PRECISE age
                        (seconds), never the floored day label. Kept adjacent to
                        the pinned Job # so it stays readable without scrolling
                        this 19-column table sideways. */}
                    <SortHeader col={JOB_AGE_SORT_KEY} sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="w-16">Age</SortHeader>
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
                  {loading && <tr><td colSpan={19} className="text-center py-8 text-muted-foreground">Loading…</td></tr>}
                  {!loading && sorted.map((j) => (
                <tr key={j.job_id}>
                  <td className="font-medium whitespace-nowrap stick-col stick-left">#{j.job_id}</td>
                  <td className="text-xs whitespace-nowrap tabular-nums" title={jobAgeTitle(j)}>{formatJobAge(j)}</td>
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
                      {/* Unconfirmed (status=9) → Confirm & Schedule. Gate: isJobConfirm
                          AND the 9→0 stage transition. */}
                      {j.job_status === 9 && canJob.isJobConfirm && transitionAllowed(me?.allowedStages, j.job_status, 0) && (
                        <IconButton
                          icon={CalendarCheck}
                          intent="primary"
                          label="Confirm — fill details, pick services, and move to Scheduled"
                          onClick={() => openConfirm(j.job_id)}
                        />
                      )}
                      {/* Schedule (status=0): assign a technician. Gate: isJobAssign
                          AND the 0→1 stage transition. */}
                      {j.job_status === 0 && canJob.isJobAssign && transitionAllowed(me?.allowedStages, j.job_status, 1) && (
                        <IconButton
                          icon={CalendarClock}
                          intent="primary"
                          label="Schedule — opens modal to assign a technician"
                          onClick={() => openView(j.job_id)}
                        />
                      )}
                      {/* Check-In + Check-Out are status mutations → isJobStatusChange,
                          also gated by the stage-transition rule (1→2 / →3). */}
                      {j.job_status === 1 && canJob.isJobStatusChange && transitionAllowed(me?.allowedStages, j.job_status, 2) && (
                        <IconButton
                          icon={PlayCircle}
                          intent="primary"
                          label="Check-In — technician on-site, move to In Progress"
                          busy={rowBusy === j.job_id}
                          onClick={() => quickStatusChange(j.job_id, 2, 'Check in')}
                        />
                      )}
                      {(j.job_status === 2 || j.job_status === 20) && canJob.isJobStatusChange && transitionAllowed(me?.allowedStages, j.job_status, 3) && (
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
        siblings={familySiblings ?? undefined}
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
            /*
             * Same precedence as load(): stages outrank Bucket Status, which
             * outranks the single code. Without this the export would ignore a
             * stage selection entirely and hand back a WIDER sheet than the
             * list on screen — the failure mode nobody notices until the
             * numbers are already in a client's inbox.
             */
            ...buildStatusParams({
              psActive,
              stages: filters.stages,
              bucketStatus: filters.bucketStatus,
              tab: TABS.find((t) => t.value === tab),
            }),
            rating: filters.rating,
            reopen: filters.reopen,
            dueTo: filters.dueTo,
            zonalId: filters.zonalId,
            zonalManagerId: filters.zonalManagerId,
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
