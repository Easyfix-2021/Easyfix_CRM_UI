'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useJobActionParams, useJobActionNav } from '@/lib/job-action-url';
import {
  Search, Eye,
  CalendarClock, PlayCircle, CheckCircle2, CalendarCheck,
  RefreshCw, MapPin,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { formatDate, formatEasyfixerName, statusLabel, statusTone } from '@/lib/utils';
import { formatJobAge, jobAgeTitle, JOB_AGE_SORT_KEY, type JobAgeFields } from '@/lib/job-age';
import { displaySlot } from '@/lib/job-slots';
import { StatusChip } from '@/components/ui/StatusChip';
import {
  TABS, filterJobRows, filterTabsForStages, makeQuickStatusChange,
  JOB_SEARCH_PLACEHOLDER, JOB_SEARCH_HINT,
} from '@/lib/job-tabs';
import { transitionAllowed } from '@/lib/job-stages';
import { JobModal, type JobModalMode } from '@/components/job/JobModal';
import { UnconfirmedSections } from '@/components/job/UnconfirmedSections';
import { PendingToStartView } from '@/components/job/PendingToStartView';
import { AssignTechnicianModal, type AssignMode } from '@/components/job/AssignTechnicianModal';
import { ScheduleAssignModal } from '@/components/job/ScheduleAssignModal';
import { OfferHoverCard } from '@/components/job/OfferHoverCard';
import {
  PendingSchedulingFilters, psFiltersFromParams, writePsFilterParams,
  psFilterKey, psAnyFilterSet, psQueryParams, type PsFilters,
} from '@/components/job/PendingSchedulingFilters';
import { CallableMobile } from '@/components/calls/CallButton';
import { CallHistoryButton } from '@/components/calls/CallHistoryButton';
import { cycleSort, SortHeader, type SortDir } from '@/lib/use-sort';
import { RefreshBar } from '@/components/ui/refresh-bar';
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
  // Offer aggregates — TOOLTIP COPY ONLY. They are counts, not a verdict; the
  // chip itself reads `offer_state` below. offered_count = offers still
  // effectively open; total = offers in any state; expired = dead offers.
  // See offerColumns() in job.service.js.
  offered_count?: number | null;
  total_offer_count?: number | null;
  expired_offer_count?: number | null;
  /*
   * THE authoritative offer sub-state, derived server-side. See offerState()
   * below for why the FE must not compute this itself.
   */
  offer_state?: 'offered' | 'expired' | 'pending' | 'none' | null;
};
type Resp = { items: JobRow[]; total: number; limit: number; offset: number };

/*
 * Pending-for-Scheduling tri-state chip — Offered / Expired / plain status.
 *
 * READ THE BACKEND'S VERDICT. Do not re-derive it.
 *
 * Offer expiry is a BATCH SWEEP, not a property of time, and whether it runs at
 * all is a business switch (`job.offer_expiry.enabled` in easyfix_properties).
 * On job #521866 the offer sat at offer_status = 0 for ~92 minutes and only
 * flipped to EXPIRED the instant an operator opened Schedule & Assign — that
 * modal runs a lazy sweep before it reads. This function, deriving the state
 * from raw counts, had rendered a live "Offered to Tx" the whole time. Two
 * implementations of one rule, disagreeing, with the modal moving the data
 * underneath the list.
 *
 * So the BE now projects `offer_state`, derived from the SAME predicate its
 * `offerState` query filter uses, and — crucially — under the SAME expiry
 * regime, resolved once per request:
 *   expiry ON  → open ⇔ offer_status = 0 AND offered_at within the TTL
 *                (the accept path's own gate; immune to sweep lag)
 *   expiry OFF → open ⇔ offer_status = 0, no clock at all, because offers are
 *                then meant to stay open indefinitely
 * plus latest-row-per-technician and technician-resolvable guards, matching what
 * the Schedule & Assign modal lists. The FE must not re-derive ANY of that from
 * counts: it cannot see the property, so it would get the regime wrong.
 *
 * Mapping: 'offered'/'expired' pass through; 'pending' (nobody holding it),
 * 'none' (documented ACCEPTED anomaly) and null (un-migrated deploy — no
 * tbl_job_offer) all mean "no offer chip", which the caller renders as the
 * plain job_status label.
 */
function offerState(j: JobRow): 'offered' | 'expired' | 'none' {
  /*
   * `null` is a REAL backend value (no offer table) and must read as 'none'.
   * Only a MISSING field means we're talking to a pre-`offer_state` backend —
   * fall back to the old count-based derivation there so the chip doesn't go
   * blank mid-deploy. Hence the explicit `undefined` test, not a truthiness or
   * null check.
   */
  if (j.offer_state !== undefined) {
    if (j.offer_state === 'offered') return 'offered';
    if (j.offer_state === 'expired') return 'expired';
    return 'none';
  }
  /*
   * Legacy fallback ONLY (older BE deploy, mid-rollout). is_offered is the
   * EXISTS flag, offered_count the COUNT.
   *
   * ⚠ This branch CANNOT express the 2026-08-03 rule, and deliberately does not
   * pretend to. The rule is "offers exist and none is still open ⇒
   * Expired/Rejected", but an old backend sends no rejected count — only total,
   * offered and expired — so a rejected-only job is indistinguishable here from
   * one whose offers are unresolvable. It stays on the OLD `expired === total`
   * test and lands in 'none'. That is the safe direction: under-claiming
   * "Expired/Rejected" for a few seconds of a deploy is better than a chip that
   * asserts every offer is spent when this code cannot actually know.
   * The moment `offer_state` arrives, the branch above wins and the chip is
   * exact.
   */
  if (j.is_offered === 1 || j.is_offered === true || (j.offered_count ?? 0) > 0) return 'offered';
  const total = j.total_offer_count ?? 0;
  const expired = j.expired_offer_count ?? 0;
  return total > 0 && expired === total ? 'expired' : 'none';
}

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
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState(() => {
    const t = searchParams.get('tab');
    return t && TABS.some((x) => x.value === t) ? t : 'all';
  });
  // Hydrate search from the URL (?q=) so it survives any remount/navigation
  // after a modal action — same rationale as the tab initializer above.
  const [q, setQ] = useState(() => searchParams.get('q') || '');
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
  // `refreshing` = a silent/poll reload while data is already shown (never gates
  // the table). `loadSeqRef` = stale-response guard this page lacked: a slow
  // poll must not clobber a newer user-initiated load — only the latest seq wins.
  const [refreshing, setRefreshing] = useState(false);
  const loadSeqRef = useRef(0);
  // Server-side sort state (whitelisted BE-side) — declared here with the other
  // query state so load() and the poll effect can depend on it. `toggle` + the
  // sort refetch effect live near the render below.
  const [sortKey, setSortKey] = useState<string | null>(() => {
    const s = searchParams.get('sort'); return s ? (s.split(':')[0] || null) : null;
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => {
    const s = searchParams.get('sort'); return s && s.split(':')[1] === 'asc' ? 'asc' : 'desc';
  });

  /*
   * Pending-for-Scheduling filters — hydrated from the URL on first render so
   * the view is shareable/bookmarkable and survives the remount that follows a
   * modal action (same rationale as the `tab` / `q` / `sort` initializers
   * above). useSearchParams() is stable at first render in the App Router.
   */
  const [psFilters, setPsFilters] = useState<PsFilters>(() => psFiltersFromParams(searchParams));
  // Serialised once per render — used as part of the result-cache key AND as
  // the refetch effect's dependency (a stable string beats an object identity
  // that changes on every setState).
  const psKey = psFilterKey(psFilters);
  const psAnySet = psAnyFilterSet(psFilters);

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

  async function load(reset = false, force = false, silent = false) {
    const seq = ++loadSeqRef.current;
    const tabDef = TABS.find((t) => t.value === tab);
    const off = reset ? 0 : offset;
    /*
     * The Pending-for-Scheduling filter bar is scoped to THAT tab only — the
     * other ~9 tabs keep their previous request shape byte-for-byte. Computed
     * locally (rather than reading the `isPendingScheduling` const declared
     * further down) so load() has no forward dependency.
     */
    const psActive = tab === 'pending-scheduling';
    // Cache key includes pageSize so changing rows-per-page doesn't
    // serve a stale 50-row payload. Also includes serverQ so the
    // Unconfirmed-tab search results don't collide with the
    // unfiltered cache entry for the same offset, and the PS filter
    // signature so two different filter sets never share an entry.
    const key = `${tab}|${off}|${limit}|${scopedOwnerId ?? 'admin-all'}|q=${serverQ}|s=${sortKey || ''}:${sortDir}|f=${psActive ? psKey : ''}`;

    // First paint (no data) shows the skeleton; every later reload — tab/page/
    // sort/search/post-mutation — is silent so the table never flashes.
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
          if (seq === loadSeqRef.current) { setData(hit.data); if (reset) setPage(0); }
          return;
        }
      }

      // In-flight dedupe — see comment on inflightRef.
      const inflight = inflightRef.current.get(key);
      if (inflight) {
        try {
          const r = await inflight;
          if (seq === loadSeqRef.current) { setData(r); if (reset) setPage(0); }
        } catch { /* originator surfaces the error */ }
        return;
      }

      // Only THIS call owns the in-flight entry it registers, so the delete is
      // scoped to an inner `finally` — the cache/dedupe short-circuits above
      // must not evict a promise another call is still awaiting.
      try {
        const reqPromise = api.get<Resp>('/admin/jobs', {
          /*
           * The tab's bucket pins, sent UNCONDITIONALLY and identically on
           * every tab. Pending-for-Scheduling therefore always ships
           * status=0 + assigned=false; no filter below can override or drop
           * them, so the list can never leave the bucket.
           */
          status:    tabDef?.statuses ? undefined : tabDef?.status,
          statuses:  tabDef?.statuses ? tabDef.statuses.join(',') : undefined,
          assigned:  tabDef?.assigned === undefined ? undefined : String(tabDef.assigned),
          /*
           * Pending-for-Scheduling filter bar → server-side WHERE clauses that
           * NARROW the pinned bucket. `psQueryParams` emits ONLY the controls
           * that are set, and it is spread only while that tab is active — so
           * the other tabs send exactly the request shape they always did.
           */
          ...(psActive ? psQueryParams(psFilters) : {}),
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
        cacheRef.current.set(key, { at: Date.now(), data: r });
        if (seq === loadSeqRef.current) {
          setData(r);
          if (reset) setPage(0);
        }
      } finally {
        inflightRef.current.delete(key);
      }
    } finally {
      if (seq === loadSeqRef.current) { setLoading(false); setRefreshing(false); }
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
  /*
   * Pending-for-Scheduling filter change → page-0 refetch. Skips the initial
   * mount (the tab effect above already fired the first load, including any
   * URL-hydrated filters). `psKey` is a string, so this fires on real
   * value changes only — not on every setState object identity.
   */
  const psMountRef = useRef(true);
  useEffect(() => {
    if (psMountRef.current) { psMountRef.current = false; return; }
    setPage(0);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [psKey]);
  // NOTE: no interval polling — data refreshes on ACTION (post-mutation
  // load(false, true) after saves/row-actions), now SILENT + flicker-free via
  // the data-null loading guard. Event-driven, no mid-task surprises.

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
   * Job Stage Access clamp (UX + defense-in-depth). A stage-restricted user
   * must never sit on a tab outside their allowed stages. filterTabsForStages
   * drops tabs whose status(es) fall outside the allowed set (including the
   * cross-stage "All" default); if the resolved tab isn't allowed, snap to the
   * first allowed one. Admin / Finance (mode 'all') and a still-loading `me`
   * are no-ops (fail-open — the server LIST endpoint stays authoritative).
   */
  useEffect(() => {
    if (!me?.allowedStages || me.allowedStages.mode === 'all') return;
    const allowedTabs = filterTabsForStages(TABS, me.allowedStages);
    if (allowedTabs.length === 0) return;
    if (!allowedTabs.some((t) => t.value === tab)) {
      setTab(allowedTabs[0].value);
      setPage(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.allowedStages, tab]);

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

  // Transient sibling family for the Unconfirmed grouped view — see jobs/page.
  const [familySiblings, setFamilySiblings] = useState<Array<{ job_id: number; service_category: string | null }> | null>(null);
  function closeModal()                { closeJobAction(); }
  function openView(id: number, siblings?: Array<{ job_id: number; service_category: string | null }>)        { setFamilySiblings(siblings ?? null); openJobAction('view',     id); }
  // Pending-to-Start Check-In — same JobModal workspace as view, opened under
  // ?action=checkin so it titles itself "Checkin · Job #N" (see JobModalMode).
  function openCheckin(id: number)     { openJobAction('checkin',  id); }
  // Unconfirmed orders open the dedicated confirm form (edit layout +
  // services basket + "Confirm & Schedule" footer), mirroring the
  // legacy addEditJob flow.
  function openConfirm(id: number, siblings?: Array<{ job_id: number; service_category: string | null }>)     { setFamilySiblings(siblings ?? null); openJobAction('confirm',  id); }
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
  // Only job_id + easyfixer_name are read by LiveLocationPopover, so the state
  // is the minimal structural shape — satisfied by BOTH JobRow (the shared
  // table's MapPin call site) and PendingToStartView's PendingJobRow, so both
  // call sites type-check without importing each other's row type.
  const [locationJob, setLocationJob] = useState<{ job_id: number; easyfixer_name: string | null } | null>(null);
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
  // Server-side sort — sortKey/sortDir state is declared up in the state block
  // (load()/the poll effect depend on it); here we wire the header-click cycle.
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
    // Shared serialiser (PendingSchedulingFilters) — also scrubs the retired
    // `psStatus` param. /jobs writes the SAME `ps*` names, so a filtered link
    // stays portable between the two surfaces.
    writePsFilterParams(p, psFilters);
    const nextStr = p.toString();
    if (nextStr !== searchParams.toString()) {
      router.replace(nextStr ? `${pathname}?${nextStr}` : pathname, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverQ, sortKey, sortDir, psKey]);

  // Resolve the current tab's human label for the page header — each sidebar
  // sub-menu is a standalone status page, so the tab name IS the page title.
  const activeTab = TABS.find((t) => t.value === tab);

  // Pending-for-Scheduling tab (status=0, unassigned) gets a DISTINCT
  // column set + a stripped-down action menu (Schedule & Assign only —
  // no generic View; the modal already shows full job detail). All other
  // tabs keep the shared table below unchanged.
  const isPendingScheduling = tab === 'pending-scheduling';

  // "Pending App Ack" is a LEGACY-ONLY bucket (BOOKED with a technician
  // attached, awaiting the tech to acknowledge in-app). The new offer-based
  // flow never produces that state — a tech ACCEPT flips BOOKED→SCHEDULED
  // atomically, so a job never dwells assigned-but-unacknowledged. The tab is
  // kept visible-but-inert (see the Sidebar's RETIRED_MENU_HREFS) and this
  // page renders an explanatory panel instead of an always-empty table.
  const isRetiredTab = tab === 'pending-app-ack';

  // "Pending to Start" (status=1 SCHEDULED) gets its own dedicated view —
  // a PM/ZM/Client/City filter bar + three appointment-bucketed,
  // independently-paginated sections (Over Due / Action Today / Future),
  // matching the legacy CRM. Rendered instead of the shared table below
  // (which stays untouched for the other ~9 tabs).
  const isPendingStart = tab === 'pending-start';

  /*
   * The local `jobAgeLabel(ts)` helper that used to live here was RETIRED
   * (2026-07-31) — it recomputed "created → now" client-side, which over-reports
   * age for every closed job. The single shared implementation is
   * `formatJobAge` / `jobAgeTitle` in '@/lib/job-age'.
   */

  /*
   * The Pending-for-Scheduling lookup options (client / city / category) now
   * live inside PendingSchedulingFilters, which owns its own `useLookup()` —
   * session-cached + request-deduped, so hosting the bar costs nothing extra.
   */

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

      {/* Search bar — hidden on the retired Pending App Ack page and on
          Pending to Start (which renders its own filter bar). */}
      {!isRetiredTab && !isPendingStart && (
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            {/* Placeholder + hint are DERIVED from JOB_SEARCH_FIELDS in
                lib/job-tabs.ts — the same array filterJobRows matches on — so
                the box can never again advertise a different set of fields than
                it actually searches (it previously named 4 of 14, hiding the
                Client SPOC / city / technician search entirely).
                This box drives BOTH: an instant client-side narrow of the
                loaded page AND — debounced 300ms via `serverQ` — the BE `q`
                param, so matches beyond the current page are found too. */}
            <Input
              placeholder={JOB_SEARCH_PLACEHOLDER}
              title={JOB_SEARCH_HINT}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
            />
          </div>
          {/*
            * Pending-for-Scheduling filter bar. Rendered ONLY on that tab —
            * the other ~9 tabs keep the bare search card they had. Every
            * control below drives the SERVER query (see load()); changing any
            * of them resets to page 1 via the psFilterKey effect, and the
            * selection is mirrored into the URL so the view is shareable.
            */}
          {isPendingScheduling && (
            <PendingSchedulingFilters value={psFilters} onChange={setPsFilters} />
          )}
        </CardContent>
      </Card>
      )}

      {isRetiredTab ? (
        <PendingAppAckRetired />
      ) : isPendingStart ? (
        <PendingToStartView
          me={me}
          isAdmin={isAdmin}
          canJob={canJob}
          openView={openView}
          openCheckin={openCheckin}
          openReassign={openReassign}
          onShowLocation={(row) => setLocationJob(row)}
        />
      ) : (
      <Card>
        <RefreshBar active={refreshing} />
        <CardContent className="p-0 overflow-x-auto">
          {tab === 'unconfirmed' ? (
            /* Same table, grouped into the five sections ops asked for. The
               component owns the grouping and the drag order only; every
               column, sort header and row action still comes from
               UnconfirmedJobsTable, which it renders once per section. */
            <UnconfirmedSections
              rows={sorted}
              loading={loading}
              // Confirm promotes an Unconfirmed order (status 9 → 0); gate it
              // by the stage-transition rule too, not just the permission.
              canConfirm={!!canJob.isJobConfirm && transitionAllowed(me?.allowedStages, 9, 0)}
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
            * triage the scheduling queue.
            *
            * Row actions: View + Schedule & Assign. View was deliberately
            * ABSENT until 2026-09-04 on the reasoning that Schedule & Assign
            * already shows full job detail — true, but it is a WRITE modal, so
            * "just look at this order" meant opening the thing that schedules
            * it. Ops asked for the read-only viewer back here and on
            * Pending-to-Start. Do not re-remove it on the old reasoning.
            */
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader<string> col="job_id" sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="stick-col-head stick-left">Job ID</SortHeader>
                {/* Age promoted OUT of the Ticket Created cell into its own
                    sortable column. The old sub-line couldn't be sorted, and
                    sorting on created_date_time is NOT equivalent: age stops
                    accruing at the terminal event while the created timestamp
                    never moves. JOB_AGE_SORT_KEY orders by precise seconds. */}
                <SortHeader<string> col={JOB_AGE_SORT_KEY} sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="w-16">Age</SortHeader>
                <SortHeader<string> col="job_reference_id" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Job Ref</SortHeader>
                <SortHeader<string> col="created_date_time" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Ticket Created Date</SortHeader>
                <SortHeader<string> col="client_name" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Client</SortHeader>
                {/* client_spoc_name is already on the LIST projection (LIST_COLUMNS
                    carries it for the Unconfirmed tab) — no BE change needed. Not
                    sortable: `client_spoc_name` isn't in the BE's SORT_COLUMN
                    whitelist, and a click on an unwhitelisted key 400s. */}
                <th>Client SPOC</th>
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
                  {Array.from({ length: 13 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-24 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!loading && sorted.length === 0 && (
                <tr><td colSpan={13} className="text-center text-muted-foreground py-8">
                  {psAnySet
                    ? 'No orders match these filters.'
                    : `No orders in this bucket${!isAdmin ? ' owned by you' : ''}.`}
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
                  <td className="text-xs whitespace-nowrap tabular-nums" title={jobAgeTitle(j)}>{formatJobAge(j)}</td>
                  <td className="text-xs whitespace-nowrap">{j.job_reference_id ?? '—'}</td>
                  <td className="whitespace-nowrap">
                    <div className="text-xs">{formatDate(j.ticket_created_date_time)}</div>
                  </td>
                  <td className="min-w-[18rem] max-w-[26rem] break-words">{j.client_name ?? '—'}</td>
                  {/* client_spoc IS the SPOC's mobile (a raw string on tbl_job —
                      there is no SPOC id), masked in transit by mask-mobile.
                      Dialling goes through the spocJobId target, which re-reads
                      the clear number BE-side; the FE never holds it. Same
                      name-over-number shape as the Customer cell below. */}
                  <td className="whitespace-nowrap">
                    <div>{j.client_spoc_name || '—'}</div>
                    {j.client_spoc && (
                      <div className="text-xs text-muted-foreground">
                        <CallableMobile spocJobId={j.job_id} mobile={j.client_spoc} />
                      </div>
                    )}
                  </td>
                  <td>{j.city_name ?? '—'}</td>
                  <td>{j.service_category ?? '—'}</td>
                  {/* Appointment. The sub-line stays a BAND — ops quotes the
                      window, not the minute — but it is the band derived from
                      `requested_date_time` when that carries a real time, not
                      the raw stored `time_slot`. The column is derived and
                      re-derived on every write, so a stale value printed a
                      window the job no longer sits in. See displaySlot. */}
                  <td className="whitespace-nowrap">
                    <div className="text-xs">{j.requested_date_time ? formatDate(j.requested_date_time) : '—'}</div>
                    {(() => {
                      const slot = displaySlot(j.requested_date_time, j.time_slot);
                      return slot ? <div className="text-xs text-muted-foreground">· {slot}</div> : null;
                    })()}
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
                    {/* Hovering the status reveals WHO the job was offered to and
                        where each offer stands. `enabled` is false when the job
                        has no offers at all, so ordinary rows get no hover card.
                        The roster is fetched lazily (and side-effect-free) —
                        see OfferHoverCard. */}
                    <OfferHoverCard jobId={j.job_id} enabled={(j.total_offer_count ?? 0) > 0}>
                    {/* Offer tri-state only overrides the chip on BOOKED (0)
                        rows — on any other status the job_status label wins. */}
                    {j.job_status === 0 && offerState(j) === 'offered' ? (
                      <StatusChip
                        tone="orange"
                        title={
                          (j.offered_count ?? 0) > 1
                            ? `Offered to ${j.offered_count} technicians — awaiting the first to accept`
                            : j.offered_efr_name ? `Offered to ${j.offered_efr_name}` : 'Offered to technician'
                        }
                      >
                        {(j.offered_count ?? 0) > 1 ? `Offered to ${j.offered_count} Tx` : 'Offered to Tx'}
                      </StatusChip>
                    ) : j.job_status === 0 && offerState(j) === 'expired' ? (
                      <StatusChip
                        tone="rose"
                        title={`Every offer on this order is spent — expired or declined (${j.total_offer_count} offer${j.total_offer_count === 1 ? '' : 's'}, ${j.expired_offer_count} expired) — it needs re-offering or a manual assign`}
                      >
                        Expired/Rejected
                      </StatusChip>
                    ) : (
                      <StatusChip tone={statusTone(j.job_status)}>
                        {statusLabel(j.job_status, { assigned: j.fk_easyfixter_id != null })}
                      </StatusChip>
                    )}
                    </OfferHoverCard>
                  </td>
                  <td className="max-w-[16rem] truncate" title={j.remarks ?? undefined}>{j.remarks || '—'}</td>
                  <td className="stick-col stick-right text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1 justify-end">
                      {/* View — read-only, ungated, and FIRST so the icon order
                          matches every other tab (Unconfirmed included). */}
                      <button
                        type="button"
                        onClick={() => openView(j.job_id)}
                        className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                        title="View details"
                        aria-label="View details"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      {canJob.isJobAssign && transitionAllowed(me?.allowedStages, j.job_status, 1) && (
                        <button
                          type="button"
                          onClick={() => openSchedule(j.job_id)}
                          className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
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
                {/* Age — server-computed + server-sorted (JOB_AGE_SORT_KEY).
                    Narrow + nowrap; sits beside the pinned Job # so it reads
                    without scrolling. */}
                <SortHeader col={JOB_AGE_SORT_KEY} sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="w-16">Age</SortHeader>
                <SortHeader col="job_reference_id"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Job Ref</SortHeader>
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
                  {Array.from({ length: 11 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-24 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!loading && sorted.length === 0 && (
                <tr><td colSpan={11} className="text-center text-muted-foreground py-8">
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
                  <td className="text-xs whitespace-nowrap tabular-nums" title={jobAgeTitle(j)}>{formatJobAge(j)}</td>
                  <td className="text-xs whitespace-nowrap">{j.job_reference_id ?? '—'}</td>
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
                        className="ml-1 inline-flex items-center rounded-full bg-warning-tint hover:bg-warning/20 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-warning-strong whitespace-nowrap cursor-pointer transition-colors"
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
                        * Generic View (Eye). Pending-for-Scheduling renders
                        * its OWN table above and now carries its own View
                        * button, so this branch is unreached for that tab
                        * either way — the guard stays only to stop the two
                        * from both firing if the custom table is ever folded
                        * back into this one.
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
                      {/*
                        * Status 1 (SCHEDULED) is the accept→check-in window —
                        * the technician is travelling. It was missing here, so
                        * the one period an operator is most likely to be on the
                        * phone asking "where is he" had no button at all.
                        */}
                      {((j.job_status === 0 && j.fk_easyfixter_id != null) ||
                        j.job_status === 1 ||
                        j.job_status === 2 || j.job_status === 20) && (
                        <button
                          type="button"
                          onClick={() => setLocationJob(j)}
                          className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
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
                      {j.job_status === 9 && canJob.isJobConfirm && transitionAllowed(me?.allowedStages, j.job_status, 0) && (
                        <button
                          type="button"
                          onClick={() => openConfirm(j.job_id)}
                          className="inline-flex items-center gap-1 text-gold-strong text-xs hover:underline"
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
                      {j.job_status === 0 && canJob.isJobAssign && transitionAllowed(me?.allowedStages, j.job_status, 1) && (
                        <button
                          type="button"
                          onClick={() => openSchedule(j.job_id)}
                          className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                          title="Schedule & Assign — set the date/slot and pick a technician"
                        >
                          <CalendarClock className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {j.job_status === 1 && (
                        <>
                          {canJob.isJobStatusChange && transitionAllowed(me?.allowedStages, j.job_status, 2) && (
                            <button
                              type="button"
                              disabled={rowBusy === j.job_id}
                              onClick={() => quickStatusChange(j.job_id, 2, 'Check in')}
                              className="inline-flex items-center gap-1 text-warning-strong text-xs hover:underline disabled:opacity-50"
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
                              className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                              title="Reassign Technician — pick a different tech from the ranked list"
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </>
                      )}
                      {(j.job_status === 2 || j.job_status === 20) && canJob.isJobStatusChange && transitionAllowed(me?.allowedStages, j.job_status, 3) && (
                        <button
                          type="button"
                          disabled={rowBusy === j.job_id}
                          onClick={() => quickStatusChange(j.job_id, 3, 'Check out & complete')}
                          className="inline-flex items-center gap-1 text-success-strong text-xs hover:underline disabled:opacity-50"
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
      )}

      <JobModal
        open={modal.open}
        mode={modal.mode}
        jobId={modal.id}
        siblings={familySiblings ?? undefined}
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
        // Cancel Job (non-assign) also mutates the list — same in-place refresh
        // as onAssigned so the cancelled row drops out without a skeleton flash.
        onChanged={() => { cacheRef.current.clear(); load(false, true); }}
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

      {/* Pending to Start renders its own per-section pagination inside
          PendingToStartView; suppress the shared footer pagination there. */}
      {data && !isPendingStart && (
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

/*
 * PendingAppAckRetired — the body shown for ?tab=pending-app-ack instead of a
 * table. "Pending App Ack" is a LEGACY concept that the new offer-based
 * assignment flow makes structurally impossible, so this page is intentionally
 * NOT built out. The sidebar entry is disabled (Sidebar.tsx RETIRED_MENU_HREFS);
 * this panel is reachable only by typing the URL and exists so a future
 * developer/operator understands WHY the bucket is empty rather than assuming
 * it was forgotten.
 *
 * Background (do not delete — this is the rationale, not decoration):
 *  - Legacy: a job was assigned to ONE technician and stayed BOOKED (status 0)
 *    with that tech attached, waiting for them to Accept/Reject in the app.
 *    That "assigned-but-unacknowledged" state = status 0 + fk_easyfixter_id set.
 *  - New CRM: a job is OFFERED to MANY technicians (tbl_job_offer). Acceptance
 *    is a single atomic UPDATE that sets fk_easyfixter_id AND flips
 *    BOOKED→SCHEDULED together, so a job never dwells in "status 0 + tech
 *    attached". The waiting-for-acceptance state now lives in tbl_job_offer and
 *    surfaces on the "Pending for Scheduling" page as the "Offered to Tx" chip.
 *  - Any pre-existing legacy rows in this state are cleared from the old portal.
 */
function PendingAppAckRetired() {
  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Retired
          </span>
          <h2 className="text-lg font-semibold">Pending App Ack — not applicable in the new CRM</h2>
        </div>

        <p className="text-sm text-muted-foreground">
          This bucket is a leftover from the legacy assignment model and is
          intentionally <strong>not built out</strong> in the new CRM. Under the
          offer-based flow it can never be populated, so it is kept visible only
          as a signpost.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-border/60 p-4">
            <h3 className="text-sm font-semibold">Legacy behaviour</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              A job was assigned to <strong>one</strong> technician and stayed{' '}
              <em>Booked</em> with that technician attached, waiting for them to{' '}
              <strong>Accept or Reject</strong> in the app. That
              &ldquo;assigned-but-unacknowledged&rdquo; window <em>was</em> Pending App Ack.
            </p>
          </div>
          <div className="rounded-md border border-border/60 p-4">
            <h3 className="text-sm font-semibold">New offer-based flow</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              A job is <strong>offered to many</strong> technicians at once. The
              first to accept wins in a single atomic step that attaches the
              technician <em>and</em> moves the job straight to{' '}
              <strong>Pending to Start</strong> — so a job never sits
              assigned-but-unacknowledged.
            </p>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          The &ldquo;awaiting acceptance&rdquo; state now lives on the{' '}
          <strong>Pending for Scheduling</strong> page, shown as the{' '}
          <span className="rounded bg-warning-tint px-1.5 py-0.5 text-xs font-medium text-warning-strong">
            Offered to Tx
          </span>{' '}
          chip while offers are open. Any surviving legacy jobs in the old
          Pending App Ack state are cleared from the old portal.
        </p>
      </CardContent>
    </Card>
  );
}
