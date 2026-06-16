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

import { useEffect, useMemo, useState } from 'react';
import {
  MapPin, Search, Plus, Upload, Download,
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, Users, Map,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
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

// Column keys eligible for the 3-state client-side sort cycle. `status` is a
// virtual string; numeric columns (lat/lng/zone_count) sort numerically via
// the shared comparator's Number()-detection.
type SortKey =
  | 'pincode' | 'city_name' | 'district' | 'state_name'
  | 'lat' | 'lng' | 'zone_count' | 'status';

// BE Joi cap on /admin/pincodes `limit` is 200000; pass it so 'All' maps to
// the endpoint's true ceiling rather than pageSizeToLimit's 1000 default.
const PINCODES_LIMIT_CAP = 200000;

export default function ManagePincodesPage() {
  const lookup  = useLookup();
  const { me } = useMe();
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
  const [uploadOpen, setUploadOpen] = useState(false);
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
  // Reset page to 0 whenever filters change (debouncedSearch handles its own delay).
  useEffect(() => { setPage(0); }, [debouncedSearch, statusFilter, showNonServiceable]);

  // Translate the shared page-size sentinel into the BE limit/offset.
  const limit = pageSizeToLimit(pageSize, PINCODES_LIMIT_CAP);
  const urlParams = new URLSearchParams();
  if (debouncedSearch.trim()) urlParams.set('q', debouncedSearch.trim());
  if (statusFilter !== 'ALL') urlParams.set('status', statusFilter);
  if (showNonServiceable) urlParams.set('includeInactive', 'true');
  urlParams.set('limit', String(limit));
  urlParams.set('offset', String(page * (pageSize === 'all' ? limit : Number(pageSize))));
  const listUrl = `/admin/pincodes?${urlParams.toString()}`;
  const { data: listData, loading, error: fetchError, refetch } = useFetch<ListResponse>(listUrl);
  const total = listData?.total ?? 0;

  // Sort the loaded page client-side (same comparator as Manage Clients):
  // numeric columns sort numerically, text columns alphabetically (locale,
  // numeric-aware). Null sortBy (3rd click) preserves the BE's pincode-ASC order.
  const items: Pincode[] = useMemo(() => {
    const arr = (listData?.items ?? []).slice();
    if (!sortBy) return arr;
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

  async function downloadTemplate() {
    try {
      const token = localStorage.getItem('crm_auth_token');
      const url = `${process.env.NEXT_PUBLIC_API_URL || '/api'}/admin/pincodes/template/download`;
      const res = await fetch(url, {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Template download failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'manage-pincodes-template.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
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
          {can.isPincodeUpload && (
            <Button variant="outline" onClick={downloadTemplate}>
              <Download className="size-4 mr-1" /> Template
            </Button>
          )}
          {can.isPincodeUpload && (
            <Button variant="outline" onClick={() => setUploadOpen(true)}>
              <Upload className="size-4 mr-1" /> Upload Excel
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
          <table className="data-table w-full">
            <thead>
              <tr>
                <SortHeader col={'pincode'    as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Pincode</SortHeader>
                <th className="!text-left">Location</th>
                <SortHeader col={'city_name'  as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>City</SortHeader>
                <SortHeader col={'district'   as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>District</SortHeader>
                <SortHeader col={'state_name' as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>State</SortHeader>
                <SortHeader col={'lat'        as SortKey} align="right"  sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Latitude</SortHeader>
                <SortHeader col={'lng'        as SortKey} align="right"  sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Longitude</SortHeader>
                <SortHeader col={'zone_count' as SortKey} align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Zones</SortHeader>
                {/* Status = Serviceable / Non-Serviceable (read-only label). */}
                <th className="!text-center">Status</th>
                {/* Mapping = Local / Travel (live technician availability). */}
                <SortHeader col={'status'     as SortKey} align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSortToggle}>Mapping</SortHeader>
                {/* Action = frozen right column; switch to flip Serviceable status. */}
                <th className="!text-center sticky right-0 bg-background shadow-[-2px_0_0_0_var(--border)]">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={11} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={11} className="!text-center text-muted-foreground py-6">No pincodes match the current filters.</td></tr>
              )}
              {!loading && items.map((p) => (
                <tr key={p.pincode_id}>
                  <td className="!text-left font-mono">{p.pincode}</td>
                  <td className="!text-left">{p.location ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left">{p.city_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left">{p.district ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-left">{p.state_name ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="!text-right font-mono text-sm">
                    {p.lat != null ? p.lat.toFixed(5) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-right font-mono text-sm">
                    {p.lng != null ? p.lng.toFixed(5) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-center tabular-nums">
                    {can.isPincodeAddNew ? (
                      <button
                        type="button"
                        onClick={() => setZoneEditPincode(p)}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors cursor-pointer ${
                          p.zone_count > 0
                            ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                            : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                        }`}
                        title={p.zone_count > 0 ? 'Edit Zone Mapping' : 'Map Zones (None Assigned)'}
                      >
                        <MapPin className="size-3 shrink-0" />
                        <span className="tabular-nums">{p.zone_count}</span>
                        <span className="hidden sm:inline">{p.zone_count > 0 ? 'Edit' : 'Map'}</span>
                      </button>
                    ) : (
                      p.zone_count
                    )}
                  </td>
                  {/* Status — Serviceable / Non-Serviceable (read-only label). */}
                  <td className="!text-center">
                    <span className={`text-xs font-medium ${p.is_active ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {p.is_active ? 'Serviceable' : 'Non-Serviceable'}
                    </span>
                  </td>
                  {/* Mapping — Local / Travel (live technician availability). */}
                  <td className="!text-center">
                    <StatusPill
                      status={p.status}
                      count={p.active_efr_count}
                      onClick={p.active_efr_count > 0 ? () => setTechModalPincode(p) : undefined}
                    />
                  </td>
                  {/* Action — frozen right; switch flips Serviceable status. */}
                  <td className="!text-center sticky right-0 bg-background shadow-[-2px_0_0_0_var(--border)]">
                    {can.isPincodeAddNew ? (
                      <Switch
                        checked={p.is_active}
                        onCheckedChange={() => toggleServiceable(p)}
                        disabled={serviceableBusy === p.pincode_id}
                        ariaLabel={p.is_active ? 'Mark Non-Serviceable' : 'Mark Serviceable'}
                      />
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
        cities={lookup.cities.map((c) => ({ city_id: c.city_id, city_name: c.city_name }))}
        onSaved={() => { setModalOpen(false); refreshList(); }}
      />

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onCommitted={() => { setUploadOpen(false); refreshList(); }}
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

// ─── Add/Edit modal ─────────────────────────────────────────────────
function PincodeFormModal({
  open, onClose, editing, cities, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: Pincode | null;
  cities: Array<{ city_id: number; city_name: string }>;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [pincode,  setPincode]  = useState('');
  const [location, setLocation] = useState('');
  const [cityId,   setCityId]   = useState<number | ''>('');
  const [district, setDistrict] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPincode (editing?.pincode  ?? '');
      setLocation(editing?.location ?? '');
      setCityId  (editing?.city_id  ?? '');
      setDistrict(editing?.district ?? '');
      setIsActive(editing?.is_active ?? true);
      setError(null);
    }
  }, [open, editing]);

  // City picker: a search input + scrollable click-list. Avoids native
  // <select size> quirks (some browsers fire onChange only on commit, not
  // on highlight, so the visually-selected option didn't actually update
  // state — caused "City is required" errors after picking). The list
  // shows ALL cities; the search filters in-memory.
  const [cityQuery, setCityQuery] = useState('');
  const filteredCities = useMemo(() => {
    const q = cityQuery.trim().toLowerCase();
    if (!q) return cities;
    return cities.filter((c) => c.city_name.toLowerCase().includes(q));
  }, [cities, cityQuery]);

  // Show the selected city's name in the picker header so users see what
  // they've chosen even after scrolling away from it in the list.
  const selectedCityName = useMemo(
    () => cities.find((c) => c.city_id === cityId)?.city_name ?? null,
    [cities, cityId],
  );

  async function handleSubmit() {
    setError(null);
    if (!isEdit && !/^\d{6}$/.test(pincode)) { setError('Pincode must be exactly 6 digits'); return; }
    if (!cityId) { setError('City is required'); return; }
    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/pincodes/${editing!.pincode_id}`, {
          location:  location || null,
          city_id:   Number(cityId),
          district:  district || null,
          is_active: isActive,
        });
      } else {
        await api.post('/admin/pincodes', {
          pincode,
          location: location || null,
          city_id:  Number(cityId),
          district: district || null,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Pincode' : 'Add Pincode'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium block mb-1">Pincode *</label>
            <Input
              value={pincode}
              onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6 digits"
              disabled={isEdit}
              className="font-mono"
            />
            {isEdit && (
              <p className="text-xs text-muted-foreground mt-1">
                Pincode is the row key; to change it, deactivate and re-add.
              </p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">Location</label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder='e.g. "Sector 18", "Andheri East" — optional'
            />
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">City *</label>
            <Input
              value={cityQuery}
              onChange={(e) => setCityQuery(e.target.value)}
              placeholder="Search cities…"
              className="mb-1"
            />
            {selectedCityName && (
              <div className="text-xs text-muted-foreground mb-1">
                Selected: <span className="font-medium text-foreground">{selectedCityName}</span>
              </div>
            )}
            <div className="border rounded bg-background max-h-48 overflow-auto" role="listbox" aria-label="Cities">
              {filteredCities.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">No cities match.</div>
              ) : filteredCities.map((c) => {
                const isSelected = c.city_id === cityId;
                return (
                  <button
                    type="button"
                    key={c.city_id}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => setCityId(c.city_id)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 ${isSelected ? 'bg-blue-50 text-blue-700 font-medium' : ''}`}
                  >
                    {c.city_name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">District (optional)</label>
            <Input
              value={district}
              onChange={(e) => setDistrict(e.target.value)}
              placeholder="Inherits the city's district if blank"
            />
          </div>

          {isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              <span>Active</span>
            </label>
          )}

          {error && (
            <div className="text-sm text-red-600 flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Pincode'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Bulk upload modal ──────────────────────────────────────────────
type UploadResult = {
  summary: { totalRows: number; createdCount: number; failedCount: number; skipCount: number; dryRun: boolean };
  results: Array<{
    rowNumber: number | null;
    status: 'created' | 'skipped' | 'failed';
    pincode?: string;
    reason?: string;
    errors?: string[];
  }>;
};

function UploadModal({
  open, onClose, onCommitted,
}: {
  open: boolean;
  onClose: () => void;
  onCommitted: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<UploadResult | null>(null);
  const [phase, setPhase] = useState<'idle' | 'dry-run' | 'committed' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setFile(null); setReport(null); setPhase('idle'); setError(null); }
  }, [open]);

  async function send(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post<UploadResult>(`/admin/pincodes/upload?dryRun=${dryRun}`, fd);
      setReport(r);
      setPhase(dryRun ? 'dry-run' : 'committed');
      if (!dryRun) onCommitted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload failed');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload Pincodes (Bulk)</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Use the &quot;Template&quot; button on the parent page to download a starter file.
            Run a dry-run first — it validates rows without inserting anything.
          </p>
          <Input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); setPhase('idle'); }}
          />

          {error && (
            <div className="text-sm text-red-600 flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}

          {report && (
            <div className="border rounded p-3 bg-muted/40 space-y-2 text-sm">
              <div className="font-medium">
                {phase === 'dry-run' ? 'Dry-run results' : 'Upload complete'}
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                <Stat label="Total"   value={report.summary.totalRows} />
                <Stat label="Created" value={report.summary.createdCount} tone="ok" />
                <Stat label="Skipped" value={report.summary.skipCount} tone="warn" />
                <Stat label="Failed"  value={report.summary.failedCount} tone="err" />
              </div>
              {!!report.results.length && (
                <div className="max-h-56 overflow-auto border rounded">
                  <table className="data-table w-full text-xs">
                    <thead>
                      <tr><th>Row</th><th>Status</th><th>Detail</th></tr>
                    </thead>
                    <tbody>
                      {report.results.slice(0, 200).map((r, i) => (
                        <tr key={i}>
                          <td className="!text-center">{r.rowNumber ?? '—'}</td>
                          <td className="!text-center">{r.status}</td>
                          <td className="!text-left">
                            {r.status === 'failed' ? (r.errors?.join('; ') ?? '') : (r.reason ?? r.pincode ?? '')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
            <Button variant="outline" disabled={!file || busy} onClick={() => send(true)}>
              {busy && phase === 'idle' ? 'Validating…' : 'Dry-run'}
            </Button>
            <Button disabled={!file || busy || (phase === 'dry-run' && (report?.summary.failedCount ?? 0) > 0)}
                    onClick={() => send(false)}>
              {busy && phase === 'dry-run' ? 'Uploading…' : 'Commit Upload'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [initial, setInitial] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the selection from the pincode's current zones once they load.
  useEffect(() => {
    if (!pincode) { setSelected(new Set()); setInitial(new Set()); setSearch(''); setError(null); return; }
    if (detail?.zones) {
      const ids = new Set(detail.zones.map((z) => z.zone_id));
      setSelected(ids);
      setInitial(new Set(ids));
    }
  }, [pincode, detail]);

  const debouncedZoneSearch = useDebouncedValue(search, 200);
  const filteredZones = useMemo(() => {
    const list = allZones ?? [];
    const q = debouncedZoneSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((z) => z.zone_name.toLowerCase().includes(q));
  }, [allZones, debouncedZoneSearch]);

  // Dirty = selection differs from the originally-loaded set.
  const isDirty = useMemo(() => {
    if (selected.size !== initial.size) return true;
    for (const id of selected) if (!initial.has(id)) return true;
    return false;
  }, [selected, initial]);

  function toggleZone(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
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
            <Map className="size-4" /> Assign Zones
          </DialogTitle>
          <div className="text-[12px] text-slate-300/85 mt-0.5">
            {headerSub}{' '}·{' '}
            {loading ? 'Loading…' : `${selected.size} Selected`}
          </div>
        </DialogHeader>

        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search Zones…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              autoFocus
            />
          </div>
        </div>

        <div className="flex-1 overflow-auto px-4 pb-2 min-h-[8rem]">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : filteredZones.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {debouncedZoneSearch.trim() ? 'No Zones Match The Search.' : 'No Zones Available.'}
            </div>
          ) : (
            <div className="border rounded bg-background divide-y" role="listbox" aria-label="Zones">
              {filteredZones.map((z) => {
                const checked = selected.has(z.zone_id);
                return (
                  <label
                    key={z.zone_id}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleZone(z.zone_id)}
                    />
                    <span className={checked ? 'font-medium text-foreground' : ''}>{z.zone_name}</span>
                  </label>
                );
              })}
            </div>
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

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'err' }) {
  const color =
    tone === 'ok' ? 'text-emerald-700'
      : tone === 'warn' ? 'text-amber-700'
      : tone === 'err' ? 'text-red-700'
      : '';
  return (
    <div className="border rounded p-2 bg-background">
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
