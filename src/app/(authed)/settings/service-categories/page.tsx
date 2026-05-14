'use client';

/*
 * Manage Service Category — Settings page.
 *
 * Operates on tbl_service_catg via /api/admin/service-categories.
 * Legacy parity: list shows ID/Name/Description/Status; form has
 * Name + Description (required) + Status (edit only). Mirrors
 * /pages/settings/manageServiceCategory.vm + addEditServicesCategory.vm.
 *
 * Soft-delete: status flips to 0. Backend hides status=3 (legacy "removed")
 * from every read so legacy data stays out of the active master list.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Package, Search, Plus, Pencil, Trash2,
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
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

type Category = {
  service_catg_id: number;
  service_catg_name: string;
  service_catg_desc: string | null;
  service_catg_status: number;
  service_type_count: number;
};
type ListResponse = { items: Category[]; total: number };
type SortKey = 'service_catg_id' | 'service_catg_name' | 'service_catg_status' | 'service_type_count';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 100;

export default function ManageServiceCategoryPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isServiceCategoryAddNew', 'isServiceCategoryEdit', 'isServiceCategoryDelete']);

  const [items, setItems] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('service_catg_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function onSort(col: SortKey) {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('asc'); }
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

  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => { setPage(0); void fetchList(); }, 300);
    return () => { if (tRef.current) clearTimeout(tRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, includeInactive]);
  useEffect(() => { void fetchList(); /* eslint-disable-next-line */ }, [page, sortBy, sortDir]);

  async function fetchList() {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (search.trim()) p.set('q', search.trim());
      if (includeInactive) p.set('includeInactive', 'true');
      p.set('limit', String(PAGE_SIZE)); p.set('offset', String(page * PAGE_SIZE));
      p.set('sortBy', sortBy); p.set('sortDir', sortDir);
      const data = await api.get<ListResponse>(`/admin/service-categories?${p}`);
      setItems(data.items); setTotal(data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load service categories');
    } finally { setLoading(false); }
  }

  async function handleDeactivate(c: Category) {
    if (c.service_type_count > 0) {
      await confirm({
        title: 'Cannot deactivate this category',
        description: `${c.service_type_count} active service type${c.service_type_count === 1 ? '' : 's'} still reference "${c.service_catg_name}". Deactivate or reassign them first.`,
        confirmLabel: 'OK',
      });
      return;
    }
    const ok = await confirm({
      title: 'Deactivate service category?',
      description: `${c.service_catg_name} will be hidden from default lists. Reactivate by editing.`,
      confirmLabel: 'Deactivate', variant: 'destructive',
    });
    if (!ok) return;
    try { await api.delete(`/admin/service-categories/${c.service_catg_id}`); void fetchList(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Deactivate failed'); }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
            <span className="font-medium">How Service Category management works</span>
            <span className="ml-auto text-xs text-muted-foreground">{howOpen ? 'Hide' : 'Show'}</span>
          </button>
          {howOpen && (
            <div className="px-4 pb-4 pt-1 text-sm text-muted-foreground space-y-2 border-t">
              <p>Each Service Category groups one or more Service Types. A category cannot be deactivated while any of its service types are still active — deactivate or reassign those first.</p>
              <p>Soft-delete only: deactivation hides the row from default lists. Toggle &ldquo;Include inactive&rdquo; to bring it back and reactivate.</p>
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

      {error && (
        <Card><CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="size-4" /> {error}
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
                <SortHeader col="service_catg_id"     align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>ID</SortHeader>
                <SortHeader col="service_catg_name"   align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Service Category Name</SortHeader>
                <th className="!text-left whitespace-nowrap">Service Description</th>
                <SortHeader col="service_type_count"  align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Service Types</SortHeader>
                <SortHeader col="service_catg_status" align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
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
                    <div className="inline-flex items-center justify-end gap-1">
                      {can.isServiceCategoryEdit && (
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(c); setModalOpen(true); }}>
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                      {can.isServiceCategoryEdit && c.service_catg_status === 1 && (
                        <Button size="sm" variant="ghost" onClick={() => handleDeactivate(c)}>
                          <Trash2 className="size-3.5 text-red-600" />
                        </Button>
                      )}
                      {!can.isServiceCategoryEdit && <span className="text-[10px] text-muted-foreground">view-only</span>}
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

      <CategoryFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
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

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('Name is required'); return; }
    if (!desc.trim()) { setError('Description is required'); return; }
    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/service-categories/${editing!.service_catg_id}`, {
          service_catg_name: name.trim(), service_catg_desc: desc.trim() || null, is_active: active,
        });
      } else {
        await api.post('/admin/service-categories', {
          service_catg_name: name.trim(), service_catg_desc: desc.trim() || null,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.service_catg_name}"` : 'Add Service Category'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium block mb-1">Service Category Name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Electrician"' />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Description *</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="What this category covers"
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
              maxLength={500} />
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
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Service Category'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
