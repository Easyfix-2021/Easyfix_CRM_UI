'use client';

/*
 * Manage Service Type — Settings page.
 *
 * Operates on tbl_service_type via /api/admin/service-types. Mirrors the
 * legacy /pages/settings/manageServiceType.vm + addEditServicesType.vm.
 *
 * Legacy fields supported (full parity with addEditServicesType.vm):
 *   name, description, parent service category (required FK), display flag
 *   (1=show to all, 0=CRM rate-card, 2=Tx App deep-skill), status,
 *   Tools multi-select (service_type_tools CSV + tool-names CSV), and
 *   Service Type Image (service_type_image — uploaded via /shared/upload,
 *   served from /easydoc).
 *
 * Delete (trash) soft-deletes to status 3 (the row leaves every list),
 * mirroring the legacy CRM trash action. The edit modal's Active toggle is a
 * separate 1↔0 deactivate (inactive rows still surface under "include inactive").
 */

import { useEffect, useState } from 'react';
import {
  Hash, Search, Plus, Pencil, CheckCircle2, XCircle,
  AlertTriangle,
  ArrowUp, ArrowDown, ArrowUpDown,
  Image as ImageIcon, UploadCloud,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { Switch } from '@/components/ui/switch';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { api, ApiError } from '@/lib/api';
import { useFetch, useDebouncedValue } from '@/lib/hooks';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useLookup } from '@/lib/use-lookup';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

type ServiceType = {
  service_type_id: number;
  service_type_name: string;
  service_type_desc: string | null;
  service_type_status: number;
  service_catg_id: number | null;
  service_catg_name: string | null;
  display: number;
  service_type_tools: string | null;
  service_type_tool_names: string | null;
  service_type_image: string | null;
};
type ListResponse = { items: ServiceType[]; total: number };
type SortKey = 'service_type_id' | 'service_type_name' | 'service_catg_name' | 'service_type_status' | 'display';
type SortDir = 'asc' | 'desc';

// BE Joi cap on /admin/service-types `limit` is 1000 (routes/admin/service-types.js);
// pass it so the shared "All" page-size maps to the endpoint's true ceiling.
const SERVICE_TYPES_LIMIT_CAP = 1000;

export default function ManageServiceTypePage() {
  const confirm = useConfirm();
  const lookup = useLookup();
  const { me } = useMe();
  const can = actionFlags(me, ['isServiceTypeAddNew', 'isServiceTypeEdit']);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<number | ''>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);
  const [editing, setEditing] = useState<ServiceType | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('service_type_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function onSort(col: SortKey) {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('asc'); }
    setPage(0);
  }

  // Debounced search — replaces the hand-rolled setTimeout/clearTimeout
  // pattern. Mandatory per memory `feedback_crm_ui_fetch_hooks`.
  const debouncedSearch = useDebouncedValue(search, 300);
  // Reset page to 0 whenever filters change (debouncedSearch handles its own delay).
  useEffect(() => { setPage(0); }, [debouncedSearch, categoryFilter, includeInactive]);

  const urlParams = new URLSearchParams();
  if (debouncedSearch.trim()) urlParams.set('q', debouncedSearch.trim());
  if (categoryFilter) urlParams.set('categoryId', String(categoryFilter));
  if (includeInactive) urlParams.set('includeInactive', 'true');
  const limit = pageSizeToLimit(pageSize, SERVICE_TYPES_LIMIT_CAP);
  const offset = page * (pageSize === 'all' ? limit : Number(pageSize));
  urlParams.set('limit', String(limit));
  urlParams.set('offset', String(offset));
  urlParams.set('sortBy', sortBy);
  urlParams.set('sortDir', sortDir);
  const listUrl = `/admin/service-types?${urlParams.toString()}`;
  const { data: listData, loading, error: fetchError, refetch } = useFetch<ListResponse>(listUrl);
  const items: ServiceType[] = listData?.items ?? [];
  const total = listData?.total ?? 0;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(fetchError); }, [fetchError]);

  // Deactivate an active row → status 0 (Inactive, still listable under
  // "include inactive"). Distinct from Delete (status 3, removed from all lists).
  async function handleDeactivate(t: ServiceType) {
    const ok = await confirm({
      title: 'Deactivate service type?',
      description: `"${t.service_type_name}" will be marked Inactive and hidden from default lists. You can reactivate it anytime.`,
      confirmLabel: 'Deactivate', variant: 'destructive',
    });
    if (!ok) return;
    try { await api.patch(`/admin/service-types/${t.service_type_id}`, { is_active: false }); refetch(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Deactivate failed'); }
  }
  // One-click reactivate for inactive (status 0) rows — flips back to Active.
  async function handleReactivate(t: ServiceType) {
    try { await api.patch(`/admin/service-types/${t.service_type_id}`, { is_active: true }); refetch(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Reactivate failed'); }
  }
  // Alias so the existing TypeFormModal `onSaved` prop continues to work.
  const fetchList = refetch;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Hash className="size-6" /> Manage Service Type
          </h1>
          <p className="text-sm text-muted-foreground">
            Specific services inside each category (AC repair, Geyser install, …). Each Service Type belongs to one Service Category.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isServiceTypeAddNew && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add Service Type
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search by name or description…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value ? Number(e.target.value) : '')}
            className="border rounded h-9 px-2 text-sm bg-background"
          >
            <option value="">All categories</option>
            {lookup.serviceCategories.map((c) => (
              <option key={c.service_catg_id} value={c.service_catg_id}>{c.service_catg_name}</option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            Include inactive
          </label>
        </CardContent>
      </Card>

      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '6%'  }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '28%' }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '8%'  }} />
              <col style={{ width: '10%' }} />
            </colgroup>
            <thead>
              <tr>
                <SortHeader col="service_type_id"     align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>ID</SortHeader>
                <SortHeader col="service_type_name"   align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Service Type Name</SortHeader>
                <th className="!text-left whitespace-nowrap">Service Description</th>
                <SortHeader col="service_catg_name"   align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Service Category</SortHeader>
                <SortHeader col="display"             align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Display</SortHeader>
                <SortHeader col="service_type_status" align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={7} className="!text-center text-muted-foreground py-6">No service types match the current filters.</td></tr>}
              {!loading && items.map((t) => (
                <tr key={t.service_type_id}>
                  <td className="!text-center font-mono text-xs truncate">{t.service_type_id}</td>
                  <td className="!text-left font-medium truncate" title={t.service_type_name}>
                    <span className="inline-flex items-center gap-1.5">
                      {t.service_type_image && <ImageIcon className="size-3.5 text-muted-foreground shrink-0" />}
                      <span className="truncate">{t.service_type_name}</span>
                    </span>
                  </td>
                  <td className="!text-left truncate text-muted-foreground" title={t.service_type_desc ?? ''}>
                    {t.service_type_desc ?? <span>—</span>}
                  </td>
                  <td className="!text-left truncate" title={t.service_catg_name ?? ''}>
                    {t.service_catg_name ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-center text-xs">
                    {t.display === 1
                      ? 'All'
                      : t.display === 2
                        ? 'Tx App'
                        : <span className="text-muted-foreground">CRM</span>}
                  </td>
                  <td className="!text-center whitespace-nowrap">
                    {t.service_type_status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-0.5">
                      {can.isServiceTypeEdit && (
                        <IconButton icon={Pencil} label="Edit Service Type" intent="primary"
                          onClick={() => { setEditing(t); setModalOpen(true); }} />
                      )}
                      {can.isServiceTypeEdit && t.service_type_status === 1 && (
                        <IconButton icon={XCircle} label="Deactivate Service Type" intent="danger"
                          onClick={() => handleDeactivate(t)} />
                      )}
                      {can.isServiceTypeEdit && t.service_type_status !== 1 && (
                        <IconButton icon={CheckCircle2} label="Reactivate Service Type" intent="success"
                          onClick={() => handleReactivate(t)} />
                      )}
                      {!can.isServiceTypeEdit && <span className="text-[10px] text-muted-foreground">view-only</span>}
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

      <TypeFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        categories={lookup.serviceCategories}
        onSaved={() => { setModalOpen(false); void fetchList(); }}
      />
    </div>
  );
}

function SortHeader({ col, align, sortBy, sortDir, onSort, children }: {
  col: SortKey; align: 'left' | 'center' | 'right'; sortBy: SortKey; sortDir: SortDir;
  onSort: (col: SortKey) => void; children: React.ReactNode;
}) {
  const isActive = sortBy === col;
  const alignCls = align === 'left' ? '!text-left' : align === 'right' ? '!text-right' : '!text-center';
  const justify = align === 'left' ? 'justify-start' : align === 'right' ? 'justify-end' : 'justify-center';
  const Icon = !isActive ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={`${alignCls} cursor-pointer select-none hover:bg-muted/40 transition-colors whitespace-nowrap overflow-hidden`}
      onClick={() => onSort(col)} role="button"
      aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span className={`inline-flex items-center gap-1 whitespace-nowrap ${justify}`}>
        {children}
        <Icon className={`size-3 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground/40'}`} />
      </span>
    </th>
  );
}

function TypeFormModal({ open, onClose, editing, categories, onSaved }: {
  open: boolean; onClose: () => void; editing: ServiceType | null;
  categories: Array<{ service_catg_id: number; service_catg_name: string }>;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [catgId, setCatgId] = useState<number | ''>('');
  const [display, setDisplay] = useState<number>(1);
  const [active, setActive] = useState(true);
  const [img, setImg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });
  /* Tools multi-select (2026-05-26) — closes the deferred field. The
     selection is stored as a CSV of tool_ids; on save we also build
     `service_type_tool_names` (CSV of tool names) so the legacy
     display column stays in sync. */
  type Tool = { tool_id: number; tool_name: string };
  const [tools, setTools] = useState<Tool[]>([]);
  const [selectedToolIds, setSelectedToolIds] = useState<number[]>([]);

  // Tools list — migrated to the mandatory shared `useFetch` (per memory
  // `feedback_crm_ui_fetch_hooks`). `enabled` ties the request to modal
  // visibility so it only fires when the operator actually opens the
  // editor. Defensively tolerates either an array or `{ items, total }`
  // envelope shape (the BE returns the envelope but old deployments
  // returned raw arrays).
  const { data: toolsData } = useFetch<Tool[] | { items?: Tool[] }>(
    '/admin/tools?limit=500',
    { enabled: open },
  );
  useEffect(() => {
    if (!toolsData) return;
    const arr: Tool[] = Array.isArray(toolsData) ? toolsData : (toolsData.items ?? []);
    setTools(arr.map((t) => ({ tool_id: Number(t.tool_id), tool_name: String(t.tool_name) })));
  }, [toolsData]);

  useEffect(() => {
    if (open) {
      setName(editing?.service_type_name ?? '');
      setDesc(editing?.service_type_desc ?? '');
      setCatgId(editing?.service_catg_id ?? '');
      setDisplay(editing?.display ?? 1);
      setActive(editing ? editing.service_type_status === 1 : true);
      setImg(editing?.service_type_image ?? null);
      const csv = (editing?.service_type_tools ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
      setSelectedToolIds(csv);
      setError(null);
    }
  }, [open, editing]);

  async function handleImage(file: File | null) {
    if (!file) return;
    setUploading(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('category', 'easyfixer_documents');
      const res = await api.post<{ filename: string }>('/shared/upload', fd);
      setImg(res.filename);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload failed');
    } finally { setUploading(false); }
  }

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('Name is required'); return; }
    if (!desc.trim()) { setError('Description is required'); return; }
    if (!catgId)      { setError('Service Category is required'); return; }
    setSubmitting(true);
    try {
      // Build the tools CSV pair: ids + display names. Empty selection
      // sends explicit empty strings so the BE clears any prior CSV
      // rather than silently keeping it (the Joi schema accepts both).
      const toolIdsCsv = selectedToolIds.join(',');
      const toolNamesCsv = selectedToolIds
        .map((id) => tools.find((t) => t.tool_id === id)?.tool_name)
        .filter(Boolean)
        .join(',');
      const body = {
        service_type_name: name.trim(),
        service_type_desc: desc.trim() || null,
        service_catg_id:   Number(catgId),
        display,
        service_type_tools: toolIdsCsv,
        service_type_tool_names: toolNamesCsv,
        service_type_image: img || null,
        ...(isEdit ? { is_active: active } : {}),
      };
      if (isEdit) await api.patch(`/admin/service-types/${editing!.service_type_id}`, body);
      else        await api.post('/admin/service-types', body);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.service_type_name}"` : 'Add Service Type'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          {/* Row 1 — Service Category | Service Type Name */}
          <div>
            <label className="text-sm font-medium block mb-1">Service Category *</label>
            <select
              value={catgId}
              onChange={(e) => setCatgId(e.target.value ? Number(e.target.value) : '')}
              className="border rounded h-9 px-2 text-sm bg-background w-full"
            >
              <option value="">Select a category…</option>
              {categories.map((c) => (
                <option key={c.service_catg_id} value={c.service_catg_id}>{c.service_catg_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Service Type Name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Split AC Installation"' />
          </div>

          {/* Row 2 — Description (full width) */}
          <div className="sm:col-span-2">
            <label className="text-sm font-medium block mb-1">Description *</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="What this service type covers"
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
              maxLength={500} />
          </div>

          {/* Row 3 — Display | Tools */}
          <div>
            <label className="text-sm font-medium block mb-1">Display</label>
            <select
              value={display}
              onChange={(e) => setDisplay(Number(e.target.value))}
              className="border rounded h-9 px-2 text-sm bg-background w-full"
            >
              <option value={1}>Display to All</option>
              <option value={0}>Display on CRM - Rate Card Level</option>
              <option value={2}>Display to Tx App - Deep Skill</option>
            </select>
          </div>
          {/* Tools — multi-select sourced from /admin/tools. Stored as CSV
              of tool_ids in `service_type_tools`; the legacy display column
              `service_type_tool_names` is rebuilt at save time. */}
          <div>
            <label className="text-sm font-medium block mb-1">Tools</label>
            <SearchMultiSelect
              value={selectedToolIds.map(String)}
              onChange={(next) => setSelectedToolIds((next as Array<string | number>).map(Number).filter((n) => Number.isFinite(n) && n > 0))}
              placeholder="— Select tools —"
              selectedLabel="tools"
              options={tools.map((t) => ({ value: String(t.tool_id), label: t.tool_name }))}
            />
          </div>

          {/* Row 4 left — Service Type Image (upload trigger, preview stacked
              beneath it within this half). Uploaded via /shared/upload, stored
              as a filename in the legacy service_type_image column. */}
          <div>
            <label className="text-sm font-medium block mb-1">Service Type Image</label>
            <label className="flex items-center justify-center gap-2 h-9 rounded-md border border-dashed border-input bg-background px-3 text-sm cursor-pointer hover:bg-muted/40 transition-colors">
              <UploadCloud className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground truncate">
                {uploading ? 'Uploading…' : (img || 'Upload Image')}
              </span>
              <input type="file" accept="image/*" className="hidden"
                onChange={(e) => handleImage(e.target.files?.[0] ?? null)} />
            </label>
            {img && (
              <div className="mt-2 flex items-center gap-3">
                <img
                  src={`/easydoc/easyfixer_documents/${img}`}
                  alt={img}
                  className="size-16 object-cover rounded border bg-muted"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                />
                <Button type="button" size="sm" variant="ghost"
                  onClick={() => setImg(null)} disabled={uploading || submitting}>
                  Clear
                </Button>
              </div>
            )}
          </div>

          {/* Row 4 right — Status toggle, right-aligned. Edit-only; a new
              Service Type is always created Active. */}
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

        {error && <div className="text-sm text-red-600 flex items-center gap-1 mt-3"><AlertTriangle className="size-4" /> {error}</div>}
        <div className="flex justify-end gap-2 pt-3">
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button onClick={handleSubmit} disabled={submitting || uploading}>
            {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Service Type'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
