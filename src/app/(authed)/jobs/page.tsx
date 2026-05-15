'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Plus, Upload, Search, Filter, ChevronLeft, ChevronRight,
  // Row-level quick-action icons (mirror the legacy Manage Jobs action column)
  Eye, CalendarClock, PlayCircle, CheckCircle2, CalendarCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { SearchSelect } from '@/components/ui/search-select';
import { api } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { cn, formatDate, formatEasyfixerName, statusColorClass, statusLabel } from '@/lib/utils';
import { TABS, type TabDef, type CountsResp, countFor } from '@/lib/job-tabs';
import { JobModal, type JobModalMode } from '@/components/job/JobModal';
import { useSort, SortHeader } from '@/lib/use-sort';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useConfirm } from '@/components/ui/confirm-dialog';

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

// TABS / TabDef / CountsResp / countFor now live in lib/job-tabs.ts and are
// shared with /my-orders. Any change to the lifecycle mapping lands in both
// places automatically.

const PAGE_SIZE = 50;

export default function JobsPage() {
  const lk = useLookup();
  const { me } = useMe();
  // Permission gating. View remains open; create + bulk upload require
  // explicit actions. The View-modal opened on row-click handles its own
  // internal Edit/Save buttons separately — gate those when the modal
  // ships a permission-aware refactor.
  const can = actionFlags(me, ['isJobAddNew', 'isJobUpload', 'isJobEdit']);
  // Per-row action gates — same keys /my-orders uses. Manage Jobs was
  // previously ungated, so Confirm/Schedule/Check-In/Check-Out icons
  // showed regardless of permission. That asymmetry let Admin appear to
  // "have" actions on /jobs that My Orders correctly hid (because Admin's
  // `role_menu_action` rows for these keys weren't seeded). With both
  // pages gated identically, the migration
  // `2026-05-13-seed-new-action-permissions.sql` is the single source of
  // truth: grant in DB → button appears on both pages; revoke → hidden
  // on both.
  const canJob = actionFlags(me, [
    'isJobConfirm',
    'isJobAssign',
    'isJobStatusChange',
  ]);
  const [tab, setTab] = useState('all');
  // Counts are fetched once on mount + re-fetched after any save from the
  // modal (so badges stay fresh). Null = still loading; populated = ready.
  const [counts, setCounts] = useState<CountsResp | null>(null);
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
    const tabDef = TABS.find((t) => t.value === tab);
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
      /*
       * Pass the tab's filter payload to the backend:
       *   - `statuses` (CSV) wins when set (multi-status tabs: Pending to Close,
       *     Audit & Complete).
       *   - `status` for single-code tabs.
       *   - `assigned` splits the BOOKED bucket for the two Pending-for-
       *     Scheduling / Pending-App-Ack tabs.
       * `undefined` values are stripped by `api.get` — no empty query params.
       */
      // `?focus=escalated` drives the legacy CRM header's "Escalated
      // Jobs" link — narrows the list to rows where tbl_job.is_escalated=1
      // regardless of which tab is active. Implemented as a separate
      // backend filter (not a tab) because escalation is a cross-cutting
      // flag, not a status bucket. When focus is unset, isEscalated is
      // omitted so the list behaves exactly as before.
      const isEscalated = searchParams.get('focus') === 'escalated' ? 'true' : undefined;
      const r = await api.get<Resp>('/admin/jobs', {
        status:    tabDef?.statuses ? undefined : tabDef?.status,
        statuses:  tabDef?.statuses ? tabDef.statuses.join(',') : undefined,
        assigned:  tabDef?.assigned === undefined ? undefined : String(tabDef.assigned),
        isEscalated,
        limit: PAGE_SIZE, offset: off,
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
  // Reload when ?focus=… changes — drives the Escalated Jobs deep-link
  // from the navbar.
  const focusParam = useSearchParams().get('focus');
  useEffect(() => { setOffset(0); load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [focusParam]);

  /*
   * Counts fetch — runs once on mount and again after a save from the modal.
   * Same endpoint the dashboard uses, so it's already warm in the pool.
   * Null-safe: if the request fails, badges simply don't render, no toast.
   */
  async function refreshCounts() {
    try { setCounts(await api.get<CountsResp>('/admin/jobs/counts')); }
    catch { /* swallow — the tab bar is still functional without badges */ }
  }
  useEffect(() => { refreshCounts(); }, []);
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

  /*
   * Deep-link tab support: /jobs?tab=<value> preselects that tab on mount.
   * Invalid / stale values silently ignored (don't kick users off for a
   * stray URL). My-Orders lives on /my-orders now — `scope=mine` on /jobs
   * no longer does anything.
   */
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && TABS.some((x) => x.value === t) && t !== tab) {
      setTab(t);
      setOffset(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function closeModal() {
    setModal((m) => ({ ...m, open: false }));
    if (searchParams.get('new') || searchParams.get('view')) router.replace('/jobs');
  }
  function openCreate() { setModal({ open: true, mode: 'create' }); }
  function openView(id: number) { setModal({ open: true, mode: 'view', id }); }
  function openConfirm(id: number) { setModal({ open: true, mode: 'confirm', id }); }

  /*
   * Quick status transition from the row action column — lets ops advance
   * a job through the flow (Check-In, Check-Out) without opening the modal.
   * Mirrors the legacy Manage Jobs page's inline icon actions.
   *
   * Schedule (status 0 → assign tech) is NOT handled here — it needs
   * operator choice, so clicking the calendar icon on a row opens the
   * modal and the operator uses the Auto-assign / Manual pick buttons
   * inside. That keeps the tech-selection flow in one place.
   */
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const confirmAction = useConfirm();
  async function quickStatusChange(jobId: number, toStatus: number, verb: string) {
    const ok = await confirmAction({
      title: `${verb} job #${jobId}?`,
      description: `The job's status will be updated.`,
      confirmLabel: verb,
    });
    if (!ok) return;
    setRowBusy(jobId);
    try {
      await api.patch(`/admin/jobs/${jobId}/status`, { status: toStatus });
      cacheRef.current.clear();
      await load(false, true);
      refreshCounts();
    } catch (e) {
      setErrorMsg(`${verb} failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setRowBusy(null);
    }
  }

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
      {errorMsg && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)} className="text-xs hover:underline">Dismiss</button>
        </div>
      )}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Jobs</h1>
          <p className="text-sm text-muted-foreground">{data?.total.toLocaleString() ?? '…'} matching jobs</p>
        </div>
        <div className="flex gap-2">
          {can.isJobUpload && (
            <Button variant="outline" asChild>
              <Link href="/jobs/upload"><Upload className="h-4 w-4 mr-1" /> Upload Excel</Link>
            </Button>
          )}
          {can.isJobAddNew && (
            <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> Add New Job</Button>
          )}
        </div>
      </div>

      {/*
        * Pill-bar tab layout with inline count badges + horizontal scroll.
        * Replaces the previous `<Tabs flex-wrap>` which broke into two rows
        * at 10+ tabs. Single-row keeps the visual rhythm tight; the right
        * edge fades to signal "more to scroll" when overflow happens.
        * `scrollbar-none` hides the bar itself (webkit + firefox); `snap-x`
        * gives ops a gentle detent when they scroll by trackpad.
        */}
      <div className="relative">
        <div className="overflow-x-auto snap-x -mx-1 px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex items-center gap-1.5 min-w-max py-1">
            {TABS.map((t) => {
              const active = t.value === tab;
              const n = countFor(t, counts);
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTab(t.value)}
                  className={cn(
                    'shrink-0 snap-start inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors whitespace-nowrap',
                    active
                      ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                      : 'bg-background hover:bg-muted/60 border-input text-foreground/80 hover:text-foreground'
                  )}
                >
                  <span>{t.label}</span>
                  {n !== null && (
                    <span className={cn(
                      'inline-flex items-center justify-center rounded-full text-[11px] font-medium tabular-nums px-1.5 min-w-[1.4rem] h-[1.25rem]',
                      active ? 'bg-white/25' : 'bg-muted text-muted-foreground'
                    )}>
                      {n.toLocaleString('en-IN')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        {/* Right-edge gradient fade — subtle cue that there's more content when
            the bar overflows. Pointer-events off so it doesn't block clicks. */}
        <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-background to-transparent" aria-hidden="true" />
      </div>

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
                    <SortHeader col="job_id"             sortBy={sortKey} sortDir={sortDir} onSort={toggle} className="stick-col-head stick-left">Job #</SortHeader>
                    <SortHeader col="job_reference_id"   sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Job Ref</SortHeader>
                    <SortHeader col="client_ref_id"      sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Client Ref</SortHeader>
                    <SortHeader col="client_name"        sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Client</SortHeader>
                    <SortHeader col="customer_name"      sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Customer</SortHeader>
                    <SortHeader col="customer_mob_no"    sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Mobile</SortHeader>
                    <SortHeader col="city_name"          sortBy={sortKey} sortDir={sortDir} onSort={toggle}>City</SortHeader>
                    <SortHeader col="job_type"           sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Type</SortHeader>
                    <SortHeader col="source_type"        sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Source</SortHeader>
                    <SortHeader col="easyfixer_name"     sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Technician</SortHeader>
                    <SortHeader col="owner_name"         sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Owner</SortHeader>
                    <SortHeader col="created_date_time"  sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Created</SortHeader>
                    <SortHeader col="requested_date_time" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Requested</SortHeader>
                    <SortHeader col="scheduled_date_time" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Scheduled</SortHeader>
                    <SortHeader col="checkin_date_time"  sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Check-in</SortHeader>
                    <SortHeader col="checkout_date_time" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Check-out</SortHeader>
                    <SortHeader col="job_status"         sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Status</SortHeader>
                    <th className="stick-col-head stick-right text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <tr><td colSpan={18} className="text-center py-8 text-muted-foreground">Loading…</td></tr>}
                  {!loading && sorted.map((j) => (
                <tr key={j.job_id}>
                  <td className="font-medium whitespace-nowrap stick-col stick-left">#{j.job_id}</td>
                  <td className="text-xs">{j.job_reference_id ?? '—'}</td>
                  <td className="text-xs">{j.client_ref_id ?? '—'}</td>
                  <td className="whitespace-nowrap">{j.client_name ?? '—'}</td>
                  <td className="whitespace-nowrap">{j.customer_name ?? '—'}</td>
                  <td className="text-xs">{j.customer_mob_no ?? '—'}</td>
                  <td>{j.city_name ?? '—'}</td>
                  <td className="text-xs">{j.job_type}</td>
                  <td className="text-xs text-muted-foreground">{j.source_type ?? '—'}</td>
                  <td className="whitespace-nowrap">{j.easyfixer_name ? formatEasyfixerName(j.easyfixer_name) : <span className="text-muted-foreground">unassigned</span>}</td>
                  <td className="text-xs text-muted-foreground whitespace-nowrap">{j.owner_name ?? '—'}</td>
                  <td className="text-xs whitespace-nowrap">{formatDate(j.created_date_time)}</td>
                  <td className="text-xs whitespace-nowrap">{formatDate(j.requested_date_time)}</td>
                  <td className="text-xs whitespace-nowrap">{j.scheduled_date_time ? formatDate(j.scheduled_date_time) : '—'}</td>
                  <td className="text-xs whitespace-nowrap">{j.checkin_date_time ? formatDate(j.checkin_date_time) : '—'}</td>
                  <td className="text-xs whitespace-nowrap">{j.checkout_date_time ? formatDate(j.checkout_date_time) : '—'}</td>
                  <td><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${statusColorClass(j.job_status)}`}>{statusLabel(j.job_status, { assigned: j.fk_easyfixter_id != null })}</span></td>
                  <td className="stick-col stick-right text-right whitespace-nowrap">
                    {/*
                      * Status-driven row actions — mirrors legacy jobList.vm:
                      *   status 0     → View + Schedule (opens modal for auto/manual pick)
                      *   status 1     → View + Check-In (direct status 1→2)
                      *   status 2, 20 → View + Check-Out (direct status 2→3)
                      *   others       → View only
                      * The quickStatusChange() handler confirms + PATCHes /status
                      * + refreshes both list + counts so badges stay coherent.
                      */}
                    <div className="inline-flex items-center gap-1 justify-end">
                      <button
                        type="button"
                        onClick={() => openView(j.job_id)}
                        className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
                        title="View details"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      {/* Unconfirmed (status=9) → opens JobModal which exposes
                          the "Confirm & Schedule" action that moves the job
                          to BOOKED, mirroring legacy `addEditJob → Book Call`.
                          Gate: isJobConfirm. */}
                      {j.job_status === 9 && canJob.isJobConfirm && (
                        <button
                          type="button"
                          onClick={() => openConfirm(j.job_id)}
                          className="inline-flex items-center gap-1 text-purple-700 text-xs hover:underline"
                          title="Confirm — fill details, pick services, and move to Scheduled"
                        >
                          <CalendarCheck className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {/* Schedule (status=0): opens JobModal for tech
                          assignment. Gate: isJobAssign — same key
                          /my-orders uses. */}
                      {j.job_status === 0 && canJob.isJobAssign && (
                        <button
                          type="button"
                          onClick={() => openView(j.job_id)}
                          className="inline-flex items-center gap-1 text-sky-700 text-xs hover:underline"
                          title="Schedule — opens modal to assign a technician"
                        >
                          <CalendarClock className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {/* Check-In + Check-Out are both status mutations →
                          isJobStatusChange. */}
                      {j.job_status === 1 && canJob.isJobStatusChange && (
                        <button
                          type="button"
                          disabled={rowBusy === j.job_id}
                          onClick={() => quickStatusChange(j.job_id, 2, 'Check in')}
                          className="inline-flex items-center gap-1 text-amber-700 text-xs hover:underline disabled:opacity-50"
                          title="Check-In — technician on-site, move to In Progress"
                        >
                          <PlayCircle className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {(j.job_status === 2 || j.job_status === 20) && canJob.isJobStatusChange && (
                        <button
                          type="button"
                          disabled={rowBusy === j.job_id}
                          onClick={() => quickStatusChange(j.job_id, 3, 'Check out & complete')}
                          className="inline-flex items-center gap-1 text-emerald-700 text-xs hover:underline disabled:opacity-50"
                          title="Check-Out — close the job"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
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
        onSaved={() => { cacheRef.current.clear(); load(false, true); refreshCounts(); }}
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
