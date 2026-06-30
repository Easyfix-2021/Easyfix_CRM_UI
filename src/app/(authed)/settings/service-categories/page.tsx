'use client';

/*
 * Manage Service Category — Settings page.
 *
 * Operates on tbl_service_catg via /api/admin/service-categories.
 * Mirrors the legacy /pages/settings/manageServiceCategory.vm +
 * addEditServicesCategory.vm.
 *
 * Legacy fields (full parity with addEditServicesCategory.vm):
 *   Service Category Name (required, min 2), Service Category Desc.
 *   (required, min 2), Status (Active/Inactive — edit only; add always
 *   creates Active). No image / sequence / parent column exists on
 *   tbl_service_catg, so there is nothing further to surface.
 *
 * Status convention: 1=Active, 0=Inactive, 3=Deleted.
 *   - Delete (trash) soft-deletes to status 3 (row leaves every list),
 *     mirroring the legacy CRM trash action and the Manage Service Type
 *     sibling.
 *   - The edit modal's Active toggle is a separate 1↔0 deactivate
 *     (inactive rows still surface under "include inactive").
 */

import { useEffect, useState } from 'react';
import {
  Package, Search, Plus, Pencil, CheckCircle2, XCircle,
  AlertTriangle, ChevronDown, ChevronRight, Info,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { Switch } from '@/components/ui/switch';
import { api, ApiError } from '@/lib/api';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { invalidateLookup } from '@/lib/use-lookup';
import { cycleSort, SortHeader, type SortDir } from '@/lib/use-sort';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

type Category = {
  service_catg_id: number;
  service_catg_name: string;
  service_catg_desc: string | null;
  service_catg_status: number;
  service_type_count: number;
};
type ListResponse = { items: Category[]; total: number };
// Server-side sort keys — must match svc.SORTABLE_COLUMNS in
// services/service-category.service.js.
type SortKey = 'service_catg_id' | 'service_catg_name' | 'service_catg_status' | 'service_type_count';

// BE Joi cap on /admin/service-categories `limit` is 1000
// (routes/admin/service-categories.js). Pass it so the shared "All"
// page-size maps to the endpoint's true ceiling.
const SERVICE_CATG_LIMIT_CAP = 1000;

export default function ManageServiceCategoryPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  // RBAC — keys mirror legacy CRM Constants.actionPermissions and are seeded
  // by migrations/2026-06-22-seed-service-category-action-permissions.sql:
  //   isServiceCategoryAddNew — Add Service Category button
  //   isServiceCategoryEdit   — per-row Edit (pencil) + the modal's Active toggle
  //   isServiceCategoryDelete — per-row Delete (trash → status 3)
  const can = actionFlags(me, ['isServiceCategoryAddNew', 'isServiceCategoryEdit']);

  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  // Server-side pagination state. Page is 0-indexed (offset = page * size).
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);
  // Server-side sort state (3-click asc → desc → unsorted via cycleSort).
  const [sortBy, setSortBy] = useState<SortKey | null>('service_catg_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  // Mutation-only error (delete). Fetch errors come from useFetch below.
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Category | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  function onSort(col: SortKey) {
    const next = cycleSort<SortKey>(col, { sortBy, sortDir });
    setSortBy(next.sortBy);
    setSortDir(next.sortDir);
    setPage(0);
  }

  const [howOpen, setHowOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('svccatg-help-collapsed') === '0';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('svccatg-help-collapsed', howOpen ? '0' : '1');
  }, [howOpen]);

  // Debounced server-side search — replaces the hand-rolled setTimeout/
  // clearTimeout pattern. Mandatory per memory `feedback_crm_ui_fetch_hooks`.
  const debouncedSearch = useDebouncedValue(search, 300);
  // Reset to page 0 whenever a filter changes (debouncedSearch self-delays).
  useEffect(() => { setPage(0); }, [debouncedSearch, includeInactive]);

  // Build the list URL — every input that affects the result set is part of
  // the key, so useFetch re-fires automatically on search/filter/sort/page
  // changes (no manual fetchList()/useEffect orchestration). 'all' maps to
  // the endpoint's Joi cap; numeric sizes map 1:1.
  const limit = pageSizeToLimit(pageSize, SERVICE_CATG_LIMIT_CAP);
  const offset = page * (pageSize === 'all' ? limit : Number(pageSize));
  const params = new URLSearchParams();
  if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
  if (includeInactive)        params.set('includeInactive', 'true');
  params.set('limit',  String(limit));
  params.set('offset', String(offset));
  // When unsorted (3rd click), omit sort params so the BE applies its default
  // (service_catg_name ASC).
  if (sortBy) { params.set('sortBy', sortBy); params.set('sortDir', sortDir); }
  const listUrl = `/admin/service-categories?${params.toString()}`;

  const { data: listData, loading, error: fetchError, refetch } = useFetch<ListResponse>(listUrl);
  const items: Category[] = listData?.items ?? [];
  const total = listData?.total ?? 0;

  // Invalidate the 30s module cache for ALL service-category list pages, then
  // refetch (a mutation changes counts/order across pages). Also bust the shared
  // 'svcCat' lookup cache so active-only category dropdowns elsewhere stop showing
  // a just-deactivated/renamed category instead of waiting out the 30-min TTL.
  function refreshList() {
    invalidateLookup('svcCat');
    invalidateFetch((k) => k.startsWith('/admin/service-categories'));
    refetch();
  }

  // Deactivate an active row → status 0 (Inactive, still listable under
  // "include inactive"). Distinct from Delete (status 3, removed). Guarded the
  // same as delete: can't hide a category out from under active service types.
  async function handleDeactivate(c: Category) {
    if (c.service_type_count > 0) {
      await confirm({
        title: 'Cannot Deactivate This Category',
        description: `${c.service_type_count} active service type${c.service_type_count === 1 ? '' : 's'} still reference "${c.service_catg_name}". Deactivate or reassign them first.`,
        confirmLabel: 'OK',
      });
      return;
    }
    const ok = await confirm({
      title: 'Deactivate service category?',
      description: `"${c.service_catg_name}" will be marked Inactive and hidden from default lists. You can reactivate it anytime.`,
      confirmLabel: 'Deactivate', variant: 'destructive',
    });
    if (!ok) return;
    setMutationError(null);
    try {
      await api.patch(`/admin/service-categories/${c.service_catg_id}`, { is_active: false });
      refreshList();
    } catch (e) {
      setMutationError(e instanceof ApiError ? e.message : 'Deactivate failed');
    }
  }
  // One-click reactivate for inactive (status 0) rows — flips back to Active.
  async function handleReactivate(c: Category) {
    setMutationError(null);
    try {
      await api.patch(`/admin/service-categories/${c.service_catg_id}`, { is_active: true });
      refreshList();
    } catch (e) {
      setMutationError(e instanceof ApiError ? e.message : 'Reactivate failed');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="size-6" /> Manage Service Category
          </h1>
          <p className="text-sm text-muted-foreground">
            Top-level service categories (Electrician, Carpentry, …). Each category groups one or more Service Types.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isServiceCategoryAddNew && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add Service Category
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <button type="button" onClick={() => setHowOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/50 transition-colors" aria-expanded={howOpen}>
            {howOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
            <Info className="size-4 shrink-0 text-blue-600" />
            <span className="font-medium">How Service Category Management Works</span>
            <span className="ml-auto text-xs text-muted-foreground">{howOpen ? 'Hide' : 'Show'}</span>
          </button>
          {howOpen && (
            <div className="px-4 pb-4 pt-1 text-sm text-muted-foreground space-y-2 border-t">
              <p>Each Service Category groups one or more Service Types. A category cannot be deactivated while any of its service types are still active — deactivate or reassign those first.</p>
              <p>Deactivate hides a category from default lists (reversible). Toggle &ldquo;Include inactive&rdquo; to bring inactive rows back and Reactivate them.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search by name or description…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
          </div>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            Include inactive
          </label>
        </CardContent>
      </Card>

      {(fetchError || mutationError) && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {fetchError || mutationError}
        </CardContent></Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '10%' }} />
              <col style={{ width: '25%' }} />
              <col style={{ width: '34%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '9%'  }} />
            </colgroup>
            <thead>
              <tr>
                <SortHeader col={'service_catg_id'     as SortKey} align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>ID</SortHeader>
                <SortHeader col={'service_catg_name'   as SortKey} align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Service Category Name</SortHeader>
                <th className="!text-left whitespace-nowrap">Service Description</th>
                <SortHeader col={'service_type_count'  as SortKey} align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Service Types</SortHeader>
                <SortHeader col={'service_catg_status' as SortKey} align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">No service categories match the current filters.</td></tr>}
              {!loading && items.map((c) => (
                <tr key={c.service_catg_id}>
                  <td className="!text-center font-mono text-xs truncate">{c.service_catg_id}</td>
                  <td className="!text-left font-medium truncate" title={c.service_catg_name}>{c.service_catg_name}</td>
                  <td className="!text-left truncate text-muted-foreground" title={c.service_catg_desc ?? ''}>
                    {c.service_catg_desc ?? <span>—</span>}
                  </td>
                  <td className="!text-center font-mono text-xs">{c.service_type_count}</td>
                  <td className="!text-center whitespace-nowrap">
                    {c.service_catg_status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-0.5">
                      {can.isServiceCategoryEdit && (
                        <IconButton
                          icon={Pencil}
                          label="Edit Service Category"
                          intent="primary"
                          onClick={() => { setEditing(c); setModalOpen(true); }}
                        />
                      )}
                      {can.isServiceCategoryEdit && c.service_catg_status === 1 && (
                        <IconButton
                          icon={XCircle}
                          label="Deactivate Service Category"
                          intent="danger"
                          onClick={() => handleDeactivate(c)}
                        />
                      )}
                      {can.isServiceCategoryEdit && c.service_catg_status !== 1 && (
                        <IconButton
                          icon={CheckCircle2}
                          label="Reactivate Service Category"
                          intent="success"
                          onClick={() => handleReactivate(c)}
                        />
                      )}
                      {!can.isServiceCategoryEdit && (
                        <span className="text-[10px] text-muted-foreground">view-only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

      <CategoryFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        onSaved={() => { setModalOpen(false); refreshList(); }}
      />
    </div>
  );
}

function CategoryFormModal({ open, onClose, editing, onSaved }: {
  open: boolean; onClose: () => void; editing: Category | null; onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.service_catg_name ?? '');
      setDesc(editing?.service_catg_desc ?? '');
      setActive(editing ? editing.service_catg_status === 1 : true);
      setError(null);
    }
  }, [open, editing]);

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  async function handleSubmit() {
    setError(null);
    // Legacy parity: name + description both required (min 2).
    if (name.trim().length < 2) { setError('Service Category Name is required (min 2 characters)'); return; }
    if (desc.trim().length < 2) { setError('Description is required (min 2 characters)'); return; }
    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/service-categories/${editing!.service_catg_id}`, {
          service_catg_name: name.trim(), service_catg_desc: desc.trim(), is_active: active,
        });
      } else {
        await api.post('/admin/service-categories', {
          service_catg_name: name.trim(), service_catg_desc: desc.trim(),
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.service_catg_name}"` : 'Add Service Category'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/* Row 1 — Name (left, reduced) + Status toggle (right-aligned, edit-only) */}
          <div className="flex items-end gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium block mb-1">Service Category Name *</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Electrician"' />
            </div>
            {isEdit && (
              <div className="flex flex-col items-end">
                <label className="text-sm font-medium block mb-1">Status</label>
                <div className="flex items-center gap-2 h-9">
                  <span className={`text-sm ${active ? 'text-emerald-700' : 'text-muted-foreground'}`}>
                    {active ? 'Active' : 'Inactive'}
                  </span>
                  <Switch checked={active} onCheckedChange={setActive} ariaLabel="Active status" />
                </div>
              </div>
            )}
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Service Category Desc. *</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="What this category covers"
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
              maxLength={500} />
          </div>
          {error && <div className="text-sm text-red-600 flex items-center gap-1"><AlertTriangle className="size-4" /> {error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Service Category'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
