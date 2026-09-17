'use client';

/*
 * Settings → Manage Materials — Material Master (Fixed | Dynamic pricing)
 * + Brand Master, one page, two cards. Built against the shared contract
 * (manage-materials-contract.md) the backend agent built the API from in
 * parallel — see that file for the authoritative endpoint/rule list.
 */

import { useMemo, useState } from 'react';
import {
  Package, Search, Plus, Upload, Pencil, XCircle, CheckCircle2, Trash2, AlertTriangle, Tags,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { StatusChip } from '@/components/ui/StatusChip';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { SortHeader, cycleSort, type SortDir } from '@/lib/use-sort';
import { api, ApiError } from '@/lib/api';
import { useFetch, useDebouncedValue } from '@/lib/hooks';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/components/ui/toast';
import { useLookup } from '@/lib/use-lookup';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { MaterialDialog } from './MaterialDialog';
import { BrandDialog } from './BrandDialog';
import { DeleteReferencesDialog } from './DeleteReferencesDialog';
import { ImportDialog } from './ImportDialog';
import {
  MATERIAL_ACTIONS, BRAND_ACTIONS,
  type MaterialListItem, type MaterialListResponse,
  type BrandListItem, type BrandListResponse, type BrandOption,
  type MaterialImportSummary, type BrandImportSummary,
} from './types';

const MATERIALS_LIMIT_CAP = 1000;
const BRANDS_LIMIT_CAP = 1000;
const DEFAULT_PAGE_SIZE: TablePageSize = 20;

type MaterialStatusFilter = 'active' | 'inactive' | 'price_pending' | 'all';
type MaterialSortKey = 'material_name' | 'service_catg_name' | 'pricing_type' | 'price_min' | 'status';
type BrandSortKey = 'brand_name' | 'used_by' | 'status';

type DeleteTarget = { entity: 'material' | 'brand'; id: number; name: string } | null;

function priceRangeLabel(min: number | null, max: number | null): string {
  if (min == null && max == null) return '—';
  if (min == null) return `₹${max}`;
  if (max == null || min === max) return `₹${min}`;
  return `₹${min} – ₹${max}`;
}

function brandsCell(m: MaterialListItem) {
  const names = m.brand_names;
  if (names.length === 0) {
    // Decision A: "Not Applicable" is gone — a FIXED material with an
    // empty brand list is the No Brand mode. DYNAMIC materials have no
    // brand concept at all, so they keep the plain dash.
    return m.pricing_type === 'FIXED' ? <span className="text-muted-foreground">No Brand</span> : '—';
  }
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

export default function ManageMaterialsPage() {
  const { me } = useMe();
  const confirm = useConfirm();
  const lookup = useLookup();
  const can = actionFlags(me, [...MATERIAL_ACTIONS, ...BRAND_ACTIONS]);

  // ── Materials filter/sort/paging state ──────────────────────────────
  const [mSearch, setMSearch] = useState('');
  const [mCategory, setMCategory] = useState<number | ''>('');
  const [mPricingType, setMPricingType] = useState<'ALL' | 'FIXED' | 'DYNAMIC'>('ALL');
  const [mBrand, setMBrand] = useState<number | ''>('');
  const [mStatus, setMStatus] = useState<MaterialStatusFilter>('active');
  const [mPage, setMPage] = useState(0);
  const [mPageSize, setMPageSize] = useState<TablePageSize>(DEFAULT_PAGE_SIZE);
  const [mSortBy, setMSortBy] = useState<MaterialSortKey | null>(null);
  const [mSortDir, setMSortDir] = useState<SortDir>('asc');
  const dMSearch = useDebouncedValue(mSearch, 300);

  function onMSort(col: MaterialSortKey) {
    const next = cycleSort<MaterialSortKey>(col, { sortBy: mSortBy, sortDir: mSortDir });
    setMSortBy(next.sortBy);
    setMSortDir(next.sortDir);
    setMPage(0);
  }

  const mLimit = pageSizeToLimit(mPageSize, MATERIALS_LIMIT_CAP);
  const materialsListUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (dMSearch.trim()) p.set('search', dMSearch.trim());
    if (mCategory) p.set('service_catg_id', String(mCategory));
    if (mPricingType !== 'ALL') p.set('pricing_type', mPricingType);
    if (mBrand) p.set('brand_id', String(mBrand));
    p.set('status', mStatus);
    p.set('page', String(mPage));
    p.set('limit', String(mLimit));
    if (mSortBy) { p.set('sort_by', mSortBy); p.set('sort_dir', mSortDir); }
    return `/admin/materials?${p.toString()}`;
  }, [dMSearch, mCategory, mPricingType, mBrand, mStatus, mPage, mLimit, mSortBy, mSortDir]);

  const { data: materialsData, loading: materialsLoading, refetch: refetchMaterials } =
    useFetch<MaterialListResponse>(can.isMaterialView ? materialsListUrl : null);
  const materials = materialsData?.items ?? [];
  const materialsTotal = materialsData?.total ?? 0;

  // ── Brands filter/sort/paging state ──────────────────────────────────
  const [bSearch, setBSearch] = useState('');
  const [bIncludeInactive, setBIncludeInactive] = useState(false);
  const [bPage, setBPage] = useState(0);
  const [bPageSize, setBPageSize] = useState<TablePageSize>(DEFAULT_PAGE_SIZE);
  const [bSortBy, setBSortBy] = useState<BrandSortKey | null>(null);
  const [bSortDir, setBSortDir] = useState<SortDir>('asc');
  const dBSearch = useDebouncedValue(bSearch, 300);

  function onBSort(col: BrandSortKey) {
    const next = cycleSort<BrandSortKey>(col, { sortBy: bSortBy, sortDir: bSortDir });
    setBSortBy(next.sortBy);
    setBSortDir(next.sortDir);
    setBPage(0);
  }

  const bLimit = pageSizeToLimit(bPageSize, BRANDS_LIMIT_CAP);
  const brandsListUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (dBSearch.trim()) p.set('search', dBSearch.trim());
    p.set('status', bIncludeInactive ? 'all' : 'active');
    p.set('page', String(bPage));
    p.set('limit', String(bLimit));
    if (bSortBy) { p.set('sort_by', bSortBy); p.set('sort_dir', bSortDir); }
    return `/admin/brands?${p.toString()}`;
  }, [dBSearch, bIncludeInactive, bPage, bLimit, bSortBy, bSortDir]);

  const { data: brandsData, loading: brandsLoading, refetch: refetchBrands } =
    useFetch<BrandListResponse>(can.isBrandView ? brandsListUrl : null);
  const brands = brandsData?.items ?? [];
  const brandsTotal = brandsData?.total ?? 0;

  // Brand-options (active brands) — feeds the Materials "Brand" filter AND
  // the material dialog's picker (which fetches it itself too; the 30s
  // useFetch cache dedupes the two).
  const { data: brandOptions } = useFetch<BrandOption[]>(can.isMaterialView ? '/admin/materials/brand-options' : null);
  const brandFilterOptions: SearchOption[] = (brandOptions ?? []).map((b) => ({ value: b.brand_id, label: b.brand_name }));

  function refreshBrands() { refetchBrands(); }
  function refreshBoth() { refetchMaterials(); refetchBrands(); }

  // ── Dialog state ──────────────────────────────────────────────────────
  const [materialDialogOpen, setMaterialDialogOpen] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState<MaterialListItem | null>(null);
  const [brandDialogOpen, setBrandDialogOpen] = useState(false);
  const [editingBrand, setEditingBrand] = useState<BrandListItem | null>(null);
  const [materialsImportOpen, setMaterialsImportOpen] = useState(false);
  const [brandsImportOpen, setBrandsImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // Replacement pickers for the delete-with-references flow — lazily
  // fetched only once a delete is actually pending for that entity.
  const { data: materialsForReplace } = useFetch<MaterialListResponse>(
    deleteTarget?.entity === 'material' ? '/admin/materials?status=all&limit=1000' : null,
  );
  const materialReplaceOptions: SearchOption[] = (materialsForReplace?.items ?? [])
    .filter((m) => m.material_id !== deleteTarget?.id)
    .map((m) => ({ value: m.material_id, label: m.material_name }));

  const { data: brandsForReplace } = useFetch<BrandListResponse>(
    deleteTarget?.entity === 'brand' ? '/admin/brands?status=all&limit=1000' : null,
  );
  const brandReplaceOptions: SearchOption[] = (brandsForReplace?.items ?? [])
    .filter((b) => b.brand_id !== deleteTarget?.id)
    .map((b) => ({ value: b.brand_id, label: b.brand_name }));

  // ── Material row actions ─────────────────────────────────────────────
  async function deactivateMaterial(m: MaterialListItem) {
    const ok = await confirm({
      title: 'Deactivate material?',
      description: `"${m.material_name}" will be marked Inactive and hidden from the default list.`,
      confirmLabel: 'Deactivate', variant: 'destructive',
    });
    if (!ok) return;
    setBusyId(m.material_id);
    try {
      await api.patch(`/admin/materials/${m.material_id}/status`, { is_active: false });
      refreshBoth();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Deactivate failed' });
    } finally { setBusyId(null); }
  }
  async function reactivateMaterial(m: MaterialListItem) {
    setBusyId(m.material_id);
    try {
      await api.patch(`/admin/materials/${m.material_id}/status`, { is_active: true });
      refreshBoth();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Reactivate failed' });
    } finally { setBusyId(null); }
  }

  // ── Brand row actions ─────────────────────────────────────────────────
  async function deactivateBrand(b: BrandListItem) {
    const ok = await confirm({
      title: 'Deactivate brand?',
      description: `"${b.brand_name}" will be marked Inactive and hidden from the material picker.`,
      confirmLabel: 'Deactivate', variant: 'destructive',
    });
    if (!ok) return;
    setBusyId(b.brand_id);
    try {
      await api.patch(`/admin/brands/${b.brand_id}/status`, { is_active: false });
      refreshBoth();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Deactivate failed' });
    } finally { setBusyId(null); }
  }
  async function reactivateBrand(b: BrandListItem) {
    setBusyId(b.brand_id);
    try {
      await api.patch(`/admin/brands/${b.brand_id}/status`, { is_active: true });
      refreshBoth();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Reactivate failed' });
    } finally { setBusyId(null); }
  }

  if (me && !can.isMaterialView) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Manage Materials</h1>
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            You don&apos;t have access to Manage Materials. Ask an admin to grant the relevant action permissions in Manage Roles.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Package className="size-6" /> Manage Materials
        </h1>
        <p className="text-sm text-muted-foreground">
          Material master (Fixed / Dynamic pricing) and Brand master used across quotations and rate cards.
        </p>
      </div>

      {/* ── Material Master ─────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          <div className="p-3 flex items-center justify-between gap-3 flex-wrap border-b">
            <h2 className="text-base font-semibold">Material Master</h2>
            <div className="flex items-center gap-2">
              {can.isMaterialImport && (
                <Button variant="outline" size="sm" onClick={() => setMaterialsImportOpen(true)}>
                  <Upload className="size-4 mr-1" /> Import
                </Button>
              )}
              {can.isMaterialAddNew && (
                <Button size="sm" onClick={() => { setEditingMaterial(null); setMaterialDialogOpen(true); }}>
                  <Plus className="size-4 mr-1" /> Add Material
                </Button>
              )}
            </div>
          </div>

          <div className="p-3 flex items-center gap-2 flex-wrap border-b">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search by name or description…" value={mSearch} onChange={(e) => { setMSearch(e.target.value); setMPage(0); }} className="pl-8" />
            </div>
            <div className="w-44">
              <SearchSelect value={mCategory} onChange={(v) => { setMCategory(v ? Number(v) : ''); setMPage(0); }} options={lookup.toOpts.serviceCategories} placeholder="All Categories" />
            </div>
            <div className="w-40">
              <SearchSelect value={mBrand} onChange={(v) => { setMBrand(v ? Number(v) : ''); setMPage(0); }} options={brandFilterOptions} placeholder="All Brands" />
            </div>
            <div className="flex items-center gap-1">
              {(['ALL', 'FIXED', 'DYNAMIC'] as const).map((pt) => (
                <Button key={pt} size="sm" variant={mPricingType === pt ? 'default' : 'outline'} onClick={() => { setMPricingType(pt); setMPage(0); }}>
                  {pt === 'ALL' ? 'All' : pt === 'FIXED' ? 'Fixed' : 'Dynamic'}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {([
                ['active', 'Active'], ['inactive', 'Inactive'], ['price_pending', 'Price Pending'], ['all', 'All'],
              ] as Array<[MaterialStatusFilter, string]>).map(([v, label]) => (
                <Button key={v} size="sm" variant={mStatus === v ? 'default' : 'outline'} onClick={() => { setMStatus(v); setMPage(0); }}>
                  {label}
                </Button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="data-table w-full" style={{ minWidth: '1100px' }}>
              <thead>
                <tr>
                  <SortHeader col={'material_name' as MaterialSortKey} align="left" sortBy={mSortBy} sortDir={mSortDir} onSort={onMSort}>Material Name</SortHeader>
                  <SortHeader col={'service_catg_name' as MaterialSortKey} align="left" sortBy={mSortBy} sortDir={mSortDir} onSort={onMSort}>Category</SortHeader>
                  <th className="!text-left whitespace-nowrap">UOM</th>
                  <SortHeader col={'pricing_type' as MaterialSortKey} align="center" sortBy={mSortBy} sortDir={mSortDir} onSort={onMSort}>Pricing Type</SortHeader>
                  <th className="!text-left whitespace-nowrap">Brands</th>
                  <SortHeader col={'price_min' as MaterialSortKey} align="right" sortBy={mSortBy} sortDir={mSortDir} onSort={onMSort}>Price Range</SortHeader>
                  <SortHeader col={'status' as MaterialSortKey} align="center" sortBy={mSortBy} sortDir={mSortDir} onSort={onMSort}>Status</SortHeader>
                  <th className="!text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody>
                {materialsLoading && materials.length === 0 && (
                  <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
                )}
                {!materialsLoading && materials.length === 0 && (
                  <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">No materials match the current filters.</td></tr>
                )}
                {materials.map((m) => (
                  <tr key={m.material_id}>
                    <td className="!text-left">
                      <div className="font-medium truncate" title={m.material_name}>{m.material_name}</div>
                      {m.description && <div className="text-xs text-muted-foreground truncate" title={m.description}>{m.description}</div>}
                    </td>
                    <td className="!text-left truncate" title={m.service_catg_name}>{m.service_catg_name}</td>
                    <td className="!text-left truncate">{m.uom_name ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="!text-center whitespace-nowrap">{m.pricing_type === 'FIXED' ? 'Fixed' : 'Dynamic'}</td>
                    <td className="!text-left truncate" title={m.brand_names.length ? m.brand_names.join(', ') : 'No Brand'}>{brandsCell(m)}</td>
                    <td className="!text-right whitespace-nowrap tabular-nums">{priceRangeLabel(m.price_min, m.price_max)}</td>
                    <td className="!text-center whitespace-nowrap">
                      {m.status !== 1
                        ? <StatusChip tone="neutral" size="sm">Inactive</StatusChip>
                        : m.price_pending
                          ? <StatusChip tone="warning" size="sm">Price Pending</StatusChip>
                          : <StatusChip tone="success" size="sm">Active</StatusChip>}
                    </td>
                    <td className="!text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-0.5">
                        {can.isMaterialEdit && (
                          <IconButton icon={Pencil} label="Edit Material" intent="primary"
                            onClick={() => { setEditingMaterial(m); setMaterialDialogOpen(true); }} />
                        )}
                        {can.isMaterialDeactivate && m.status === 1 && (
                          <IconButton icon={XCircle} label="Deactivate Material" intent="danger"
                            busy={busyId === m.material_id} onClick={() => deactivateMaterial(m)} />
                        )}
                        {can.isMaterialDeactivate && m.status !== 1 && (
                          <IconButton icon={CheckCircle2} label="Reactivate Material" intent="success"
                            busy={busyId === m.material_id} onClick={() => reactivateMaterial(m)} />
                        )}
                        {can.isMaterialDelete && (
                          <IconButton icon={Trash2} label="Delete Material" intent="danger"
                            onClick={() => setDeleteTarget({ entity: 'material', id: m.material_id, name: m.material_name })} />
                        )}
                        {!can.isMaterialEdit && !can.isMaterialDeactivate && !can.isMaterialDelete && (
                          <span className="text-xs text-muted-foreground">view-only</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 border-t">
            <TablePagination page={mPage} pageSize={mPageSize} total={materialsTotal} loading={materialsLoading}
              onPageChange={setMPage} onPageSizeChange={(s) => { setMPageSize(s); setMPage(0); }} />
          </div>
        </CardContent>
      </Card>

      {/* ── Brand Master ─────────────────────────────────────────────── */}
      {can.isBrandView && (
        <Card>
          <CardContent className="p-0">
            <div className="p-3 flex items-center justify-between gap-3 flex-wrap border-b">
              <h2 className="text-base font-semibold flex items-center gap-2"><Tags className="size-4" /> Brand Master</h2>
              <div className="flex items-center gap-2">
                {can.isBrandImport && (
                  <Button variant="outline" size="sm" onClick={() => setBrandsImportOpen(true)}>
                    <Upload className="size-4 mr-1" /> Import
                  </Button>
                )}
                {can.isBrandAddNew && (
                  <Button size="sm" onClick={() => { setEditingBrand(null); setBrandDialogOpen(true); }}>
                    <Plus className="size-4 mr-1" /> Add Brand
                  </Button>
                )}
              </div>
            </div>

            <div className="p-3 flex items-center gap-2 flex-wrap border-b">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input placeholder="Search by brand name…" value={bSearch} onChange={(e) => { setBSearch(e.target.value); setBPage(0); }} className="pl-8" />
              </div>
              <label className="flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer">
                <input type="checkbox" checked={bIncludeInactive} onChange={(e) => { setBIncludeInactive(e.target.checked); setBPage(0); }} />
                Include Inactive
              </label>
            </div>

            <div className="overflow-x-auto">
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <SortHeader col={'brand_name' as BrandSortKey} align="left" sortBy={bSortBy} sortDir={bSortDir} onSort={onBSort}>Brand Name</SortHeader>
                    <SortHeader col={'used_by' as BrandSortKey} align="center" sortBy={bSortBy} sortDir={bSortDir} onSort={onBSort}>Used By</SortHeader>
                    <SortHeader col={'status' as BrandSortKey} align="center" sortBy={bSortBy} sortDir={bSortDir} onSort={onBSort}>Status</SortHeader>
                    <th className="!text-right whitespace-nowrap">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {brandsLoading && brands.length === 0 && (
                    <tr><td colSpan={4} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
                  )}
                  {!brandsLoading && brands.length === 0 && (
                    <tr><td colSpan={4} className="!text-center text-muted-foreground py-6">No brands match the current filters.</td></tr>
                  )}
                  {brands.map((b) => (
                    <tr key={b.brand_id}>
                      <td className="!text-left truncate">
                        <span className="inline-flex items-center gap-1.5">
                          {b.brand_name}
                          {b.is_system === 1 && <StatusChip tone="info" size="sm">System</StatusChip>}
                        </span>
                      </td>
                      <td className="!text-center tabular-nums">{b.used_by}</td>
                      <td className="!text-center whitespace-nowrap">
                        {b.status === 1
                          ? <StatusChip tone="success" size="sm">Active</StatusChip>
                          : <StatusChip tone="neutral" size="sm">Inactive</StatusChip>}
                      </td>
                      <td className="!text-right whitespace-nowrap">
                        {b.is_system === 1 ? (
                          <span className="text-xs text-muted-foreground">system</span>
                        ) : (
                          <div className="inline-flex items-center justify-end gap-0.5">
                            {can.isBrandEdit && (
                              <IconButton icon={Pencil} label="Edit Brand" intent="primary"
                                onClick={() => { setEditingBrand(b); setBrandDialogOpen(true); }} />
                            )}
                            {can.isBrandDeactivate && b.status === 1 && (
                              <IconButton icon={XCircle} label="Deactivate Brand" intent="danger"
                                busy={busyId === b.brand_id} onClick={() => deactivateBrand(b)} />
                            )}
                            {can.isBrandDeactivate && b.status !== 1 && (
                              <IconButton icon={CheckCircle2} label="Reactivate Brand" intent="success"
                                busy={busyId === b.brand_id} onClick={() => reactivateBrand(b)} />
                            )}
                            {can.isBrandDelete && (
                              <IconButton icon={Trash2} label="Delete Brand" intent="danger"
                                onClick={() => setDeleteTarget({ entity: 'brand', id: b.brand_id, name: b.brand_name })} />
                            )}
                            {!can.isBrandEdit && !can.isBrandDeactivate && !can.isBrandDelete && (
                              <span className="text-xs text-muted-foreground">view-only</span>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-2 border-t">
              <TablePagination page={bPage} pageSize={bPageSize} total={brandsTotal} loading={brandsLoading}
                onPageChange={setBPage} onPageSizeChange={(s) => { setBPageSize(s); setBPage(0); }} />
            </div>
          </CardContent>
        </Card>
      )}

      <MaterialDialog
        open={materialDialogOpen}
        onClose={() => setMaterialDialogOpen(false)}
        editing={editingMaterial}
        canSeeBrands={can.isBrandView}
        onSaved={() => { setMaterialDialogOpen(false); refreshBoth(); }}
      />

      <BrandDialog
        open={brandDialogOpen}
        onClose={() => setBrandDialogOpen(false)}
        editing={editingBrand}
        onSaved={() => { setBrandDialogOpen(false); refreshBoth(); }}
      />

      <DeleteReferencesDialog
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        entity={deleteTarget?.entity ?? 'material'}
        id={deleteTarget?.id ?? null}
        name={deleteTarget?.name ?? ''}
        replacementOptions={deleteTarget?.entity === 'brand' ? brandReplaceOptions : materialReplaceOptions}
        onDone={refreshBoth}
      />

      <ImportDialog<MaterialImportSummary>
        open={materialsImportOpen}
        onClose={() => setMaterialsImportOpen(false)}
        entityLabel="Material"
        templateUrl="/admin/materials/import/template.xlsx"
        templateFilename="manage-materials-template.xlsx"
        previewUrl="/admin/materials/import/preview"
        commitUrl="/admin/materials/import/commit"
        errorsUrl="/admin/materials/import/errors.xlsx"
        renderRowLabel={(r) => String(r.material_name ?? '')}
        summaryStats={(s) => [
          { label: 'New', value: s.new, tone: 'ok' as const },
          { label: 'Update', value: s.update },
          { label: 'Price Pending', value: s.price_pending, tone: 'warn' as const },
          { label: 'Blocked', value: s.blocked, tone: 'err' as const },
        ]}
        extraNotice={(s) => (s.brands_to_create?.length ? (
          <div className={`text-xs rounded p-2 border flex items-start gap-1.5 ${s.can_create_brands ? 'bg-info-tint text-info-strong border-info/30' : 'bg-warning-tint text-warning-strong border-warning/30'}`}>
            <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
            {s.can_create_brands
              ? `${s.brands_to_create.length} brand(s) will be created: ${s.brands_to_create.join(', ')}`
              : `${s.brands_to_create.length} unknown brand(s) need Import Brands permission to create: ${s.brands_to_create.join(', ')}`}
          </div>
        ) : null)}
        onImported={refreshBoth}
      />

      <ImportDialog<BrandImportSummary>
        open={brandsImportOpen}
        onClose={() => setBrandsImportOpen(false)}
        entityLabel="Brand"
        templateUrl="/admin/brands/import/template.xlsx"
        templateFilename="manage-brands-template.xlsx"
        previewUrl="/admin/brands/import/preview"
        commitUrl="/admin/brands/import/commit"
        errorsUrl="/admin/brands/import/errors.xlsx"
        renderRowLabel={(r) => String(r.brand_name ?? '')}
        summaryStats={(s) => [
          { label: 'New', value: s.new, tone: 'ok' as const },
          { label: 'Exists', value: s.exists },
          { label: 'Blocked', value: s.blocked, tone: 'err' as const },
        ]}
        onImported={refreshBrands}
      />
    </div>
  );
}
