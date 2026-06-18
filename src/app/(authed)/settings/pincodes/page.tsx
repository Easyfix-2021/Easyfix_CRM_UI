'use client';

/*
 * Manage Pincodes — Settings page (uses tbl_pincode, EasyFix's generic
 * pincode catalog — distinct from pincode_firefox_city_mapping which is
 * firefox-client-specific data).
 *
 * Surface:
 *   - Filterable table: pincode | location | city | district | state | status
 *   - Status pill: LOCAL / TRAVEL (computed from active+verified easyfixers
 *     in the pincode's city). UNZONED is detected at job-create time and
 *     never appears in this list.
 *   - Add/Edit modal — full field set (pincode, location, city dropdown,
 *     district override).
 *   - Bulk Excel upload with dry-run.
 *
 * Backend: /api/admin/pincodes (routes/admin/pincodes.js +
 *   services/pincode.service.js + services/pincode-upload.service.js).
 */

import { useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import {
  MapPin, Search, Plus, Upload,
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, Users, Map as MapIcon,
  Pencil, XCircle, X, RotateCw, Loader2,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { IconButton } from '@/components/ui/icon-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StatusChip } from '@/components/ui/StatusChip';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { Switch } from '@/components/ui/switch';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { cycleSort, SortHeader, type SortDir } from '@/lib/use-sort';
import { api, ApiError } from '@/lib/api';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { useLookup } from '@/lib/use-lookup';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

type Pincode = {
  pincode_id: number;
  pincode: string;
  location: string | null;
  city_id: number | null;
  city_name: string | null;
  district: string | null;
  state_name: string | null;
  zonal_manager_name: string | null;
  is_active: boolean;
  status: 'LOCAL' | 'TRAVEL';
  active_efr_count: number;
  zone_count: number;
  lat: number | null;
  lng: number | null;
};

type ListResponse = {
  items: Pincode[];
  total: number;
};

type StatusFilter = 'ALL' | 'LOCAL' | 'TRAVEL';

// Column keys eligible for the 3-state sort cycle.
//   - SERVER-side sort (sent to /admin/pincodes as sortBy/sortDir):
//     'location', 'zonal_manager', 'is_active' — these are real columns that
//     need the full result set ordered before pagination, so the BE handles
//     them. ('is_active' = the Serviceable/Non-Serviceable "Status" column →
//     BE pincode_status.) Use EXACTLY these key strings; the BE whitelist
//     matches them verbatim.
//   - CLIENT-side sort (over the loaded page, shared comparator):
//     'pincode', 'city_name', 'district', 'state_name', 'lat', 'lng',
//     'zone_count'. Numeric columns (lat/lng/zone_count) sort numerically via
//     the comparator's Number()-detection.
//   - The LOCAL/TRAVEL "Mapping" value is NOT sortable: it's a virtual value
//     the BE derives from active_efr_count AFTER pagination, so it isn't a real
//     column the BE can ORDER BY and a page-local client sort would be misleading.
type SortKey =
  | 'pincode' | 'location' | 'city_name' | 'district' | 'state_name'
  | 'lat' | 'lng' | 'zone_count' | 'zonal_manager' | 'is_active';

// Keys the BACKEND sorts (passed as the `sortBy` query param). Everything
// else is sorted in-memory over the current page.
const SERVER_SORT_KEYS = new Set<SortKey>(['location', 'zonal_manager', 'is_active']);

// BE Joi cap on /admin/pincodes `limit` is 200000; pass it so 'All' maps to
// the endpoint's true ceiling rather than pageSizeToLimit's 1000 default.
const PINCODES_LIMIT_CAP = 200000;

export default function ManagePincodesPage() {
  const router = useRouter();
  const lookup  = useLookup();
  const { me } = useMe();
  const confirm = useConfirm();
  // Permission gating — keys follow the legacy `is{Entity}{Verb}` convention.
  // Production rollout requires seeding the corresponding rows in `menu_action`
  // and assigning them to the Admin role via Manage Roles → action checkboxes.
  const can = actionFlags(me, ['isPincodeAddNew', 'isPincodeUpload']);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  // Serviceable filter: by default the list shows only Serviceable pincodes
  // (pincode_status = 1). Toggle on to ALSO show Non-Serviceable (0) rows so
  // they can be re-marked Serviceable.
  const [showNonServiceable, setShowNonServiceable] = useState(false);
  const [serviceableBusy, setServiceableBusy] = useState<number | null>(null);
  // Bulk recompute ("Refresh Status") busy flag — disables the toolbar button
  // and swaps in a spinner while the POST /refresh-status rewrite runs.
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  // Server-side pagination state. Page is 0-indexed (offset = page * size).
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);

  // Sort state — client-side over the loaded page. Mirrors Manage Clients:
  // own sortBy/sortDir directly and use cycleSort to compute next state.
  const [sortBy, setSortBy] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  function onSortToggle(col: SortKey) {
    const next = cycleSort<SortKey>(col, { sortBy, sortDir });
    setSortBy(next.sortBy);
    setSortDir(next.sortDir);
  }

  const [editing, setEditing] = useState<Pincode | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [techModalPincode, setTechModalPincode] = useState<Pincode | null>(null);
  const [zoneEditPincode, setZoneEditPincode] = useState<Pincode | null>(null);

  // Help panel — collapsed by default (operator-confirmed: most uses of
  // this page are routine, not first-time onboarding). Persisted state
  // means anyone who deliberately opens it stays opened next visit.
  const [howOpen, setHowOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('pincodes-help-collapsed') === '0';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('pincodes-help-collapsed', howOpen ? '0' : '1');
  }, [howOpen]);

  // Debounced server-side search to keep payloads small even as the catalog grows.
  const debouncedSearch = useDebouncedValue(search, 300);
  // Server-side sort is active only for the whitelisted keys (location /
  // zonal_manager). When it changes, reset to page 0 too.
  const serverSortBy = sortBy && SERVER_SORT_KEYS.has(sortBy) ? sortBy : null;
  // Direction only matters for the page-reset when a SERVER sort is active.
  // Pinning it to null while a client-side column is active means flipping a
  // client-side sort's direction doesn't end up in the effect's dep set, so it
  // won't yank the user back to page 1 (client sort only reorders the loaded
  // page anyway). See the items useMemo below for the client-side comparator.
  const serverSortDir = serverSortBy ? sortDir : null;
  // Reset page to 0 whenever filters or the SERVER-side sort change. Client-side
  // sort changes (city/district/state/lat/lng/zone_count) deliberately
  // do NOT reset the page — they reorder only the currently-loaded page.
  useEffect(() => { setPage(0); }, [debouncedSearch, statusFilter, showNonServiceable, serverSortBy, serverSortDir]);

  // Translate the shared page-size sentinel into the BE limit/offset.
  const limit = pageSizeToLimit(pageSize, PINCODES_LIMIT_CAP);
  const urlParams = new URLSearchParams();
  if (debouncedSearch.trim()) urlParams.set('q', debouncedSearch.trim());
  if (statusFilter !== 'ALL') urlParams.set('status', statusFilter);
  if (showNonServiceable) urlParams.set('includeInactive', 'true');
  // Push only the whitelisted columns to the BE; everything else stays client-side.
  if (serverSortBy) {
    urlParams.set('sortBy', serverSortBy);
    urlParams.set('sortDir', sortDir);
  }
  urlParams.set('limit', String(limit));
  urlParams.set('offset', String(page * (pageSize === 'all' ? limit : Number(pageSize))));
  const listUrl = `/admin/pincodes?${urlParams.toString()}`;
  const { data: listData, loading, error: fetchError, refetch } = useFetch<ListResponse>(listUrl);
  const total = listData?.total ?? 0;

  // Sort the loaded page client-side (same comparator as Manage Clients):
  // numeric columns sort numerically, text columns alphabetically (locale,
  // numeric-aware). Null sortBy (3rd click) preserves the BE's pincode-ASC order.
  // Server-sorted keys (location / zonal_manager / is_active) are already ordered
  // by the BE across the whole result set — leave the page as-received.
  const items: Pincode[] = useMemo(() => {
    const arr = (listData?.items ?? []).slice();
    if (!sortBy || SERVER_SORT_KEYS.has(sortBy)) return arr;
    arr.sort((a, b) => {
      const av: unknown = (a as Record<string, unknown>)[sortBy];
      const bv: unknown = (b as Record<string, unknown>)[sortBy];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const na = Number(av), nb = Number(bv);
      const cmp = (!Number.isNaN(na) && !Number.isNaN(nb) && typeof av !== 'string')
        ? na - nb
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [listData?.items, sortBy, sortDir]);

  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(fetchError); }, [fetchError]);

  // Invalidate the 30s module cache for ALL pincode list pages, then refetch.
  function refreshList() {
    invalidateFetch((k) => k.startsWith('/admin/pincodes'));
    refetch();
  }

  // Flip a pincode between Serviceable (pincode_status=1) and Non-Serviceable
  // (0) via the existing PATCH is_active → pincode_status mapping. With the
  // "Show Non-Serviceable" filter OFF, marking one Non-Serviceable drops it from
  // the visible list (it's filtered out) — toggle that filter on to see/restore.
  async function toggleServiceable(p: Pincode) {
    setServiceableBusy(p.pincode_id);
    setError(null);
    try {
      await api.patch(`/admin/pincodes/${p.pincode_id}`, { is_active: !p.is_active });
      refreshList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Status update failed');
    } finally {
      setServiceableBusy(null);
    }
  }

  // Bulk recompute: marks every technician's serviceable + current pincodes as
  // Serviceable and everything else Non-Serviceable. Rewrites ALL rows, so we
  // confirm first, then refresh the list and toast the returned serviceable count.
  async function refreshStatus() {
    const ok = await confirm({
      title: 'Refresh Pincode Status?',
      description:
        "This rewrites every pincode's status — all technicians' serviceable " +
        'pincodes and their current pincodes become Serviceable, and everything ' +
        'else becomes Non-Serviceable. Continue?',
    });
    if (!ok) return;
    setRefreshingStatus(true);
    setError(null);
    try {
      const res = await api.post<{ serviceableCount?: number }>('/admin/pincodes/refresh-status', {});
      refreshList();
      showToast({
        variant: 'success',
        message: `Pincode status refreshed — ${res?.serviceableCount ?? 0} serviceable.`,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Refresh status failed');
    } finally {
      setRefreshingStatus(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="size-6" /> Manage Pincodes
          </h1>
          <p className="text-sm text-muted-foreground">
            EasyFix-owned pincode catalog. Local/Travel status reflects current technician availability.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isPincodeAddNew && (
            <Button
              variant="outline"
              onClick={refreshStatus}
              disabled={refreshingStatus}
            >
              {refreshingStatus
                ? <Loader2 className="size-4 mr-1 animate-spin" />
                : <RotateCw className="size-4 mr-1" />}
              {refreshingStatus ? 'Refreshing…' : 'Refresh Status'}
              {/* Tooltip lives inside the button so there's no separate (i) chip beside it. */}
              <span className="ml-1.5 inline-flex" onClick={(e) => e.stopPropagation()}>
                <InfoTooltip>
                  <strong className="block mb-1">Refresh Status</strong>
                  Marks all technicians&apos; serviceable pincodes + their current pincodes as
                  Serviceable, and everything else Non-Serviceable.
                </InfoTooltip>
              </span>
            </Button>
          )}
          {can.isPincodeUpload && (
            <Button variant="outline" onClick={() => router.push('/settings/pincodes/upload')}>
              <Upload className="size-4 mr-1" /> Upload Pincodes
            </Button>
          )}
          {can.isPincodeAddNew && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add Pincode
            </Button>
          )}
        </div>
      </div>

      {/* Expandable docs */}
      <Card>
        <CardContent className="p-0">
          <button
            type="button"
            onClick={() => setHowOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
            aria-expanded={howOpen}
          >
            {howOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
            <Info className="size-4 shrink-0 text-blue-600" />
            <span className="font-medium">How Pincode Management Works?</span>
            <span className="ml-auto text-xs text-muted-foreground">{howOpen ? 'Hide' : 'Show'}</span>
          </button>
          {howOpen && (
            <div className="px-4 pb-4 pt-1 text-sm text-muted-foreground space-y-3 border-t">
              <section>
                <h3 className="font-semibold text-foreground mb-1">1. The master list</h3>
                <p>
                  Canonical list of pincodes the platform serves. Each row maps a 6-digit pincode to a city,
                  with optional location label and district override. The platform routes jobs to technicians
                  whose service zone covers this pincode&apos;s city.
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-foreground mb-1">2. How a pincode gets a status</h3>
                <p>The status badge is computed live on every page load — no stored flag to maintain:</p>
                <ul className="list-disc pl-5 mt-1 space-y-1">
                  <li>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">
                      <CheckCircle2 className="size-3" /> Local
                    </span>{' — '}
                    at least one active and verified Easyfixer is mapped to a zone covering this pincode&apos;s
                    city. No travel charge applies.
                  </li>
                  <li>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                      Travel
                    </span>{' — '}
                    pincode is listed but no active Easyfixer is currently available in the area.
                    Jobs in this pincode get a <strong>travel charge</strong> (rate-card defined).
                  </li>
                  <li>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
                      Unzoned
                    </span>{' — '}
                    a job was created with a pincode <em>not</em> in this list. The system flags the job,
                    sends an alert to the Project Manager, and treats the job as Travel until the pincode is
                    added here. Won&apos;t appear in this table — only on jobs.
                  </li>
                </ul>
                <p className="mt-2">
                  <strong className="text-foreground">Status changes by itself.</strong> When a technician is
                  onboarded, deactivated, or moved to a different zone, the affected pincodes flip between
                  Local and Travel automatically on the next page load.
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-foreground mb-1">3. How to add pincodes</h3>
                <ul className="list-disc pl-5 space-y-1">
                  <li>
                    <strong className="text-foreground">One at a time:</strong> click <em>+ Add Pincode</em>,
                    fill in the 6-digit code, optional location, city (dropdown), and optional district.
                  </li>
                  <li>
                    <strong className="text-foreground">In bulk:</strong> click <em>Template</em> for an Excel
                    file with the city dropdown pre-filled and locked. Fill the Pincodes sheet, then upload.
                    Run a <em>Dry-run</em> first to validate without inserting — the report shows which rows
                    would succeed, fail, or be skipped (already in the catalog).
                  </li>
                </ul>
              </section>

              <section>
                <h3 className="font-semibold text-foreground mb-1">4. What happens at job creation</h3>
                <ol className="list-decimal pl-5 space-y-1">
                  <li>Customer enters a pincode on a new job.</li>
                  <li>
                    Platform looks up the pincode here. <strong className="text-foreground">Found</strong> →
                    job inherits Local/Travel status. <strong className="text-foreground">Not found</strong>{' '}
                    → job is marked <em>Unzoned</em>, PM alert fires, travel charge applied until you add the
                    pincode here.
                  </li>
                  <li>
                    Auto-allocation picks a technician from the matching zone (Local) or from the nearest
                    serviceable zone with a travel reimbursement (Travel).
                  </li>
                </ol>
              </section>

              <section>
                <h3 className="font-semibold text-foreground mb-1">5. Editing and deactivating</h3>
                <p>
                  The pincode itself is the row key — to change it, deactivate and re-add. Other fields
                  (location, city, district) are editable any time. Deactivating is a soft-delete: the row
                  hides from the default list but historical jobs that reference it remain intact. You can
                  reactivate later by toggling &quot;Active&quot; in the edit modal.
                </p>
              </section>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by pincode, location or city…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="flex items-center gap-1">
            {(['ALL', 'LOCAL', 'TRAVEL'] as StatusFilter[]).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={statusFilter === s ? 'default' : 'outline'}
                onClick={() => setStatusFilter(s)}
              >
                {s === 'ALL' ? 'All' : s === 'LOCAL' ? 'Local' : 'Travel'}
              </Button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer">
            <input
              type="checkbox"
              checked={showNonServiceable}
              onChange={(e) => setShowNonServiceable(e.target.checked)}
            />
            Show Non-Serviceable
          </label>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle className="size-4" /> {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          {/* Fixed layout + explicit per-column widths so the row total exceeds
              the viewport, triggering horizontal scroll and letting the frozen
              Pincode (left) + Action (right) columns stay pinned. */}
          <table className="data-table w-full" style={{ tableLayout: 'fixed', minWidth: '1400px' }}>
            <colgroup>
              <col style={{ width: '110px' }} />{/* Pincode (frozen left) */}
              <col style={{ width: '180px' }} />{/* Location */}
              <col style={{ width: '160px' }} />{/* City */}
              <col style={{ width: '160px' }} />{/* District */}
              <col style={{ width: '150px' }} />{/* State */}
              <col style={{ width: '110px' }} />{/* Latitude */}
              <col style={{ width: '110px' }} />{/* Longitude */}
              <col style={{ width: '90px'  }} />{/* Zones */}
              <col style={{ width: '170px' }} />{/* Zonal Manager */}
              <col style={{ width: '130px' }} />{/* Status */}
              <col style={{ width: '180px' }} />{/* Mapping */}
              <col style={{ width: '110px' }} />{/* Action (frozen right) */}
            </colgroup>
            <thead>
              <tr>
                <SortHeader col={'pincode'       as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle} className="whitespace-nowrap stick-col-head stick-left">Pincode</SortHeader>
                <SortHeader col={'location'      as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle} className="whitespace-nowrap">Location</SortHeader>
                <SortHeader col={'city_name'     as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle} className="whitespace-nowrap">City</SortHeader>
                <SortHeader col={'district'      as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle} className="whitespace-nowrap">District</SortHeader>
                <SortHeader col={'state_name'    as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle} className="whitespace-nowrap">State</SortHeader>
                <SortHeader col={'lat'           as SortKey} align="right"  sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle} className="whitespace-nowrap">Latitude</SortHeader>
                <SortHeader col={'lng'           as SortKey} align="right"  sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle} className="whitespace-nowrap">Longitude</SortHeader>
                <SortHeader col={'zone_count'    as SortKey} align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle} className="whitespace-nowrap">Zones</SortHeader>
                {/* Zonal Manager — city's zonal manager (tbl_city.state_user). Server-side sort. */}
                <SortHeader col={'zonal_manager' as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle} className="whitespace-nowrap">Zonal Manager</SortHeader>
                {/* Status = Serviceable / Non-Serviceable. Real pincode_status column → server-side sort. */}
                <SortHeader col={'is_active'     as SortKey} align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle} className="whitespace-nowrap">Status</SortHeader>
                {/* Mapping = Local / Travel (virtual, derived post-pagination) — not sortable. */}
                <th className="!text-center whitespace-nowrap">Mapping</th>
                {/* Action = frozen right column; switch to flip Serviceable status. */}
                <th className="!text-center whitespace-nowrap stick-col-head stick-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={12} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={12} className="!text-center text-muted-foreground py-6">No pincodes match the current filters.</td></tr>
              )}
              {!loading && items.map((p) => (
                <tr key={p.pincode_id}>
                  {/* Pincode — frozen left column; opaque bg so scrolled cells don't bleed through. */}
                  <td className="!text-left font-mono whitespace-nowrap stick-col stick-left">{p.pincode}</td>
                  <td className="!text-left whitespace-nowrap truncate">{p.location ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left whitespace-nowrap truncate">{p.city_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left whitespace-nowrap truncate">{p.district ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left whitespace-nowrap truncate">{p.state_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-right font-mono text-sm whitespace-nowrap">
                    {p.lat != null ? p.lat.toFixed(5) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-right font-mono text-sm whitespace-nowrap">
                    {p.lng != null ? p.lng.toFixed(5) : <span className="text-muted-foreground">—</span>}
                  </td>
                  {/* Zones — pin icon + count; click opens the reverse zone-map editor. */}
                  <td className="!text-center tabular-nums whitespace-nowrap">
                    {can.isPincodeAddNew ? (
                      <button
                        type="button"
                        onClick={() => setZoneEditPincode(p)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                        title={p.zone_count > 0 ? 'Edit Zone Mapping' : 'Map Zones (None Assigned)'}
                      >
                        <MapPin className="size-4 shrink-0" />
                        <span className="tabular-nums">{p.zone_count}</span>
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                        <MapPin className="size-4 shrink-0" />{p.zone_count}
                      </span>
                    )}
                  </td>
                  {/* Zonal Manager — city's zonal manager; blank/— for a new city. */}
                  <td className="!text-left whitespace-nowrap truncate">{p.zonal_manager_name ?? <span className="text-muted-foreground">—</span>}</td>
                  {/* Status — Serviceable / Non-Serviceable (read-only label). */}
                  <td className="!text-center whitespace-nowrap">
                    <span className={`text-xs font-medium ${p.is_active ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {p.is_active ? 'Serviceable' : 'Non-Serviceable'}
                    </span>
                  </td>
                  {/* Mapping — Local / Travel (live technician availability). */}
                  <td className="!text-center whitespace-nowrap">
                    <StatusPill
                      status={p.status}
                      count={p.active_efr_count}
                      onClick={p.active_efr_count > 0 ? () => setTechModalPincode(p) : undefined}
                    />
                  </td>
                  {/* Action — frozen right; Edit + Serviceable-toggle via the shared
                      naked IconButton (one canonical per-row action style). */}
                  <td className="!text-center whitespace-nowrap stick-col stick-right">
                    {can.isPincodeAddNew ? (
                      <div className="inline-flex items-center justify-end gap-0.5">
                        <IconButton
                          icon={Pencil}
                          label="Edit"
                          intent="primary"
                          onClick={() => { setEditing(p); setModalOpen(true); }}
                        />
                        {p.is_active ? (
                          <IconButton
                            icon={XCircle}
                            label="Mark Non-Serviceable"
                            intent="danger"
                            busy={serviceableBusy === p.pincode_id}
                            onClick={() => toggleServiceable(p)}
                          />
                        ) : (
                          <IconButton
                            icon={CheckCircle2}
                            label="Mark Serviceable"
                            intent="success"
                            busy={serviceableBusy === p.pincode_id}
                            onClick={() => toggleServiceable(p)}
                          />
                        )}
                      </div>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {/* Pagination band — shared component, server-side paged. */}
          <div className="px-3 py-2 border-t">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </div>
        </CardContent>
      </Card>

      <PincodeFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        cityOptions={lookup.toOpts.cities}
        stateOptions={lookup.toOpts.states}
        zones={lookup.zones}
        onSaved={() => { setModalOpen(false); refreshList(); }}
        onSwitchToEdit={(p) => setEditing(p)}
      />

      <PincodeTechniciansModal
        pincode={techModalPincode}
        onClose={() => setTechModalPincode(null)}
      />

      <PincodeZonesModal
        pincode={zoneEditPincode}
        onClose={() => setZoneEditPincode(null)}
        onSaved={() => { setZoneEditPincode(null); refreshList(); }}
      />
    </div>
  );
}

// ─── Status pill ────────────────────────────────────────────────────
function StatusPill({
  status,
  count,
  onClick,
}: {
  status: 'LOCAL' | 'TRAVEL';
  count: number;
  onClick?: () => void;
}) {
  const label = count === 1 ? '1 Technician' : `${count} Technicians`;

  if (status === 'LOCAL') {
    if (onClick) {
      return (
        <button
          type="button"
          onClick={onClick}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors cursor-pointer"
          title={`View ${label} servicing this pincode`}
        >
          <CheckCircle2 className="size-3" /> Local · {label}
        </button>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
        <CheckCircle2 className="size-3" /> Local · {label}
      </span>
    );
  }

  // TRAVEL status — count is 0 so no click handler is expected
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
      Travel
    </span>
  );
}

// ─── Geocode + zone-suggestion contract (Add flow) ──────────────────
type GeocodeResp = {
  pincode: string;
  duplicate: {
    pincode_id: number; location: string | null; city_name: string | null;
    state_name: string | null; is_active: boolean;
  } | null;
  geocoded: boolean;
  lat: number | null;
  lng: number | null;
  district: string | null;
  google: { state: string | null; city: string | null; district: string | null };
  state: { state_id: number | null; name: string | null; isNew: boolean };
  city:  { city_id: number | null; name: string | null; state_id: number | null; isNew: boolean };
};

type ZoneSuggestion = {
  zone_id: number;
  zone_name: string;
  // 'random' is the pad reason: suggest-zones now ALWAYS returns 3, filling
  // any shortfall with random active zones flagged 'random'.
  reason: 'same_city' | 'nearby' | 'random';
  distance_km: number | null;
};
type SuggestZonesResp = { suggestions: ZoneSuggestion[] };

// ─── Add/Edit modal ─────────────────────────────────────────────────
function PincodeFormModal({
  open, onClose, editing, cityOptions, stateOptions, zones, onSaved, onSwitchToEdit,
}: {
  open: boolean;
  onClose: () => void;
  editing: Pincode | null;
  cityOptions: SearchOption[];
  stateOptions: SearchOption[];
  zones: Array<{ zone_id: number; zone_name: string }>;
  onSaved: () => void;
  // Add-flow duplicate auto-open: when the geocode finds the pincode already
  // exists, the modal loads that row's detail and hands it up so the parent
  // flips `editing`, turning THIS open modal into the Edit view for it.
  onSwitchToEdit: (pincode: Pincode) => void;
}) {
  const isEdit = !!editing;
  const confirm = useConfirm();
  const [pincode,  setPincode]  = useState('');
  const [location, setLocation] = useState('');
  const [cityId,   setCityId]   = useState<number | ''>('');
  const [district, setDistrict] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Add-flow geocode state ──
  // The geocode result drives the whole Add form. `geo` is null until the
  // operator fetches details for a valid 6-digit pincode. lat/lng are kept
  // separately so they survive into the POST body. `cityOverride` lets the
  // operator map a geocoded NEW city onto an EXISTING one (becomes city_id).
  const [geo, setGeo] = useState<GeocodeResp | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  // ADD-path prefilled State name (geocoded). EDIT keeps it null (state isn't
  // editable in the PATCH contract — only location/city/district/is_active).
  const [stateName, setStateName] = useState('');
  const [cityName, setCityName] = useState('');
  const [cityOverride, setCityOverride] = useState<number | ''>('');
  // Existing-state override (mirror of cityOverride). When set, the new city is
  // attached to this existing state_id instead of creating a new state.
  const [stateOverride, setStateOverride] = useState<number | ''>('');
  const [suggestions, setSuggestions] = useState<ZoneSuggestion[]>([]);
  // The chosen zone set (shared by Add + Edit). Edit pre-loads the pincode's
  // current zones; Add starts empty.
  const [selectedZones, setSelectedZones] = useState<Set<number>>(new Set());
  // Set when an Add geocode found a duplicate and we auto-switched this modal
  // into Edit for the existing row — drives a brief inline note in the header.
  const [openedFromDuplicate, setOpenedFromDuplicate] = useState(false);

  // Monotonic geocode request id. Captured before each await; on resolution we
  // only apply the result if this is still the latest in-flight request. This
  // cancels (ignores) a stale geocode when the operator edits the pincode digits
  // while a previous fetch is still pending — a superseded fetch never re-enables
  // the form with stale state. (api has no AbortSignal hook, so we guard by id.)
  const geoReqIdRef = useRef(0);

  // EDIT preload — dedup the pincode-detail fetch through the shared cache
  // instead of a raw api.get. Keyed null in Add mode (and while closed) so it
  // never fires there. detail.zones seeds the selected set ONCE per open.
  const editDetailKey = (open && isEdit && editing) ? `/admin/pincodes/${editing.pincode_id}` : null;
  const { data: editDetail } = useFetch<PincodeDetail>(editDetailKey);
  // Tracks which pincode_id we've already seeded zones for this open, so the
  // seed runs once and doesn't clobber the operator's subsequent edits on every
  // render (or on a cache-driven re-resolve).
  const seededZonesForRef = useRef<number | null>(null);

  // Quick name lookup for rendering chips of zones the suggestions list may
  // not contain (e.g. an Edit pincode's pre-existing zone or a manually added
  // one). Falls back to the suggestion list, then to "Zone #id".
  const zoneNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const z of zones) m.set(z.zone_id, z.zone_name);
    for (const s of suggestions) if (!m.has(s.zone_id)) m.set(s.zone_id, s.zone_name);
    return m;
  }, [zones, suggestions]);

  // All active zones as SearchSelect options (the "add any zone" input box).
  const zoneOptions = useMemo<SearchOption[]>(
    () => zones.map((z) => ({ value: z.zone_id, label: z.zone_name })),
    [zones],
  );

  useEffect(() => {
    if (open) {
      setPincode (editing?.pincode  ?? '');
      setLocation(editing?.location ?? '');
      setCityId  (editing?.city_id  ?? '');
      setDistrict(editing?.district ?? '');
      setIsActive(editing?.is_active ?? true);
      setStateName(editing?.state_name ?? '');
      setCityName(editing?.city_name ?? '');
      setError(null);
      // Reset add-flow state on every open so a fresh Add never inherits a
      // previous session's geocode / zone picks.
      setGeo(null);
      setGeoLoading(false);
      setLat(editing?.lat ?? null);
      setLng(editing?.lng ?? null);
      setCityOverride('');
      setStateOverride('');
      setSuggestions([]);
      setSelectedZones(new Set());
      // Allow the EDIT detail fetch to re-seed zones for this fresh open.
      seededZonesForRef.current = null;
    }
  }, [open, editing]);

  // Clear the "opened from duplicate" note ONLY on a genuine open/close
  // transition — keyed on `open` alone so the editing-driven re-run of the
  // prefill effect above (which fires when the duplicate auto-switch flips
  // `editing`) doesn't wipe the note we just set.
  useEffect(() => {
    if (open) setOpenedFromDuplicate(false);
  }, [open]);

  // ── Add-flow derived flags ──
  const isDuplicate = !!geo?.duplicate;
  // The effective existing-city id: an explicit override wins; otherwise the
  // geocoder's matched city (when it matched an existing one).
  const effectiveCityId: number | null = cityOverride !== ''
    ? Number(cityOverride)
    : (geo && !geo.city.isNew ? geo.city.city_id : null);
  // Treat the city as NEW only when the geocoder flagged it new AND the
  // operator hasn't overridden it onto an existing city.
  const cityIsNew = !!geo && geo.city.isNew && cityOverride === '';
  // Effective existing-state id: an explicit override wins; otherwise the
  // geocoder's matched state (when it matched an existing one).
  const effectiveStateId: number | null = stateOverride !== ''
    ? Number(stateOverride)
    : (geo && !geo.state.isNew ? geo.state.state_id : null);
  // A new state will be created on save only when the geocoder flagged the
  // state new AND the operator hasn't re-targeted it onto an existing state.
  const stateIsNew = !!geo && geo.state.isNew && stateOverride === '';

  // Fetch the 3 zone recommendations (always padded to 3 by the BE) for the
  // given city/coords. Shared by the Add geocode flow and the Edit preload.
  async function loadSuggestions(cityIdArg: number | null, latArg: number | null, lngArg: number | null) {
    const sp = new URLSearchParams();
    if (cityIdArg != null) sp.set('cityId', String(cityIdArg));
    if (latArg != null) sp.set('lat', String(latArg));
    if (lngArg != null) sp.set('lng', String(lngArg));
    // Over-fetch (BE caps at 10) so the "promote on select" UI can backfill:
    // we render up to 3 recommendations that aren't already selected, and as
    // the operator picks one the next buffered suggestion takes its slot.
    sp.set('limit', '8');
    try {
      const s = await api.get<SuggestZonesResp>(`/admin/pincodes/suggest-zones?${sp.toString()}`);
      setSuggestions(s.suggestions ?? []);
    } catch {
      // Suggestions are advisory — a failure here shouldn't block the form.
      setSuggestions([]);
    }
  }

  async function fetchDetails() {
    if (!/^\d{6}$/.test(pincode)) { setError('Pincode must be exactly 6 digits'); return; }
    // Bump + capture the request id for this fetch. Any earlier in-flight fetch
    // now holds a stale id and will be ignored when it resolves.
    const reqId = ++geoReqIdRef.current;
    const reqPincode = pincode;
    setError(null);
    setGeoLoading(true);
    setGeo(null);
    setSuggestions([]);
    setSelectedZones(new Set());
    setCityOverride('');
    setStateOverride('');
    try {
      const g = await api.get<GeocodeResp>(`/admin/pincodes/geocode?pincode=${reqPincode}`);
      // Stale-response guard: a newer fetch superseded this one — drop it.
      if (reqId !== geoReqIdRef.current) return;
      setGeo(g);
      setLat(g.lat);
      setLng(g.lng);
      setDistrict(g.district ?? g.google.district ?? '');
      // Prefill the now-enabled editable fields from the geocode result.
      setStateName(g.state.name ?? '');
      setCityName(g.city.name ?? '');
      setLocation((prev) => prev || g.google.city || g.city.name || '');
      // Duplicate → auto-open the existing row for editing instead of leaving
      // the operator on a dead-end "already exists" warning. Load the full
      // pincode detail and hand it up so the parent flips `editing`, turning
      // THIS modal into the Edit view. (The geocode `duplicate` payload only
      // carries a partial row, so we fetch the canonical detail by id.)
      if (g.duplicate?.pincode_id != null) {
        try {
          const existing = await api.get<PincodeDetail>(`/admin/pincodes/${g.duplicate.pincode_id}`);
          if (reqId !== geoReqIdRef.current) return;   // superseded — drop
          setOpenedFromDuplicate(true);
          onSwitchToEdit(existing);
        } catch {
          // Fall back to the inline duplicate warning if the detail fetch
          // fails — `geo.duplicate` is still set so the red banner shows.
        }
        return;
      }
      await loadSuggestions(
        g.city.city_id != null && !g.city.isNew ? g.city.city_id : null,
        g.lat,
        g.lng,
      );
    } catch (e) {
      // Only surface the error if this is still the latest request.
      if (reqId === geoReqIdRef.current) {
        setError(e instanceof ApiError ? e.message : 'Failed to fetch pincode details');
      }
    } finally {
      // Only the latest request controls the loading flag, so a superseded
      // fetch resolving late can't flip the spinner off mid-flight.
      if (reqId === geoReqIdRef.current) setGeoLoading(false);
    }
  }

  // ── ADD: auto-fetch on a valid 6-digit pincode (debounced ~450ms) ──
  // Re-editing the digits clears `geo` (see the Pincode onChange handler),
  // which re-disables the fields until this fires again.
  const debouncedPincode = useDebouncedValue(pincode, 450);
  useEffect(() => {
    if (!open || isEdit) return;
    if (/^\d{6}$/.test(debouncedPincode) && !geo && !geoLoading) {
      void fetchDetails();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedPincode, open, isEdit]);

  // ── EDIT: seed current zones from the (deduped) detail fetch — once ──
  // editDetail comes from useFetch, so the request is cache-deduped. Seed the
  // selected set exactly once per open (guarded by seededZonesForRef) so the
  // operator's subsequent add/remove edits aren't clobbered on a re-resolve.
  useEffect(() => {
    if (!open || !isEdit || !editing || !editDetail) return;
    if (editDetail.pincode_id !== editing.pincode_id) return;       // stale cache hit for a different row
    if (seededZonesForRef.current === editing.pincode_id) return;   // already seeded this open
    if (editDetail.zones) setSelectedZones(new Set(editDetail.zones.map((z) => z.zone_id)));
    seededZonesForRef.current = editing.pincode_id;
  }, [open, isEdit, editing, editDetail]);

  // ── EDIT: load zone recommendations on open (advisory, separate fetch) ──
  useEffect(() => {
    if (!open || !isEdit || !editing) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) await loadSuggestions(editing.city_id, editing.lat, editing.lng);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, editing]);

  function addZone(id: number) {
    setSelectedZones((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function removeZone(id: number) {
    setSelectedZones((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  // Replace the whole set in one shot — the multi-select dropdown returns the
  // full next selection on each toggle (stays open across multiple picks).
  function replaceZones(ids: number[]) {
    setSelectedZones(new Set(ids));
  }

  async function handleSubmit() {
    setError(null);
    if (isEdit) {
      if (!cityId) { setError('City is required'); return; }
      setSubmitting(true);
      try {
        // 1. Save the editable scalar fields (PATCH contract does NOT accept zones).
        await api.patch(`/admin/pincodes/${editing!.pincode_id}`, {
          location:  location || null,
          city_id:   Number(cityId),
          district:  district || null,
          is_active: isActive,
        });
        // 2. Persist the zone mapping separately. If this fails the PATCH is
        //    already committed, so surface a softer toast and still close.
        try {
          await api.put(`/admin/pincodes/${editing!.pincode_id}/zones`, {
            zoneIds: Array.from(selectedZones),
          });
          showToast({ variant: 'success', message: 'Pincode updated.' });
        } catch {
          showToast({ variant: 'error', message: 'Pincode saved, but zone mapping failed to update.' });
        }
        onSaved();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Save failed');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // ── ADD path ──
    if (!/^\d{6}$/.test(pincode)) { setError('Pincode must be exactly 6 digits'); return; }
    if (!geo) { setError('Fetch the pincode details first.'); return; }
    if (isDuplicate) { setError('This pincode already exists — edit the existing record instead.'); return; }
    if (effectiveCityId == null && !cityIsNew) {
      setError('A city could not be determined. Pick an existing city to map this pincode.');
      return;
    }

    // Confirm before silently creating a new State and/or City.
    if (stateIsNew || cityIsNew) {
      const parts: string[] = [];
      const newStateName = stateName.trim() || geo.state.name;
      const newCityName = cityName.trim() || geo.city.name;
      if (stateIsNew && newStateName) parts.push(`State "${newStateName}"`);
      if (cityIsNew && newCityName)   parts.push(`City "${newCityName}"`);
      const ok = await confirm({
        title: 'Create New Location?',
        description: `This will create new ${parts.join(' and ')}. Continue?`,
      });
      if (!ok) return;
    }

    setSubmitting(true);
    try {
      // Build the POST payload. The city decision: an existing/overridden city
      // sends `city_id`; a geocoded new city sends `newCity` (with state_id if
      // the state matched, else state_name so the BE creates both).
      const body: {
        pincode: string;
        location: string | null;
        district: string | null;
        lat: number | null;
        lng: number | null;
        is_active: boolean;
        city_id?: number;
        newCity?: { city_name: string; state_id?: number; state_name?: string };
        zoneIds?: number[];
      } = {
        pincode,
        location: location || null,
        district: district || null,
        lat,
        lng,
        is_active: isActive,
      };
      if (effectiveCityId != null) {
        body.city_id = effectiveCityId;
      } else {
        // Honor any operator edits to the City name (editable per spec); fall
        // back to the raw geocode name. State resolution: an existing state
        // (geocoder-matched OR operator-overridden) is pinned by state_id and
        // we DON'T send state_name. Only a genuinely-new, non-overridden state
        // sends state_name so the BE creates both state + city.
        body.newCity = {
          city_name: (cityName.trim() || geo.city.name) ?? '',
          state_id: effectiveStateId ?? undefined,
          state_name: stateIsNew
            ? (stateName.trim() || geo.state.name || undefined)
            : undefined,
        };
      }
      if (selectedZones.size > 0) body.zoneIds = Array.from(selectedZones);

      await api.post('/admin/pincodes', body);
      showToast({ variant: 'success', message: 'Pincode added.' });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  // The full 2-column field grid is shown for Edit, or for Add once a
  // non-duplicate geocode lands. Until then (Add pre-fetch, or a duplicate
  // warning) only the single Pincode field is visible — so the dialog uses a
  // NARROW width to avoid the half-empty look; it widens once the form reveals.
  const showFullForm = isEdit || (!!geo && !isDuplicate);

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      {/* Adaptive width: narrow (max-w-md) while only the Pincode field shows;
          wide (max-w-3xl) once the 2-column field grid is revealed. Capped
          height with an internal scroll region so the tall Add flow never
          overflows short viewports — header + footer stay pinned. */}
      <DialogContent
        className={`${showFullForm ? 'max-w-3xl' : 'max-w-md'} p-0 overflow-hidden flex flex-col max-h-[85vh] transition-[max-width] duration-200`}
      >
        <DialogHeader className="!mx-0 !mt-0 px-6 py-4 mb-0">
          <DialogTitle>{isEdit ? 'Edit Pincode' : 'Add Pincode'}</DialogTitle>
          {openedFromDuplicate && (
            <div className="text-[12px] text-slate-300/85 mt-0.5">
              This pincode already exists — opened for editing.
            </div>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {/* ── Row 1: Pincode (left) + Status toggle (right) ──
              Single-column (Pincode full width) until the Status toggle is
              revealed (pre-fetch / duplicate); 2-col only once the full form
              shows, so the lone Pincode field doesn't sit awkwardly in the
              left half of the narrow modal. */}
          <div className={`grid grid-cols-1 ${showFullForm ? 'sm:grid-cols-2' : ''} gap-3 items-start`}>
            {/* Pincode — always visible. In Add mode this is the ONLY field shown
                until a geocode lands; the rest reveal afterward. */}
            <div>
              <label className="text-sm font-medium block mb-1">Pincode *</label>
              <div className="relative">
                <Input
                  value={pincode}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setPincode(v);
                    // Re-editing the digits invalidates any stale geocode, which
                    // re-hides every downstream field until the auto-fetch
                    // re-runs on the next valid 6-digit value.
                    if (!isEdit && geo) {
                      setGeo(null);
                      setSuggestions([]);
                      setSelectedZones(new Set());
                      setCityOverride('');
                      setStateOverride('');
                      setStateName('');
                      setCityName('');
                    }
                  }}
                  placeholder="Enter 6 digits — details load automatically"
                  disabled={isEdit}
                  className="font-mono"
                />
                {!isEdit && geoLoading && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                    Fetching…
                  </span>
                )}
              </div>
              {isEdit ? (
                <p className="text-xs text-muted-foreground mt-1">
                  Pincode is the row key; to change it, deactivate and re-add.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">
                  Other fields unlock once the pincode is geocoded.
                </p>
              )}
            </div>

            {/* Status toggle — Edit always; Add only after a geocode. Sits in a
                field-height bordered row so it lines up cleanly with the Pincode
                input on the left. */}
            {(isEdit || (geo && !isDuplicate)) && (
              <div>
                <label className="text-sm font-medium block mb-1">Status</label>
                <div className="flex h-9 items-center justify-between gap-2 rounded-md border border-input bg-background px-3">
                  <span className={`text-sm font-medium ${isActive ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {isActive ? 'Serviceable' : 'Non-Serviceable'}
                  </span>
                  <Switch checked={isActive} onCheckedChange={setIsActive} ariaLabel="Serviceable status" />
                </div>
              </div>
            )}
          </div>

          {/* ── Duplicate warning (Add path) ── */}
          {!isEdit && isDuplicate && geo?.duplicate && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2 flex items-start gap-2">
              <AlertTriangle className="size-4 mt-0.5 shrink-0" />
              <span>
                Pincode already exists in{' '}
                <span className="font-medium">
                  {geo.duplicate.city_name ?? '—'}{geo.duplicate.state_name ? `, ${geo.duplicate.state_name}` : ''}
                </span>{' '}— edit the existing record instead.
              </span>
            </div>
          )}

          {/* ── Detail fields — Edit always; Add only after a successful geocode.
              Identical 3-row grid for both flows; the Add flow adds the geocode
              create-new-location affordances inside the City cell + a new-state
              block below. ── */}
          {(isEdit || (geo && !isDuplicate)) && (
            <>
              {/* Row 2: Location + District */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium block mb-1">Location</label>
                  <Input
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder='e.g. "Sector 18", "Andheri East" — optional'
                  />
                </div>
                <div>
                  <label className="text-sm font-medium block mb-1">District (Optional)</label>
                  <Input
                    value={district}
                    onChange={(e) => setDistrict(e.target.value)}
                    placeholder="Inherits the city's district if blank"
                  />
                </div>
              </div>

              {/* Row 3: City (searchable dropdown, left) + Map Zones (right) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
                {/* City */}
                <div>
                  <label className="text-sm font-medium block mb-1">City *</label>
                  {isEdit ? (
                    <>
                      <SearchSelect
                        value={cityId === '' ? '' : cityId}
                        onChange={(v) => setCityId(v === '' ? '' : Number(v))}
                        options={cityOptions}
                        placeholder="Search Cities…"
                      />
                      {editing?.state_name && (
                        <p className="text-xs text-muted-foreground mt-1">
                          State: <span className="text-foreground">{editing.state_name}</span>
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      {/* Add: geocoded city name (editable) + New chip + map-to-existing override */}
                      <div className="flex items-center gap-2 mb-1">
                        <Input
                          value={cityName}
                          onChange={(e) => setCityName(e.target.value)}
                          placeholder="City"
                        />
                        {cityIsNew && <StatusChip tone="amber" size="sm">New</StatusChip>}
                      </div>
                      <SearchSelect
                        value={cityOverride}
                        onChange={(v) => setCityOverride(v === '' ? '' : Number(v))}
                        options={cityOptions}
                        placeholder="Or map to an existing city…"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        {cityOverride !== ''
                          ? 'This pincode will be mapped to the selected existing city.'
                          : geo?.city.isNew
                            ? 'No existing match — a new city will be created on save. Override above to map it to an existing city.'
                            : 'Matched an existing city.'}
                      </p>
                    </>
                  )}
                </div>

                {/* Map Zones */}
                <ZoneMappingField
                  zoneOptions={zoneOptions}
                  zoneNameById={zoneNameById}
                  suggestions={suggestions}
                  selectedZones={selectedZones}
                  onReplace={replaceZones}
                  onAdd={addZone}
                  onRemove={removeZone}
                />
              </div>

              {/* Row 4 (Add only): State. The existing-state override is ALWAYS
                  offered while adding so the operator can re-target even a
                  geocoder-MATCHED state. When the geocoded state is genuinely new
                  it gets the amber "will be created" treatment + an editable name;
                  when matched it shows the matched name as context. Choosing an
                  existing state sends newCity.state_id (no state_name) — see the
                  POST body builder. (Only consumed when a NEW city is created;
                  for an existing/overridden city the state comes from that city.) */}
              {!isEdit && (
                <div
                  className={`rounded border p-3 space-y-2 ${
                    stateIsNew ? 'border-amber-200 bg-amber-50' : 'border-input bg-muted/30'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-medium">State</label>
                    {stateIsNew && <StatusChip tone="amber" size="sm">New</StatusChip>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {stateIsNew
                      ? "This pincode's state isn't in our records yet — it will be created on save, or map it to an existing state instead."
                      : stateOverride !== ''
                        ? 'A new city (if created) will be attached to the selected existing state.'
                        : 'Matched an existing state. Re-target it below if needed.'}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-start">
                    {stateIsNew ? (
                      <Input
                        value={stateName}
                        onChange={(e) => {
                          setStateName(e.target.value);
                          if (stateOverride !== '') setStateOverride('');
                        }}
                        placeholder="New state name"
                        disabled={stateOverride !== ''}
                      />
                    ) : (
                      <div className="flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm text-foreground">
                        {stateOverride !== ''
                          ? (stateOptions.find((o) => Number(o.value) === Number(stateOverride))?.label ?? (stateName || '—'))
                          : (stateName || '—')}
                      </div>
                    )}
                    <SearchSelect
                      value={stateOverride}
                      onChange={(v) => {
                        const next = v === '' ? '' : Number(v);
                        setStateOverride(next);
                        if (next !== '') setStateName('');
                      }}
                      options={stateOptions}
                      placeholder="Or map to an existing state…"
                    />
                  </div>
                </div>
              )}

              {/* Coordinates (read-only) — own labelled caption, grouped at the
                  foot of the form for a balanced layout. */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
                <MapPin className="size-3.5 shrink-0" />
                {lat != null && lng != null ? (
                  <span>
                    Coordinates:{' '}
                    <span className="font-mono text-foreground">{lat.toFixed(5)}, {lng.toFixed(5)}</span>
                  </span>
                ) : (
                  <span>Coordinates: not available from geocoding</span>
                )}
              </div>
            </>
          )}

          {error && (
            <div className="text-sm text-red-600 flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}
        </div>

        {/* Pinned footer */}
        <div className="flex justify-end gap-2 px-6 py-3 border-t">
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button
            onClick={handleSubmit}
            disabled={submitting || (!isEdit && (!geo || isDuplicate || geoLoading))}
          >
            {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Pincode'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Portaled hover tooltip ─────────────────────────────────────────
/*
 * InfoTooltip — a small (i) icon whose hover bubble renders through a
 * `createPortal` into <body> and is positioned `fixed` via the
 * trigger's getBoundingClientRect. This escapes the modal's
 * `overflow-y-auto` / `overflow-hidden` ancestors that would otherwise
 * clip a plain `absolute` tooltip (z-index does NOT defeat overflow
 * clipping). Same posture as the SearchSelect popover. The bubble is
 * anchored below the icon and centred horizontally on it, clamped to
 * stay within the viewport.
 */
function InfoTooltip({ children, width = 288 }: { children: React.ReactNode; width?: number }) {
  const [shown, setShown] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Recompute position whenever the tooltip becomes visible, reading the
  // live rect so modal scroll position is reflected at hover time.
  useLayoutEffect(() => {
    if (!shown || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const gap = 6;
    const half = width / 2;
    let left = r.left + r.width / 2 - half;
    // Clamp horizontally into the viewport (8px margin each side).
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    setPos({ top: r.bottom + gap, left });
  }, [shown, width]);

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex"
      onMouseEnter={() => setShown(true)}
      onMouseLeave={() => setShown(false)}
    >
      <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
      {shown && typeof document !== 'undefined' && createPortal(
        <span
          role="tooltip"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width }}
          className="pointer-events-none z-[60] rounded-md border bg-white p-2 text-left text-[11px] font-normal normal-case leading-snug text-foreground shadow-lg"
        >
          {children}
        </span>,
        document.body,
      )}
    </span>
  );
}

// ─── In-modal Map Zones field (Add + Edit) ──────────────────────────
/*
 * ZoneMappingField — the "Map Zones" control shared by the Add and Edit
 * pincode flows. Composition:
 *   - a searchable MULTI-SELECT dropdown (SearchMultiSelect, +/- per option)
 *     that stays open so several zones can be toggled in one go;
 *   - the chosen zones rendered as removable chips UNDER the input;
 *   - directly below, up to 3 quick-add recommendation chips ("+ <Zone> ~
 *     <distance>") drawn from the suggest-zones results that aren't already
 *     selected. A picked recommendation is promoted into the chips, and the
 *     next buffered suggestion (we over-fetch ~8) backfills the slot — so the
 *     row keeps ~3 and never shows a zone twice.
 */
function ZoneMappingField({
  zoneOptions, zoneNameById, suggestions, selectedZones, onReplace, onAdd, onRemove,
}: {
  zoneOptions: SearchOption[];
  zoneNameById: Map<number, string>;
  suggestions: ZoneSuggestion[];
  selectedZones: Set<number>;
  onReplace: (ids: number[]) => void;
  onAdd: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  const selectedIds = Array.from(selectedZones);
  // Recommendations = suggest-zones results not already selected, capped at 3.
  // Selecting one promotes it into the chips; the next buffered suggestion
  // (over-fetched) takes its place, so the two rows never show the same zone.
  const visibleSuggestions = suggestions.filter((z) => !selectedZones.has(z.zone_id)).slice(0, 3);
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <label className="text-sm font-medium">Map Zones</label>
        <InfoTooltip>
          <strong className="block mb-1">How recommendations are picked</strong>
          Top 3 zones ranked from the pincodes each zone already contains — zones already
          covering this pincode&apos;s city first, then geographically nearest; if there
          aren&apos;t enough relevant ones, the rest are filled with other zones at random.
        </InfoTooltip>
      </div>

      {/* Searchable multi-select — stays open across toggles; each option shows
          a +/- to add/drop. Returns the full next selection on every toggle. */}
      <SearchMultiSelect
        value={selectedIds}
        onChange={(next) => onReplace(next.map(Number))}
        options={zoneOptions}
        placeholder="Add zones…"
        selectedLabel="zones"
        indicator="plusminus"
      />

      {/* Selected zones as removable chips */}
      {selectedIds.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {selectedIds.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-100 text-blue-800 text-xs font-medium pl-2 pr-1 py-0.5"
            >
              {zoneNameById.get(id) ?? `Zone #${id}`}
              <button
                type="button"
                onClick={() => onRemove(id)}
                className="rounded-full hover:bg-blue-200 p-0.5"
                aria-label={`Remove ${zoneNameById.get(id) ?? `Zone #${id}`}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground mt-1">No zones mapped yet.</p>
      )}

      {/* Quick-add recommendations — directly under the input, no heading.
          Format: "+ <Zone Name> ~ <km> km" ONLY when a real distance is known;
          otherwise just "+ <Zone Name>" (no "~ Suggested" / "~ Same City"). */}
      {visibleSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {visibleSuggestions.map((z) => (
            <button
              key={z.zone_id}
              type="button"
              onClick={() => onAdd(z.zone_id)}
              className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-background text-foreground hover:bg-muted cursor-pointer text-xs px-2 py-1 transition-colors"
              title="Add this zone"
            >
              <Plus className="size-3 shrink-0" />
              <span className="font-medium">{z.zone_name}</span>
              {z.distance_km != null && (
                <span className="text-muted-foreground">~ {z.distance_km} km</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Pincode Technicians Modal ───────────────────────────────────────
type TechItem = {
  efr_id: number;
  efr_name: string | null;
  efr_no: string | null;
  city_name: string | null;
  zone_name: string | null;
};

type TechResp = {
  items: TechItem[];
  total: number;
};

/*
 * PincodeTechniciansModal — searchable list of active+verified technicians
 * who explicitly service the selected pincode (matched via
 * tbl_efr_serviceable_pincodes). Mirrors the DeepSkillMappedEasyfixersModal
 * pattern: useDebouncedValue + useFetch, sidebar-dark header, data-table.
 */
function PincodeTechniciansModal({
  pincode,
  onClose,
}: {
  pincode: Pincode | null;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);

  // Reset search when the modal closes or opens for a different pincode.
  useEffect(() => { setSearch(''); }, [pincode]);

  const listKey = useMemo(() => {
    if (!pincode) return null;
    const p = new URLSearchParams();
    if (debouncedSearch.trim()) p.set('q', debouncedSearch.trim());
    p.set('limit', '50');
    p.set('offset', '0');
    return `/admin/pincodes/${pincode.pincode_id}/technicians?${p.toString()}`;
  }, [pincode, debouncedSearch]);

  const { data, loading, error } = useFetch<TechResp>(listKey);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  // Read-only modal — no dirty state; guard never blocks, but satisfies the
  // no-restricted-syntax rule that bans inline onOpenChange lambdas on <Dialog>.
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => false });

  if (!pincode) return null;

  const headerSub = pincode.city_name
    ? `${pincode.pincode} · ${pincode.city_name}`
    : pincode.pincode;

  return (
    <Dialog open={!!pincode} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-3xl w-[min(96vw,900px)] h-[75vh] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="!mx-0 !mt-0 px-6 py-4 mb-0">
          <DialogTitle className="flex items-center gap-2">
            <Users className="size-4" /> Serviceable Technicians
          </DialogTitle>
          <div className="text-[12px] text-slate-300/85 mt-0.5">
            {headerSub}{' '}·{' '}
            {loading ? 'Loading…' : `${total} Technician${total === 1 ? '' : 's'}`}
          </div>
        </DialogHeader>

        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, mobile or ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              autoFocus
            />
          </div>
        </div>

        <div className="flex-1 overflow-auto px-4 pb-3">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="whitespace-nowrap !text-left">Id</th>
                <th className="whitespace-nowrap !text-left">Name</th>
                <th className="whitespace-nowrap !text-left">Mobile</th>
                <th className="whitespace-nowrap !text-left">City</th>
                <th className="whitespace-nowrap !text-left">Zone</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={5} className="!text-center py-8 text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && error && (
                <tr>
                  <td colSpan={5} className="!text-center py-8 text-rose-600">
                    <AlertTriangle className="size-4 inline mr-1" />{error}
                  </td>
                </tr>
              )}
              {!loading && !error && items.length === 0 && (
                <tr>
                  <td colSpan={5} className="!text-center py-8 text-muted-foreground">
                    {debouncedSearch.trim()
                      ? 'No technicians match the search.'
                      : 'No active technicians service this pincode.'}
                  </td>
                </tr>
              )}
              {!loading && !error && items.map((t) => (
                <tr key={t.efr_id}>
                  <td className="!text-left text-xs text-muted-foreground tabular-nums">{t.efr_id}</td>
                  <td className="!text-left font-medium">{t.efr_name ?? '—'}</td>
                  <td className="!text-left text-xs whitespace-nowrap">{t.efr_no ?? '—'}</td>
                  <td className="!text-left text-xs">{t.city_name ?? '—'}</td>
                  <td className="!text-left text-xs">{t.zone_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Pincode → Zones Mapping Modal ───────────────────────────────────
type ZoneOption = { zone_id: number; zone_name: string };
type PincodeDetail = Pincode & { zones?: ZoneOption[] };

/*
 * PincodeZonesModal — reverse of the Manage Zones zone→pincodes editor.
 * Assigns THIS pincode to one or more zones (many-to-many junction
 * tbl_zone_pincode_mapping). All active zones come from
 * GET /shared/lookup/zones; the pre-checked set comes from the pincode's
 * own detail (GET /admin/pincodes/:id → zones[]). Save PUTs the chosen
 * zone-id set to PUT /admin/pincodes/:id/zones.
 */
function PincodeZonesModal({
  pincode,
  onClose,
  onSaved,
}: {
  pincode: Pincode | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // All active zones (multi-select source). useFetch — no raw useEffect+api.get.
  const { data: allZones, loading: zonesLoading } = useFetch<ZoneOption[]>('/shared/lookup/zones');
  // This pincode's current zones (pre-checked state).
  const detailKey = pincode ? `/admin/pincodes/${pincode.pincode_id}` : null;
  const { data: detail, loading: detailLoading } = useFetch<PincodeDetail>(detailKey);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [initial, setInitial] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the selection from the pincode's current zones once they load.
  useEffect(() => {
    if (!pincode) { setSelected(new Set()); setInitial(new Set()); setError(null); return; }
    if (detail?.zones) {
      const ids = new Set(detail.zones.map((z) => z.zone_id));
      setSelected(ids);
      setInitial(new Set(ids));
    }
  }, [pincode, detail]);

  // SearchMultiSelect options + a name lookup for the removable chips (mirrors
  // the in-modal ZoneMappingField pattern used by Add/Edit).
  const zoneOptions = useMemo<SearchOption[]>(
    () => (allZones ?? []).map((z) => ({ value: z.zone_id, label: z.zone_name })),
    [allZones],
  );
  const zoneNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const z of allZones ?? []) m.set(z.zone_id, z.zone_name);
    return m;
  }, [allZones]);
  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  // Dirty = selection differs from the originally-loaded set.
  const isDirty = useMemo(() => {
    if (selected.size !== initial.size) return true;
    for (const id of selected) if (!initial.has(id)) return true;
    return false;
  }, [selected, initial]);

  // SearchMultiSelect returns the full next selection on every toggle.
  function replaceSelected(ids: number[]) {
    setSelected(new Set(ids));
  }
  function removeZone(id: number) {
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function handleSave() {
    if (!pincode) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.put(`/admin/pincodes/${pincode.pincode_id}/zones`, {
        zoneIds: Array.from(selected),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  // Guard the dialog close while the selection is dirty (ESLint rule bans
  // inline onOpenChange lambdas on <Dialog>).
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    when: () => !submitting && isDirty,
  });

  if (!pincode) return null;

  const headerSub = pincode.city_name
    ? `${pincode.pincode} · ${pincode.city_name}`
    : pincode.pincode;
  const loading = zonesLoading || detailLoading;

  return (
    <Dialog open={!!pincode} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-lg p-0 overflow-hidden flex flex-col max-h-[80vh]">
        <DialogHeader className="!mx-0 !mt-0 px-6 py-4 mb-0">
          <DialogTitle className="flex items-center gap-2">
            <MapIcon className="size-4" /> Assign Zones
          </DialogTitle>
          <div className="text-[12px] text-slate-300/85 mt-0.5">
            {headerSub}{' '}·{' '}
            {loading ? 'Loading…' : `${selected.size} Selected`}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto px-4 pt-3 pb-2 min-h-[8rem] space-y-2">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              {/* Searchable multi-select (+/- per option) — same control as the
                  in-modal ZoneMappingField. Returns the full next selection on
                  every toggle; selected zones render as removable chips below. */}
              <SearchMultiSelect
                value={selectedIds}
                onChange={(next) => replaceSelected(next.map(Number))}
                options={zoneOptions}
                placeholder="Add Zones…"
                selectedLabel="zones"
                indicator="plusminus"
                emptyText="No Zones Available"
              />

              {selectedIds.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {selectedIds.map((id) => (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-100 text-blue-800 text-xs font-medium pl-2 pr-1 py-0.5"
                    >
                      {zoneNameById.get(id) ?? `Zone #${id}`}
                      <button
                        type="button"
                        onClick={() => removeZone(id)}
                        className="rounded-full hover:bg-blue-200 p-0.5"
                        aria-label={`Remove ${zoneNameById.get(id) ?? `Zone #${id}`}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No zones mapped yet.</p>
              )}
            </>
          )}
        </div>

        {error && (
          <div className="px-4 text-sm text-red-600 flex items-center gap-1">
            <AlertTriangle className="size-4" /> {error}
          </div>
        )}

        <div className="flex justify-end gap-2 px-4 py-3 border-t">
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button onClick={handleSave} disabled={submitting || loading}>
            {submitting ? 'Saving…' : 'Save Zones'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
