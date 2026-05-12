'use client';

/*
 * Manage B2B Rate Cards — Settings page.
 *
 * Operates on tbl_client_rate_card via /api/admin/rate-cards-b2b.
 * Mirrors legacy /pages/settings/manageB2BRatecard.vm + addEditB2BRatecard.vm.
 *
 * Columns: ID | Service Category | Service Type | B2B Service Name | Status | Actions.
 * Form: Service Category → Service Type (dependent) → Name + Status.
 *
 * B2B has NO price field — per-client pricing lives in tbl_client_service
 * (junction). That's a separate "Client Services" screen, not this CRUD.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollText, Search, Plus, Pencil, Trash2,
  AlertTriangle, ArrowUp, ArrowDown, ArrowUpDown,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useLookup } from '@/lib/use-lookup';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

type RateCard = {
  crc_id: number;
  crc_ratecard_name: string;
  crc_servicetype_id: number | null;
  service_type_name: string | null;
  service_catg_id: number | null;
  service_catg_name: string | null;
  status: number;
};
type ListResponse = { items: RateCard[]; total: number };
type SortKey = 'crc_id' | 'crc_ratecard_name' | 'service_type_name' | 'service_catg_name' | 'status';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 100;

export default function ManageRateCardsB2BPage() {
  const confirm = useConfirm();
  const lookup = useLookup();
  const { me } = useMe();
  // Legacy keys: isServiceAddNew / isServiceEdit / isServiceDelete were used
  // for "Manage Services" — the B2B rate card screen. Reusing them here.
  const can = actionFlags(me, ['isServiceAddNew', 'isServiceEdit', 'isServiceDelete']);

  const [items, setItems] = useState<RateCard[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<number | ''>('');
  const [typeFilter, setTypeFilter] = useState<number | ''>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RateCard | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('crc_ratecard_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function onSort(col: SortKey) {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('asc'); }
    setPage(0);
  }

  // When the category filter changes, clear the type filter if its parent
  // category no longer matches — keeps the dependent filter coherent.
  const filteredServiceTypes = useMemo(() => {
    if (!categoryFilter) return lookup.serviceTypes;
    return lookup.serviceTypes.filter((t) => t.service_catg_id === categoryFilter);
  }, [lookup.serviceTypes, categoryFilter]);

  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => { setPage(0); void fetchList(); }, 300);
    return () => { if (tRef.current) clearTimeout(tRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, categoryFilter, typeFilter, includeInactive]);
  useEffect(() => { void fetchList(); /* eslint-disable-next-line */ }, [page, sortBy, sortDir]);

  async function fetchList() {
    setLoading(true); setError(null);
    try {
      const p = new URLSearchParams();
      if (search.trim()) p.set('q', search.trim());
      if (categoryFilter) p.set('serviceCatgId', String(categoryFilter));
      if (typeFilter)     p.set('serviceTypeId', String(typeFilter));
      if (includeInactive) p.set('includeInactive', 'true');
      p.set('limit', String(PAGE_SIZE)); p.set('offset', String(page * PAGE_SIZE));
      p.set('sortBy', sortBy); p.set('sortDir', sortDir);
      const data = await api.get<ListResponse>(`/admin/rate-cards-b2b?${p}`);
      setItems(data.items); setTotal(data.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load B2B rate cards');
    } finally { setLoading(false); }
  }

  async function handleDeactivate(r: RateCard) {
    const ok = await confirm({
      title: 'Remove B2B rate card?',
      description: `${r.crc_ratecard_name} will be soft-deleted (status=3). Existing client_service rows that reference it stay intact but won't be picked up by new bindings. This cannot be undone via this UI — restore requires direct DB intervention.`,
      confirmLabel: 'Remove', variant: 'destructive',
    });
    if (!ok) return;
    try { await api.delete(`/admin/rate-cards-b2b/${r.crc_id}`); void fetchList(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Remove failed'); }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ScrollText className="size-6" /> Manage B2B Rate Cards
          </h1>
          <p className="text-sm text-muted-foreground">
            Service definitions billed to clients. Per-client pricing lives in
            Client Services (separate screen).
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isServiceAddNew && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add B2B Rate Card
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search by name or service type…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => { setCategoryFilter(e.target.value ? Number(e.target.value) : ''); setTypeFilter(''); }}
            className="border rounded h-9 px-2 text-sm bg-background"
          >
            <option value="">All categories</option>
            {lookup.serviceCategories.map((c) => (
              <option key={c.service_catg_id} value={c.service_catg_id}>{c.service_catg_name}</option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value ? Number(e.target.value) : '')}
            className="border rounded h-9 px-2 text-sm bg-background"
          >
            <option value="">All service types</option>
            {filteredServiceTypes.map((t) => (
              <option key={t.service_type_id} value={t.service_type_id}>{t.service_type_name}</option>
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
              <col style={{ width: '7%'  }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '30%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '13%' }} />
            </colgroup>
            <thead>
              <tr>
                <SortHeader col="crc_id"            align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>ID</SortHeader>
                <SortHeader col="service_catg_name" align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Service Category</SortHeader>
                <SortHeader col="service_type_name" align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Service Type</SortHeader>
                <SortHeader col="crc_ratecard_name" align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>B2B Service Name</SortHeader>
                <SortHeader col="status"            align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Status</SortHeader>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">Loading…</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">No rate cards match the current filters.</td></tr>}
              {!loading && items.map((r) => (
                <tr key={r.crc_id}>
                  <td className="!text-center font-mono text-xs truncate">{r.crc_id}</td>
                  <td className="!text-left truncate" title={r.service_catg_name ?? ''}>
                    {r.service_catg_name ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left truncate" title={r.service_type_name ?? ''}>
                    {r.service_type_name ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left font-medium truncate" title={r.crc_ratecard_name}>{r.crc_ratecard_name}</td>
                  <td className="!text-center whitespace-nowrap">
                    {r.status === 1
                      ? <span className="text-emerald-700 text-xs">Active</span>
                      : <span className="text-muted-foreground text-xs">Inactive</span>}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-1">
                      {can.isServiceEdit && (
                        <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setModalOpen(true); }}>
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                      {can.isServiceDelete && r.status === 1 && (
                        <Button size="sm" variant="ghost" onClick={() => handleDeactivate(r)}>
                          <Trash2 className="size-3.5 text-red-600" />
                        </Button>
                      )}
                      {!can.isServiceEdit && !can.isServiceDelete && (
                        <span className="text-[10px] text-muted-foreground">view-only</span>
                      )}
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

      <RateCardFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        editing={editing}
        categories={lookup.serviceCategories}
        serviceTypes={lookup.serviceTypes}
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

function RateCardFormModal({ open, onClose, editing, categories, serviceTypes, onSaved }: {
  open: boolean; onClose: () => void; editing: RateCard | null;
  categories: Array<{ service_catg_id: number; service_catg_name: string }>;
  serviceTypes: Array<{ service_type_id: number; service_type_name: string; service_catg_id: number }>;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [name, setName] = useState('');
  const [catgId, setCatgId] = useState<number | ''>('');
  const [typeId, setTypeId] = useState<number | ''>('');
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dependent type dropdown — only show types under the selected category.
  const filteredTypes = useMemo(() => {
    if (!catgId) return [];
    return serviceTypes.filter((t) => t.service_catg_id === catgId);
  }, [serviceTypes, catgId]);

  useEffect(() => {
    if (open) {
      setName(editing?.crc_ratecard_name ?? '');
      setCatgId(editing?.service_catg_id ?? '');
      setTypeId(editing?.crc_servicetype_id ?? '');
      setActive(editing ? editing.status === 1 : true);
      setError(null);
    }
  }, [open, editing]);

  async function handleSubmit() {
    setError(null);
    if (!catgId) { setError('Service Category is required'); return; }
    if (!typeId) { setError('Service Type is required'); return; }
    if (!name.trim()) { setError('B2B Service Name is required'); return; }
    setSubmitting(true);
    try {
      const body = {
        crc_ratecard_name: name.trim(),
        crc_servicetype_id: Number(typeId),
        ...(isEdit ? { is_active: active } : {}),
      };
      if (isEdit) await api.patch(`/admin/rate-cards-b2b/${editing!.crc_id}`, body);
      else        await api.post('/admin/rate-cards-b2b', body);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.crc_ratecard_name}"` : 'Add B2B Rate Card'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium block mb-1">Service Category *</label>
            <select
              value={catgId}
              onChange={(e) => { setCatgId(e.target.value ? Number(e.target.value) : ''); setTypeId(''); }}
              className="border rounded h-9 px-2 text-sm bg-background w-full"
            >
              <option value="">Select a category…</option>
              {categories.map((c) => (
                <option key={c.service_catg_id} value={c.service_catg_id}>{c.service_catg_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Service Type *</label>
            <select
              value={typeId}
              onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : '')}
              className="border rounded h-9 px-2 text-sm bg-background w-full"
              disabled={!catgId}
            >
              <option value="">{catgId ? 'Select a service type…' : 'Pick a category first'}</option>
              {filteredTypes.map((t) => (
                <option key={t.service_type_id} value={t.service_type_id}>{t.service_type_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">B2B Service Name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "AC Installation – Single Unit"' />
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
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add B2B Rate Card'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
