'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Search, Filter, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { formatDate } from '@/lib/utils';

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
  const [data, setData] = useState<Resp | null>(null);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ cityId: '', serviceCategory: '', isVerified: '', status: '' });
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  async function load(reset = false) {
    setLoading(true);
    const off = reset ? 0 : offset;
    try {
      const r = await api.get<Resp>('/admin/easyfixers', {
        q: q || undefined, limit: PAGE_SIZE, offset: off,
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

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Easyfixers</h1>
          <p className="text-sm text-muted-foreground">{data?.total.toLocaleString() ?? '…'} technicians</p>
        </div>
        <Button asChild>
          <Link href="/easyfixers/new"><Plus className="h-4 w-4 mr-1" /> New Easyfixer</Link>
        </Button>
      </div>

      <Card>
        <CardContent className="p-4 space-y-3">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); load(true); }}>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search name, mobile, email…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
            </div>
            <Button type="button" variant="outline" onClick={() => setShowFilters((s) => !s)}>
              <Filter className="h-4 w-4 mr-1" /> Filters
            </Button>
            <Button type="submit">Search</Button>
          </form>
          {showFilters && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 pt-2 border-t">
              <Select placeholder="Any city" value={filters.cityId} onChange={(e) => setFilters({ ...filters, cityId: e.target.value })} options={lk.toOpts.cities} />
              <Select placeholder="Any service category" value={filters.serviceCategory} onChange={(e) => setFilters({ ...filters, serviceCategory: e.target.value })}>
                {lk.serviceCategories.map((c) => <option key={c.service_catg_id} value={c.service_catg_name}>{c.service_catg_name}</option>)}
              </Select>
              <Select placeholder="Any verified status" value={filters.isVerified} onChange={(e) => setFilters({ ...filters, isVerified: e.target.value })} options={[
                { value: 'true', label: 'Verified' }, { value: 'false', label: 'Not verified' },
              ]} />
              <Select placeholder="Any active status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} options={[
                { value: '1', label: 'Active' }, { value: '0', label: 'Inactive' },
              ]} />
              <div className="md:col-span-4 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => { setFilters({ cityId: '', serviceCategory: '', isVerified: '', status: '' }); load(true); }}>Clear</Button>
                <Button type="button" onClick={() => load(true)}>Apply</Button>
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
                <th>ID</th>
                <th>Name</th>
                <th>Mobile</th>
                <th>Email</th>
                <th>City</th>
                <th>Category</th>
                <th>Service Type</th>
                <th>Profile %</th>
                <th>Verified</th>
                <th>Status</th>
                <th>Joined</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={12} className="text-center py-8 text-muted-foreground">Loading…</td></tr>}
              {!loading && (data?.items ?? []).map((e) => (
                <tr key={e.efr_id}>
                  <td className="text-xs text-muted-foreground">{e.efr_id}</td>
                  <td className="font-medium whitespace-nowrap">{e.efr_name}</td>
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
                  <td><Link className="text-primary text-xs hover:underline" href={`/easyfixers/${e.efr_id}`}>View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

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
