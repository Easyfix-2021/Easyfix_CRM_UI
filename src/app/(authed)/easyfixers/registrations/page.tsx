'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Search, Unlock, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { SearchSelect } from '@/components/ui/search-select';
import { DownloadButton } from '@/components/ui/download-button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { IconButton } from '@/components/ui/icon-button';
import { showToast } from '@/components/ui/toast';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { SortHeader, cycleSort, type SortDir } from '@/lib/use-sort';
import { CallableMobile } from '@/components/calls/CallButton';
import { api, ApiError } from '@/lib/api';
import { downloadXlsx } from '@/lib/download-xlsx';
import { cn, formatDate, formatEasyfixerName } from '@/lib/utils';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

/*
 * Registered Easyfixers — parity rewrite of the legacy CRM page
 * (efer-registration / registeredEasyfixers.vm).
 *
 * The legacy page is the "registration intake" queue: technicians who
 * have applied (self-registration or recruiter-added) and are working
 * through the verification funnel. The single row action is "Verify
 * Easyfixer", which deep-links to the verification workflow.
 *
 * Backend contract (DONE — consumed verbatim, not changed here):
 *   GET /admin/easyfixers/registered
 *     q, registrationStatus, easyfixerType, dateFrom (YYYY-MM-DD),
 *     dateTo, ndmId, limit, offset, sortBy, sortDir
 *     → { items, total, limit, offset }
 *   GET /admin/easyfixers/registered/download → XLSX
 *
 * Filters are server-side and apply only on Search / Reset / pagination
 * (NOT per-keystroke) — same UX as the main Manage Easyfixers page so
 * operators don't lose partially-typed input mid-load.
 */

type RegRow = {
  efr_id: number;
  registered_date: string;
  name: string | null;
  mobile: string | null;
  city: string | null;
  pincode: string | null;
  state_name: string | null;
  state_user_name: string | null;
  profile_perc: number | null;
  is_existing_easyfixer: boolean | number | null;
  new_easy_fixer: boolean | number | null;
  registration_status_label: string;
  early_activation_eligible: boolean | number | null;
  profile_activation_date_time: string | null;
  efr_service_category: string | null;
  efr_service_type: string | null;
};

type Resp = { items: RegRow[]; total: number; limit: number; offset: number };

type ZonalManager = { user_id: number; user_name: string };

type RegCounts = {
  new_lead: number; in_progress: number; details_not_available: number;
  not_eligible: number; send_to_finance: number; activation_pending: number;
  not_suitable: number; pending_member_verification: number; total: number;
};
// Status-count strip chips: [label, count key, registrationStatus filter value].
const COUNT_CHIPS: ReadonlyArray<[string, keyof RegCounts, string]> = [
  ['New Lead', 'new_lead', '1'],
  ['In Progress', 'in_progress', '2'],
  ['Details N/A', 'details_not_available', '3'],
  ['Not Eligible', 'not_eligible', '5'],
  ['Send To Finance', 'send_to_finance', '6'],
  ['Activation Pending', 'activation_pending', '7'],
  ['Not Suitable', 'not_suitable', '8'],
  ['Pending Member Verif.', 'pending_member_verification', '9'],
];

/*
 * Registration-status pill tone map. Legacy CRM colour convention:
 *   - in-flight intake (New Lead, Self Reg In Progress) → sky / amber
 *   - blocked / rejected (Not Eligible, Not Suitable, Send Back…) → red
 *   - happy-path forward (Send To Finance, Activation Pending, Pending
 *     Member Verification) → emerald / sky
 *   - missing data (Details Not Available) → slate
 */
function regStatusTone(label: string): StatusChipTone {
  switch (label) {
    case 'New Lead':
      return 'sky';
    case 'Self Registration In Progress':
      return 'amber';
    case 'Not Eligible':
    case 'Not Suitable':
    case 'Send Back To Tx EC':
    case 'Send Back To Tx Identity Section':
      return 'red';
    case 'Send To Finance':
    case 'Activation Pending':
      return 'emerald';
    case 'Pending Member Verification':
      return 'sky';
    case 'Details Not Available':
      return 'slate';
    default:
      return 'slate';
  }
}

/*
 * Two labels append the profile completion % beneath the pill (legacy
 * parity — the only two statuses where the operator needs to see how far
 * the self-registration has progressed).
 */
const SHOW_PCT_LABELS = new Set<string>([
  'Self Registration In Progress',
  'Not Suitable',
]);

const DEFAULT_FILTERS = {
  q: '',
  registrationStatus: '', // '' = All
  easyfixerType: '',      // '' = All | '1' Already Existing | '2' New
  dateFrom: '',
  dateTo: '',
  ndmId: '',
};
type Filters = typeof DEFAULT_FILTERS;

const REGISTRATION_STATUS_OPTS: { value: string; label: string }[] = [
  { value: '1', label: 'New Lead' },
  { value: '2', label: 'In Progress' },
  { value: '3', label: 'Details Not Available' },
  { value: '5', label: 'Not Eligible' },
  { value: '6', label: 'Send To Finance' },
  { value: '7', label: 'Activation Pending' },
  { value: '8', label: 'Not Suitable' },
  { value: '9', label: 'Pending Member Verification' },
];

const EASYFIXER_TYPE_OPTS: { value: string; label: string }[] = [
  { value: '1', label: 'Already Existing' },
  { value: '2', label: 'New Easyfixer' },
];

function buildQuery(f: Filters): Record<string, string | number | undefined> {
  const q: Record<string, string | number | undefined> = {};
  if (f.q) q.q = f.q;
  if (f.registrationStatus) q.registrationStatus = f.registrationStatus;
  if (f.easyfixerType) q.easyfixerType = f.easyfixerType;
  if (f.dateFrom) q.dateFrom = f.dateFrom;
  if (f.dateTo) q.dateTo = f.dateTo;
  if (f.ndmId) q.ndmId = f.ndmId;
  return q;
}

/*
 * Module-level deduped zonal-managers fetch — same source the main
 * Manage Easyfixers page uses for its "Zonal Manager" / NDM (= State
 * User) dropdown (GET /shared/lookup/zonal-managers). React StrictMode
 * double-mounts effects in dev; the in-flight promise collapses the two
 * concurrent calls into one network request, plus a per-tab
 * sessionStorage cache for instant remount hydration. Mirrors
 * `fetchZonalManagersOnce()` in easyfixers/page.tsx.
 */
const SS_KEY = 'ef-reg-lookup:zm';
const SS_TTL_MS = 30 * 60 * 1000;
let zonalManagersPromise: Promise<ZonalManager[]> | null = null;

function readSessionZm(): ZonalManager[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t: number; d: ZonalManager[] };
    if (Date.now() - parsed.t > SS_TTL_MS) return null;
    return parsed.d;
  } catch {
    return null;
  }
}
function writeSessionZm(data: ZonalManager[]) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SS_KEY, JSON.stringify({ t: Date.now(), d: data }));
  } catch {
    /* quota — ignore */
  }
}
function fetchZonalManagersOnce(): Promise<ZonalManager[]> {
  if (zonalManagersPromise) return zonalManagersPromise;
  const cached = readSessionZm();
  if (cached) {
    zonalManagersPromise = Promise.resolve(cached);
    return zonalManagersPromise;
  }
  zonalManagersPromise = api
    .get<ZonalManager[]>('/shared/lookup/zonal-managers')
    .then((data) => {
      writeSessionZm(data);
      return data;
    })
    .catch((e) => {
      zonalManagersPromise = null;
      throw e;
    });
  return zonalManagersPromise;
}

/*
 * Module-level in-flight collapse for the LIST call — PARAM-KEYED so only
 * concurrent IDENTICAL calls (StrictMode's double-mount) collapse into
 * one request; a Search with new filters / page flip fires its own
 * request. Mirrors `fetchListOnce()` in easyfixers/page.tsx.
 */
let listInflight: { key: string; promise: Promise<Resp> } | null = null;
function fetchListOnce(params: Record<string, string | number | undefined>): Promise<Resp> {
  const key = JSON.stringify(params);
  if (listInflight && listInflight.key === key) return listInflight.promise;
  const promise = api.get<Resp>('/admin/easyfixers/registered', params).finally(() => {
    if (listInflight && listInflight.key === key) listInflight = null;
  });
  listInflight = { key, promise };
  return promise;
}

// In-flight dedupe for the status-count strip (no persistent cache — counts
// drift as technicians get verified, so each mount refetches; StrictMode's
// double-mount collapses via the shared in-flight promise). Module-level so it
// satisfies the no-raw-api-in-useEffect rule, same pattern as the list fetch.
let countsInflight: Promise<RegCounts> | null = null;
function fetchRegisteredCountsOnce(): Promise<RegCounts> {
  if (countsInflight) return countsInflight;
  countsInflight = api
    .get<RegCounts>('/admin/easyfixers/registered/status-counts')
    .finally(() => {
      countsInflight = null;
    });
  return countsInflight;
}

export default function RegisteredEasyfixersPage() {
  const router = useRouter();
  const { me } = useMe();
  /*
   * Same bare-verb action keys as the main Manage Easyfixers screen
   * (`isEdit`) — the Legacy CRM (Java) gates its registration screen on
   * the same bare names and both CRMs share the easyfix_core DB seed.
   * The single "Verify Easyfixer" action is gated behind isEdit.
   */
  const can = actionFlags(me, ['isEdit']);

  const [rows, setRows] = useState<RegRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  // Default page size 20 — legacy parity.
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [zonalManagers, setZonalManagers] = useState<ZonalManager[]>([]);
  const [counts, setCounts] = useState<RegCounts | null>(null);
  // Server-side sort via the shared SortHeader / cycleSort (3-click cycle:
  // asc → desc → null). A null sortKey means "BE default order", which is
  // registered_date DESC — same idiom as the Manage Easyfixers roster, so
  // idle columns show no arrow and the BE owns the default ordering.
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Monotonic sequence — a superseded load discards its response.
  const loadSeqRef = useRef(0);

  async function load(
    reset = false,
    overrideFilters?: Filters,
    overridePage?: number,
    overridePageSize?: TablePageSize,
    overrideSort?: { sortBy: string | null; sortDir: SortDir },
  ) {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    const f = overrideFilters ?? filters;
    const pg = reset ? 0 : (overridePage ?? page);
    const ps = overridePageSize ?? pageSize;
    const sb = overrideSort ? overrideSort.sortBy : sortKey;
    const sd = overrideSort ? overrideSort.sortDir : sortDir;
    // BE Joi cap on the registered list is 500 — pass it explicitly so "All"
    // maps to the endpoint's real ceiling (not pageSizeToLimit's 1000 default,
    // which the Joi validator would reject as limit > 500).
    const limit = pageSizeToLimit(ps, 500);
    const offset = pg * (ps === 'all' ? 0 : Number(ps));
    // null sortKey → omit sort params so the BE applies its default order
    // (registered_date DESC). Only an explicitly-clicked column sends them.
    const sortParams = sb ? { sortBy: sb, sortDir: sd } : {};
    try {
      const r = await fetchListOnce({
        limit,
        offset,
        ...sortParams,
        ...buildQuery(f),
      });
      if (seq !== loadSeqRef.current) return; // superseded — discard
      setRows(r.items ?? []);
      setTotal(r.total ?? 0);
      if (reset) setPage(0);
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      setRows([]);
      setTotal(0);
      console.error('Failed to load registered easyfixers', e);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }

  // Single initial-mount load — StrictMode double-fire collapses via
  // fetchListOnce.
  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-shot NDM / State-User lookup, deduped at module scope.
  useEffect(() => {
    let cancelled = false;
    fetchZonalManagersOnce()
      .then((d) => {
        if (!cancelled) setZonalManagers(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Status-count strip — scope-only counts, deduped at module scope.
  useEffect(() => {
    let cancelled = false;
    fetchRegisteredCountsOnce()
      .then((d) => {
        if (!cancelled) setCounts(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function onSearch() {
    setPage(0);
    load(true);
  }
  function onReset() {
    setPage(0);
    setFilters(DEFAULT_FILTERS);
    load(true, DEFAULT_FILTERS);
  }
  // Shared 3-click sort cycle (asc → desc → unsorted) via cycleSort, identical
  // to the Manage Easyfixers roster and every other CRM table.
  function onSort(col: string) {
    const next = cycleSort<string>(col, { sortBy: sortKey, sortDir });
    setSortKey(next.sortBy);
    setSortDir(next.sortDir);
    setPage(0);
    load(true, undefined, 0, undefined, { sortBy: next.sortBy, sortDir: next.sortDir });
  }
  // Status-strip chip → set (or toggle off) the registrationStatus filter.
  function applyStatusFilter(value: string) {
    const next = filters.registrationStatus === value ? '' : value;
    const nf = { ...filters, registrationStatus: next };
    setFilters(nf);
    setPage(0);
    load(true, nf);
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
      Object.entries(q).forEach(([k, v]) => {
        if (v !== undefined && v !== '') params.set(k, String(v));
      });
      await downloadXlsx({
        url: `/admin/easyfixers/registered/download${params.toString() ? `?${params.toString()}` : ''}`,
        filename: `registered-easyfixers-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message || 'Unknown error';
      console.error('Download failed', e);
      showToast({ variant: 'error', message: `Download failed: ${msg}` });
    } finally {
      setDownloading(false);
    }
  }

  const onVerify = useCallback(
    (efrId: number) => {
      router.push(`/easyfixers/${efrId}/verification`);
    },
    [router],
  );

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Registered Easyfixers</h1>
          <p className="text-sm text-muted-foreground">
            {loading ? '…' : total.toLocaleString('en-IN')} Registrations
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DownloadButton onClick={onDownload} downloading={downloading} />
        </div>
      </div>

      {/* Status-count strip — clickable triage; chip sets/toggles the
          registrationStatus filter. Counts are queue-wide (scope-only). */}
      {counts && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => applyStatusFilter('')}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              filters.registrationStatus === ''
                ? 'bg-primary text-primary-foreground border-primary'
                : 'hover:bg-muted',
            )}
          >
            All <span className="font-semibold tabular-nums">{counts.total.toLocaleString('en-IN')}</span>
          </button>
          {COUNT_CHIPS.map(([label, key, value]) => (
            <button
              key={value}
              type="button"
              onClick={() => applyStatusFilter(value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                filters.registrationStatus === value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'hover:bg-muted',
              )}
            >
              {label} <span className="font-semibold tabular-nums">{counts[key].toLocaleString('en-IN')}</span>
            </button>
          ))}
        </div>
      )}

      {/* Filter card — always visible, no toggle. Applies on Search only. */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="text-sm font-medium flex items-center gap-1.5">
            <Search className="h-4 w-4 text-muted-foreground" /> Filter Parameter
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3 items-end">
            <Field label="Registration Status">
              <SearchSelect
                placeholder="All"
                value={filters.registrationStatus}
                onChange={(v) => setFilters({ ...filters, registrationStatus: v })}
                options={REGISTRATION_STATUS_OPTS}
              />
            </Field>
            <Field label="Search">
              <Input
                placeholder="PIN No, Tx ID, Mob. No, Name"
                value={filters.q}
                onChange={(e) => setFilters({ ...filters, q: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSearch();
                }}
              />
            </Field>
            <Field label="Easyfixer Type">
              <SearchSelect
                placeholder="All"
                value={filters.easyfixerType}
                onChange={(v) => setFilters({ ...filters, easyfixerType: v })}
                options={EASYFIXER_TYPE_OPTS}
              />
            </Field>
            <Field label="Applied On">
              <div className="relative z-0 min-w-0 flex flex-wrap gap-1">
                <Input
                  type="date"
                  className="min-w-0 flex-1"
                  value={filters.dateFrom}
                  onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
                />
                <Input
                  type="date"
                  className="min-w-0 flex-1"
                  value={filters.dateTo}
                  onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
                />
              </div>
            </Field>
            <Field label="State User / NDM">
              <SearchSelect
                placeholder="All"
                value={filters.ndmId}
                onChange={(v) => setFilters({ ...filters, ndmId: v })}
                options={zonalManagers.map((z) => ({ value: z.user_id, label: z.user_name }))}
              />
            </Field>
          </div>

          <div className="flex items-center gap-2">
            <Button type="button" onClick={onSearch} disabled={loading}>
              <Search className="h-4 w-4 mr-1" /> Search
            </Button>
            <Button type="button" variant="outline" onClick={onReset}>
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="data-table" style={{ tableLayout: 'fixed', minWidth: '1150px' }}>
              <colgroup>
                <col style={{ width: '90px' }} />{/* Technician Id (sticky) */}
                <col style={{ width: '210px' }} />{/* Technician Details (sticky) */}
                <col style={{ width: '240px' }} />{/* Registration Status */}
                <col style={{ width: '180px' }} />{/* Technician Location */}
                <col style={{ width: '200px' }} />{/* State User */}
                <col style={{ width: '150px' }} />{/* Applied On */}
                <col style={{ width: '90px' }} />{/* Action (sticky) */}
              </colgroup>
              <thead>
                <tr>
                  {/* Technician Id — sortable; sticky-left (col 1, left:0). The
                      queue sorts on the technician id, never the name. */}
                  <SortHeader
                    col="efr_id"
                    align="left"
                    sortBy={sortKey}
                    sortDir={sortDir}
                    onSort={onSort}
                    className="stick-col-head stick-left"
                  >
                    Technician Id
                  </SortHeader>
                  {/* Technician Details (Name + mobile) — sticky-left (col 2,
                      offset by the 90px Id column). */}
                  <th className="!text-left stick-col-head stick-left" style={{ left: '90px' }}>
                    Technician Details
                  </th>
                  <th className="!text-left">Registration Status</th>
                  <th className="!text-left">Technician Location</th>
                  <th className="!text-left">State User</th>
                  <SortHeader
                    col="registered_date"
                    align="left"
                    sortBy={sortKey}
                    sortDir={sortDir}
                    onSort={onSort}
                  >
                    Applied On
                  </SortHeader>
                  <th className="!text-center stick-col-head stick-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="!text-center text-muted-foreground py-6">
                      Loading…
                    </td>
                  </tr>
                )}
                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="!text-center text-muted-foreground py-6">
                      No registrations match the current filters.
                    </td>
                  </tr>
                )}
                {!loading &&
                  rows.map((e) => {
                    const early = !!e.early_activation_eligible;
                    const existing = !!e.is_existing_easyfixer;
                    const label = e.registration_status_label || '—';
                    const showPct =
                      SHOW_PCT_LABELS.has(label) && e.profile_perc != null;
                    const efName = formatEasyfixerName(e.name ?? '');
                    return (
                      <tr key={e.efr_id}>
                        {/* Technician Id (+ early-activation unlock marker) —
                            sticky-left col 1. */}
                        <td className="!text-left font-mono text-xs stick-col stick-left">
                          <span className="inline-flex items-center gap-1 align-middle">
                            <span>{e.efr_id}</span>
                            {early && (
                              <Unlock
                                className="size-3.5 text-amber-500 shrink-0"
                                aria-label="Early Activation Eligible"
                              />
                            )}
                          </span>
                        </td>
                        {/* Technician Details — Name (+ existing-easyfixer
                            marker) over the masked click-to-call mobile.
                            Sticky-left col 2, offset by the 90px Id column.
                            CallableMobile dials via efrId only (BE re-resolves
                            the real number); `mobile` is display-only and
                            already bullet-masked by the response middleware. */}
                        <td className="!text-left stick-col stick-left" style={{ left: '90px' }}>
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="inline-flex items-center gap-1.5 font-medium">
                              <span className="truncate" title={efName}>
                                {efName || '—'}
                              </span>
                              {existing && (
                                <User
                                  className="size-3.5 text-sky-600 shrink-0"
                                  aria-label="Existing Easyfixer"
                                />
                              )}
                            </span>
                            <CallableMobile efrId={e.efr_id} mobile={e.mobile} />
                          </div>
                        </td>
                        {/* Registration Status (+ profile % for 2 labels) */}
                        <td className="!text-left">
                          <div className="flex flex-col gap-0.5 items-start">
                            <StatusChip tone={regStatusTone(label)} size="sm">
                              {label}
                            </StatusChip>
                            {showPct && (
                              <span className="text-[10px] text-muted-foreground tabular-nums">
                                ({Math.round(Number(e.profile_perc))}%)
                              </span>
                            )}
                          </div>
                        </td>
                        {/* Technician Location: city + pincode */}
                        <td className="!text-left">
                          <div className="flex flex-col gap-0.5">
                            <span className="truncate" title={e.city ?? ''}>
                              {e.city ?? '—'}
                            </span>
                            {e.pincode && (
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {e.pincode}
                              </span>
                            )}
                          </div>
                        </td>
                        {/* State User: state name + state-user name */}
                        <td className="!text-left">
                          <div className="flex flex-col gap-0.5">
                            <span className="truncate" title={e.state_name ?? ''}>
                              {e.state_name ?? '—'}
                            </span>
                            {e.state_user_name && (
                              <span className="text-xs text-muted-foreground truncate" title={e.state_user_name}>
                                {e.state_user_name}
                              </span>
                            )}
                          </div>
                        </td>
                        {/* Applied On */}
                        <td className="!text-left text-xs whitespace-nowrap text-muted-foreground">
                          {formatDate(e.registered_date)}
                        </td>
                        {/* Action — single Verify deep-link (sticky-right). Uses
                            the shared Pencil edit icon, same as every other CRM
                            row action. */}
                        <td className="!text-center stick-col stick-right">
                          {can.isEdit && (
                            <IconButton
                              icon={Pencil}
                              intent="primary"
                              label="Verify Easyfixer"
                              onClick={() => onVerify(e.efr_id)}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
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
    </div>
  );
}

/*
 * Small label+control wrapper — keeps the filter grid tidy with
 * consistent label spacing (mirrors the Field helper on the main
 * Manage Easyfixers page).
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 min-w-0">
      <div className="text-xs font-medium text-muted-foreground whitespace-nowrap">{label}</div>
      {children}
    </div>
  );
}
