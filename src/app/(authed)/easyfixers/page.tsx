'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { SearchSelect } from '@/components/ui/search-select';
import { DownloadButton } from '@/components/ui/download-button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { CsvCellModal, type CsvCellItem } from '@/components/ui/CsvCellModal';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { api } from '@/lib/api';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useLookup } from '@/lib/use-lookup';
import { cn, formatDate, formatEasyfixerName } from '@/lib/utils';
import { EasyfixerModal, type EasyfixerModalMode } from '@/components/easyfixer/EasyfixerModal';
import { EasyfixerActionMenu } from '@/components/easyfixer/EasyfixerActionMenu';
import { EasyfixerTransactionsModal } from '@/components/easyfixer/EasyfixerTransactionsModal';
import { EasyfixerClientMappingModal } from '@/components/easyfixer/EasyfixerClientMappingModal';
import { useSort, SortHeader } from '@/lib/use-sort';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

/*
 * Manage Easyfixers — parity rewrite of the legacy CRM page.
 * 14 filters, 15 primary columns (+ a few legacy extras kept around for
 * day-to-day CRM use: Mobile, Email, Service Type, Verified, Action).
 *
 * Filters NO LONGER auto-refetch on every change — operators kept losing
 * partially-typed filter input mid-load. Search/Reset/initial mount and
 * pagination are the only fetch triggers.
 */

type Ef = {
  efr_id: number; efr_name: string; efr_first_name: string | null; efr_last_name: string | null;
  efr_no: string; efr_email: string | null;
  efr_cityId: number | null; city_name: string | null;
  efr_service_category: string | null; efr_service_type: string | null;
  efr_profile_perc: number | null;
  is_technician_verified: boolean | number | null;
  efr_status: number;
  /*
   * `efr_status_label` (2026-06-08) — server-side derived from the 4
   * underlying columns (user_id, personal_details_filled,
   * is_identity_details_verified, is_technician_verified, efr_status).
   * Use this string in the Status column, NOT the binary `efr_status`.
   * Possible values: 'Active' · 'Inactive' · 'Idle' · 'Not Eligible'
   *                · 'Not Suitable' · 'Registration In Progress'
   */
  efr_status_label: 'Active' | 'Inactive' | 'Idle' | 'Not Eligible' | 'Not Suitable' | 'Registration In Progress';
  user_id: number | null;
  personal_details_filled: number | null;
  is_identity_details_verified: number | null;
  efr_manager_id: number | null;
  insert_date: string; update_date: string | null;
  // New fields (BE contract — sibling agent adds these in parallel).
  state_id: number | null;
  state_name: string | null;
  zonal_manager_user_id: number | null;
  user_mapped_to_city: string | null;
  current_balance: number | string | null;
  profile_activation_date_time: string | null;
  clients_mapped: number;
  total_earnings: number;
  job_count: number;
  avg_rating: number | null;
  ef_account: 'Under Master' | 'Master' | 'Individual';
  att_is_leave_marked: number | null;
  att_morning_slot: number | null;
  att_evening_slot: number | null;
  att_created_on: string | null;
};
type Resp = { items: Ef[]; total: number; limit: number; offset: number };

/*
 * EnrichedEf — row state on the page after the two-phase fetch (issue
 * 4). The base list returns instantly with aggregate/attendance columns
 * blank; we render the row immediately with "…" placeholders and merge
 * the heavier rollups in as their parallel calls land. `_aggregatesLoaded`
 * and `_attendanceLoaded` flip false → true per-row so individual cells
 * can swap their placeholder for the real value without rerendering the
 * whole grid.
 */
type EnrichedEf = Ef & {
  _aggregatesLoaded?: boolean;
  _attendanceLoaded?: boolean;
};

type AggregateRow = {
  efr_id: number;
  clients_mapped: number;
  total_earnings: number;
  job_count: number;
  avg_rating: number | null;
};
/*
 * Aggregates cache (2026-06-08). Pagination back-and-forth, search-and-back,
 * or just re-clicking the same filter shouldn't refire the aggregates POST
 * for rows we already enriched this session. 60s TTL is short enough to catch
 * ops-driven mutations (job completion → earnings tick up) while long enough
 * to absorb the normal navigation patterns.
 *
 * Cache lives at module-scope so it survives the page component's re-mounts
 * (e.g. when the user opens the EasyfixerModal and closes it, the list page
 * stays mounted — but if it WERE to remount, we still don't want the cache
 * to die). Map<efr_id, {data, at}> rather than an array so per-id lookups
 * stay O(1) for big page sizes ('All' → up to 500 rows).
 *
 * Attendance is intentionally NOT cached — it's today's data, only a few
 * hundred ms to fetch, and a stale 60s view could mask a leave-mark that
 * just landed. Caching it would save very little for noticeable risk.
 */
const AGGREGATE_CACHE_TTL_MS = 60_000;
const aggregateCache = new Map<number, { data: AggregateRow; at: number }>();

function readAggregatesFromCache(efrIds: number[]): {
  cached: AggregateRow[];
  missing: number[];
} {
  const now = Date.now();
  const cached: AggregateRow[] = [];
  const missing: number[] = [];
  for (const id of efrIds) {
    const hit = aggregateCache.get(id);
    if (hit && now - hit.at < AGGREGATE_CACHE_TTL_MS) {
      cached.push(hit.data);
    } else {
      missing.push(id);
    }
  }
  return { cached, missing };
}

function writeAggregatesToCache(rows: AggregateRow[]): void {
  const at = Date.now();
  for (const r of rows) aggregateCache.set(r.efr_id, { data: r, at });
}

/*
 * Status-counts cache (2026-06-08). Mirrors the aggregateCache TTL +
 * lifecycle. Rapid Search clicks within the TTL window hit the cache
 * synchronously instead of refiring the SUM-CASE query (~150-200ms
 * each). Same module-scope persistence so the cache survives modal
 * open/close cycles. Counts only meaningfully change on Edit-save,
 * which already triggers a fresh load() from the modal's onSaved
 * callback — that bypass is handled below via `invalidateStatusCounts()`.
 *
 * Single-row cache (not keyed) because the response is global (not
 * filter-narrowed) — there's only ever one current "snapshot" of all
 * 6 counts at any time.
 */
const STATUS_COUNTS_CACHE_TTL_MS = 30_000;
let statusCountsCache: { data: StatusCountsResp; at: number } | null = null;

function readStatusCountsFromCache(): StatusCountsResp | null {
  if (!statusCountsCache) return null;
  if (Date.now() - statusCountsCache.at > STATUS_COUNTS_CACHE_TTL_MS) return null;
  return statusCountsCache.data;
}
function writeStatusCountsToCache(data: StatusCountsResp): void {
  statusCountsCache = { data, at: Date.now() };
}
function invalidateStatusCounts(): void {
  statusCountsCache = null;
}

type AttendanceRow = {
  efr_id: number;
  att_is_leave_marked: number | null;
  att_morning_slot: number | null;
  att_evening_slot: number | null;
  att_created_on: string | null;
};

/*
 * Status-counts API response (2026-06-08). One number per of the 6
 * status buckets the dropdown filter exposes, plus an unfiltered total.
 * Buckets overlap (sum > total) because the legacy WHERE clauses don't
 * priority-guard each other; that's the documented contract.
 */
type StatusCountsResp = {
  active: number;
  inactive: number;
  idle: number;
  not_eligible: number;
  not_suitable: number;
  reg_in_progress: number;
  total: number;
};

type ServiceType = { service_type_id: number; service_type_name: string; service_catg_id: number };
type ZonalManager = { user_id: number; user_name: string };
type DeepSkill = { deep_skill_id: number; deep_skill_name: string };

const DEFAULT_FILTERS = {
  easyfixerId: '',
  name: '',
  mobileNo: '',
  efAccount: '',         // under_master | master | individual
  status: '1',           // Active default per screenshot
  stateId: '',
  cityId: '',
  serviceCategory: '',
  serviceType: '',
  deepSkillId: '',
  activeFromDate: '',
  activeToDate: '',
  zonalManagerId: '',
  attendance: '',        // present | absent | on_leave | no_information
  deepSkillMapped: 'mapped', // mapped | not_mapped — default Mapped per screenshot
};

type Filters = typeof DEFAULT_FILTERS;

function buildQuery(f: Filters, extras: Record<string, string | number | undefined> = {}) {
  const q: Record<string, string | number | undefined> = { ...extras };
  if (f.easyfixerId) q.easyfixerId = f.easyfixerId;
  if (f.name) q.name = f.name;
  if (f.mobileNo) q.mobileNo = f.mobileNo;
  if (f.efAccount) q.efAccount = f.efAccount;
  if (f.status !== '') q.status = f.status;
  if (f.stateId) q.stateId = f.stateId;
  if (f.cityId) q.cityId = f.cityId;
  if (f.serviceCategory) q.serviceCategory = f.serviceCategory;
  if (f.serviceType) q.serviceType = f.serviceType;
  if (f.deepSkillId) q.deepSkillId = f.deepSkillId;
  if (f.activeFromDate) q.activeFromDate = f.activeFromDate;
  if (f.activeToDate) q.activeToDate = f.activeToDate;
  if (f.zonalManagerId) q.zonalManagerId = f.zonalManagerId;
  if (f.attendance) q.attendance = f.attendance;
  if (f.deepSkillMapped) q.deepSkillMapped = f.deepSkillMapped;
  return q;
}

function efAccountTone(v: Ef['ef_account']): StatusChipTone {
  if (v === 'Master') return 'sky';
  if (v === 'Under Master') return 'emerald';
  return 'slate';
}

/*
 * Status pill tone per the 6-status enum (2026-06-08). Mirrors the
 * legacy CRM colour convention: green for happy-path Active, slate
 * for terminal/parked states (Inactive/Idle), amber/red for blocked,
 * sky for in-flight registration.
 */
function statusLabelTone(v: Ef['efr_status_label']): StatusChipTone {
  switch (v) {
    case 'Active':                    return 'emerald';
    case 'Inactive':                  return 'slate';
    case 'Idle':                      return 'slate';
    case 'Registration In Progress':  return 'sky';
    case 'Not Eligible':              return 'red';
    case 'Not Suitable':              return 'amber';
    default:                          return 'slate';
  }
}

/*
 * Module-level dedupe for inline lookup fetches.
 *
 * React StrictMode mounts effects twice in dev, and a single page mount
 * was producing TWO `/shared/lookup/zonal-managers`, TWO
 * `/admin/deep-skills`, and TWO `/shared/lookup/service-types` requests.
 * Pattern mirrors `fetchMeOnce()` in `lib/auth-context.tsx`: one
 * module-level promise per endpoint, collapsing concurrent calls into a
 * single in-flight request, plus a per-tab sessionStorage cache so a
 * remount within the session hydrates instantly.
 *
 * The promises are NEVER cleared on resolve — these lookups are
 * session-stable (zonal managers, deep-skill catalogue, all service
 * types). A logout / role change clears sessionStorage via
 * `clearLookupCache()` / sign-out flow.
 */
let zonalManagersPromise: Promise<ZonalManager[]> | null = null;
let deepSkillsPromise: Promise<DeepSkill[]> | null = null;
let serviceTypesAllPromise: Promise<ServiceType[]> | null = null;

/*
 * Module-level in-flight collapse for the LIST call itself.
 *
 * React StrictMode mounts the page twice in dev, firing `load(true)`
 * twice on the same tick — both hit `/admin/easyfixers` and both wait
 * 20s+ for the legacy slow query, doubling the network footprint. This
 * promise is cleared in .finally() so subsequent paginations / search
 * clicks aren't stuck behind a stale resolved promise; we ONLY want to
 * coalesce concurrent identical calls, not memoise across the session.
 *
 * Param-keyed dedupe would be over-engineering for the mount-only case
 * StrictMode triggers — the simple in-flight collapse is enough.
 */
let listPromise: Promise<Resp> | null = null;
function fetchListOnce(params: Record<string, string | number | undefined>): Promise<Resp> {
  if (listPromise) return listPromise;
  listPromise = api.get<Resp>('/admin/easyfixers', params).finally(() => {
    listPromise = null;
  });
  return listPromise;
}

const SS_PREFIX = 'ef-mgmt-lookup:';
const SS_TTL_MS = 30 * 60 * 1000;

function readSession<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SS_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t: number; d: T };
    if (Date.now() - parsed.t > SS_TTL_MS) return null;
    return parsed.d;
  } catch { return null; }
}
function writeSession<T>(key: string, data: T) {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.setItem(SS_PREFIX + key, JSON.stringify({ t: Date.now(), d: data })); }
  catch { /* quota — ignore */ }
}

function fetchZonalManagersOnce(): Promise<ZonalManager[]> {
  if (zonalManagersPromise) return zonalManagersPromise;
  const cached = readSession<ZonalManager[]>('zm');
  if (cached) {
    zonalManagersPromise = Promise.resolve(cached);
    return zonalManagersPromise;
  }
  zonalManagersPromise = api
    .get<ZonalManager[]>('/shared/lookup/zonal-managers')
    .then((data) => { writeSession('zm', data); return data; })
    .catch((e) => { zonalManagersPromise = null; throw e; });
  return zonalManagersPromise;
}

function fetchDeepSkillsOnce(): Promise<DeepSkill[]> {
  if (deepSkillsPromise) return deepSkillsPromise;
  const cached = readSession<DeepSkill[]>('ds');
  if (cached) {
    deepSkillsPromise = Promise.resolve(cached);
    return deepSkillsPromise;
  }
  deepSkillsPromise = api
    .get<{ items: DeepSkill[] } | DeepSkill[]>('/admin/deep-skills', { limit: 500, status: 1 })
    .then((r) => {
      const list = Array.isArray(r) ? r : (r.items ?? []);
      writeSession('ds', list);
      return list;
    })
    .catch((e) => { deepSkillsPromise = null; throw e; });
  return deepSkillsPromise;
}

function fetchServiceTypesAllOnce(): Promise<ServiceType[]> {
  if (serviceTypesAllPromise) return serviceTypesAllPromise;
  const cached = readSession<ServiceType[]>('st');
  if (cached) {
    serviceTypesAllPromise = Promise.resolve(cached);
    return serviceTypesAllPromise;
  }
  serviceTypesAllPromise = api
    .get<ServiceType[]>('/shared/lookup/service-types')
    .then((data) => { writeSession('st', data); return data; })
    .catch((e) => { serviceTypesAllPromise = null; throw e; });
  return serviceTypesAllPromise;
}

export default function EasyfixersPage() {
  const lk = useLookup();
  const router = useRouter();
  const { me } = useMe();
  /*
   * Action permission keys (2026-06-08).
   *
   * The Manage Easyfixers screen uses BARE verbs (`isAddNew`, `isEdit`,
   * `isClientMapping`, `isAssessment`) — NOT the `is{Entity}{Verb}`
   * convention every other module follows (`isClientEdit`, `isToolEdit`,
   * `isJobEdit`, `isRollEdit`, etc.).
   *
   * Why the exception: the Legacy CRM (Java) has been gating its own
   * Manage Easyfixers screen on these bare names for years. The DB seed
   * matches (menu_action.action_name for menu_id=9 is the bare verb).
   * Renaming to add the entity prefix would silently break Legacy CRM's
   * permission checks since both CRMs share the same `easyfix_core` DB.
   *
   * No FE collision risk: no other Easyfix_CRM_UI page checks `isEdit`
   * or `isAddNew` as bare keys (verified via grep — every other module
   * uses prefixed keys). The bare keys are namespaced de-facto to this
   * one screen.
   *
   * Future easyfixer-specific actions should also use bare names here
   * to stay consistent with the Legacy CRM seed.
   */
  const can = actionFlags(me, ['isAddNew', 'isEdit']);
  const searchParams = useSearchParams();
  // Total comes from the base list response; rows are stored separately
  // so we can mutate them in place when aggregates/attendance land.
  const [rows, setRows] = useState<EnrichedEf[]>([]);
  /*
   * Status-counts strip (2026-06-08). Populated by a single
   * GET /admin/easyfixers/status-counts call alongside every load().
   * Each count matches what the operator sees after clicking the
   * corresponding dropdown filter — buckets overlap by design
   * (legacy parity).
   */
  const [statusCounts, setStatusCounts] = useState<StatusCountsResp | null>(null);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  // TablePagination is 0-indexed; we keep the same convention here.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Inline lookups not exposed by useLookup() (we keep that hook untouched
  // per the strict file-scope rule and fetch these one-time on mount).
  const [zonalManagers, setZonalManagers] = useState<ZonalManager[]>([]);
  const [deepSkills, setDeepSkills] = useState<DeepSkill[]>([]);
  const [serviceTypesAll, setServiceTypesAll] = useState<ServiceType[]>([]);

  const [modal, setModal] = useState<{ open: boolean; mode: EasyfixerModalMode; id?: number }>({ open: false, mode: 'create' });

  // Per-row drill-in modals (CSV expansion, mapped clients, transactions).
  // Each tracks the row that triggered it so the modal renders against
  // the right easyfixer + we know which heading to show.
  const [csvCell, setCsvCell] = useState<{
    open: boolean;
    title: string;
    items: CsvCellItem[];
  }>({ open: false, title: '', items: [] });
  const [clientMappingFor, setClientMappingFor] = useState<Ef | null>(null);
  const [transactionsFor, setTransactionsFor] = useState<Ef | null>(null);

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setModal({ open: true, mode: 'create' });
    } else {
      const v = searchParams.get('view');
      // Deep-link compat: ?view=<id> still opens the modal, but in `edit`
      // mode (the page no longer has a view-only flow — issue 4).
      if (v && /^\d+$/.test(v)) setModal({ open: true, mode: 'edit', id: Number(v) });
    }
  }, [searchParams]);

  function closeModal() {
    setModal((m) => ({ ...m, open: false }));
    if (searchParams.get('new') || searchParams.get('view')) router.replace('/easyfixers');
  }
  function openCreate() { setModal({ open: true, mode: 'create' }); }

  /*
   * Two-phase fetch (issue 4):
   *
   *   Phase 1 — base list:   GET /admin/easyfixers (no aggregates)
   *                          Returns ~1-2s with the 12 always-shown
   *                          columns (name, mobile, city, state, etc.).
   *                          We render rows immediately with "…" in the
   *                          4 aggregation cells + 4 attendance cells.
   *
   *   Phase 2 — fan-out:     POST /admin/easyfixers/aggregates
   *                          POST /admin/easyfixers/attendance
   *                          Fired in parallel against the current
   *                          page's efr_ids. Each merges its rows back
   *                          into state keyed by efr_id, flipping the
   *                          per-row `_aggregatesLoaded` /
   *                          `_attendanceLoaded` flag so individual
   *                          cells can swap their placeholder.
   *
   * The two phase-2 calls run as fire-and-forget — neither blocks the
   * UI nor each other. If one fails we keep its cells showing "…"
   * rather than throwing the whole page.
   */
  async function load(
    reset = false,
    overrideFilters?: Filters,
    overridePage?: number,
    overridePageSize?: TablePageSize,
  ) {
    setLoading(true);
    const f = overrideFilters ?? filters;
    const pg = reset ? 0 : (overridePage ?? page);
    const ps = overridePageSize ?? pageSize;
    // BE Joi cap on /admin/easyfixers is 500; pass it explicitly so
    // "All" maps to the true ceiling rather than the helper's 1000
    // default (which would 400).
    const limit = pageSizeToLimit(ps, 500);
    const offset = pg * (ps === 'all' ? 0 : Number(ps));
    try {
      /*
       * Status-counts: consult the 30s cache first. Rapid Search clicks
       * within the TTL window hit synchronously — no network round-trip,
       * no SUM-CASE re-query. Edit-saves invalidate the cache via
       * `invalidateStatusCounts()` in the modal's onSaved callback below,
       * so post-mutation counts always refresh.
       */
      const cachedCounts = readStatusCountsFromCache();
      if (cachedCounts) {
        setStatusCounts(cachedCounts);
      } else {
        void api
          .get<StatusCountsResp>('/admin/easyfixers/status-counts')
          .then((c) => { writeStatusCountsToCache(c); setStatusCounts(c); })
          .catch(() => { /* keep prior counts on failure */ });
      }

      const r = await fetchListOnce({
        limit, offset,
        ...buildQuery(f),
      });
      const enriched: EnrichedEf[] = r.items.map((e) => ({
        ...e,
        _aggregatesLoaded: false,
        _attendanceLoaded: false,
      }));
      setRows(enriched);
      setTotal(r.total);
      if (reset) setPage(0);
      // Phase 2 — fan out aggregates + attendance in parallel. Fire and
      // forget; merge as each resolves. We capture the id list NOW so a
      // subsequent page change doesn't merge stale results into the
      // wrong rows (the id-based merge already self-guards against
      // that, but explicit capture avoids any ambiguity).
      const efrIds = enriched.map((e) => e.efr_id);
      if (efrIds.length > 0) {
        // Aggregates: consult the 60s client-side cache first. Apply cached
        // values SYNCHRONOUSLY so already-seen rows fill in instantly (no
        // network round-trip, no "…" placeholder flash). Only POST for the
        // efrIds that weren't cached or whose entry has expired.
        const { cached, missing } = readAggregatesFromCache(efrIds);
        if (cached.length > 0) {
          const map = new Map(cached.map((a) => [a.efr_id, a]));
          setRows((prev) => prev.map((row) => {
            const agg = map.get(row.efr_id);
            if (!agg) return row;
            return {
              ...row,
              clients_mapped: agg.clients_mapped,
              total_earnings: agg.total_earnings,
              job_count: agg.job_count,
              avg_rating: agg.avg_rating,
              _aggregatesLoaded: true,
            };
          }));
        }
        if (missing.length > 0) {
          void api
            .post<{ rows: AggregateRow[] }>('/admin/easyfixers/aggregates', { efrIds: missing })
            .then((resp) => {
              // Persist into the module-level cache so a later page-flip
              // / search-back picks them up instantly.
              writeAggregatesToCache(resp.rows);
              const map = new Map(resp.rows.map((a) => [a.efr_id, a]));
              setRows((prev) => prev.map((row) => {
                // Only flip rows that were in the `missing` set this call.
                // Cached rows were already flipped synchronously above; rows
                // outside the current page aren't touched.
                if (!missing.includes(row.efr_id)) return row;
                const agg = map.get(row.efr_id);
                if (!agg) return { ...row, _aggregatesLoaded: true };
                return {
                  ...row,
                  clients_mapped: agg.clients_mapped,
                  total_earnings: agg.total_earnings,
                  job_count: agg.job_count,
                  avg_rating: agg.avg_rating,
                  _aggregatesLoaded: true,
                };
              }));
            })
            .catch(() => { /* keep placeholders on failure */ });
        }
        void api
          .post<{ rows: AttendanceRow[] }>('/admin/easyfixers/attendance', { efrIds })
          .then((resp) => {
            const map = new Map(resp.rows.map((a) => [a.efr_id, a]));
            setRows((prev) => prev.map((row) => {
              const att = map.get(row.efr_id);
              if (!att) return { ...row, _attendanceLoaded: true };
              return {
                ...row,
                att_is_leave_marked: att.att_is_leave_marked,
                att_morning_slot: att.att_morning_slot,
                att_evening_slot: att.att_evening_slot,
                att_created_on: att.att_created_on,
                _attendanceLoaded: true,
              };
            }));
          })
          .catch(() => { /* keep placeholders on failure */ });
      }
    } finally { setLoading(false); }
  }

  // SINGLE initial-mount effect. React StrictMode double-fires this in
  // dev but the module-level `fetchListOnce` collapses the two
  // concurrent calls into one network request. Pagination + search
  // call `load()` directly through their own handlers.
  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-shot lookups for filters not in useLookup(). Each fetcher is a
  // module-level deduped promise — StrictMode's double-mount collapses to
  // a single network request per endpoint.
  useEffect(() => {
    let cancelled = false;
    fetchZonalManagersOnce().then((d) => { if (!cancelled) setZonalManagers(d); }).catch(() => {});
    fetchDeepSkillsOnce().then((d) => { if (!cancelled) setDeepSkills(d); }).catch(() => {});
    fetchServiceTypesAllOnce().then((d) => { if (!cancelled) setServiceTypesAll(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // When a Service Category is chosen we narrow Service Types to that category.
  const serviceTypeOpts = (() => {
    const list = serviceTypesAll.length ? serviceTypesAll : lk.serviceTypes;
    if (!filters.serviceCategory) return list;
    // Match by category name → id (filters.serviceCategory holds the category NAME,
    // matching the existing BE contract for `serviceCategory`).
    const cat = lk.serviceCategories.find((c) => c.service_catg_name === filters.serviceCategory);
    if (!cat) return list;
    return list.filter((t) => t.service_catg_id === cat.service_catg_id);
  })();

  function onSearch() { setPage(0); load(true); }
  function onReset() {
    setPage(0);
    setFilters(DEFAULT_FILTERS);
    load(true, DEFAULT_FILTERS);
  }

  function onPageChange(nextPage: number) {
    setPage(nextPage);
    load(false, undefined, nextPage);
  }

  function onPageSizeChange(nextSize: TablePageSize) {
    setPageSize(nextSize);
    setPage(0);
    load(false, undefined, 0, nextSize);
  }

  async function onDownload() {
    setDownloading(true);
    try {
      const params = new URLSearchParams();
      const q = buildQuery(filters);
      Object.entries(q).forEach(([k, v]) => { if (v !== undefined && v !== '') params.set(k, String(v)); });
      await downloadXlsx({
        url: `/admin/easyfixers/download${params.toString() ? `?${params.toString()}` : ''}`,
        filename: `easyfixers-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
    } catch (e) {
      // Surface a minimal error — operators already see browser-level
      // download failure UI; this is a best-effort backstop.
      console.error('Download failed', e);
      alert(`Download failed: ${(e as Error).message || 'Unknown error'}`);
    } finally { setDownloading(false); }
  }

  const { sorted, sortKey, sortDir, toggle } = useSort<EnrichedEf>(rows);

  /*
   * Service Category / Service Type CSV cell helpers.
   *
   * The BE stores these as comma-separated id strings on tbl_easyfixer
   * (efr_service_category / efr_service_type). The legacy page displayed
   * the raw IDs which was unusable — issue 3 asks us to:
   *   1. Map ids → names via the loaded lookups
   *   2. Show "<First Name> (Id: <First Id>) +K" where K is the remaining count
   *   3. Native tooltip = full comma list
   *   4. Click cell → CsvCellModal with search
   *
   * Memoised lookup maps so we don't rebuild them on every row render.
   */
  const categoryById = useMemo(() => {
    const m = new Map<string, string>();
    lk.serviceCategories.forEach((c) => m.set(String(c.service_catg_id), c.service_catg_name));
    return m;
  }, [lk.serviceCategories]);

  const serviceTypeById = useMemo(() => {
    const list = serviceTypesAll.length ? serviceTypesAll : lk.serviceTypes;
    const m = new Map<string, string>();
    list.forEach((t) => m.set(String(t.service_type_id), t.service_type_name));
    return m;
  }, [serviceTypesAll, lk.serviceTypes]);

  function parseCsvCell(raw: string | null | undefined, lookup: Map<string, string>): CsvCellItem[] {
    if (!raw) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => ({ id, name: lookup.get(id) ?? `Unknown (${id})` }));
  }

  function openCsvModal(title: string, items: CsvCellItem[]) {
    if (items.length === 0) return;
    setCsvCell({ open: true, title, items });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Easyfixers</h1>
          {/*
            * Status-counts strip (2026-06-08). Replaces the bare
            * "{total} technicians" subtitle with a one-click filter
            * shortcut for each of the 6 status buckets. Clicking a
            * count sets the Status filter to that bucket and triggers
            * a load() — matches what the dropdown click does.
            * Each count comes from a single BE GET that runs alongside
            * the base list, so the strip stays in sync after edits.
            */}
          {statusCounts ? (
            <StatusCountsStrip
              counts={statusCounts}
              activeStatus={filters.status}
              onPick={(s) => {
                const next = { ...filters, status: s };
                setFilters(next);
                setPage(0);
                load(true, next, 0);
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{loading ? '…' : total.toLocaleString()} technicians</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {can.isAddNew && (
            <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> Add New Easyfixer</Button>
          )}
          <DownloadButton onClick={onDownload} downloading={downloading} />
        </div>
      </div>

      {/* Filter Parameter card — always visible (no toggle). */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="text-sm font-medium flex items-center gap-1.5">
            <Search className="h-4 w-4 text-muted-foreground" /> Filter Parameter
          </div>

          {/* Row 1 */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <Field label="Easyfixer Id">
              <Input
                inputMode="numeric"
                placeholder="Easyfixer Id"
                value={filters.easyfixerId}
                onChange={(e) => setFilters({ ...filters, easyfixerId: e.target.value.replace(/[^0-9]/g, '') })}
              />
            </Field>
            <Field label="Name">
              <Input
                placeholder="Name"
                value={filters.name}
                onChange={(e) => setFilters({ ...filters, name: e.target.value })}
              />
            </Field>
            <Field label="Mobile No">
              <Input
                inputMode="numeric"
                placeholder="Mobile No"
                value={filters.mobileNo}
                onChange={(e) => setFilters({ ...filters, mobileNo: e.target.value.replace(/[^0-9]/g, '') })}
              />
            </Field>
            <Field label="EF Account">
              <SearchSelect
                placeholder="All"
                value={filters.efAccount}
                onChange={(v) => setFilters({ ...filters, efAccount: v })}
                options={[
                  { value: 'under_master', label: 'Under Master' },
                  { value: 'master', label: 'Master' },
                  { value: 'individual', label: 'Individual' },
                ]}
              />
            </Field>
            <Field label="Status">
              {/*
                * 6-status enum (2026-06-08) — matches legacy CRM dropdown.
                * Value=0 is "All". Default selection is '1' (Active) set
                * in DEFAULT_FILTERS. The BE applies a priority-aware
                * WHERE clause per value (see easyfixer.service.js list()).
                */}
              <SearchSelect
                placeholder="All"
                value={filters.status}
                onChange={(v) => setFilters({ ...filters, status: v })}
                options={[
                  { value: '1', label: 'Active' },
                  { value: '2', label: 'Inactive' },
                  { value: '3', label: 'Idle' },
                  { value: '4', label: 'Not Eligible' },
                  { value: '5', label: 'Not Suitable' },
                  { value: '6', label: 'Registration In Progress' },
                ]}
              />
            </Field>
          </div>

          {/* Row 2 */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <Field label="State">
              <SearchSelect
                placeholder="All"
                value={filters.stateId}
                onChange={(v) => setFilters({ ...filters, stateId: v })}
                options={lk.toOpts.states.map((o) => ({ value: o.value, label: String(o.label) }))}
              />
            </Field>
            <Field label="City">
              <SearchSelect
                placeholder="All"
                value={filters.cityId}
                onChange={(v) => setFilters({ ...filters, cityId: v })}
                options={lk.toOpts.cities.map((o) => ({ value: o.value, label: String(o.label) }))}
              />
            </Field>
            <Field label="Service Category">
              <SearchSelect
                placeholder="All"
                value={filters.serviceCategory}
                onChange={(v) => setFilters({ ...filters, serviceCategory: v, serviceType: '' })}
                options={lk.serviceCategories.map((c) => ({ value: c.service_catg_name, label: c.service_catg_name }))}
              />
            </Field>
            <Field label="Service Type">
              <SearchSelect
                placeholder="All"
                value={filters.serviceType}
                onChange={(v) => setFilters({ ...filters, serviceType: v })}
                options={serviceTypeOpts.map((t) => ({ value: t.service_type_name, label: t.service_type_name }))}
              />
            </Field>
            <Field label="Deep Skill">
              <SearchSelect
                placeholder="All"
                value={filters.deepSkillId}
                onChange={(v) => setFilters({ ...filters, deepSkillId: v })}
                options={deepSkills.map((d) => ({ value: d.deep_skill_id, label: d.deep_skill_name }))}
              />
            </Field>
          </div>

          {/* Row 3 */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            {/*
             * Active Date Range — the twin <input type="date"> controls
             * used to overflow their grid cell, letting the to-date sit
             * visually behind the adjacent Zonal Manager SearchSelect
             * trigger. Fix (issue 2): wrap in a relative `min-w-0`
             * container that `flex-wrap`s so the two inputs stack on
             * narrow widths instead of leaking into the next column.
             */}
            <Field label="Active Date Range">
              <div className="relative z-0 min-w-0 flex flex-wrap gap-1">
                <Input
                  type="date"
                  className="min-w-0 flex-1"
                  value={filters.activeFromDate}
                  onChange={(e) => setFilters({ ...filters, activeFromDate: e.target.value })}
                />
                <Input
                  type="date"
                  className="min-w-0 flex-1"
                  value={filters.activeToDate}
                  onChange={(e) => setFilters({ ...filters, activeToDate: e.target.value })}
                />
              </div>
            </Field>
            <Field label="Zonal Manager">
              <div className="relative">
                <SearchSelect
                  placeholder="All"
                  value={filters.zonalManagerId}
                  onChange={(v) => setFilters({ ...filters, zonalManagerId: v })}
                  options={zonalManagers.map((z) => ({ value: z.user_id, label: z.user_name }))}
                />
              </div>
            </Field>
            <Field label="Attendance">
              <SearchSelect
                placeholder="All"
                value={filters.attendance}
                onChange={(v) => setFilters({ ...filters, attendance: v })}
                options={[
                  { value: 'present', label: 'Present' },
                  { value: 'absent', label: 'Absent' },
                  { value: 'on_leave', label: 'On Leave' },
                  { value: 'no_information', label: 'No Information' },
                ]}
              />
            </Field>
            <Field label="DeepSkill Mapped">
              <SearchSelect
                placeholder="Mapped To DS"
                value={filters.deepSkillMapped}
                onChange={(v) => setFilters({ ...filters, deepSkillMapped: v })}
                options={[
                  { value: 'mapped', label: 'Mapped To DS' },
                  { value: 'not_mapped', label: 'Not Mapped To DS' },
                ]}
              />
            </Field>
            <div className="flex items-end gap-2">
              <Button type="button" onClick={onSearch} disabled={loading}>
                <Search className="h-4 w-4 mr-1" /> Search
              </Button>
              <Button type="button" variant="outline" onClick={onReset}>Reset</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/*
        * Unified table card (2026-06-08). Manage Users uses a no-scroll
        * narrow table because it has 8 columns; Manage Easyfixers has
        * 20 — squeezing them all into a single viewport width turns
        * every cell into 60-80px ellipsis-soup AND leaves no room for
        * the 4-icon Action menu (which needs ~130px to render without
        * wrapping).
        *
        * Layout pattern (matches the legacy CRM behaviour for dense
        * 15+ column admin tables — see Jobs list for prior art):
        *   - `overflow-x-auto` on the table-wrapping div so the table
        *     scrolls horizontally when it exceeds viewport width.
        *   - The table itself has an explicit min-width via colgroup
        *     px values that sum to ~2260px. Columns get readable widths;
        *     content-heavy cells (Email, Name, Service Cat/Type) get
        *     extra room.
        *   - `.stick-col` / `.stick-left` / `.stick-right` (defined in
        *     globals.css) pin the ID column to the left viewport edge
        *     and the Action column to the right, with subtle inset
        *     shadows hinting "more content exists beyond this edge".
        *     Operators never lose context — they can see WHICH row
        *     they're scrolling across AND act on it from the right.
        *
        * TablePagination still lives INSIDE the same Card as a footer
        * band — that part stays.
        */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          {/*
            * Manage-Easyfixers list table (2026-06-08). Visual + behaviour
            * parity with the Manage Users table pattern:
            *   - `data-table w-full` + `tableLayout: 'fixed'` so columns
            *     don't auto-size to the widest cell (which made the table
            *     scroll horizontally past the viewport on 20 columns).
            *   - `<colgroup>` with explicit percentage widths that sum to
            *     ~100% — wider for content-heavy cells (Name, Email,
            *     Service Cat/Type), narrower for numeric / status cells.
            *   - Cell content uses `truncate` + `title=` so overflowing
            *     text gets an ellipsis with the full value on hover.
            *   - SortHeader rendered with `align` so the header aligns to
            *     the cell content direction.
            */}
          <table className="data-table" style={{ tableLayout: 'fixed', minWidth: '2260px' }}>
            {/*
              * Explicit px widths (not percentages) so the table has a
              * deterministic intrinsic width that exceeds the viewport,
              * triggering horizontal scroll via the wrapping
              * `overflow-x-auto` div. Sticky ID + Action cols pin to
              * viewport edges; everything else scrolls between them.
              *
              * Sum of widths = 2260px. Content-heavy cells (Name,
              * Email, Service Cat/Type) get the lion's share; numeric
              * + status cells stay narrow.
              */}
            <colgroup>
              <col style={{ width: '70px'  }} />{/* ID — sticky-left */}
              <col style={{ width: '160px' }} />{/* Name */}
              <col style={{ width: '130px' }} />{/* User Mapped To City */}
              <col style={{ width: '130px' }} />{/* EF Account */}
              <col style={{ width: '110px' }} />{/* State */}
              <col style={{ width: '110px' }} />{/* City */}
              <col style={{ width: '110px' }} />{/* Mobile */}
              <col style={{ width: '200px' }} />{/* Email */}
              <col style={{ width: '140px' }} />{/* Service Category */}
              <col style={{ width: '140px' }} />{/* Service Type */}
              <col style={{ width: '90px'  }} />{/* Clients Mapped */}
              <col style={{ width: '110px' }} />{/* Total Earnings */}
              <col style={{ width: '80px'  }} />{/* Job Count */}
              <col style={{ width: '110px' }} />{/* A/C Balance */}
              <col style={{ width: '80px'  }} />{/* Rating */}
              <col style={{ width: '80px'  }} />{/* Profile % */}
              <col style={{ width: '70px'  }} />{/* Verified */}
              <col style={{ width: '120px' }} />{/* Registered */}
              <col style={{ width: '90px'  }} />{/* Status */}
              <col style={{ width: '130px' }} />{/* Action — sticky-right */}
            </colgroup>
            <thead>
              <tr>
                <SortHeader col="efr_id"                 align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="stick-col-head stick-left">ID</SortHeader>
                <SortHeader col="efr_name"               align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Name</SortHeader>
                <SortHeader col="user_mapped_to_city"    align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>User Mapped To City</SortHeader>
                <SortHeader col="ef_account"             align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>EF Account</SortHeader>
                <SortHeader col="state_name"             align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>State</SortHeader>
                <SortHeader col="city_name"              align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>City</SortHeader>
                <SortHeader col="efr_no"                 align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Mobile</SortHeader>
                <SortHeader col="efr_email"              align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Email</SortHeader>
                <SortHeader col="efr_service_category"   align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Service Category</SortHeader>
                <SortHeader col="efr_service_type"       align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Service Type</SortHeader>
                <SortHeader col="clients_mapped"         align="right"  sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Clients Mapped</SortHeader>
                <SortHeader col="total_earnings"         align="right"  sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Total Earnings</SortHeader>
                <SortHeader col="job_count"              align="right"  sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Job Count</SortHeader>
                <SortHeader col="current_balance"        align="right"  sortBy={sortKey} sortDir={sortDir} onSort={toggle}>A/C Balance</SortHeader>
                <SortHeader col="avg_rating"             align="right"  sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Rating</SortHeader>
                <SortHeader col="efr_profile_perc"       align="right"  sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Profile %</SortHeader>
                <SortHeader col="is_technician_verified" align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Verified</SortHeader>
                <SortHeader col="insert_date"            align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Registered</SortHeader>
                <SortHeader col="efr_status_label"       align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap stick-col-head stick-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {/* Manage-Users semantic: keep existing rows visible during
                  a refetch so the table doesn't flash empty during the
                  200ms server round-trip — only show "Loading…" on the
                  cold first paint when there's nothing to keep. */}
              {loading && sorted.length === 0 && (
                <tr><td colSpan={20} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && sorted.length === 0 && (
                <tr><td colSpan={20} className="!text-center text-muted-foreground py-6">No easyfixers match the current filters.</td></tr>
              )}
              {!loading && sorted.map((e) => {
                const catItems = parseCsvCell(e.efr_service_category, categoryById);
                const typeItems = parseCsvCell(e.efr_service_type, serviceTypeById);
                const efName = formatEasyfixerName(e.efr_name);
                return (
                <tr key={e.efr_id}>
                  <td className="!text-center font-mono text-xs truncate stick-col stick-left">{e.efr_id}</td>
                  <td className="!text-left font-medium truncate" title={efName}>{efName}</td>
                  <td className="!text-left truncate" title={e.user_mapped_to_city ?? ''}>{e.user_mapped_to_city ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left truncate">{e.ef_account ? <StatusChip tone={efAccountTone(e.ef_account)} size="sm">{e.ef_account}</StatusChip> : <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left truncate" title={e.state_name ?? ''}>{e.state_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left truncate" title={e.city_name ?? ''}>{e.city_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left font-mono text-xs truncate" title={e.efr_no}>{e.efr_no}</td>
                  <td className="!text-left text-xs truncate" title={e.efr_email ?? ''}>{e.efr_email ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left text-xs truncate">
                    <CsvCellButton
                      items={catItems}
                      onOpen={() => openCsvModal(`Service Categories — ${efName}`, catItems)}
                    />
                  </td>
                  <td className="!text-left text-xs truncate">
                    <CsvCellButton
                      items={typeItems}
                      onOpen={() => openCsvModal(`Service Types — ${efName}`, typeItems)}
                    />
                  </td>
                  <td className="!text-right tabular-nums truncate">
                    {e._aggregatesLoaded
                      ? (e.clients_mapped ?? 0)
                      : <span className="text-muted-foreground">…</span>}
                  </td>
                  <td className="!text-right tabular-nums truncate">
                    {e._aggregatesLoaded
                      ? (e.total_earnings != null ? `₹${Number(e.total_earnings).toLocaleString('en-IN')}` : '—')
                      : <span className="text-muted-foreground">…</span>}
                  </td>
                  <td className="!text-right tabular-nums truncate">
                    {e._aggregatesLoaded
                      ? (e.job_count ?? 0)
                      : <span className="text-muted-foreground">…</span>}
                  </td>
                  <td className="!text-right tabular-nums truncate">{e.current_balance != null ? `₹${Number(e.current_balance).toLocaleString('en-IN')}` : '—'}</td>
                  <td className="!text-right tabular-nums truncate">
                    {e._aggregatesLoaded
                      ? (e.avg_rating != null ? `${Number(e.avg_rating).toFixed(1)} ★` : '—')
                      : <span className="text-muted-foreground">…</span>}
                  </td>
                  <td className="!text-right text-xs tabular-nums truncate">{e.efr_profile_perc != null ? `${Math.round(Number(e.efr_profile_perc))}%` : '—'}</td>
                  <td className="!text-center truncate">{e.is_technician_verified ? '✓' : <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left text-xs whitespace-nowrap text-muted-foreground truncate" title={formatDate(e.insert_date)}>{formatDate(e.insert_date)}</td>
                  <td className="!text-center truncate">
                    {e.efr_status_label
                      ? <StatusChip tone={statusLabelTone(e.efr_status_label)} size="sm">{e.efr_status_label}</StatusChip>
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-right stick-col stick-right">
                    <EasyfixerActionMenu
                      easyfixer={{ efr_id: e.efr_id, efr_name: e.efr_name }}
                      canEdit={!!can.isEdit}
                      onEdit={() => router.push(`/easyfixers/${e.efr_id}/verification`)}
                      onClientMapping={() => setClientMappingFor(e)}
                      onTransactions={() => setTransactionsFor(e)}
                      onAssessment={() => router.push('/coming-soon')}
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {/*
            * Pagination footer — lives inside the same Card as the table
            * so the whole list reads as one cohesive component (matches
            * the Manage Users pattern). `border-t` provides the visual
            * footer divider; `p-3` matches the filter-card padding so
            * the band heights line up visually.
            */}
          {total > 0 && (
            <div className="border-t p-3">
              <TablePagination
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={onPageChange}
                onPageSizeChange={onPageSizeChange}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <EasyfixerModal
        open={modal.open}
        mode={modal.mode}
        easyfixerId={modal.id}
        onClose={closeModal}
        onSaved={() => { invalidateStatusCounts(); load(true); }}
      />

      <CsvCellModal
        open={csvCell.open}
        onClose={() => setCsvCell((s) => ({ ...s, open: false }))}
        title={csvCell.title}
        items={csvCell.items}
      />

      <EasyfixerClientMappingModal
        open={clientMappingFor != null}
        onClose={() => setClientMappingFor(null)}
        easyfixerId={clientMappingFor?.efr_id ?? null}
        easyfixerName={clientMappingFor?.efr_name ?? null}
      />

      <EasyfixerTransactionsModal
        open={transactionsFor != null}
        onClose={() => setTransactionsFor(null)}
        easyfixerId={transactionsFor?.efr_id ?? null}
        easyfixerName={transactionsFor?.efr_name ?? null}
        easyfixerMobile={transactionsFor?.efr_no ?? null}
      />

    </div>
  );
}

/*
 * Small label+control wrapper — keeps the 3-row filter grid visually tidy
 * with consistent label spacing without pulling in a heavier <Label>
 * component.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 min-w-0">
      <div className="text-xs font-medium text-muted-foreground whitespace-nowrap">{label}</div>
      {children}
    </div>
  );
}

/*
 * CsvCellButton — renders "<First Name> (Id: <First Id>) +K" with native
 * tooltip + click-to-expand. Stays a tiny inline button so the table
 * density doesn't grow.
 *
 * `+K` is only shown when there are 2+ items; a single-item cell renders
 * just "<Name> (Id: <Id>)" without trailing noise.
 */
function CsvCellButton({ items, onOpen }: { items: CsvCellItem[]; onOpen: () => void }) {
  if (items.length === 0) return <span className="text-muted-foreground">—</span>;
  const first = items[0];
  const more = items.length - 1;
  const full = items.map((i) => `${i.name} (Id: ${i.id})`).join(', ');
  return (
    <button
      type="button"
      onClick={onOpen}
      title={full}
      className="text-left text-xs hover:underline hover:text-primary truncate max-w-[18rem] inline-flex items-center gap-1"
    >
      <span className="truncate">
        {first.name} <span className="text-muted-foreground">(Id: {first.id})</span>
      </span>
      {more > 0 && (
        <span className="text-[10px] font-medium rounded bg-muted px-1.5 py-0.5 text-muted-foreground shrink-0">
          +{more}
        </span>
      )}
    </button>
  );
}

/*
 * StatusCountsStrip — clickable inline counts strip that replaces the
 * bare "{total} technicians" subtitle. Each entry shows the count for
 * one of the 6 dropdown filter values; clicking it sets the Status
 * filter to that value and reloads. Matches the legacy CRM's "filter
 * by status with one click from the header" affordance.
 *
 * Tones mirror the in-row StatusChip palette: emerald for Active,
 * slate for Inactive/Idle, sky for Reg In Progress, red for Not
 * Eligible, amber for Not Suitable. The dot before each count is
 * the only colour-coded element so the strip stays scannable in a
 * single line.
 */
function StatusCountsStrip({
  counts,
  activeStatus,
  onPick,
}: {
  counts: StatusCountsResp;
  /*
   * Currently-selected dropdown value ('1'..'6' or ''). When it matches
   * an entry's value, that entry renders BOLD with a fully-filled,
   * slightly larger dot — a non-intrusive way for the operator to see
   * which status is currently filtering the list without having to look
   * down at the dropdown.
   */
  activeStatus: string;
  onPick: (statusValue: string) => void;
}) {
  const items: Array<{ key: keyof StatusCountsResp; label: string; value: string; dot: string; ring: string }> = [
    { key: 'active',          label: 'Active',                   value: '1', dot: 'bg-emerald-500', ring: 'ring-emerald-500/30' },
    { key: 'inactive',        label: 'Inactive',                 value: '2', dot: 'bg-slate-500',   ring: 'ring-slate-500/30' },
    { key: 'idle',            label: 'Idle',                     value: '3', dot: 'bg-slate-400',   ring: 'ring-slate-400/30' },
    { key: 'not_eligible',    label: 'Not Eligible',             value: '4', dot: 'bg-red-500',     ring: 'ring-red-500/30' },
    { key: 'not_suitable',    label: 'Not Suitable',             value: '5', dot: 'bg-amber-500',   ring: 'ring-amber-500/30' },
    { key: 'reg_in_progress', label: 'Registration In Progress', value: '6', dot: 'bg-sky-500',     ring: 'ring-sky-500/30' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1">
      {items.map((it, i) => {
        const isActive = activeStatus === it.value;
        return (
          <span key={it.key} className="inline-flex items-center gap-2">
            {i > 0 && <span className="text-muted-foreground/50">·</span>}
            <button
              type="button"
              onClick={() => onPick(it.value)}
              /*
               * Active state — bold text + slightly enlarged solid dot
               * with a subtle ring halo. Inactive entries keep the
               * default muted appearance + the small dot. Hover still
               * grows the dot + underlines the label on both states.
               */
              className={cn(
                'inline-flex items-center gap-1.5 transition-colors group',
                isActive ? 'text-foreground font-semibold' : 'hover:text-foreground',
              )}
              title={`Filter list by "${it.label}"${isActive ? ' (currently active)' : ''}`}
              aria-pressed={isActive}
            >
              <span className={cn(
                'inline-block rounded-full transition-all',
                it.dot,
                isActive
                  ? `size-2 ring-2 ${it.ring}`
                  : 'size-1.5 group-hover:size-2',
              )} />
              <span className="tabular-nums">{Number(counts[it.key]).toLocaleString('en-IN')}</span>
              <span className={cn(!isActive && 'group-hover:underline')}>{it.label}</span>
            </button>
          </span>
        );
      })}
    </div>
  );
}
