'use client';

/*
 * Manage Vertical — Settings page.
 * Operates on tbl_vertical via /api/admin/verticals.
 *
 * Schema: vertical_id, vertical_name, vertical_desc, status (1=active/0=inactive),
 * plus inserted_on/by + updated_on/by audit columns (stamped server-side).
 */

import { useEffect, useRef, useState } from 'react';
import {
  Layers, Search, Plus, Pencil, Trash2,
  AlertTriangle, ArrowUp, ArrowDown, ArrowUpDown,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

type Vertical = {
  vertical_id: number;
  vertical_name: string;
  vertical_desc: string | null;
  inserted_on: string | null;
  inserted_by: number | null;
  updated_on: string | null;
  updated_by: number | null;
  status: number;
};
type ListResponse = { items: Vertical[]; total: number };
type SortKey = 'vertical_id' | 'vertical_name' | 'status' | 'updated_on';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 100;

export default function ManageVerticalsPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isVerticalAddNew', 'isVerticalEdit']);

  const [items, setItems] = useState<Vertical[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Vertical | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('vertical_name');
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
      const data = await api.get<ListResponse>(`/admin/verticals?${p}`);
      setItems(data.items); setTotal(data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load verticals');
    } finally { setLoading(false); }
  }

  async function handleDeactivate(v: Vertical) {
    const ok = await confirm({
      title: 'Deactivate vertical?',
      description: `${v.vertical_name} will be hidden from default lists. Reactivate by editing.`,
      confirmLabel: 'Deactivate', variant: 'destructive',
    });
    if (!ok) return;
    try { await api.delete(`/admin/verticals/${v.vertical_id}`); void fetchList(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Deactivate failed'); }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Layers className="size-6" /> Manage Vertical
          </h1>
          <p className="text-sm text-muted-foreground">
            Business verticals stored in <code>tbl_vertical</code>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isVerticalAddNew && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add Vertical
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
              <col style={{ width: '8%'  }} />
              <col style={{ width: '25%' }} />
              <col style={{ width: '40%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '15%' }} />
            </colgroup>
            <thead>
              <tr>
                <SortHeader col="vertical_id"   align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>ID</SortHeader>
                <SortHeader col="vertical_name" align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Vertical Name</SortHeader>
                <th className="!text-left whitespace-nowrap">Description</th>
                <SortHeader col="status"        align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={5} className="!text-center text-muted-foreground py-6">No verticals match the current filters.</td></tr>}
              {!loading && items.map((v) => (
                <tr key={v.vertical_id}>
                  <td className="!text-center font-mono text-xs truncate">{v.vertical_id}</td>
                  <td className="!text-left font-medium truncate" title={v.vertical_name}>{v.vertical_name}</td>
                  <td className="!text-left truncate text-muted-foreground" title={v.vertical_desc ?? ''}>
                    {v.vertical_desc ?? <span>—</span>}
                  </td>
                  <td className="!text-center whitespace-nowrap">
                    {v.status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-1">
                      {can.isVerticalEdit && (
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(v); setModalOpen(true); }}>
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                      {can.isVerticalEdit && v.status === 1 && (
                        <Button size="sm" variant="ghost" onClick={() => handleDeactivate(v)}>
                          <Trash2 className="size-3.5 text-red-600" />
                        </Button>
                      )}
                      {!can.isVerticalEdit && <span className="text-[10px] text-muted-foreground">view-only</span>}
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

      <VerticalFormModal
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

function VerticalFormModal({ open, onClose, editing, onSaved }: {
  open: boolean; onClose: () => void; editing: Vertical | null; onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.vertical_name ?? '');
      setDesc(editing?.vertical_desc ?? '');
      setActive(editing ? editing.status === 1 : true);
      setError(null);
    }
  }, [open, editing]);

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('Vertical name is required'); return; }
    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/verticals/${editing!.vertical_id}`, {
          vertical_name: name.trim(),
          vertical_desc: desc.trim() || null,
          status: active ? 1 : 0,
        });
      } else {
        await api.post('/admin/verticals', {
          vertical_name: name.trim(),
          vertical_desc: desc.trim() || null,
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
          <DialogTitle>{isEdit ? `Edit "${editing!.vertical_name}"` : 'Add Vertical'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium block mb-1">Vertical Name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Retail"' />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Description</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="What this vertical covers"
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
            <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Vertical'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
