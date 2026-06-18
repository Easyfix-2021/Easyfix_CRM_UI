'use client';

/*
 * Manage Zones — Settings page (spec-aligned model).
 *
 * Spec:
 *   - Zones are created per City (one zone belongs to ONE city).
 *   - A zone is a group of pincodes within that city.
 *   - One pincode belongs to one zone only.
 *   - Zone Name is free text (e.g. "South Delhi", "Whitefield").
 *   - List columns: Zone ID | Zone Name | City | Pincodes | Technicians.
 *
 * Endpoints under /api/admin/zones — see backend services/zone.service.js
 * + routes/admin/zones.js + zone-upload.service.js.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  MapPin, MapPinned, Users, Building2, Search, Plus, Pencil, LayoutGrid, List,
  Upload, Download, AlertTriangle, CheckCircle2, ToggleLeft, ToggleRight,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { api, ApiError } from '@/lib/api';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { useSort, SortHeader } from '@/lib/use-sort';
import { useLookup } from '@/lib/use-lookup';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { Switch } from '@/components/ui/switch';

type Zone = {
  zone_id: number;
  zone_name: string;
  zone_status: number | null;
  created_date: string | null;
  city_id: number | null;
  city_name: string | null;
  pincode_count: number;
  technician_count: number;
};

type ZoneListResponse = {
  items: Zone[];
  total: number;
};

type View = 'cards' | 'table';

// BE Joi cap on /admin/zones `limit` is 5000; pass it so the 'All' sentinel
// maps to the endpoint's true ceiling rather than pageSizeToLimit's 1000 default.
const ZONES_LIMIT_CAP = 5000;
const VIEW_LS_KEY = 'manage-zones:view';

export default function ManageZonesPage() {
  const { me } = useMe();
  // Permission gating — legacy `is{Entity}{Verb}` convention. Production
  // rollout needs corresponding rows in `menu_action` assigned to Admin.
  const can = actionFlags(me, ['isZoneAddNew', 'isZoneEdit', 'isZoneUpload']);
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [view, setView]     = useState<View>('cards');
  // Active-by-default; opt in to see inactive zones (e.g. to reactivate them).
  const [showInactive, setShowInactive] = useState(false);
  useEffect(() => {
    const saved = (typeof window !== 'undefined' ? localStorage.getItem(VIEW_LS_KEY) : null) as View | null;
    if (saved === 'table' || saved === 'cards') setView(saved);
  }, []);
  function pickView(v: View) { setView(v); try { localStorage.setItem(VIEW_LS_KEY, v); } catch {} }

  const [addOpen,    setAddOpen]    = useState(false);
  const [editTarget, setEditTarget] = useState<Zone | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Server-side pagination state. Page is 0-indexed (offset = page * size).
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(20);

  // Debounced server-side search keeps the payload small as zones grow.
  const debouncedSearch = useDebouncedValue(search, 300);
  // Reset to the first page whenever a filter changes.
  useEffect(() => { setPage(0); }, [debouncedSearch, showInactive]);

  // Build the list URL: q + limit/offset (+ includeInactive). 'All' maps to
  // the BE's true cap.
  const limit = pageSizeToLimit(pageSize, ZONES_LIMIT_CAP);
  const urlParams = new URLSearchParams();
  if (debouncedSearch.trim()) urlParams.set('q', debouncedSearch.trim());
  if (showInactive) urlParams.set('includeInactive', 'true');
  urlParams.set('limit', String(limit));
  urlParams.set('offset', String(page * (pageSize === 'all' ? limit : Number(pageSize))));
  const listUrl = `/admin/zones?${urlParams.toString()}`;
  const { data: listData, loading, refetch } = useFetch<ZoneListResponse>(listUrl);
  const zones = listData?.items ?? null;
  const total = listData?.total ?? 0;

  // Invalidate the module cache for ALL zone list pages, then refetch.
  function load() {
    invalidateFetch((k) => k.startsWith('/admin/zones'));
    refetch();
  }

  // Toggle a zone's active status directly from the list row / card. The BE
  // 409s on deactivating a zone that still has pincodes mapped; we pre-empt
  // that with a clear toast (and disable the control) so it never round-trips.
  async function toggleStatus(z: Zone) {
    const deactivating = !!z.zone_status;
    if (deactivating && (z.pincode_count ?? 0) > 0) {
      showToast({ variant: 'error', message: `Remove its ${z.pincode_count} mapped pincode(s) before deactivating "${z.zone_name}".` });
      return;
    }
    if (deactivating) {
      const ok = await confirm({
        title: 'Deactivate Zone',
        description: `Mark "${z.zone_name}" inactive? It will be hidden from the default list and excluded from auto-allocation.`,
        confirmLabel: 'Deactivate',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    try {
      await api.patch(`/admin/zones/${z.zone_id}`, { zone_status: !deactivating });
      showToast({ variant: 'success', message: deactivating ? 'Zone deactivated.' : 'Zone reactivated.' });
      load();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Status update failed.' });
    }
  }

  // Loaded page rows (already filtered + paginated server-side).
  const filtered = useMemo(() => zones ?? [], [zones]);

  // Client-side 3-state sort over the loaded page (table view) — same pattern
  // as Manage Pincodes. useSort picks numeric vs alphabetical per the actual
  // cell value, so count/ID/status columns sort numerically and name/city
  // alphabetically. `sorted === filtered` (server order) when sortKey is null.
  const { sorted, sortKey, sortDir, toggle } = useSort<Zone>(filtered);

  async function downloadTemplate() {
    const base  = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5100/api';
    const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
    const res = await fetch(`${base}/admin/zones/template`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) { showToast({ variant: 'error', message: `Template download failed: HTTP ${res.status}` }); return; }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'easyfix-zone-mapping-template.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      {/* ── Header ─ */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Manage Zones</h1>
          <p className="text-sm text-muted-foreground">
            Each zone belongs to one city and groups the pincodes within it. Auto-allocation
            uses the zone of the customer&apos;s pincode to filter eligible technicians.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isZoneUpload && (
            <Button variant="outline" onClick={downloadTemplate}>
              <Download className="h-4 w-4 mr-1" /> Download Template
            </Button>
          )}
          {can.isZoneUpload && (
            <Button variant="outline" onClick={() => setUploadOpen(true)}>
              <Upload className="h-4 w-4 mr-1" /> Upload Excel
            </Button>
          )}
          {can.isZoneAddNew && (
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add Zone
            </Button>
          )}
        </div>
      </div>

      {/* ── Filter + view toggle ─ */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Filter by zone name or city…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <label className="flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer">
                <input
                  type="checkbox"
                  checked={showInactive}
                  onChange={(e) => setShowInactive(e.target.checked)}
                />
                Show Inactive Zones
              </label>
            </div>
            <div className="inline-flex border rounded-md overflow-hidden">
              <button type="button" onClick={() => pickView('cards')}
                className={`px-3 h-9 text-xs inline-flex items-center gap-1 ${view === 'cards' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/60'}`}>
                <LayoutGrid className="h-3.5 w-3.5" /> Cards
              </button>
              <button type="button" onClick={() => pickView('table')}
                className={`px-3 h-9 text-xs inline-flex items-center gap-1 border-l ${view === 'table' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/60'}`}>
                <List className="h-3.5 w-3.5" /> Table
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Body ─ */}
      {loading && zones === null && <Card><CardContent className="p-8 text-center text-muted-foreground">Loading Zones…</CardContent></Card>}
      {zones && filtered.length === 0 && (
        <Card><CardContent className="p-8 text-center text-muted-foreground">
          {debouncedSearch ? 'No Zones Match Your Filter.' : 'No Zones Yet — Click "Add Zone" To Create The First One.'}
        </CardContent></Card>
      )}

      {view === 'cards' && filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((z) => (
            // canEdit controls the "Edit" affordance inside ZoneCard. When
            // false, the card still navigates to /settings/zones/:id (read-
            // only manage view) but the inline Edit button is suppressed.
            <ZoneCard key={z.zone_id} zone={z} canEdit={can.isZoneEdit} onEdit={() => setEditTarget(z)} onToggleStatus={() => toggleStatus(z)} />
          ))}
        </div>
      )}

      {view === 'table' && filtered.length > 0 && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <SortHeader col={'zone_id'          as keyof Zone} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Zone ID</SortHeader>
                  <SortHeader col={'zone_name'        as keyof Zone} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Zone Name</SortHeader>
                  <SortHeader col={'city_name'        as keyof Zone} align="left"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>City</SortHeader>
                  <SortHeader col={'pincode_count'    as keyof Zone} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Pincodes</SortHeader>
                  <SortHeader col={'technician_count' as keyof Zone} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Technicians</SortHeader>
                  <SortHeader col={'zone_status'      as keyof Zone} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Status</SortHeader>
                  <th className="!text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((z) => (
                  <tr key={z.zone_id} className="hover:bg-muted/40">
                    <td className="!text-center font-mono text-xs">{z.zone_id}</td>
                    <td className="!text-left font-medium">
                      <Link href={`/settings/zones/${z.zone_id}`} className="hover:underline">{z.zone_name}</Link>
                    </td>
                    <td className="!text-left">{z.city_name ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="!text-center">{z.pincode_count}</td>
                    <td className="!text-center">{z.technician_count}</td>
                    <td className="!text-center">
                      <div
                        className="inline-flex items-center gap-2"
                        title={z.zone_status ? ((z.pincode_count ?? 0) > 0 ? 'Remove pincodes to deactivate' : 'Active — toggle to deactivate') : 'Inactive — toggle to activate'}
                      >
                        <Switch
                          checked={!!z.zone_status}
                          onCheckedChange={() => toggleStatus(z)}
                          disabled={!can.isZoneEdit || (!!z.zone_status && (z.pincode_count ?? 0) > 0)}
                          ariaLabel={z.zone_status ? 'Deactivate Zone' : 'Activate Zone'}
                        />
                        <span className={`text-xs ${z.zone_status ? 'text-emerald-700' : 'text-muted-foreground'}`}>
                          {z.zone_status ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    </td>
                    <td className="!text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1 justify-end">
                        <Link
                          href={`/settings/zones/${z.zone_id}`}
                          title="Manage Pincodes"
                          aria-label="Manage Pincodes"
                          className="inline-flex size-7 shrink-0 items-center justify-center rounded text-blue-600 transition-colors hover:bg-muted/60 hover:text-blue-700"
                        >
                          <MapPinned className="size-4" aria-hidden="true" />
                        </Link>
                        {can.isZoneEdit && (
                          <IconButton
                            icon={Pencil}
                            label="Edit Zone"
                            intent="primary"
                            onClick={() => setEditTarget(z)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Pagination band — shared component, server-side paged. Shown for both
          card and table views whenever there are rows on the current page. */}
      {filtered.length > 0 && (
        <Card>
          <CardContent className="px-3 py-2">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </CardContent>
        </Card>
      )}

      <ZoneAddEditDialog
        open={addOpen}
        zone={null}
        onClose={() => setAddOpen(false)}
        onSaved={() => { setAddOpen(false); load(); }}
      />
      <ZoneAddEditDialog
        open={editTarget !== null}
        zone={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => { setEditTarget(null); load(); }}
      />
      <ZoneUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onApplied={() => { setUploadOpen(false); load(); }}
      />
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────
function ZoneCard({ zone, canEdit, onEdit, onToggleStatus }: { zone: Zone; canEdit: boolean; onEdit: () => void; onToggleStatus: () => void }) {
  return (
    <Card className="hover:shadow-md transition-shadow">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link href={`/settings/zones/${zone.zone_id}`} className="text-base font-semibold hover:underline truncate block">
              {zone.zone_name}
            </Link>
            <div className="text-xs text-muted-foreground mt-0.5">
              <Building2 className="inline h-3 w-3 mr-1" />
              {zone.city_name ?? 'No city'} · ID {zone.zone_id}
            </div>
          </div>
          {canEdit && (
            <button type="button" onClick={onEdit} className="text-xs text-muted-foreground hover:underline shrink-0">
              <Pencil className="inline h-3 w-3 mr-0.5" />Edit
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span><MapPin className="inline h-3.5 w-3.5 mr-1 text-violet-700" />{zone.pincode_count} pincodes</span>
          <span><Users  className="inline h-3.5 w-3.5 mr-1 text-emerald-700" />{zone.technician_count} technicians</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <div
            className="inline-flex items-center gap-2"
            title={zone.zone_status ? ((zone.pincode_count ?? 0) > 0 ? 'Remove pincodes to deactivate' : 'Active — toggle to deactivate') : 'Inactive — toggle to activate'}
          >
            <Switch
              checked={!!zone.zone_status}
              onCheckedChange={onToggleStatus}
              disabled={!canEdit || (!!zone.zone_status && (zone.pincode_count ?? 0) > 0)}
              ariaLabel={zone.zone_status ? 'Deactivate Zone' : 'Activate Zone'}
            />
            <span className={zone.zone_status ? 'text-emerald-700' : 'text-muted-foreground'}>
              {zone.zone_status ? 'Active' : 'Inactive'}
            </span>
          </div>
          <Link
            href={`/settings/zones/${zone.zone_id}`}
            title="Manage Pincodes"
            aria-label="Manage Pincodes"
            className="inline-flex items-center text-primary hover:text-primary/80"
          >
            <MapPinned className="h-4 w-4" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Add / Edit Zone dialog ─────────────────────────────────────────
function ZoneAddEditDialog({ open, zone, onClose, onSaved }: {
  open: boolean; zone: Zone | null; onClose: () => void; onSaved: () => void;
}) {
  const lk = useLookup();
  const [name,   setName]   = useState('');
  const [cityId, setCityId] = useState<number | ''>('');
  const [cityQuery, setCityQuery] = useState('');
  const [active, setActive] = useState(true);
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState<string | null>(null);
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });

  useEffect(() => {
    if (open) {
      setName(zone?.zone_name ?? '');
      setCityId(zone?.city_id ?? '');
      setCityQuery('');
      setActive(zone ? Boolean(zone.zone_status) : true);
      setErr(null);
    }
  }, [open, zone]);

  const filteredCities = useMemo(() => {
    const q = cityQuery.trim().toLowerCase();
    return q ? lk.cities.filter((c) => c.city_name.toLowerCase().includes(q)) : lk.cities;
  }, [lk.cities, cityQuery]);

  const selectedCityName = useMemo(
    () => lk.cities.find((c) => c.city_id === cityId)?.city_name ?? null,
    [lk.cities, cityId],
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr('Zone name is required'); return; }
    if (!zone && !cityId) { setErr('City is required'); return; }
    setBusy(true); setErr(null);
    try {
      if (zone) {
        // City is locked on edit — moving a zone across cities would
        // invalidate every assigned pincode and dangle technicians.
        await api.patch(`/admin/zones/${zone.zone_id}`, { zone_name: name, zone_status: active });
      } else {
        await api.post('/admin/zones', { zone_name: name, city_id: Number(cityId) });
      }
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Save failed');
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{zone ? `Edit "${zone.zone_name}"` : 'Add new zone'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-3 pt-2">
          <div className="space-y-1.5">
            <label className="text-sm">Zone name *</label>
            <Input required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "South Delhi", "Whitefield"' />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm">City *</label>
            {zone ? (
              <div className="text-sm bg-muted/40 border rounded px-3 py-2">
                {zone.city_name ?? '—'}
                <span className="ml-2 text-xs text-muted-foreground">(locked — recreate to move)</span>
              </div>
            ) : (
              <>
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
                <div className="border rounded bg-background max-h-44 overflow-auto" role="listbox">
                  {filteredCities.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">No cities match.</div>
                  ) : filteredCities.map((c) => {
                    const selected = c.city_id === cityId;
                    return (
                      <button
                        type="button"
                        key={c.city_id}
                        role="option"
                        aria-selected={selected}
                        onClick={() => setCityId(c.city_id)}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 ${selected ? 'bg-blue-50 text-blue-700 font-medium' : ''}`}
                      >
                        {c.city_name}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {zone && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => {
                  // A zone with pincodes mapped can't be deactivated (the BE
                  // also enforces this with a 409).
                  if (active && (zone.pincode_count ?? 0) > 0) return;
                  setActive((s) => !s);
                }}
                disabled={active && (zone.pincode_count ?? 0) > 0}
                className="flex items-center gap-2 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {active
                  ? <ToggleRight className="h-5 w-5 text-emerald-600" />
                  : <ToggleLeft  className="h-5 w-5 text-muted-foreground" />}
                {active ? 'Active' : 'Inactive'} — toggle to {active ? 'deactivate' : 'reactivate'}
              </button>
              {active && (zone.pincode_count ?? 0) > 0 && (
                <p className="text-[11px] text-amber-700">
                  Remove its {zone.pincode_count} mapped pincode{zone.pincode_count === 1 ? '' : 's'} before deactivating.
                </p>
              )}
            </div>
          )}
          {err && <div className="text-sm text-destructive">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : zone ? 'Save changes' : 'Create zone'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Excel upload dialog ────────────────────────────────────────────
type UploadResult = {
  summary: {
    totalRows: number;
    createdZones: number;
    assignedPincodes: number;
    skipCount: number;
    failedCount: number;
    dryRun: boolean;
  };
  results: Array<{
    rowNumber: number | null;
    status: 'assigned' | 'skipped' | 'failed';
    pincode?: string;
    zone_name?: string;
    city_name?: string;
    reason?: string;
    errors?: string[];
  }>;
};

function ZoneUploadDialog({ open, onClose, onApplied }: {
  open: boolean; onClose: () => void; onApplied: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file,   setFile]   = useState<File | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !busy });

  useEffect(() => {
    if (open) { setFile(null); setDryRun(true); setBusy(false); setErr(null); setResult(null); }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { setErr('Pick an .xlsx file first'); return; }
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post<UploadResult>(`/admin/zones/upload?dryRun=${dryRun}`, fd);
      setResult(r);
      if (!dryRun) onApplied();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Upload failed');
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk Upload Zone-Pincode Mapping</DialogTitle>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3 pt-2">
          <p className="text-sm text-muted-foreground">
            Use the template downloaded from the parent screen. Each row = (zone_name,
            city_name, pincode). Zones not yet present get created on commit; pincodes
            already in another zone are reported as skipped.
          </p>

          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm"
          />

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            <strong>Dry run</strong> — validate only, don&apos;t write to DB (recommended on first try)
          </label>

          {err && <div className="text-sm text-destructive">{err}</div>}

          {result && (
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm">
                {result.summary.failedCount === 0
                  ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  : <AlertTriangle className="h-4 w-4 text-amber-600" />}
                <span>
                  <strong>{result.summary.totalRows}</strong> rows ·
                  zones created <strong>{result.summary.createdZones}</strong> ·
                  pincodes assigned <strong>{result.summary.assignedPincodes}</strong> ·
                  skipped <strong>{result.summary.skipCount}</strong> ·
                  failed <strong>{result.summary.failedCount}</strong>
                  {result.summary.dryRun ? ' (dry run — nothing written)' : ''}
                </span>
              </div>
              {result.results.some((r) => r.status === 'failed' || r.status === 'skipped') && (
                <div className="max-h-60 overflow-y-auto text-xs border rounded">
                  <table className="data-table">
                    <thead><tr><th>Row</th><th>Status</th><th>Detail</th></tr></thead>
                    <tbody>
                      {result.results.filter((r) => r.status !== 'assigned').slice(0, 200).map((r, i) => (
                        <tr key={i}>
                          <td className="!text-center">{r.rowNumber ?? '—'}</td>
                          <td className={`!text-center ${r.status === 'failed' ? 'text-destructive' : ''}`}>{r.status}</td>
                          <td className="!text-left">
                            {r.status === 'failed' ? (r.errors?.join('; ') ?? '') : (r.reason ?? '')}
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
            <Button type="button" variant="outline" onClick={onClose}>Close</Button>
            <Button type="submit" disabled={busy || !file}>
              {busy ? 'Uploading…' : dryRun ? 'Validate (dry run)' : 'Apply to DB'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
