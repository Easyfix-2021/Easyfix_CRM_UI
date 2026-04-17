'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Search, Filter, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { SearchSelect } from '@/components/ui/search-select';
import { api } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { formatDate, formatEasyfixerName } from '@/lib/utils';
import { EasyfixerModal, type EasyfixerModalMode } from '@/components/easyfixer/EasyfixerModal';
import { useSort, SortHeader } from '@/lib/use-sort';

type Ef = {
  efr_id: number; efr_name: string; efr_first_name: string | null; efr_last_name: string | null;
  efr_no: string; efr_email: string | null;
  efr_cityId: number | null; city_name: string | null;
  efr_service_category: string | null; efr_service_type: string | null;
  efr_profile_perc: number | null;
  is_technician_verified: boolean | number | null;
  efr_status: number; efr_manager_id: number | null;
  insert_date: string; update_date: string | null;
};
type Resp = { items: Ef[]; total: number };

const PAGE_SIZE = 50;

export default function EasyfixersPage() {
  const lk = useLookup();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<Resp | null>(null);
  // `q` is a UI-only filter — searching runs in memory over the currently
  // loaded page instead of firing a backend call per keystroke. Filter
  // dropdowns (city / category / verified / status) still trigger a refetch.
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ cityId: '', serviceCategory: '', isVerified: '', status: '' });
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  // Modal state — also driven by URL params so /easyfixers?new=1 and
  // /easyfixers?view=8799 still work as deep-links (legacy /easyfixers/new and
  // /easyfixers/[id] redirect into these).
  const [modal, setModal] = useState<{ open: boolean; mode: EasyfixerModalMode; id?: number }>({ open: false, mode: 'create' });

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setModal({ open: true, mode: 'create' });
    } else {
      const v = searchParams.get('view');
      if (v && /^\d+$/.test(v)) setModal({ open: true, mode: 'view', id: Number(v) });
    }
  }, [searchParams]);

  function closeModal() {
    setModal((m) => ({ ...m, open: false }));
    // Strip the query param from the URL so refresh/back-nav doesn't pop it back.
    if (searchParams.get('new') || searchParams.get('view')) router.replace('/easyfixers');
  }
  function openCreate() { setModal({ open: true, mode: 'create' }); }
  function openView(id: number) { setModal({ open: true, mode: 'view', id }); }

  async function load(reset = false) {
    setLoading(true);
    const off = reset ? 0 : offset;
    try {
      const r = await api.get<Resp>('/admin/easyfixers', {
        limit: PAGE_SIZE, offset: off,
        cityId: filters.cityId || undefined,
        serviceCategory: filters.serviceCategory || undefined,
        isVerified: filters.isVerified === '' ? undefined : filters.isVerified,
        status: filters.status === '' ? undefined : filters.status,
      });
      setData(r);
      if (reset) setOffset(0);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [offset]);
  useEffect(() => { load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  // Filter-dropdown changes refetch (backend-driven). The search box is UI-only.
  useEffect(() => { setOffset(0); load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [filters.cityId, filters.serviceCategory, filters.isVerified, filters.status]);

  // Client-side filter: match q across visible text columns.
  const filteredItems = (data?.items ?? []).filter((e) => {
    if (!q) return true;
    const needle = q.toLowerCase();
    const haystacks = [
      e.efr_id, e.efr_name, e.efr_no, e.efr_email,
      e.city_name, e.efr_service_category, e.efr_service_type,
    ];
    return haystacks.some((h) => h != null && String(h).toLowerCase().includes(needle));
  });
  const { sorted, sortKey, sortDir, toggle } = useSort<Ef>(filteredItems);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Easyfixers</h1>
          <p className="text-sm text-muted-foreground">{data?.total.toLocaleString() ?? '…'} technicians</p>
        </div>
        <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> Add New Easyfixer</Button>
      </div>

      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search name, mobile, email…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
            </div>
            <Button type="button" variant="outline" onClick={() => setShowFilters((s) => !s)}>
              <Filter className="h-4 w-4 mr-1" /> Filters
            </Button>
          </div>
          {showFilters && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 pt-2 border-t">
              <SearchSelect placeholder="Any city" value={filters.cityId} onChange={(v) => setFilters({ ...filters, cityId: v })} options={lk.toOpts.cities.map((o) => ({ value: o.value, label: String(o.label) }))} />
              <SearchSelect
                placeholder="Any service category"
                value={filters.serviceCategory}
                onChange={(v) => setFilters({ ...filters, serviceCategory: v })}
                options={lk.serviceCategories.map((c) => ({ value: c.service_catg_name, label: c.service_catg_name }))}
              />
              <Select placeholder="Any verified status" value={filters.isVerified} onChange={(e) => setFilters({ ...filters, isVerified: e.target.value })} options={[
                { value: 'true', label: 'Verified' }, { value: 'false', label: 'Not verified' },
              ]} />
              <Select placeholder="Any active status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} options={[
                { value: '1', label: 'Active' }, { value: '0', label: 'Inactive' },
              ]} />
              <div className="md:col-span-4 flex justify-end">
                <Button type="button" variant="outline" onClick={() => setFilters({ cityId: '', serviceCategory: '', isVerified: '', status: '' })}>Clear filters</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader<Ef> colKey="efr_id"                 sortKey={sortKey} sortDir={sortDir} onToggle={toggle} className="stick-col-head stick-left">ID</SortHeader>
                <SortHeader<Ef> colKey="efr_name"               sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Name</SortHeader>
                <SortHeader<Ef> colKey="efr_no"                 sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Mobile</SortHeader>
                <SortHeader<Ef> colKey="efr_email"              sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Email</SortHeader>
                <SortHeader<Ef> colKey="city_name"              sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>City</SortHeader>
                <SortHeader<Ef> colKey="efr_service_category"   sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Category</SortHeader>
                <SortHeader<Ef> colKey="efr_service_type"       sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Service Type</SortHeader>
                <SortHeader<Ef> colKey="efr_profile_perc"       sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Profile %</SortHeader>
                <SortHeader<Ef> colKey="is_technician_verified" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Verified</SortHeader>
                <SortHeader<Ef> colKey="efr_status"             sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Status</SortHeader>
                <SortHeader<Ef> colKey="insert_date"            sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Joined</SortHeader>
                <th className="stick-col-head stick-right text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={12} className="text-center py-8 text-muted-foreground">Loading…</td></tr>}
              {!loading && sorted.map((e) => (
                <tr key={e.efr_id}>
                  <td className="text-xs text-muted-foreground stick-col stick-left">{e.efr_id}</td>
                  <td className="font-medium whitespace-nowrap">{formatEasyfixerName(e.efr_name)}</td>
                  <td>{e.efr_no}</td>
                  <td className="text-xs">{e.efr_email ?? '—'}</td>
                  <td>{e.city_name ?? '—'}</td>
                  <td className="text-xs">{e.efr_service_category ?? '—'}</td>
                  <td className="text-xs">{e.efr_service_type ?? '—'}</td>
                  <td className="text-xs tabular-nums">{e.efr_profile_perc != null ? `${Math.round(Number(e.efr_profile_perc))}%` : '—'}</td>
                  <td>{e.is_technician_verified ? '✓' : <span className="text-muted-foreground">—</span>}</td>
                  <td>{e.efr_status ? (
                    <span className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-medium">Active</span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 text-xs font-medium">Inactive</span>
                  )}</td>
                  <td className="text-xs whitespace-nowrap text-muted-foreground">{formatDate(e.insert_date)}</td>
                  <td className="stick-col stick-right text-right">
                    <button
                      type="button"
                      onClick={() => openView(e.efr_id)}
                      className="text-primary text-xs hover:underline whitespace-nowrap"
                    >View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <EasyfixerModal
        open={modal.open}
        mode={modal.mode}
        easyfixerId={modal.id}
        onClose={closeModal}
        onSaved={() => load(true)}
      />

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total.toLocaleString()}
          </span>
          <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}><ChevronLeft className="h-4 w-4" /> Prev</Button>
          <Button variant="outline" size="sm" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset((o) => o + PAGE_SIZE)}>Next <ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}
    </div>
  );
}
