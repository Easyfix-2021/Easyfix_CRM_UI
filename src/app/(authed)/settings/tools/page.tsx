'use client';

/*
 * Manage Tools — Settings page. Operates on tbl_tool via /api/admin/tools.
 * Mirrors /pages/settings/manageTool.vm + addEditTool.vm.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Wrench, Search, Plus, Pencil, Trash2,
  AlertTriangle, ArrowUp, ArrowDown, ArrowUpDown,
  Image as ImageIcon, UploadCloud,
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

type Tool = {
  tool_id: number;
  tool_name: string;
  tool_desc: string | null;
  tool_status: string | number;
  tool_img: string | null;
};
type ListResponse = { items: Tool[]; total: number };
type SortKey = 'tool_id' | 'tool_name' | 'tool_status';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 100;
const isActive = (s: string | number) => s === 1 || s === '1';

export default function ManageToolsPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isToolAddNew', 'isToolEdit', 'isToolDelete']);

  const [items, setItems] = useState<Tool[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Tool | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('tool_name');
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
      const data = await api.get<ListResponse>(`/admin/tools?${p}`);
      setItems(data.items); setTotal(data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load tools');
    } finally { setLoading(false); }
  }

  async function handleDeactivate(t: Tool) {
    const ok = await confirm({
      title: 'Deactivate tool?',
      description: `${t.tool_name} will be hidden from default lists. Reactivate by editing.`,
      confirmLabel: 'Deactivate', variant: 'destructive',
    });
    if (!ok) return;
    try { await api.delete(`/admin/tools/${t.tool_id}`); void fetchList(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Deactivate failed'); }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wrench className="size-6" /> Manage Tools
          </h1>
          <p className="text-sm text-muted-foreground">
            Tools required by deep skills (multimeter, welding kit, …). Add an optional image to each tool.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isToolAddNew && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add Tool
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
              <col style={{ width: '42%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '15%' }} />
            </colgroup>
            <thead>
              <tr>
                <SortHeader col="tool_id"     align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>ID</SortHeader>
                <SortHeader col="tool_name"   align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Tool Name</SortHeader>
                <th className="!text-left whitespace-nowrap">Tool Description</th>
                <SortHeader col="tool_status" align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={5} className="!text-center text-muted-foreground py-6">No tools match the current filters.</td></tr>}
              {!loading && items.map((t) => (
                <tr key={t.tool_id}>
                  <td className="!text-center font-mono text-xs truncate">{t.tool_id}</td>
                  <td className="!text-left font-medium truncate" title={t.tool_name}>
                    <span className="inline-flex items-center gap-1.5">
                      {t.tool_img && <ImageIcon className="size-3.5 text-muted-foreground shrink-0" />}
                      <span className="truncate">{t.tool_name}</span>
                    </span>
                  </td>
                  <td className="!text-left truncate text-muted-foreground" title={t.tool_desc ?? ''}>
                    {t.tool_desc ?? <span>—</span>}
                  </td>
                  <td className="!text-center whitespace-nowrap">
                    {isActive(t.tool_status)
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-1">
                      {can.isToolEdit && (
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(t); setModalOpen(true); }}>
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                      {can.isToolEdit && isActive(t.tool_status) && (
                        <Button size="sm" variant="ghost" onClick={() => handleDeactivate(t)}>
                          <Trash2 className="size-3.5 text-red-600" />
                        </Button>
                      )}
                      {!can.isToolEdit && <span className="text-[10px] text-muted-foreground">view-only</span>}
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

      <ToolFormModal
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
  const isAct = sortBy === col;
  const alignCls = align === 'left' ? '!text-left' : align === 'right' ? '!text-right' : '!text-center';
  const justify = align === 'left' ? 'justify-start' : align === 'right' ? 'justify-end' : 'justify-center';
  const Icon = !isAct ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={`${alignCls} cursor-pointer select-none hover:bg-muted/40 transition-colors whitespace-nowrap overflow-hidden`}
      onClick={() => onSort(col)} role="button"
      aria-sort={isAct ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span className={`inline-flex items-center gap-1 whitespace-nowrap ${justify}`}>
        {children}
        <Icon className={`size-3 shrink-0 ${isAct ? 'text-foreground' : 'text-muted-foreground/40'}`} />
      </span>
    </th>
  );
}

function ToolFormModal({ open, onClose, editing, onSaved }: {
  open: boolean; onClose: () => void; editing: Tool | null; onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [img, setImg] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.tool_name ?? '');
      setDesc(editing?.tool_desc ?? '');
      setImg(editing?.tool_img ?? null);
      setActive(editing ? isActive(editing.tool_status) : true);
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
    if (!name.trim()) { setError('Tool name is required'); return; }
    if (!desc.trim()) { setError('Tool description is required'); return; }
    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/tools/${editing!.tool_id}`, {
          tool_name: name.trim(), tool_desc: desc.trim() || null,
          tool_img: img || null, is_active: active,
        });
      } else {
        await api.post('/admin/tools', {
          tool_name: name.trim(), tool_desc: desc.trim() || null,
          tool_img: img || null,
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
          <DialogTitle>{isEdit ? `Edit "${editing!.tool_name}"` : 'Add Tool'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium block mb-1">Tool Name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Multimeter"' />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Tool Description *</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="What this tool is used for"
              className="w-full border rounded px-2 py-1 text-sm bg-background min-h-[80px]"
              maxLength={500} />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Image</label>
            <div className="flex items-center gap-3">
              {img && (
                <img
                  src={`/easydoc/easyfixer_documents/${img}`}
                  alt={img}
                  className="size-14 object-cover rounded border bg-muted"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                />
              )}
              <label className="flex-1 flex items-center justify-center gap-2 h-9 rounded-md border border-dashed border-input bg-background px-3 text-sm cursor-pointer hover:bg-muted/40 transition-colors">
                <UploadCloud className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground truncate">
                  {uploading ? 'Uploading…' : (img || 'Select file')}
                </span>
                <input type="file" accept="image/*" className="hidden"
                  onChange={(e) => handleImage(e.target.files?.[0] ?? null)} />
              </label>
              {img && (
                <Button type="button" size="sm" variant="ghost"
                  onClick={() => setImg(null)} disabled={uploading || submitting}>
                  Clear
                </Button>
              )}
            </div>
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
            <Button onClick={handleSubmit} disabled={submitting || uploading}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Tool'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
