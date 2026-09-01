'use client';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, MapPin, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { SearchSelect } from '@/components/ui/search-select';
import { CitySelect } from '@/components/ui/city-select';
import { DownloadButton } from '@/components/ui/download-button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { CsvCellModal, type CsvCellItem } from '@/components/ui/CsvCellModal';
import { useVirtualRows, VirtualPad } from '@/components/ui/virtual-rows';
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
import { CallableMobile } from '@/components/calls/CallButton';
import { showToast } from '@/components/ui/toast';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useLookup } from '@/lib/use-lookup';
import { cn, formatDate, formatEasyfixerName } from '@/lib/utils';
import { maskMobile } from '@/lib/format';
import { EasyfixerModal, type EasyfixerModalMode } from '@/components/easyfixer/EasyfixerModal';
import { EasyfixerActionMenu } from '@/components/easyfixer/EasyfixerActionMenu';
import { openAppView } from '@/components/easyfixer/AppViewPanel';
import { EasyfixerLifecycleChip } from '@/components/easyfixer/EasyfixerLifecycleChip';
import { EasyfixerTransactionsModal } from '@/components/easyfixer/EasyfixerTransactionsModal';
import { EasyfixerClientMappingModal } from '@/components/easyfixer/EasyfixerClientMappingModal';
import { EasyfixerDeepSkillModal } from '@/components/easyfixer/EasyfixerDeepSkillModal';
import { EasyfixerMobileDialog } from '@/components/easyfixer/EasyfixerMobileDialog';
import { EasyfixerBankDialog } from '@/components/easyfixer/EasyfixerBankDialog';
import { LiveLocationPopover } from '@/components/location/LiveLocationPopover';
import { cycleSort, SortHeader, type SortDir } from '@/lib/use-sort';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import {
  EASYFIXER_LIFECYCLE_STATUSES,
  lifecycleLabel,
  type LifecycleRowFields,
} from '@/lib/easyfixer-lifecycle';

const EasyfixerStatusDialog = dynamic(
  () => import('@/components/easyfixer/EasyfixerStatusDialog')
    .then((module) => module.EasyfixerStatusDialog),
  { ssr: false },
);

/*
 * Manage Easyfixers — parity rewrite of the legacy CRM page.
 * 14 filters, 15 primary columns (+ a few legacy extras kept around for
 * day-to-day CRM use: Mobile, Email, Service Type, Verified, Action).
 *
 * Filters NO LONGER auto-refetch on every change — operators kept losing
 * partially-typed filter input mid-load. Search/Reset/initial mount and
 * pagination are the only fetch triggers.
 */

type Ef = LifecycleRowFields & {
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
  /*
   * Lifecycle bucket, not one of the six legacy status buckets — it filters
   * on `lifecycleStatus=TRAINING_PENDING` rather than `status=<n>`. Comes back
   * as 0 on an environment without the lifecycle migration, and the strip
   * hides a zero, so it simply does not render there.
   */
  training_pending: number;
  total: number;
};

type ServiceType = { service_type_id: number; service_type_name: string; service_catg_id: number };
type ServiceCategory = { service_catg_id: number; service_catg_name: string };
type ZonalManager = { user_id: number; user_name: string };
type DeepSkill = { deep_skill_id: number; deep_skill_name: string };
// Raw shape returned by GET /admin/deep-skills (deepskill_id/deepskill_name);
// remapped to DeepSkill in fetchDeepSkillsOnce so the dropdown + filter work.
type RawDeepSkill = { deepskill_id: number; deepskill_name: string };

const DEFAULT_FILTERS = {
  easyfixerId: '',
  name: '',
  mobileNo: '',
  efAccount: '',         // under_master | master | individual
  status: '1',           // Active default per screenshot
  lifecycleStatus: '',   // '' = All (no filter) | UPPER_SNAKE lifecycle status
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

/*
 * Lifecycle-status filter options — reuse the canonical status list + label map
 * (no second hardcoded list). Value is the UPPER_SNAKE status the BE's
 * `lifecycleStatus` param expects; the SearchSelect placeholder covers "All"
 * (empty value = no filter).
 */
const LIFECYCLE_STATUS_OPTS = EASYFIXER_LIFECYCLE_STATUSES.map((s) => ({
  value: s,
  label: lifecycleLabel(s),
}));

function buildQuery(f: Filters, extras: Record<string, string | number | undefined> = {}) {
  const q: Record<string, string | number | undefined> = { ...extras };
  if (f.easyfixerId) q.easyfixerId = f.easyfixerId;
  /*
   * AN ID SEARCH IS AN IDENTITY LOOKUP, so no roster bucket narrows it.
   *
   * `status` defaults to '1' (Active) and there is no control on this form that
   * shows it — the visible "Status" dropdown drives `lifecycleStatus`, and the
   * bucket is only surfaced by the counts strip above the filters. So typing an
   * Easyfixer Id while the form reads "Status: All" still sent status=1, and a
   * technician who is not Active came back as "no results" for a record that
   * plainly exists. Reported for efr 9501 (efr_status NULL,
   * lifecycle REGISTRATION_INCOMPLETE): 0 rows by id, 1 row with status=0.
   *
   * Searching a primary key means "find this one", so the two STATUS filters
   * are suppressed for that query. Every other filter still applies — an id
   * search is narrowed by nothing the operator cannot see.
   *
   * SUPPRESSED MEANS status=0, NOT "omit it". A missing status makes the
   * backend apply its own Active default, so dropping the parameter would
   * re-arm the very filter this is removing. 0 is the explicit All.
   */
  const idLookup = Boolean(f.easyfixerId);
  if (f.name) q.name = f.name;
  if (f.mobileNo) q.mobileNo = f.mobileNo;
  if (f.efAccount) q.efAccount = f.efAccount;
  if (idLookup) q.status = 0;
  else if (f.status !== '') q.status = f.status;
  // Lifecycle-status filter (13-state technician machine). Sent as the canonical
  // UPPER_SNAKE value; empty = All (no filter). Independent of the coarse
  // `status` bucket param above. Suppressed for an id lookup for the same
  // reason as the bucket — see the note at the top of this function.
  if (!idLookup && f.lifecycleStatus) q.lifecycleStatus = f.lifecycleStatus;
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
  /*
   * `isVerified=true` USED TO BE FORCED HERE, and it is gone because it was
   * redundant where it worked and destructive everywhere else.
   *
   * It appended `is_technician_verified = 1` to EVERY request. The default view
   * and the Active/Inactive buckets already carry that predicate themselves, so
   * for those it changed nothing — measured, not assumed: 2,636 / 2,636 / 215,
   * identical with and without.
   *
   * The other four buckets are DEFINED by not being verified, so the flag
   * contradicted them and they returned nothing while the counts strip above
   * them advertised a number:
   *
   *     Idle              3,449 counted →     0 shown
   *     Not Eligible      2,476 counted →     0 shown
   *     Not Suitable      1,222 counted →     0 shown
   *     Reg In Progress     356 counted →     0 shown
   *
   * 7,503 technicians counted and unreachable, and every id search for one of
   * them answered "no easyfixers match" — which is how efr 9501 (unverified,
   * Activation Pending) read as missing while the Registered queue showed it.
   *
   * The 2026-07-13 intent — the roster is verified technicians — is unchanged
   * and now comes from the buckets themselves rather than from a parameter
   * that overrode them.
   */
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
  const cached = readSession<DeepSkill[]>('ds_v2');
  if (cached) {
    deepSkillsPromise = Promise.resolve(cached);
    return deepSkillsPromise;
  }
  deepSkillsPromise = api
    // /admin/deep-skills returns deepskill_id/deepskill_name — remap to the FE
    // shape (deep_skill_id/deep_skill_name) the dropdown + filter read. The old
    // code cached the raw shape under 'ds' with undefined ids → the v2 key.
    .get<{ items: RawDeepSkill[] } | RawDeepSkill[]>('/admin/deep-skills', { limit: 500, status: 1 })
    .then((r) => {
      const raw = Array.isArray(r) ? r : (r.items ?? []);
      const list: DeepSkill[] = raw.map((d) => ({ deep_skill_id: d.deepskill_id, deep_skill_name: d.deepskill_name }));
      writeSession('ds_v2', list);
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
  const can = actionFlags(me, [
    'isEdit',
    'isEasyfixerTempInactive',
    'isProfileUpdateLinkSend',
    /*
     * Change-mobile / change-bank (2026-08-17). Both follow the
     * `isEasyfixer<Verb>` shape the two most recent additions on this screen
     * use (`isEasyfixerTempInactive`), NOT the bare-verb legacy names — these
     * actions have no Legacy CRM counterpart to stay compatible with.
     *
     * Fail-closed by construction: actionFlags returns false for a key that
     * isn't in the /auth/me payload, so until the `menu_action` rows are
     * seeded neither item renders. The BE must gate the routes on these exact
     * key names (see the handoff note).
     */
    'isEasyfixerMobileUpdate',
    'isEasyfixerBankUpdate',
  ]);
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
  // The row whose canonical lifecycle + audit dialog is open (null = closed).
  const [statusFor, setStatusFor] = useState<Ef | null>(null);
  // setTimeout(0): same Radix DropdownMenu → Dialog race as openSendDialog — open
  // synchronously and the menu's teardown dismisses the just-mounted dialog
  // (it flashes open then auto-closes). Defer so the dropdown closes first.
  const openStatusDialog = useCallback((e: Ef) => { setTimeout(() => setStatusFor(e), 0); }, []);
  /*
   * Change-mobile / change-bank dialog targets (null = closed). Both open
   * from the row kebab, so both go through the same setTimeout(0) deferral
   * as every other menu-launched dialog on this page — see openSendDialog
   * below for the full write-up of the Radix DropdownMenu → Dialog race.
   */
  const [mobileDialogFor, setMobileDialogFor] = useState<Ef | null>(null);
  const [bankDialogFor, setBankDialogFor] = useState<Ef | null>(null);
  const openMobileDialog = useCallback((e: Ef) => { setTimeout(() => setMobileDialogFor(e), 0); }, []);
  const openBankDialog = useCallback((e: Ef) => { setTimeout(() => setBankDialogFor(e), 0); }, []);
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
    // Carry the origin so the verification page's back-link returns HERE
    // (the Manage Easyfixers roster) rather than defaulting elsewhere.
    router.push(`/easyfixers/${e.efr_id}/verification?from=${encodeURIComponent('/easyfixers')}`);
  }, [router]);
  const onRowAssessment = useCallback(() => {
    router.push('/coming-soon');
  }, [router]);
  /*
   * Opens the FLOATING App View panel — not a route.
   *
   * This used to router.push to /easyfixers/[id]/app-view. That took the whole
   * CRM away to show one thing, which is exactly wrong for the job: the
   * operator is on the phone walking a technician through his screen and needs
   * the technician's record, his jobs and their notes at the same time. The
   * panel floats over whatever they are already doing and survives navigation,
   * because it is mounted at the authed layout rather than by this page.
   *
   * No setTimeout(0) needed: openAppView only dispatches an event, so there is
   * no dialog-close pointer event for a newly mounted surface to race.
   */
  const onRowAppView = useCallback((e: Ef) => {
    openAppView({ efrId: e.efr_id, name: e.efr_name });
  }, []);

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
    // Create flow retired (2026-07-13 — "Add New Easyfixer" removed); only the
    // ?view=<id> deep link remains, opening the modal in edit mode.
    const v = searchParams.get('view');
    if (v && /^\d+$/.test(v)) setModal({ open: true, mode: 'edit', id: Number(v) });
  }, [searchParams]);

  function closeModal() {
    setModal((m) => ({ ...m, open: false }));
    if (searchParams.get('new') || searchParams.get('view')) router.replace('/easyfixers');
  }

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
    // filters.serviceCategory holds the category ID (string) — narrow Service
    // Types to that category by id.
    return list.filter((t) => String(t.service_catg_id) === filters.serviceCategory);
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
  /*
   * Row virtualisation. `displayRows` is memoised (the EfRow memo depends on
   * that same stability), which is the hook's contract — an array rebuilt every
   * render would reset the scroll window on every render.
   */
  const displayRows = useMemo(() => rows.map((e) => ({
    e,
    catItems: parseCsvCell(e.efr_service_category, categoryById),
    typeItems: parseCsvCell(e.efr_service_type, serviceTypeById),
    efName: formatEasyfixerName(e.efr_name),
  })), [rows, categoryById, serviceTypeById]);
  const vEf = useVirtualRows(displayRows);

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
              activeLifecycleStatus={filters.lifecycleStatus}
              onPick={({ status, lifecycleStatus }) => {
                // Legacy status bucket and the lifecycle-status filter are the
                // same dimension — picking one clears the other (else the
                // backend ANDs them, e.g. Active + Blacklisted → zero rows).
                // Each strip entry carries both fields with the unused one
                // blank, so applying them together IS the mutual exclusion.
                const next = { ...filters, status, lifecycleStatus };
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
                * Lifecycle-status filter (2026-08). The Status dropdown now
                * offers the full technician-lifecycle machine (New … Suspended)
                * instead of the coarse Active/Inactive buckets. Selecting one
                * sends `lifecycleStatus=<UPPER_SNAKE>` to the list endpoint;
                * empty value (placeholder "All") = no lifecycle filter. Options
                * reuse EASYFIXER_LIFECYCLE_STATUSES + the shared label map.
                */}
              <SearchSelect
                placeholder="All"
                value={filters.lifecycleStatus}
                onChange={(v) => setFilters({
                  ...filters,
                  lifecycleStatus: v,
                  /*
                   * ALWAYS clear the legacy bucket, including when the operator
                   * picks "All".
                   *
                   * It used to keep `filters.status` on the empty value, and
                   * that default is '1' (Active) — so choosing All left an
                   * Active filter running that no control on this form shows.
                   * The one field labelled Status said All while a different,
                   * invisible filter did the excluding, which is how efr 9501
                   * (efr_status NULL) read as "no results" for a record that
                   * exists.
                   *
                   * Touching this control now decides the whole status
                   * dimension: a value filters by lifecycle, All filters by
                   * nothing. The counts strip above still sets the bucket for
                   * anyone who wants Active/Idle/Not Eligible explicitly, and
                   * it shows which one is on.
                   *
                   * '0', NOT ''. An EMPTY status is OMITTED from the query, and
                   * the backend reads a missing status as its own Active
                   * default — so clearing the field would have meant "Active"
                   * just as loudly as leaving it. 0 is the API's explicit
                   * "All", and it is the only value that filters nothing.
                   */
                  status: v ? '' : '0',
                })}
                options={LIFECYCLE_STATUS_OPTS}
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
                options={lk.serviceCategories.map((c) => ({ value: String(c.service_catg_id), label: c.service_catg_name }))}
              />
            </Field>
            <Field label="Service Type">
              <SearchSelect
                placeholder="All"
                value={filters.serviceType}
                onChange={(v) => setFilters({ ...filters, serviceType: v })}
                options={serviceTypeOpts.map((t) => ({ value: String(t.service_type_id), label: t.service_type_name }))}
              />
            </Field>
            <Field label="Deep Skill">
              <SearchSelect
                placeholder="All"
                value={filters.deepSkillId}
                onChange={(v) => setFilters({ ...filters, deepSkillId: v })}
                options={deepSkills.map((d) => ({ value: String(d.deep_skill_id), label: d.deep_skill_name }))}
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
          {/*
            * ref + containerClass = row virtualisation (components/ui/virtual-rows).
            * INERT below 200 rows, so 10 / 20 / 50 per page behave exactly as
            * before and only "All" (500, the endpoint's Joi max) is windowed —
            * which is the page size that mounts 500 rows x 22 cells AND 500
            * Radix action menus in one go.
            */}
          <div ref={vEf.scrollRef} className={`overflow-x-auto ${vEf.containerClass}`}>
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
          <table
            className={`data-table ${vEf.active ? 'head-sticky' : ''}`}
            style={{ tableLayout: 'fixed', minWidth: '2950px' }}
          >
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
              {/*
                * 190px, not 115px. This column used to render only
                * efr_status_label (six values); it now renders the LIFECYCLE
                * chip, whose longest label is "Registration Incomplete" — 23
                * characters. At 115px the chip was clipped mid-word by the
                * cell's own `truncate` and disappeared under the sticky Action
                * column, so the one thing the column exists to say was the part
                * that got cut. Sized to the longest label rather than the
                * average, because a status that reads "Registration Inco" is
                * worse than no status at all.
                */}
              <col style={{ width: '190px' }} />{/* Status — fits the longest lifecycle label */}
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
                {/* !pl-6 mirrors the body cell below. Padding applied to only
                    one of th/td shifts the header 12px out of line with the
                    icons it labels — the column stops reading as one column. */}
                <th className="!text-right !pl-6 whitespace-nowrap stick-col-head stick-right">Action</th>
              </tr>
            </thead>
            <tbody ref={vEf.bodyRef}>
              {/* Show "Loading…" on EVERY in-flight fetch — initial, search,
                  pagination AND sort. Sort reloads the full list server-side
                  and can take ~1-2s for aggregate columns, so a clear loading
                  state matters (the rows are gated on !loading below, so
                  without this the body would sit blank during the sort). */}
              {loading && (
                <tr><td colSpan={EF_COLS} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={EF_COLS} className="!text-center text-muted-foreground py-6">No easyfixers match the current filters.</td></tr>
              )}
              {/* Gated on !loading like the rows: a spacer standing in for rows
                  that are currently suppressed is thousands of px of blank under
                  a "Loading…" line. */}
              {!loading && <VirtualPad height={vEf.padTop} colSpan={EF_COLS} />}
              {!loading && vEf.slice.map((row) => (
                <EfRow
                  key={row.e.efr_id}
                  row={row}
                  canEdit={!!can.isEdit}
                  canSend={!!can.isProfileUpdateLinkSend}
                  canManageLifecycle={!!can.isEdit}
                  canUpdateMobile={!!can.isEasyfixerMobileUpdate}
                  canUpdateBank={!!can.isEasyfixerBankUpdate}
                  isProd={isProd}
                  isSending={sendingFor.has(row.e.efr_id)}
                  isCopyingDevUrl={copyingDevUrlFor.has(row.e.efr_id)}
                  onEdit={onRowEdit}
                  onLifecycle={openStatusDialog}
                  onClientMapping={openClientMapping}
                  onTransactions={openTransactions}
                  onAssessment={onRowAssessment}
                  onLiveLocation={openLiveLocation}
                  onAppView={onRowAppView}
                  onSendProfileUpdateLink={openSendDialog}
                  onCopyDevUrl={copyDevUrl}
                  onUpdateMobile={openMobileDialog}
                  onUpdateBank={openBankDialog}
                  onOpenCsvModal={openCsvModal}
                  onOpenDeepSkillModal={openDeepSkillModal}
                />
              ))}
              {!loading && <VirtualPad height={vEf.padBottom} colSpan={EF_COLS} />}
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
      <EasyfixerStatusDialog
        open={statusFor != null}
        easyfixerId={statusFor?.efr_id ?? null}
        easyfixerName={statusFor?.efr_name ?? null}
        canChange={!!can.isEdit}
        canSchedule={!!can.isEasyfixerTempInactive}
        onClose={() => setStatusFor(null)}
        onChanged={() => {
          invalidateStatusCounts();
          void load();
        }}
      />

      <EasyfixerTransactionsModal
        open={transactionsFor != null}
        onClose={() => setTransactionsFor(null)}
        easyfixerId={transactionsFor?.efr_id ?? null}
        easyfixerName={transactionsFor?.efr_name ?? null}
        easyfixerMobile={transactionsFor?.efr_no ?? null}
      />

      {/*
        * Change-mobile — the technician's LOGIN identity, so the dialog states
        * that consequence outright. On success we reload the list the same way
        * every other mutation on this page does; the masked `efr_no` in the
        * Mobile column is re-derived server-side.
        */}
      <EasyfixerMobileDialog
        open={mobileDialogFor !== null}
        easyfixer={mobileDialogFor}
        onClose={() => setMobileDialogFor(null)}
        onUpdated={() => { void load(); }}
      />

      {/*
        * Change-bank — ONE step by default. The OTP gate is a server property
        * (`bank.change.crm.otp.required`, seeded 'false'); the dialog still
        * carries the OTP step and reveals it if the server demands one. No bank
        * column exists on this table, so the reload is purely for consistency
        * with the other mutations.
        */}
      <EasyfixerBankDialog
        open={bankDialogFor !== null}
        easyfixer={bankDialogFor}
        onClose={() => setBankDialogFor(null)}
        onUpdated={() => { void load(); }}
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
/*
 * Column count of the list table. Named because FOUR things must span it — the
 * loading row, the empty row and the two virtualisation spacers — and four
 * literals that have to agree is how one of them goes stale.
 */
const EF_COLS = 22;

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
  row, canEdit, canSend, canManageLifecycle, canUpdateMobile, canUpdateBank,
  isProd, isSending, isCopyingDevUrl,
  onEdit, onClientMapping, onTransactions, onAssessment, onLiveLocation, onAppView,
  onSendProfileUpdateLink, onCopyDevUrl, onLifecycle, onUpdateMobile, onUpdateBank,
  onOpenCsvModal, onOpenDeepSkillModal,
}: {
  row: DisplayRow;
  canEdit: boolean;
  canSend: boolean;
  canManageLifecycle: boolean;
  canUpdateMobile: boolean;
  canUpdateBank: boolean;
  isProd: boolean;
  isSending: boolean;
  isCopyingDevUrl: boolean;
  onEdit: (e: Ef) => void;
  onClientMapping: (e: Ef) => void;
  onTransactions: (e: Ef) => void;
  onAssessment: () => void;
  onLiveLocation: (e: Ef) => void;
  onAppView: (e: Ef) => void;
  onSendProfileUpdateLink: (e: Ef) => void;
  onCopyDevUrl: (e: Ef) => void;
  onLifecycle: (e: Ef) => void;
  onUpdateMobile: (e: Ef) => void;
  onUpdateBank: (e: Ef) => void;
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
      {/* Dial the technician straight from the list — the point is not having
          to open the profile just to call after sending a link. Mirrors the
          Registered EasyFixer page. CallableMobile dials by efrId and the BE
          re-resolves the real number; `mobile` is display-only and already
          bullet-masked by the response middleware, so nothing here unmasks. */}
      <td className="!text-left font-mono text-xs truncate" title={e.efr_no}>
        <CallableMobile efrId={e.efr_id} mobile={e.efr_no} />
      </td>
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
                <span className="text-xs font-medium rounded bg-ink-100 px-1.5 py-0.5 text-ink-700 shrink-0">
                  {e.profile_update_send_count}×
                </span>
              )}
            </span>
          ) : (
            <span className="text-ink-500">—</span>
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
      <td className="!text-center whitespace-nowrap">
        <EasyfixerLifecycleChip
          value={e}
          fallbackLabel={e.efr_status_label}
          fallbackTone={statusLabelTone(e.efr_status_label)}
        />
      </td>
      {/*
        * !pl-6 — extra breathing room on the LEFT of the sticky action column.
        *
        * The column to its left (Serviceable Pincode) is long and horizontally
        * scrolled, so its text slides underneath this sticky cell. With only
        * the shared `.data-table td` px-3, the last visible digits ended up
        * touching the location icon and the two read as one control.
        *
        * `!` because `.data-table td` applies px-3 through @apply; a plain
        * pl-6 is the same specificity and would win or lose on source order.
        * The sibling !text-right is `!` for the same reason.
        */}
      <td className="!text-right !pl-6 stick-col stick-right">
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
          {/* Read-only mirror of what this technician sees in the app. */}
          <IconButton
            icon={Smartphone}
            intent="default"
            label="View technician app (read-only)"
            onClick={() => onAppView(e)}
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
            canManageLifecycle={canManageLifecycle}
            onLifecycle={() => onLifecycle(e)}
            canUpdateMobile={canUpdateMobile}
            canUpdateBank={canUpdateBank}
            onUpdateMobile={() => onUpdateMobile(e)}
            onUpdateBank={() => onUpdateBank(e)}
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
        <span className="text-xs font-medium rounded bg-muted px-1.5 py-0.5 text-muted-foreground shrink-0">
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
        <span className="text-xs font-medium rounded bg-muted px-1.5 py-0.5 text-muted-foreground shrink-0">
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
  activeLifecycleStatus,
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
  /* Same idea for the lifecycle dimension (UPPER_SNAKE, '' = none). */
  activeLifecycleStatus: string;
  onPick: (next: { status: string; lifecycleStatus: string }) => void;
}) {
  /*
   * Each entry drives exactly ONE filter dimension and blanks the other:
   * `status` is the legacy 1..6 bucket, `lifecycleStatus` is the technician
   * lifecycle machine. They are the same conceptual axis, so the backend ANDs
   * them and a combination like Active + Blacklisted yields zero rows —
   * carrying both fields on every entry is what makes "picking one clears the
   * other" structural rather than something each call site has to remember.
   */
  /*
   * Annotated on the literal, not on the filtered result: a type annotation
   * does not flow backwards through a chained `.filter()`, so writing
   * `const items: StripItem[] = [...].filter(...)` lets `key` widen to
   * `string` and then fails to index StatusCountsResp.
   */
  type StripItem = {
    key: keyof StatusCountsResp;
    label: string;
    status: string;
    lifecycleStatus: string;
    dot: string;
    ring: string;
  };
  const allItems: StripItem[] = [
    { key: 'active',          label: 'Active',                   status: '1', lifecycleStatus: '', dot: 'bg-success', ring: 'ring-success/30' },
    { key: 'inactive',        label: 'Inactive',                 status: '2', lifecycleStatus: '', dot: 'bg-ink-500',   ring: 'ring-ink-500/30' },
    { key: 'idle',            label: 'Idle',                     status: '3', lifecycleStatus: '', dot: 'bg-ink-300',   ring: 'ring-ink-300/30' },
    { key: 'not_eligible',    label: 'Not Eligible',             status: '4', lifecycleStatus: '', dot: 'bg-urgent',     ring: 'ring-urgent/30' },
    { key: 'not_suitable',    label: 'Not Suitable',             status: '5', lifecycleStatus: '', dot: 'bg-warning',   ring: 'ring-warning/30' },
    { key: 'reg_in_progress', label: 'Registration In Progress', status: '6', lifecycleStatus: '', dot: 'bg-info',        ring: 'ring-info/30' },
    /*
     * Training Pending (2026-08-13). Earns a place here because the LMS made
     * it actionable: completing the assigned videos now advances a technician
     * out of TRAINING_PENDING automatically, so whoever remains in it is
     * exactly the set who have not finished their training — a worklist, not
     * just a state.
     *
     * Violet rather than the amber its in-row StatusChip uses. The strip's
     * dots are its only colour coding and Not Suitable already owns amber;
     * two identical dots would defeat the one-line scannability this strip
     * exists for. The chip inside the table keeps the canonical tone.
     */
    { key: 'training_pending', label: 'Training Pending', status: '', lifecycleStatus: 'TRAINING_PENDING', dot: 'bg-gold', ring: 'ring-gold/30' },
  ];

  /*
   * Every entry always renders, including at zero — operators read a zero as
   * data, and a filter that disappears when empty is a filter nobody can find.
   *
   * Expect Training Pending to read 0 for now: as of 2026-08-13 no technician
   * is in TRAINING_PENDING, because nothing currently PUTS them there. The
   * LMS completion wire moves people OUT of the state; the entrance is still
   * a manual CRM transition. The count becomes meaningful once something
   * assigns the state on registration.
   */
  const items = allItems;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1">
      {items.map((it, i) => {
        const isActive = it.lifecycleStatus
          ? activeLifecycleStatus === it.lifecycleStatus
          : activeStatus === it.status && !activeLifecycleStatus;
        return (
          <span key={it.key} className="inline-flex items-center gap-2">
            {i > 0 && <span className="text-muted-foreground/50">·</span>}
            <button
              type="button"
              onClick={() => onPick({ status: it.status, lifecycleStatus: it.lifecycleStatus })}
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
