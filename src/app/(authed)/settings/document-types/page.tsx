'use client';

/*
 * Manage Document Type — Settings page.
 * Operates on tbl_document_type via /api/admin/document-types.
 * Legacy parity: list shows Document Name | Mandatory | Status. Form
 * has Name (req) + Mandatory radio (req) + Status (edit only).
 * Mirrors /pages/settings/manageDocumentType.vm + addEditDocumentType.vm.
 */

import { useEffect, useRef, useState } from 'react';
import {
  FileText, Search, Plus, Pencil, Trash2,
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

type DocType = {
  document_type_id: number;
  document_name: string;
  document_mandatory: string;   // 'Yes' | 'No'
  document_type_status: number;
};
type ListResponse = { items: DocType[]; total: number };
type SortKey = 'document_type_id' | 'document_name' | 'document_mandatory' | 'document_type_status';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 100;

export default function ManageDocumentTypesPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isDocumentTypeAddNew', 'isDocumentTypeEdit']);

  const [items, setItems] = useState<DocType[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DocType | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('document_name');
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
      const data = await api.get<ListResponse>(`/admin/document-types?${p}`);
      setItems(data.items); setTotal(data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load document types');
    } finally { setLoading(false); }
  }

  async function handleDeactivate(d: DocType) {
    const ok = await confirm({
      title: 'Deactivate document type?',
      description: `${d.document_name} will be hidden from default lists. Existing references stay intact. Reactivate by editing.`,
      confirmLabel: 'Deactivate', variant: 'destructive',
    });
    if (!ok) return;
    try { await api.delete(`/admin/document-types/${d.document_type_id}`); void fetchList(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Deactivate failed'); }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="size-6" /> Manage Document Type
          </h1>
          <p className="text-sm text-muted-foreground">Document types required from technicians for verification (Aadhaar, PAN, …).</p>
        </div>
        <div className="flex items-center gap-2">
          {can.isDocumentTypeAddNew && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add Document Type
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search by document name…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
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
              <col style={{ width: '50%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '15%' }} />
            </colgroup>
            <thead>
              <tr>
                <SortHeader col="document_type_id"     align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>ID</SortHeader>
                <SortHeader col="document_name"        align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Document Name</SortHeader>
                <SortHeader col="document_mandatory"   align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Mandatory</SortHeader>
                <SortHeader col="document_type_status" align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={5} className="!text-center text-muted-foreground py-6">No document types match the current filters.</td></tr>}
              {!loading && items.map((d) => (
                <tr key={d.document_type_id}>
                  <td className="!text-center font-mono text-xs truncate">{d.document_type_id}</td>
                  <td className="!text-left font-medium truncate" title={d.document_name}>{d.document_name}</td>
                  <td className="!text-center whitespace-nowrap text-xs">
                    {d.document_mandatory === 'Yes'
                      ? <span className="text-emerald-700">Yes</span>
                      : <span className="text-muted-foreground">No</span>}
                  </td>
                  <td className="!text-center whitespace-nowrap">
                    {d.document_type_status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-1">
                      {can.isDocumentTypeEdit && (
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(d); setModalOpen(true); }}>
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                      {can.isDocumentTypeEdit && d.document_type_status === 1 && (
                        <Button size="sm" variant="ghost" onClick={() => handleDeactivate(d)}>
                          <Trash2 className="size-3.5 text-red-600" />
                        </Button>
                      )}
                      {!can.isDocumentTypeEdit && <span className="text-[10px] text-muted-foreground">view-only</span>}
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

      <DocTypeFormModal
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

function DocTypeFormModal({ open, onClose, editing, onSaved }: {
  open: boolean; onClose: () => void; editing: DocType | null; onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState('');
  const [mandatory, setMandatory] = useState<'Yes' | 'No'>('Yes');
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.document_name ?? '');
      setMandatory((editing?.document_mandatory as 'Yes' | 'No') ?? 'Yes');
      setActive(editing ? editing.document_type_status === 1 : true);
      setError(null);
    }
  }, [open, editing]);

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError('Document name is required'); return; }
    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/document-types/${editing!.document_type_id}`, {
          document_name: name.trim(), document_mandatory: mandatory, is_active: active,
        });
      } else {
        await api.post('/admin/document-types', {
          document_name: name.trim(), document_mandatory: mandatory,
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
          <DialogTitle>{isEdit ? `Edit "${editing!.document_name}"` : 'Add Document Type'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium block mb-1">Document Name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Aadhaar Card"' />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Mandatory? *</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="mandatory" checked={mandatory === 'Yes'} onChange={() => setMandatory('Yes')} />
                <span>Yes</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="mandatory" checked={mandatory === 'No'} onChange={() => setMandatory('No')} />
                <span>No</span>
              </label>
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
            <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Document Type'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
