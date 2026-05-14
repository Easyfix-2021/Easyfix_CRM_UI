'use client';

/*
 * Manage Service Type — Settings page.
 *
 * Operates on tbl_service_type via /api/admin/service-types. Mirrors the
 * legacy /pages/settings/manageServiceType.vm + addEditServicesType.vm.
 *
 * Legacy fields supported: name, description, parent service category
 * (required FK), display flag (1=show to all, 0=CRM only), status.
 *
 * Tools multi-select (service_type_tools CSV) is deferred — production
 * data still flows through if you set it via API directly. Will surface
 * a UI picker once the tools lookup endpoint exists.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Hash, Search, Plus, Pencil, Trash2,
  AlertTriangle, ChevronDown, ChevronRight, Info,
  ArrowUp, ArrowDown, ArrowUpDown,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useLookup } from '@/lib/use-lookup';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

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
};
type ListResponse = { items: ServiceType[]; total: number };
type SortKey = 'service_type_id' | 'service_type_name' | 'service_catg_name' | 'service_type_status' | 'display';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 100;

export default function ManageServiceTypePage() {
  const confirm = useConfirm();
  const lookup = useLookup();
  const { me } = useMe();
  const can = actionFlags(me, ['isServiceTypeAddNew', 'isServiceTypeEdit', 'isServiceTypeDelete']);

  const [items, setItems] = useState<ServiceType[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<number | ''>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ServiceType | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('service_type_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function onSort(col: SortKey) {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('asc'); }
    setPage(0);
  }

  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => { setPage(0); void fetchList(); }, 300);
    return () => { if (tRef.current) clearTimeout(tRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, categoryFilter, includeInactive]);
  useEffect(() => { void fetchList(); /* eslint-disable-next-line */ }, [page, sortBy, sortDir]);

  async function fetchList() {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (search.trim()) p.set('q', search.trim());
      if (categoryFilter) p.set('categoryId', String(categoryFilter));
      if (includeInactive) p.set('includeInactive', 'true');
      p.set('limit', String(PAGE_SIZE)); p.set('offset', String(page * PAGE_SIZE));
      p.set('sortBy', sortBy); p.set('sortDir', sortDir);
      const data = await api.get<ListResponse>(`/admin/service-types?${p}`);
      setItems(data.items); setTotal(data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load service types');
    } finally { setLoading(false); }
  }

  async function handleDeactivate(t: ServiceType) {
    const ok = await confirm({
      title: 'Deactivate service type?',
      description: `${t.service_type_name} will be hidden from default lists. Existing references stay intact. Reactivate by editing.`,
      confirmLabel: 'Deactivate', variant: 'destructive',
    });
    if (!ok) return;
    try { await api.delete(`/admin/service-types/${t.service_type_id}`); void fetchList(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Deactivate failed'); }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
                  <td className="!text-left font-medium truncate" title={t.service_type_name}>{t.service_type_name}</td>
                  <td className="!text-left truncate text-muted-foreground" title={t.service_type_desc ?? ''}>
                    {t.service_type_desc ?? <span>—</span>}
                  </td>
                  <td className="!text-left truncate" title={t.service_catg_name ?? ''}>
                    {t.service_catg_name ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-center text-xs">
                    {t.display === 1 ? 'All' : <span className="text-muted-foreground">CRM only</span>}
                  </td>
                  <td className="!text-center whitespace-nowrap">
                    {t.service_type_status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-1">
                      {can.isServiceTypeEdit && (
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(t); setModalOpen(true); }}>
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                      {can.isServiceTypeEdit && t.service_type_status === 1 && (
                        <Button size="sm" variant="ghost" onClick={() => handleDeactivate(t)}>
                          <Trash2 className="size-3.5 text-red-600" />
                        </Button>
                      )}
                      {!can.isServiceTypeEdit && <span className="text-[10px] text-muted-foreground">view-only</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.service_type_name ?? '');
      setDesc(editing?.service_type_desc ?? '');
      setCatgId(editing?.service_catg_id ?? '');
      setDisplay(editing?.display ?? 1);
      setActive(editing ? editing.service_type_status === 1 : true);
      setError(null);
    }
  }, [open, editing]);

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('Name is required'); return; }
    if (!desc.trim()) { setError('Description is required'); return; }
    if (!catgId)      { setError('Service Category is required'); return; }
    setSubmitting(true);
    try {
      const body = {
        service_type_name: name.trim(),
        service_type_desc: desc.trim() || null,
        service_catg_id:   Number(catgId),
        display:           display === 1 ? 1 : 0,
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
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.service_type_name}"` : 'Add Service Type'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
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
          <div>
            <label className="text-sm font-medium block mb-1">Description *</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="What this service type covers"
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
              maxLength={500} />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Display</label>
            <select
              value={display}
              onChange={(e) => setDisplay(Number(e.target.value))}
              className="border rounded h-9 px-2 text-sm bg-background w-full"
            >
              <option value={1}>Display To All</option>
              <option value={0}>Display Only To CRM</option>
            </select>
          </div>
          {isEdit && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              <span>Active</span>
            </label>
          )}
          {error && <div className="text-sm text-red-600 flex items-center gap-1"><AlertTriangle className="size-4" /> {error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Service Type'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
