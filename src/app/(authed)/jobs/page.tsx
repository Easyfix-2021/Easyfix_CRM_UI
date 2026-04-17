'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Upload, Search, Filter, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SearchSelect } from '@/components/ui/search-select';
import { api } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { formatDate, statusColorClass, statusLabel } from '@/lib/utils';
import { JobModal, type JobModalMode } from '@/components/job/JobModal';
import { useSort, SortHeader } from '@/lib/use-sort';

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
  // `q` is UI-only — filters the currently-loaded page in memory rather than
  // firing a backend request per keystroke. Searching feels instant. Fetches
  // still happen on tab switch, filter changes, and pagination.
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({
    clientId: '', cityId: '', ownerId: '', easyfixerId: '',
    startDate: '', endDate: '',
  });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  /*
   * Result cache keyed by `${tab}|${offset}|${filters+q}`. Switching back to a
   * tab you've already visited is instant + DB-free. Search/filter changes bust
   * their portion of the key. TTL is 30 s — long enough to make tab switching
   * feel snappy, short enough that a freshly-assigned tech is reflected when
   * the ops user returns to the Scheduled tab.
   */
  const cacheRef = useRef<Map<string, { at: number; data: Resp }>>(new Map());
  const TAB_CACHE_TTL = 30_000;

  function filterKey() {
    // `q` intentionally excluded — it's a UI-only filter, doesn't change the
    // backend request, so we cache the same underlying result regardless of query.
    return [filters.clientId, filters.cityId, filters.ownerId, filters.easyfixerId, filters.startDate, filters.endDate].join('|');
  }

  async function load(reset = false, force = false) {
    const status = TABS.find((t) => t.value === tab)?.status;
    const off = reset ? 0 : offset;
    const key = `${tab}|${off}|${filterKey()}`;

    if (!force) {
      const hit = cacheRef.current.get(key);
      if (hit && Date.now() - hit.at < TAB_CACHE_TTL) {
        setData(hit.data);
        if (reset) setOffset(0);
        return;
      }
    }

    setLoading(true);
    try {
      const r = await api.get<Resp>('/admin/jobs', {
        status, limit: PAGE_SIZE, offset: off,
        clientId: filters.clientId || undefined,
        cityId: filters.cityId || undefined,
        ownerId: filters.ownerId || undefined,
        easyfixerId: filters.easyfixerId || undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
      });
      setData(r);
      cacheRef.current.set(key, { at: Date.now(), data: r });
      if (reset) setOffset(0);
    } finally { setLoading(false); }
  }

  useEffect(() => { setOffset(0); load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab]);
  useEffect(() => { load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [offset]);
  // Filter changes refetch (backend-driven); the search box doesn't — see below.
  useEffect(() => { setOffset(0); load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [filters.clientId, filters.cityId, filters.ownerId, filters.easyfixerId, filters.startDate, filters.endDate]);

  // Modal state + URL-driven deep-link support (matches Easyfixer pattern).
  const router = useRouter();
  const searchParams = useSearchParams();
  const [modal, setModal] = useState<{ open: boolean; mode: JobModalMode; id?: number }>({ open: false, mode: 'create' });

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
    if (searchParams.get('new') || searchParams.get('view')) router.replace('/jobs');
  }
  function openCreate() { setModal({ open: true, mode: 'create' }); }
  function openView(id: number) { setModal({ open: true, mode: 'view', id }); }

  // Apply UI-only search filter before sorting. Matches against any visible
  // text column (job #, refs, client, customer name, mobile, city, tech, owner).
  const filteredItems = (data?.items ?? []).filter((j) => {
    if (!q) return true;
    const needle = q.toLowerCase();
    const haystacks = [
      j.job_id, j.job_reference_id, j.client_ref_id,
      j.client_name, j.customer_name, j.customer_mob_no,
      j.city_name, j.easyfixer_name, j.owner_name, j.job_type,
    ];
    return haystacks.some((h) => h != null && String(h).toLowerCase().includes(needle));
  });
  // Sort hook must live at the component root to satisfy Rules of Hooks.
  const { sorted, sortKey, sortDir, toggle } = useSort<JobRow>(filteredItems);

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
          <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> Add New Job</Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          {TABS.map((t) => <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-3 space-y-3">
          {/* Search + filters are realtime — typing debounces 350ms, filter
              changes refetch immediately. No "Search" button needed. */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search job ref / client ref / customer name or mobile…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
            </div>
            <Button type="button" variant="outline" onClick={() => setShowFilters((s) => !s)}>
              <Filter className="h-4 w-4 mr-1" /> Filters
            </Button>
          </div>
          {showFilters && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t">
              <SearchSelect placeholder="Any client" value={filters.clientId} onChange={(v) => setFilters({ ...filters, clientId: v })} options={lk.toOpts.clients.map((o) => ({ value: o.value, label: String(o.label) }))} />
              <SearchSelect placeholder="Any city"   value={filters.cityId}   onChange={(v) => setFilters({ ...filters, cityId: v })} options={lk.toOpts.cities.map((o) => ({ value: o.value, label: String(o.label) }))} />
              <SearchSelect placeholder="Any owner"  value={filters.ownerId}  onChange={(v) => setFilters({ ...filters, ownerId: v })} options={lk.toOpts.adminUsers.map((o) => ({ value: o.value, label: String(o.label) }))} />
              <Input placeholder="Easyfixer ID" type="number" min={1} value={filters.easyfixerId} onChange={(e) => setFilters({ ...filters, easyfixerId: e.target.value.replace(/[^0-9]/g, '') })} />
              <Input type="date" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} />
              <Input type="date" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} />
              <div className="md:col-span-3 flex justify-end">
                <Button type="button" variant="outline" onClick={() => setFilters({ clientId: '', cityId: '', ownerId: '', easyfixerId: '', startDate: '', endDate: '' })}>Clear filters</Button>
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
                    <SortHeader<JobRow> colKey="job_id"             sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Job #</SortHeader>
                    <SortHeader<JobRow> colKey="job_reference_id"   sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Job Ref</SortHeader>
                    <SortHeader<JobRow> colKey="client_ref_id"      sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Client Ref</SortHeader>
                    <SortHeader<JobRow> colKey="client_name"        sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Client</SortHeader>
                    <SortHeader<JobRow> colKey="customer_name"      sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Customer</SortHeader>
                    <SortHeader<JobRow> colKey="customer_mob_no"    sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Mobile</SortHeader>
                    <SortHeader<JobRow> colKey="city_name"          sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>City</SortHeader>
                    <SortHeader<JobRow> colKey="job_type"           sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Type</SortHeader>
                    <SortHeader<JobRow> colKey="source_type"        sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Source</SortHeader>
                    <SortHeader<JobRow> colKey="easyfixer_name"     sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Technician</SortHeader>
                    <SortHeader<JobRow> colKey="owner_name"         sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Owner</SortHeader>
                    <SortHeader<JobRow> colKey="created_date_time"  sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Created</SortHeader>
                    <SortHeader<JobRow> colKey="requested_date_time" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Requested</SortHeader>
                    <SortHeader<JobRow> colKey="scheduled_date_time" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Scheduled</SortHeader>
                    <SortHeader<JobRow> colKey="checkin_date_time"  sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Check-in</SortHeader>
                    <SortHeader<JobRow> colKey="checkout_date_time" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Check-out</SortHeader>
                    <SortHeader<JobRow> colKey="job_status"         sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>Status</SortHeader>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <tr><td colSpan={18} className="text-center py-8 text-muted-foreground">Loading…</td></tr>}
                  {!loading && sorted.map((j) => (
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
                  <td>
                    <button
                      type="button"
                      onClick={() => openView(j.job_id)}
                      className="text-primary text-xs hover:underline"
                    >View</button>
                  </td>
                </tr>
              ))}
                </tbody>
              </table>
        </CardContent>
      </Card>

      <JobModal
        open={modal.open}
        mode={modal.mode}
        jobId={modal.id}
        onClose={closeModal}
        onSaved={() => { cacheRef.current.clear(); load(false, true); }}
      />

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
