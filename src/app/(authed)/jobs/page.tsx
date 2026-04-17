'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Upload, Search, Filter, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { formatDate, statusColorClass, statusLabel } from '@/lib/utils';

type JobRow = {
  job_id: number; job_reference_id: string | null; client_ref_id: string | null;
  job_status: number; job_type: string; source_type: string | null;
  job_desc: string | null;
  created_date_time: string; requested_date_time: string; scheduled_date_time: string | null;
  checkin_date_time: string | null; checkout_date_time: string | null;
  fk_customer_id: number; customer_name: string; customer_mob_no: string;
  fk_client_id: number; client_name: string;
  fk_easyfixter_id: number | null; easyfixer_name: string | null;
  job_owner: number | null; owner_name: string | null;
  fk_address_id: number; city_name: string | null;
};
type Resp = { items: JobRow[]; total: number; limit: number; offset: number };

const TABS: { value: string; label: string; status?: number }[] = [
  { value: 'all',         label: 'All' },
  { value: 'booked',      label: 'Booked',      status: 0 },
  { value: 'scheduled',   label: 'Scheduled',   status: 1 },
  { value: 'inprogress',  label: 'In Progress', status: 2 },
  { value: 'completed',   label: 'Completed',   status: 3 },
  { value: 'cancelled',   label: 'Cancelled',   status: 6 },
  { value: 'enquiry',     label: 'Enquiry',     status: 7 },
  { value: 'calllater',   label: 'Call Later',  status: 9 },
  { value: 'revisit',     label: 'Revisit',     status: 10 },
];

const PAGE_SIZE = 50;

export default function JobsPage() {
  const lk = useLookup();
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({
    clientId: '', cityId: '', ownerId: '', easyfixerId: '',
    startDate: '', endDate: '',
  });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  async function load(reset = false) {
    setLoading(true);
    const status = TABS.find((t) => t.value === tab)?.status;
    const off = reset ? 0 : offset;
    try {
      const r = await api.get<Resp>('/admin/jobs', {
        status, q: q || undefined, limit: PAGE_SIZE, offset: off,
        clientId: filters.clientId || undefined,
        cityId: filters.cityId || undefined,
        ownerId: filters.ownerId || undefined,
        easyfixerId: filters.easyfixerId || undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
      });
      setData(r);
      if (reset) setOffset(0);
    } finally { setLoading(false); }
  }

  useEffect(() => { setOffset(0); load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab]);
  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [offset]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Jobs</h1>
          <p className="text-sm text-muted-foreground">{data?.total.toLocaleString() ?? '…'} matching jobs</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/jobs/upload"><Upload className="h-4 w-4 mr-1" /> Upload Excel</Link>
          </Button>
          <Button asChild>
            <Link href="/jobs/new"><Plus className="h-4 w-4 mr-1" /> New Job</Link>
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          {TABS.map((t) => <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-4 space-y-3">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); load(true); }}>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search job ref / client ref / customer name or mobile…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
            </div>
            <Button type="button" variant="outline" onClick={() => setShowFilters((s) => !s)}>
              <Filter className="h-4 w-4 mr-1" /> Filters
            </Button>
            <Button type="submit">Search</Button>
          </form>
          {showFilters && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t">
              <Select placeholder="Any client" value={filters.clientId} onChange={(e) => setFilters({ ...filters, clientId: e.target.value })} options={lk.toOpts.clients} />
              <Select placeholder="Any city"   value={filters.cityId}   onChange={(e) => setFilters({ ...filters, cityId: e.target.value })} options={lk.toOpts.cities} />
              <Select placeholder="Any owner"  value={filters.ownerId}  onChange={(e) => setFilters({ ...filters, ownerId: e.target.value })} options={lk.toOpts.adminUsers} />
              <Input placeholder="Easyfixer ID" value={filters.easyfixerId} onChange={(e) => setFilters({ ...filters, easyfixerId: e.target.value })} />
              <Input type="date" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} />
              <Input type="date" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} />
              <div className="md:col-span-3 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => { setFilters({ clientId: '', cityId: '', ownerId: '', easyfixerId: '', startDate: '', endDate: '' }); load(true); }}>Clear</Button>
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
                <th>Job #</th>
                <th>Job Ref</th>
                <th>Client Ref</th>
                <th>Client</th>
                <th>Customer</th>
                <th>Mobile</th>
                <th>City</th>
                <th>Type</th>
                <th>Source</th>
                <th>Technician</th>
                <th>Owner</th>
                <th>Created</th>
                <th>Requested</th>
                <th>Scheduled</th>
                <th>Check-in</th>
                <th>Check-out</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={18} className="text-center py-8 text-muted-foreground">Loading…</td></tr>}
              {!loading && (data?.items ?? []).map((j) => (
                <tr key={j.job_id}>
                  <td className="font-medium whitespace-nowrap">#{j.job_id}</td>
                  <td className="text-xs">{j.job_reference_id ?? '—'}</td>
                  <td className="text-xs">{j.client_ref_id ?? '—'}</td>
                  <td className="whitespace-nowrap">{j.client_name ?? '—'}</td>
                  <td className="whitespace-nowrap">{j.customer_name ?? '—'}</td>
                  <td className="text-xs">{j.customer_mob_no ?? '—'}</td>
                  <td>{j.city_name ?? '—'}</td>
                  <td className="text-xs">{j.job_type}</td>
                  <td className="text-xs text-muted-foreground">{j.source_type ?? '—'}</td>
                  <td className="whitespace-nowrap">{j.easyfixer_name ?? <span className="text-muted-foreground">unassigned</span>}</td>
                  <td className="text-xs text-muted-foreground whitespace-nowrap">{j.owner_name ?? '—'}</td>
                  <td className="text-xs whitespace-nowrap">{formatDate(j.created_date_time)}</td>
                  <td className="text-xs whitespace-nowrap">{formatDate(j.requested_date_time)}</td>
                  <td className="text-xs whitespace-nowrap">{j.scheduled_date_time ? formatDate(j.scheduled_date_time) : '—'}</td>
                  <td className="text-xs whitespace-nowrap">{j.checkin_date_time ? formatDate(j.checkin_date_time) : '—'}</td>
                  <td className="text-xs whitespace-nowrap">{j.checkout_date_time ? formatDate(j.checkout_date_time) : '—'}</td>
                  <td><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${statusColorClass(j.job_status)}`}>{statusLabel(j.job_status)}</span></td>
                  <td><Link className="text-primary text-xs hover:underline" href={`/jobs/${j.job_id}`}>View</Link></td>
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
          <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>
            <ChevronLeft className="h-4 w-4" /> Prev
          </Button>
          <Button variant="outline" size="sm" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset((o) => o + PAGE_SIZE)}>
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
