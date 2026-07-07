'use client';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Search, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { SearchSelect } from '@/components/ui/search-select';
import { CitySelect } from '@/components/ui/city-select';
import { DownloadButton } from '@/components/ui/download-button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { CsvCellModal, type CsvCellItem } from '@/components/ui/CsvCellModal';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { api, ApiError } from '@/lib/api';
import { showToast } from '@/components/ui/toast';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useLookup } from '@/lib/use-lookup';
import { cn, formatDate, formatEasyfixerName } from '@/lib/utils';
import { maskMobile } from '@/lib/format';
import { EasyfixerModal, type EasyfixerModalMode } from '@/components/easyfixer/EasyfixerModal';
import { EasyfixerActionMenu } from '@/components/easyfixer/EasyfixerActionMenu';
import { EasyfixerTransactionsModal } from '@/components/easyfixer/EasyfixerTransactionsModal';
import { EasyfixerClientMappingModal } from '@/components/easyfixer/EasyfixerClientMappingModal';
import { EasyfixerDeepSkillModal } from '@/components/easyfixer/EasyfixerDeepSkillModal';
import { LiveLocationPopover } from '@/components/location/LiveLocationPopover';
import { cycleSort, SortHeader, type SortDir } from '@/lib/use-sort';
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
  job_count: number; // completed jobs (status 3/5); < 5 => "Fresher" chip
  avg_rating: number | null;
  options_mapped_count: number;
  ef_account: 'Under Master' | 'Master' | 'Individual';
  att_is_leave_marked: number | null;
  att_morning_slot: number | null;
  att_evening_slot: number | null;
  att_created_on: string | null;
  /*
   * Profile-update magic-link audit (2026-06-11). Surfaced via the
   * aggregates POST; rendered in the "Last Link Sent" column so
   * operators see who's been pinged and how many times. Nullable until
   * the first send (per the migration default of 0/NULL).
   */
  profile_update_sent_at: string | null;
  profile_update_send_count: number;
  serviceable_pincodes_csv?: string;
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
  options_mapped_count: number;
  // Profile-update magic-link audit (2026-06-11).
  profile_update_sent_at: string | null;
  profile_update_send_count: number;
  serviceable_pincodes_csv: string;
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
type ServiceCategory = { service_catg_id: number; service_catg_name: string };
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
  deepSkillMapped: '',   // '' = All (no filter) | mapped | not_mapped
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
 * Pure CSV-cell parser (module scope so memoised rows keep a stable
 * reference) — maps a comma-separated id string to {id, name} items via
 * the supplied lookup Map. See the CSV cell helper comment inside the
 * component for the display contract.
 */
function parseCsvCell(raw: string | null | undefined, lookup: Map<string, string>): CsvCellItem[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: lookup.get(id) ?? `Unknown (${id})` }));
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
let serviceCategoriesAllPromise: Promise<ServiceCategory[]> | null = null;

/*
 * Module-level in-flight collapse for the LIST call itself.
 *
 * React StrictMode mounts the page twice in dev, firing `load(true)`
 * twice on the same tick — both hit `/admin/easyfixers` and both wait
 * 20s+ for the legacy slow query, doubling the network footprint. The
 * dedupe is PARAM-KEYED: only concurrent IDENTICAL calls (same filters
 * + pagination — StrictMode's double-mount) collapse into one request.
 * A call with DIFFERENT params (Search with new filters, page flip,
 * status-chip click while a slow load is still in flight) fires its own
 * request immediately instead of being served the stale in-flight
 * response. Stale responses are additionally discarded in the component
 * via the `loadSeqRef` sequence counter so a superseded load() can't
 * clobber newer state. The in-flight entry is cleared in .finally() so
 * nothing memoises across the session.
 *
 * JSON.stringify is a safe key here because every call site builds the
 * params object with identical literal key order
 * (`{ limit, offset, ...buildQuery(f) }`).
 */
let listInflight: { key: string; promise: Promise<Resp> } | null = null;
function fetchListOnce(params: Record<string, string | number | undefined>): Promise<Resp> {
  const key = JSON.stringify(params);
  if (listInflight && listInflight.key === key) return listInflight.promise;
  const promise = api.get<Resp>('/admin/easyfixers', params).finally(() => {
    if (listInflight && listInflight.key === key) listInflight = null;
  });
  listInflight = { key, promise };
  return promise;
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
  // includeInactive=true: this list is the id→name map for the Service Type
  // column. A tech's efr_service_type CSV can reference service types that were
  // later DEACTIVATED (service_type_status=0); the default active-only lookup
  // omits them, so those ids rendered as "Unknown (<id>)" even though they have
  // a real name. Fetching inactive types too lets the column name any type that
  // still exists. (Cache key bumped to 'stAll' so stale active-only caches from
  // the previous behaviour don't shadow this.)
  const cached = readSession<ServiceType[]>('stAll');
  if (cached) {
    serviceTypesAllPromise = Promise.resolve(cached);
    return serviceTypesAllPromise;
  }
  serviceTypesAllPromise = api
    .get<ServiceType[]>('/shared/lookup/service-types?includeInactive=true')
    .then((data) => { writeSession('stAll', data); return data; })
    .catch((e) => { serviceTypesAllPromise = null; throw e; });
  return serviceTypesAllPromise;
}

function fetchServiceCategoriesAllOnce(): Promise<ServiceCategory[]> {
  if (serviceCategoriesAllPromise) return serviceCategoriesAllPromise;
  // includeInactive=true — same rationale as service types: this list is the
  // id→name map for the Service Category column, and a tech's
  // efr_service_category CSV can reference DEACTIVATED categories that the
  // default active-only lookup omits (rendering them as "Unknown (<id>)").
  const cached = readSession<ServiceCategory[]>('scAll');
  if (cached) {
    serviceCategoriesAllPromise = Promise.resolve(cached);
    return serviceCategoriesAllPromise;
  }
  serviceCategoriesAllPromise = api
    .get<ServiceCategory[]>('/shared/lookup/service-categories?includeInactive=true')
    .then((data) => { writeSession('scAll', data); return data; })
    .catch((e) => { serviceCategoriesAllPromise = null; throw e; });
  return serviceCategoriesAllPromise;
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
  const can = actionFlags(me, ['isAddNew', 'isEdit', 'isProfileUpdateLinkSend']);
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
  // Server-side sort (2026-06-17). sortKey=null => BE default order (efr_id
  // DESC). A column click reloads the COMPLETE filtered list sorted on the
  // server, not just the current page.
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // Monotonic sequence per load() call — a superseded load (older seq)
  // discards its response instead of clobbering newer rows/total state.
  const loadSeqRef = useRef(0);

  // Inline lookups not exposed by useLookup() (we keep that hook untouched
  // per the strict file-scope rule and fetch these one-time on mount).
  const [zonalManagers, setZonalManagers] = useState<ZonalManager[]>([]);
  const [deepSkills, setDeepSkills] = useState<DeepSkill[]>([]);
  const [serviceTypesAll, setServiceTypesAll] = useState<ServiceType[]>([]);
  const [serviceCategoriesAll, setServiceCategoriesAll] = useState<ServiceCategory[]>([]);

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
  const [deepSkillFor, setDeepSkillFor] = useState<Ef | null>(null);
  // Live technician-location popover target (null = closed). Polls
  // GET /admin/easyfixers/:id/location every 15s while open.
  const [locationFor, setLocationFor] = useState<Ef | null>(null);
  /*
   * Per-row spinner state for the "Send Profile Update Link" action.
   * Tracks efr_ids whose POST is currently in flight so multiple rows
   * can be in flight concurrently without one row's spinner masking
   * another's. The row-level menu reads this via `isSending` and shows
   * a Loader2 in place of the Send icon until the POST resolves.
   */
  const [sendingFor, setSendingFor] = useState<Set<number>>(new Set());
  // Per-row loading state for the dev-only "Copy Dev URL" action. Same
  // Set<number>-of-efr_ids pattern as `sendingFor` so the menu can show
  // a spinner without coupling to the broader page state.
  const [copyingDevUrlFor, setCopyingDevUrlFor] = useState<Set<number>>(new Set());
  /*
   * "Send To" confirmation dialog (2026-06-10).
   *
   * Replaces the direct POST on action-menu click with an environment-aware
   * confirmation step:
   *   - Production: dialog shows the technician's real mobile MASKED with
   *     the input DISABLED. Operator just confirms.
   *   - Non-prod (dev/staging): dialog prefills the real mobile but lets
   *     the operator OVERRIDE it (test against their own WhatsApp number).
   * The BE Joi schema rejects `override_mobile` outright in production
   * (custom production-block rule) so this isn't security boundary — it's
   * a UX guard to prevent accidental pings to real technicians while
   * QA / staging testing.
   */
  const [sendDialogFor, setSendDialogFor] = useState<Ef | null>(null);
  /*
   * Environment detection — uses the same `process.env.NODE_ENV` pattern
   * already established for the QuickSight URL split in Navbar.tsx. Next.js
   * inlines NODE_ENV at build time so this is a static branch in the
   * compiled bundle (production builds will never see the override path).
   */
  const isProd = process.env.NODE_ENV === 'production';

  const openSendDialog = useCallback((e: Ef) => {
    /*
     * Defer the Dialog open by one macrotask (2026-06-11). Classic
     * Radix DropdownMenu → Dialog race: the DropdownMenuItem's onClick
     * fires + sets `sendDialogFor`, which mounts the Dialog. The
     * dropdown then auto-closes — and the pointer-up event that closed
     * it is what Radix's <Dialog> interprets as a "pointer down outside"
     * event for the just-mounted Dialog, calling `onOpenChange(false)`
     * → instant dismiss.
     *
     * setTimeout(..., 0) schedules the state update for the next
     * event-loop tick, by which time the dropdown's close + focus-
     * management sequence has settled and Radix's outside-click
     * detector no longer sees the original pointer-up as relevant
     * to the new Dialog. requestAnimationFrame would also work but
     * setTimeout(0) is the conventional Radix workaround for this race.
     *
     * useCallback (empty deps — only the stable setter + setTimeout) so
     * the memoised <EfRow> sees a stable prop across re-renders.
     */
    setTimeout(() => setSendDialogFor(e), 0);
  }, []);

  /*
   * Same Radix DropdownMenu → Dialog race as openSendDialog above
   * (2026-06-11 audit). Client Mapping and Transactions modals were
   * being opened directly from DropdownMenuItem onClick handlers; the
   * pointer-up that closed the dropdown was being interpreted by the
   * just-mounted Dialog as an outside click → instant dismiss. Defer
   * via setTimeout(0) so the dropdown teardown finishes first.
   */
  const openClientMapping = useCallback((e: Ef) => {
    setTimeout(() => setClientMappingFor(e), 0);
  }, []);

  const openTransactions = useCallback((e: Ef) => {
    setTimeout(() => setTransactionsFor(e), 0);
  }, []);

  const openDeepSkillModal = useCallback((e: Ef) => {
    setTimeout(() => setDeepSkillFor(e), 0);
  }, []);

  // Live Location now opens from a plain sibling IconButton (not a
  // DropdownMenuItem), so there's no dropdown-close pointer-up to race the
  // just-mounted popover — set state directly, no setTimeout(0) deferral.
  const openLiveLocation = useCallback((e: Ef) => {
    setLocationFor(e);
  }, []);

  // Stable row-action navigation callbacks for the memoised <EfRow>.
  const onRowEdit = useCallback((e: Ef) => {
    router.push(`/easyfixers/${e.efr_id}/verification`);
  }, [router]);
  const onRowAssessment = useCallback(() => {
    router.push('/coming-soon');
  }, [router]);

  /*
   * Dev-only "Copy Dev URL" handler (2026-06-11). Hits the new
   * GET /admin/easyfixers/:id/profile-update-link/dev-url endpoint
   * (which returns 404 in production) and copies the response URL to
   * the clipboard. No WhatsApp send. The button that invokes this is
   * already gated behind `process.env.NODE_ENV !== 'production'`, so
   * this handler should only ever fire in non-prod — but we still let
   * the BE be the source of truth for the prod block (the FE gate is
   * a defence-in-depth nicety; the 404 is the real enforcement).
   */
  const copyDevUrl = useCallback(async (e: Ef) => {
    setCopyingDevUrlFor((prev) => new Set(prev).add(e.efr_id));
    try {
      const resp = await api.get<{ efrId: number; token: string; url: string }>(
        `/admin/easyfixers/${e.efr_id}/profile-update-link/dev-url`,
      );
      if (!resp?.url) throw new Error('No URL returned from BE');
      // navigator.clipboard requires a secure context (https or localhost).
      // localhost:5180 qualifies, so this works in standard dev.
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(resp.url);
        showToast({ variant: 'success', message: `Dev URL copied for ${e.efr_name}` });
      } else {
        // Clipboard API not available — surface the URL in the toast so
        // the operator can copy it manually.
        showToast({ variant: 'success', message: `Dev URL: ${resp.url}` });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast({ variant: 'error', message: "You don't have permission to copy dev URLs." });
      } else if (err instanceof ApiError && err.status === 404) {
        showToast({ variant: 'error', message: 'Dev URL endpoint disabled in this environment.' });
      } else {
        showToast({ variant: 'error', message: err instanceof Error ? err.message : 'Failed to copy dev URL' });
      }
    } finally {
      setCopyingDevUrlFor((prev) => {
        const next = new Set(prev);
        next.delete(e.efr_id);
        return next;
      });
    }
  }, []);

  async function confirmSendProfileUpdateLink(efrId: number, overrideMobile: string | undefined) {
    setSendingFor((prev) => new Set(prev).add(efrId));
    try {
      await api.post(`/admin/easyfixers/${efrId}/profile-update-link/send`, {
        action: 'first',
        ...(overrideMobile ? { override_mobile: overrideMobile } : {}),
      });
      // Send succeeded — the cached aggregate row (60s TTL) now holds a
      // stale "Last Link Sent" date/count. Drop it so the next load()
      // refetches, and optimistically patch the rendered row so the
      // column reflects the send immediately (no full load() refire).
      aggregateCache.delete(efrId);
      setRows((prev) => prev.map((r) => r.efr_id === efrId
        ? { ...r, profile_update_sent_at: new Date().toISOString(), profile_update_send_count: (r.profile_update_send_count ?? 0) + 1 }
        : r));
      const target = sendDialogFor;
      showToast({
        variant: 'success',
        message: overrideMobile
          ? `Profile update link sent to ${overrideMobile} on WhatsApp`
          : `Profile update link sent to ${target?.efr_name ?? 'easyfixer'} on WhatsApp`,
      });
      setSendDialogFor(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast({ variant: 'error', message: "You don't have permission to send profile update links." });
      } else {
        showToast({ variant: 'error', message: err instanceof Error ? err.message : 'Failed to send link' });
      }
    } finally {
      setSendingFor((prev) => {
        const next = new Set(prev);
        next.delete(efrId);
        return next;
      });
    }
  }

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
    overrideSortBy?: string | null,
    overrideSortDir?: SortDir,
  ) {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    const f = overrideFilters ?? filters;
    const pg = reset ? 0 : (overridePage ?? page);
    const ps = overridePageSize ?? pageSize;
    // Sort: a null sortKey (initial / cleared on 3rd click) sends no sort
    // params, so the BE applies its default (efr_id DESC). Overrides let the
    // onSort handler reload with the new sort before state has flushed.
    const sKey = overrideSortBy !== undefined ? overrideSortBy : sortKey;
    const sDir = overrideSortDir ?? sortDir;
    const sortParams = sKey ? { sortBy: sKey, sortDir: sDir } : {};
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
        ...sortParams,
        ...buildQuery(f),
      });
      if (seq !== loadSeqRef.current) return; // superseded by a newer load — discard
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
              options_mapped_count: agg.options_mapped_count,
              profile_update_sent_at: agg.profile_update_sent_at ?? null,
              profile_update_send_count: agg.profile_update_send_count ?? 0,
              serviceable_pincodes_csv: agg.serviceable_pincodes_csv ?? '',
              _aggregatesLoaded: true,
            };
          }));
        }
        if (missing.length > 0) {
          void api
            .post<{ items: AggregateRow[] }>('/admin/easyfixers/aggregates', { efrIds: missing })
            .then((resp) => {
              // Persist into the module-level cache so a later page-flip
              // / search-back picks them up instantly. (BE wraps under `items`,
              // matching the rest of the API — not `rows`.)
              writeAggregatesToCache(resp.items);
              const map = new Map(resp.items.map((a) => [a.efr_id, a]));
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
                  options_mapped_count: agg.options_mapped_count,
                  profile_update_sent_at: agg.profile_update_sent_at ?? null,
                  profile_update_send_count: agg.profile_update_send_count ?? 0,
                  serviceable_pincodes_csv: agg.serviceable_pincodes_csv ?? '',
                  _aggregatesLoaded: true,
                };
              }));
            })
            .catch(() => { /* keep placeholders on failure */ });
        }
        void api
          .post<{ items: AttendanceRow[] }>('/admin/easyfixers/attendance', { efrIds })
          .then((resp) => {
            const map = new Map(resp.items.map((a) => [a.efr_id, a]));
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
    } finally {
      // A superseded load leaves `loading` for the newer in-flight load
      // to clear; the non-superseded case (including the early discard
      // return) clears it here as before.
      if (seq === loadSeqRef.current) setLoading(false);
    }
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
    fetchServiceCategoriesAllOnce().then((d) => { if (!cancelled) setServiceCategoriesAll(d); }).catch(() => {});
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
      showToast({ variant: 'error', message: `Download failed: ${(e as Error).message || 'Unknown error'}` });
    } finally { setDownloading(false); }
  }

  /*
   * Server-side sort handler (2026-06-17). Cycles asc → desc → cleared via
   * cycleSort, then reloads page 0 so the BE sorts the COMPLETE filtered list
   * (cleared => BE default efr_id DESC). Replaces the old client-side useSort,
   * which only reordered the rows already loaded for the current page.
   */
  function onSort(col: string) {
    const next = cycleSort<string>(col, { sortBy: sortKey, sortDir });
    setSortKey(next.sortBy);
    setSortDir(next.sortDir);
    setPage(0);
    load(false, undefined, 0, undefined, next.sortBy, next.sortDir);
  }

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
    const list = serviceCategoriesAll.length ? serviceCategoriesAll : lk.serviceCategories;
    const m = new Map<string, string>();
    list.forEach((c) => m.set(String(c.service_catg_id), c.service_catg_name));
    return m;
  }, [serviceCategoriesAll, lk.serviceCategories]);

  const serviceTypeById = useMemo(() => {
    const list = serviceTypesAll.length ? serviceTypesAll : lk.serviceTypes;
    const m = new Map<string, string>();
    list.forEach((t) => m.set(String(t.service_type_id), t.service_type_name));
    return m;
  }, [serviceTypesAll, lk.serviceTypes]);

  const openCsvModal = useCallback((title: string, items: CsvCellItem[]) => {
    if (items.length === 0) return;
    setCsvCell({ open: true, title, items });
  }, []);

  /*
   * Per-row derived data, hoisted out of the row render (2026-06-11).
   * Previously each row re-parsed both CSV columns + re-formatted the
   * name on EVERY page render — including filter keystrokes that don't
   * touch the table at all. Memoising the bundle here (and rendering
   * rows via the memoised <EfRow>) means typing in a filter input no
   * longer re-reconciles 500 rows × 22 cells.
   */
  // Rows arrive already sorted from the server (full-list sort), so we map the
  // raw `rows` directly — no client-side re-sort of the current page.
  const displayRows = useMemo(() => rows.map((e) => ({
    e,
    catItems: parseCsvCell(e.efr_service_category, categoryById),
    typeItems: parseCsvCell(e.efr_service_type, serviceTypeById),
    efName: formatEasyfixerName(e.efr_name),
  })), [rows, categoryById, serviceTypeById]);

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
                  { value: '0', label: 'All' },
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
              <CitySelect
                placeholder="All"
                value={filters.cityId}
                onChange={(id) => setFilters({ ...filters, cityId: id })}
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
                placeholder="All"
                value={filters.deepSkillMapped}
                onChange={(v) => setFilters({ ...filters, deepSkillMapped: v })}
                options={[
                  { value: '', label: 'All' },
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
          <table className="data-table" style={{ tableLayout: 'fixed', minWidth: '2950px' }}>
            {/*
              * Explicit px widths (not percentages) so the table has a
              * deterministic intrinsic width that exceeds the viewport,
              * triggering horizontal scroll via the wrapping
              * `overflow-x-auto` div. Sticky ID + Action cols pin to
              * viewport edges; everything else scrolls between them.
              *
              * Column order follows the user-specified sequence (2026-06-17).
              * EF Account column removed from the UI (BE still returns the
              * field). Widths sized to the CONTENT/header + ~16px headroom so
              * the active-sort arrow (SortHeader is whitespace-nowrap +
              * overflow-hidden) is never clipped. Sum ≈ 2937px.
              */}
            <colgroup>
              <col style={{ width: '70px'  }} />{/* ID — sticky-left */}
              <col style={{ width: '160px' }} />{/* Name */}
              <col style={{ width: '110px' }} />{/* Mobile */}
              <col style={{ width: '200px' }} />{/* Email */}
              <col style={{ width: '110px' }} />{/* State */}
              <col style={{ width: '110px' }} />{/* City */}
              <col style={{ width: '160px' }} />{/* Service Category */}
              <col style={{ width: '140px' }} />{/* Service Type */}
              <col style={{ width: '220px' }} />{/* Serviceable Pincodes */}
              <col style={{ width: '165px' }} />{/* Mapped Deep Skill */}
              <col style={{ width: '185px' }} />{/* User Mapped to Client */}
              <col style={{ width: '130px' }} />{/* Clients Mapped */}
              <col style={{ width: '105px' }} />{/* Job Count */}
              <col style={{ width: '130px' }} />{/* Total Earnings */}
              <col style={{ width: '120px' }} />{/* A/C Balance */}
              <col style={{ width: '95px'  }} />{/* Profile % */}
              <col style={{ width: '175px' }} />{/* Last Link Sent */}
              <col style={{ width: '175px' }} />{/* Registered on — sized to date+time content */}
              <col style={{ width: '95px'  }} />{/* Verified */}
              <col style={{ width: '95px'  }} />{/* Rating */}
              <col style={{ width: '115px' }} />{/* Status */}
              <col style={{ width: '72px' }} />{/* Action — sticky-right; kebab menu only (was 130px when 6 inline icons) */}
            </colgroup>
            <thead>
              <tr>
                <SortHeader col="efr_id"                 align="center" sortBy={sortKey} sortDir={sortDir} onSort={onSort} className="stick-col-head stick-left">ID</SortHeader>
                <SortHeader col="efr_name"               align="left"   sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Name</SortHeader>
                <SortHeader col="efr_no"                 align="left"   sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Mobile</SortHeader>
                <SortHeader col="efr_email"              align="left"   sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Email</SortHeader>
                <SortHeader col="state_name"             align="left"   sortBy={sortKey} sortDir={sortDir} onSort={onSort}>State</SortHeader>
                <SortHeader col="city_name"              align="left"   sortBy={sortKey} sortDir={sortDir} onSort={onSort}>City</SortHeader>
                <SortHeader col="efr_service_category"   align="left"   sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Service Category</SortHeader>
                <SortHeader col="efr_service_type"       align="left"   sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Service Type</SortHeader>
                <th className="!text-left">Serviceable Pincodes</th>
                <SortHeader col="options_mapped_count"   align="right"  sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Mapped Deep Skill</SortHeader>
                <SortHeader col="user_mapped_to_city"    align="left"   sortBy={sortKey} sortDir={sortDir} onSort={onSort}>User Mapped to Client</SortHeader>
                <SortHeader col="clients_mapped"         align="right"  sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Clients Mapped</SortHeader>
                <SortHeader col="job_count"              align="right"  sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Job Count</SortHeader>
                <SortHeader col="total_earnings"         align="right"  sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Total Earnings</SortHeader>
                <SortHeader col="current_balance"        align="right"  sortBy={sortKey} sortDir={sortDir} onSort={onSort}>A/C Balance</SortHeader>
                <SortHeader col="efr_profile_perc"       align="right"  sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Profile %</SortHeader>
                <SortHeader col="profile_update_sent_at" align="left"   sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Last Link Sent</SortHeader>
                <SortHeader col="insert_date"            align="left"   sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Registered on</SortHeader>
                <SortHeader col="is_technician_verified" align="center" sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Verified</SortHeader>
                <SortHeader col="avg_rating"             align="right"  sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Rating</SortHeader>
                <SortHeader col="efr_status_label"       align="center" sortBy={sortKey} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap stick-col-head stick-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {/* Show "Loading…" on EVERY in-flight fetch — initial, search,
                  pagination AND sort. Sort reloads the full list server-side
                  and can take ~1-2s for aggregate columns, so a clear loading
                  state matters (the rows are gated on !loading below, so
                  without this the body would sit blank during the sort). */}
              {loading && (
                <tr><td colSpan={22} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={22} className="!text-center text-muted-foreground py-6">No easyfixers match the current filters.</td></tr>
              )}
              {!loading && displayRows.map((row) => (
                <EfRow
                  key={row.e.efr_id}
                  row={row}
                  canEdit={!!can.isEdit}
                  canSend={!!can.isProfileUpdateLinkSend}
                  isProd={isProd}
                  isSending={sendingFor.has(row.e.efr_id)}
                  isCopyingDevUrl={copyingDevUrlFor.has(row.e.efr_id)}
                  onEdit={onRowEdit}
                  onClientMapping={openClientMapping}
                  onTransactions={openTransactions}
                  onAssessment={onRowAssessment}
                  onLiveLocation={openLiveLocation}
                  onSendProfileUpdateLink={openSendDialog}
                  onCopyDevUrl={copyDevUrl}
                  onOpenCsvModal={openCsvModal}
                  onOpenDeepSkillModal={openDeepSkillModal}
                />
              ))}
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

      <EasyfixerDeepSkillModal
        open={deepSkillFor != null}
        onClose={() => setDeepSkillFor(null)}
        easyfixerId={deepSkillFor?.efr_id ?? null}
        easyfixerName={deepSkillFor?.efr_name ?? null}
        onUnmapped={(efrId, count) => {
          // Recompute (not decrement): the modal hands back the technician's
          // NEW distinct-deep-skill count after the unmap. Bust the aggregate
          // cache + set the row's count to that exact value.
          aggregateCache.delete(efrId);
          setRows((prev) => prev.map((r) =>
            r.efr_id === efrId ? { ...r, options_mapped_count: count } : r));
        }}
      />

      <EasyfixerTransactionsModal
        open={transactionsFor != null}
        onClose={() => setTransactionsFor(null)}
        easyfixerId={transactionsFor?.efr_id ?? null}
        easyfixerName={transactionsFor?.efr_name ?? null}
        easyfixerMobile={transactionsFor?.efr_no ?? null}
      />

      <SendProfileUpdateLinkDialog
        open={sendDialogFor !== null}
        easyfixer={sendDialogFor}
        isProd={isProd}
        isSending={sendDialogFor ? sendingFor.has(sendDialogFor.efr_id) : false}
        onConfirm={(overrideMobile) => {
          if (sendDialogFor) confirmSendProfileUpdateLink(sendDialogFor.efr_id, overrideMobile);
        }}
        onClose={() => setSendDialogFor(null)}
      />

      {/*
        * Live technician location — per-easyfixer. Polls
        * GET /admin/easyfixers/:id/location every 15s while open; the interval
        * cleanup lives inside LiveLocationPopover.
        */}
      <LiveLocationPopover
        open={locationFor != null}
        onClose={() => setLocationFor(null)}
        source="easyfixer"
        id={locationFor?.efr_id ?? null}
        title={locationFor
          ? `${formatEasyfixerName(locationFor.efr_name)}${locationFor.efr_no ? ` · ${locationFor.efr_no}` : ''}`
          : undefined}
      />

    </div>
  );
}

/*
 * Per-row display bundle produced by the `displayRows` memo in the page
 * component — the CSV columns are parsed and the name formatted ONCE per
 * rows/lookup change, not on every render pass.
 */
type DisplayRow = {
  e: EnrichedEf;
  catItems: CsvCellItem[];
  typeItems: CsvCellItem[];
  efName: string;
};

/*
 * EfRow — memoised list row (2026-06-11). The 14 controlled filter
 * inputs live in the same component as the table, so before this every
 * filter keystroke re-rendered all rows (at pageSize 'All' that's 500
 * rows × 22 cells + 1,000 CSV parses + 500 action-menu re-renders per
 * keystroke — for zero visual change, since filters don't refetch).
 * React.memo + the stable `row` bundle from `displayRows` + useCallback'd
 * handlers mean a keystroke skips the entire tbody. Aggregate/attendance
 * merges replace row objects immutably, so affected rows still re-render.
 */
const EfRow = memo(function EfRow({
  row, canEdit, canSend, isProd, isSending, isCopyingDevUrl,
  onEdit, onClientMapping, onTransactions, onAssessment, onLiveLocation,
  onSendProfileUpdateLink, onCopyDevUrl, onOpenCsvModal, onOpenDeepSkillModal,
}: {
  row: DisplayRow;
  canEdit: boolean;
  canSend: boolean;
  isProd: boolean;
  isSending: boolean;
  isCopyingDevUrl: boolean;
  onEdit: (e: Ef) => void;
  onClientMapping: (e: Ef) => void;
  onTransactions: (e: Ef) => void;
  onAssessment: () => void;
  onLiveLocation: (e: Ef) => void;
  onSendProfileUpdateLink: (e: Ef) => void;
  onCopyDevUrl: (e: Ef) => void;
  onOpenCsvModal: (title: string, items: CsvCellItem[]) => void;
  onOpenDeepSkillModal: (e: Ef) => void;
}) {
  const { e, catItems, typeItems, efName } = row;
  return (
    <tr>
      <td className="!text-center font-mono text-xs truncate stick-col stick-left">{e.efr_id}</td>
      <td className="!text-left font-medium" title={efName}>
        <span className="inline-flex items-center gap-1.5 max-w-full align-middle">
          <span className="truncate">{efName}</span>
          {e._aggregatesLoaded && e.job_count != null && e.job_count < 5 && (
            <StatusChip tone="sky" size="sm" className="shrink-0" title="Completed Less Than 5 Jobs Till Now">Fresher</StatusChip>
          )}
        </span>
      </td>
      <td className="!text-left font-mono text-xs truncate" title={e.efr_no}>{e.efr_no}</td>
      <td className="!text-left text-xs truncate" title={e.efr_email ?? ''}>{e.efr_email ?? <span className="text-muted-foreground">—</span>}</td>
      <td className="!text-left truncate" title={e.state_name ?? ''}>{e.state_name ?? <span className="text-muted-foreground">—</span>}</td>
      <td className="!text-left truncate" title={e.city_name ?? ''}>{e.city_name ?? <span className="text-muted-foreground">—</span>}</td>
      <td className="!text-left text-xs truncate">
        <CsvCellButton
          items={catItems}
          onOpen={() => onOpenCsvModal(`Service Categories — ${efName}`, catItems)}
        />
      </td>
      <td className="!text-left text-xs truncate">
        <CsvCellButton
          items={typeItems}
          onOpen={() => onOpenCsvModal(`Service Types — ${efName}`, typeItems)}
        />
      </td>
      <td className="!text-left text-xs truncate">
        <PincodesCell
          csv={e.serviceable_pincodes_csv ?? ''}
          efName={efName}
          onOpen={onOpenCsvModal}
        />
      </td>
      <td className="!text-right tabular-nums truncate">
        {e._aggregatesLoaded
          ? (e.options_mapped_count > 0
            ? <button
                type="button"
                onClick={() => onOpenDeepSkillModal(e)}
                className="font-semibold text-primary hover:underline tabular-nums"
                title="View / unmap mapped deep skills"
              >{e.options_mapped_count}</button>
            : <span className="text-muted-foreground">0</span>)
          : <span className="text-muted-foreground">…</span>}
      </td>
      <td className="!text-left truncate" title={e.user_mapped_to_city ?? ''}>{e.user_mapped_to_city ?? <span className="text-muted-foreground">—</span>}</td>
      <td className="!text-right tabular-nums truncate">
        {e._aggregatesLoaded
          ? (e.clients_mapped ?? 0)
          : <span className="text-muted-foreground">…</span>}
      </td>
      <td className="!text-right tabular-nums truncate">
        {e._aggregatesLoaded
          ? (e.job_count ?? 0)
          : <span className="text-muted-foreground">…</span>}
      </td>
      <td className="!text-right tabular-nums truncate">
        {e._aggregatesLoaded
          ? (e.total_earnings != null ? `₹${Number(e.total_earnings).toLocaleString('en-IN')}` : '—')
          : <span className="text-muted-foreground">…</span>}
      </td>
      <td className="!text-right tabular-nums truncate">{e.current_balance != null ? `₹${Number(e.current_balance).toLocaleString('en-IN')}` : '—'}</td>
      <td className="!text-right text-xs tabular-nums truncate">{e.efr_profile_perc != null ? `${Math.round(Number(e.efr_profile_perc))}%` : '—'}</td>
      {/*
        * Last Link Sent — profile-update magic-link audit
        * (2026-06-11). Date + a slate "N×" pill showing
        * `profile_update_send_count` when > 0. Placeholder "…"
        * while aggregates phase is still in flight; muted "—"
        * when the easyfixer has never been pinged.
        */}
      <td className="!text-left text-xs tabular-nums truncate">
        {e._aggregatesLoaded ? (
          e.profile_update_sent_at ? (
            <span className="inline-flex items-center gap-1.5" title={formatDate(e.profile_update_sent_at)}>
              <span className="truncate">{formatDate(e.profile_update_sent_at)}</span>
              {e.profile_update_send_count > 1 && (
                <span className="text-[10px] font-medium rounded bg-slate-100 px-1.5 py-0.5 text-slate-600 shrink-0">
                  {e.profile_update_send_count}×
                </span>
              )}
            </span>
          ) : (
            <span className="text-slate-400">—</span>
          )
        ) : (
          <span className="text-muted-foreground">…</span>
        )}
      </td>
      <td className="!text-left text-xs whitespace-nowrap text-muted-foreground truncate" title={formatDate(e.insert_date)}>{formatDate(e.insert_date)}</td>
      <td className="!text-center truncate">{e.is_technician_verified ? '✓' : <span className="text-muted-foreground">—</span>}</td>
      <td className="!text-right tabular-nums truncate">
        {e._aggregatesLoaded
          ? (e.avg_rating != null ? `${Number(e.avg_rating).toFixed(1)} ★` : '—')
          : <span className="text-muted-foreground">…</span>}
      </td>
      <td className="!text-center truncate">
        {e.efr_status_label
          ? <StatusChip tone={statusLabelTone(e.efr_status_label)} size="sm">{e.efr_status_label}</StatusChip>
          : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="!text-right stick-col stick-right">
        {/*
          * Live Location moved OUT of the 3-dot menu into this sibling
          * IconButton (2026-06-26). Opening it from a DropdownMenuItem race'd
          * the menu's close pointer/focus event against the just-mounted
          * Dialog → instant dismiss. A plain button is race-free (mirrors the
          * jobs page, which opens the same LiveLocationPopover this way) and
          * gives ops one-click access without opening the menu.
          */}
        <div className="flex items-center justify-end gap-1">
          <IconButton
            icon={MapPin}
            intent="primary"
            label="Live technician location"
            onClick={() => onLiveLocation(e)}
          />
          <EasyfixerActionMenu
            easyfixer={{ efr_id: e.efr_id, efr_name: e.efr_name }}
            canEdit={canEdit}
            canSend={canSend}
            canCopyDevUrl={!isProd && canSend}
            onEdit={() => onEdit(e)}
            onClientMapping={() => onClientMapping(e)}
            onTransactions={() => onTransactions(e)}
            onAssessment={onAssessment}
            onSendProfileUpdateLink={() => onSendProfileUpdateLink(e)}
            onCopyDevUrl={() => onCopyDevUrl(e)}
            isSending={isSending}
            isCopyingDevUrl={isCopyingDevUrl}
          />
        </div>
      </td>
    </tr>
  );
});

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
 * PincodesCell — inline cell for the Serviceable Pincodes column.
 * Splits the `serviceable_pincodes_csv` string (e.g. "560001,560002,560003")
 * into an array, shows the first 3 joined with commas + "+N more" badge,
 * and opens the shared CsvCellModal on click (reusing the same search UX
 * as Service Category / Service Type).
 */
function PincodesCell({
  csv,
  efName,
  onOpen,
}: {
  csv: string;
  efName: string;
  onOpen: (title: string, items: CsvCellItem[]) => void;
}) {
  const pincodes = (csv || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (pincodes.length === 0) return <span className="text-muted-foreground">—</span>;

  const PREVIEW = 3;
  const preview = pincodes.slice(0, PREVIEW).join(', ');
  const more = pincodes.length - PREVIEW;
  const full = pincodes.join(', ');
  // Build CsvCellItem[] for the modal: use the pincode string as both id and name.
  const items: CsvCellItem[] = pincodes.map((p) => ({ id: p, name: p }));

  return (
    <button
      type="button"
      onClick={() => onOpen(`Serviceable Pincodes — ${efName}`, items)}
      title={full}
      className="text-left text-xs hover:underline hover:text-primary truncate max-w-full inline-flex items-center gap-1"
    >
      <span className="truncate">{preview}</span>
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

/*
 * SendProfileUpdateLinkDialog — environment-aware "Send To" confirmation
 * step (2026-06-10).
 *
 * Why this exists: testing in dev / staging accidentally pinged real
 * technicians on WhatsApp. The dialog adds a confirmation step plus, in
 * non-prod only, an editable destination override so testers can send to
 * their own number. In production the input is disabled AND the mobile
 * is masked so an over-the-shoulder operator can't accidentally read out
 * another technician's number.
 *
 * Defence in depth: even if a tampered client bypassed this dialog and
 * POSTed `override_mobile` directly, the BE Joi schema's custom
 * `production-block` rule rejects it 400 in production.
 *
 * Defined inline in this file (per spec). The masking rule is "first 2 +
 * last 3 digits visible, the rest X'd" — e.g. `9876543210` →
 * `98XXXXX210`.
 */
function SendProfileUpdateLinkDialog({
  open, easyfixer, isProd, isSending, onConfirm, onClose,
}: {
  open: boolean;
  easyfixer: Ef | null;
  isProd: boolean;
  isSending: boolean;
  onConfirm: (overrideMobile: string | undefined) => void;
  onClose: () => void;
}) {
  const realMobile = easyfixer?.efr_no ?? '';
  const [override, setOverride] = useState('');
  useEffect(() => {
    if (open && easyfixer) {
      setOverride(realMobile);
    }
  }, [open, easyfixer, realMobile]);

  // Timestamp of the last open — drives the race-close swallow below.
  const openedAtRef = useRef(0);
  useEffect(() => { if (open) openedAtRef.current = Date.now(); }, [open]);

  /*
   * Discard-changes guard for Esc / overlay-click / X. This dialog is a
   * confirmation step, not a multi-field form — `isDirty: false` so the
   * prompt never fires (operator just closes). The `when` gate suppresses
   * the close path entirely while a send is in flight so the dialog can't
   * unmount mid-POST.
   *
   * MUST be called above the `if (!easyfixer) return null` early-return
   * below (2026-06-11). Rules of Hooks: every render must call the same
   * hooks in the same order. Putting this below the early-return meant
   * the very first render (when `easyfixer === null` on mount) called
   * 2 hooks (useState + useEffect) and skipped the third; the second
   * render (after `sendDialogFor` was set) called all 3 — React's
   * "Previous: undefined, Next: useContext" hooks-order error.
   */
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: false,
    when: () => !isSending,
  });

  // Bulletproof fix for the "opens and closes in a blink" race: Radix's
  // DismissableLayer fires onOpenChange(false) from the SAME pointer
  // interaction that opened this dialog (it was launched from a DropdownMenu
  // item). Since isDirty:false closes with no prompt, that phantom close
  // dismisses the dialog instantly. Swallow ANY close fired within 400ms of
  // opening; genuine Esc / X / Cancel / outside-clicks always arrive later.
  function handleOpenChange(next: boolean) {
    if (!next && Date.now() - openedAtRef.current < 400) return;
    guardedOpenChange(next);
  }

  // Fragment instead of null (2026-06-11) — keeps the render shape
  // consistent across all render paths so React's reconciliation
  // doesn't flag a shape-change. Functionally identical for the user.
  if (!easyfixer) return <></>;

  const cleanedOverride = override.replace(/[^\d]/g, '');
  const overrideInvalid = !isProd && cleanedOverride.length < 10;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send Profile Update Link</DialogTitle>
          <DialogDescription>
            {isProd
              ? `WhatsApp Link Will Be Sent To ${easyfixer.efr_name} On Their Registered Mobile.`
              : `Override The Destination Mobile For Testing — Production Sends To The Real Mobile.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="dest-mobile" className="text-sm">Destination Mobile</Label>
          {isProd ? (
            <Input
              id="dest-mobile"
              value={maskMobile(realMobile)}
              disabled
              className="font-mono"
            />
          ) : (
            <Input
              id="dest-mobile"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              placeholder="Enter destination mobile (10-15 digits)"
              className="font-mono"
              inputMode="numeric"
            />
          )}
          <p className="text-xs text-muted-foreground">
            {isProd
              ? `Real Mobile Is Masked For Privacy.`
              : `In Non-Production Environments You Can Send The Link To Your Own Number For Testing.`}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSending}>Cancel</Button>
          <Button
            onClick={() => {
              // In prod: undefined (BE uses real efr_no). In non-prod: send the
              // override unconditionally — the BE no-ops it back to efr_no if
              // it happens to equal the real value, but explicit override
              // makes the audit trail unambiguous.
              onConfirm(isProd ? undefined : cleanedOverride);
            }}
            disabled={isSending || overrideInvalid}
          >
            {isSending ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
