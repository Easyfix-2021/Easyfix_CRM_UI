'use client';

/*
 * QuickSight — Supply Gap Analysis (legacy "Open City") report page.
 *
 *   registry slug : opencity   ·   urlBase: supply-gap
 *   action key    : isQuickSightSupplyGapView
 *   BE endpoints  : GET /api/admin/quicksight/supply-gap            (list + ?format=xlsx)
 *                   GET /api/admin/quicksight/supply-gap/:id        (detail)
 *                   GET /api/admin/quicksight/supply-gap/:id/allocations
 *                   GET /api/admin/quicksight/supply-gap/:id/history
 *
 * Native rebuild of the legacy "Supply Gap Dashboard" LIST surface. This is
 * the READ/report view — the legacy full-CRUD write flow (new request /
 * allocate / action) is out of scope for the QuickSight rebuild.
 *
 * Fetch hygiene: data comes through the shared `useFetch` (GET) keyed on the
 * serialized applied-filter + page state — never a raw useEffect+api.get
 * (mandatory CRM_UI fetch-hooks rule). Export streams via a Bearer fetch →
 * blob (download-xlsx pattern), replacing the legacy 5s disk-URL hack.
 *
 * Gating: page is gated on the per-report action key via actionFlags (the
 * family key is enforced server-side by requireQuickSight). A 403 from the
 * list endpoint flips the scaffold's accessDenied panel.
 */

import { useCallback, useMemo, useState } from 'react';
import { LayoutGrid, Eye, Loader2 } from 'lucide-react';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFetch } from '@/lib/hooks';
import { useLookup } from '@/lib/use-lookup';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DownloadButton } from '@/components/ui/download-button';
import { SearchSelect } from '@/components/ui/search-select';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const ACTION_KEY = 'isQuickSightSupplyGapView';
const API_BASE = '/admin/quicksight/supply-gap';
// pageSize cap matching the BE Joi `pageSize.max(200)`.
const MAX_PAGE_SIZE = 200;

/* ── Row + response types (mirror the BE service response) ─────────────── */
type ListRow = {
  openCityId: number;
  pinCode: number | null;
  cityName: string | null;
  districtName: string | null;
  stateName: string | null;
  category: string | null;
  zonalManager: string | null;
  refId: string | null;
  comments: string | null;
  status: number | null;
  oldSupplyId: number | null;
  newSupplyNumber: string | null;
  newSupplyName: string | null;
  actionRemarks: string | null;
  actionOn: string | null;
  actionBy: string | null;
  initiatedBy: string | null;
  initiatedOn: string | null;
  closeBy: string | null;
  closeOn: string | null;
  requestFor: number | null;
  allocationCount: number;
  gapAge: number;
  supplyStatus: string | null;
};

type ListResponse = {
  data: ListRow[];
  pageNumber: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
};

type DetailRow = {
  id: number;
  clientName: string | null;
  stateUserName: string | null;
  catgName: string | null;
  pin: number | null;
  cityName: string | null;
  districtName: string | null;
  stateName: string | null;
  comments: string | null;
  referenceId: string | null;
  status: number | null;
  newSupplyNumber: string | null;
  newSupplyName: string | null;
  oldSupplyId: number | null;
  actionDate: string | null;
  actionRemarks: string | null;
  initiatedOn: string | null;
  requestFor: number | null;
  closedOn: string | null;
  closedComments: string | null;
  actionUserName: string | null;
  initiatedByUser: string | null;
  closedByUser: string | null;
  isJobEscalated: number;
  jobStatus: number | null;
};

type AllocationRow = {
  supplyId: number;
  supplyName: string | null;
  supplyNo: string | null;
  remarks: string | null;
  supplyStatus: string | null;
  createdOn: string | null;
  createdBy: string | null;
  actionType: string;
};

/* ── Filter state (draft edits; applied drives the fetch) ─────────────── */
type Filters = {
  zonalManager: number; // 0 = All
  supplyStatus: number; // 5 = All
  requestFor: number; // 0 = All
  startDate: string;
  endDate: string;
  searchText: string;
};

const EMPTY_FILTERS: Filters = {
  zonalManager: 0,
  supplyStatus: 5,
  requestFor: 0,
  startDate: '',
  endDate: '',
  searchText: '',
};

/* On-screen status labels {0 Open,1 In Progress,2 Assigned,3 Cancelled,4 Completed}. */
const STATUS_LABEL: Record<number, string> = {
  0: 'Open',
  1: 'In Progress',
  2: 'Assigned',
  3: 'Cancelled',
  4: 'Completed',
};
const STATUS_CLASS: Record<number, string> = {
  0: 'bg-sky-100 text-sky-800',
  1: 'bg-amber-100 text-amber-800',
  2: 'bg-indigo-100 text-indigo-800',
  3: 'bg-rose-100 text-rose-800',
  4: 'bg-emerald-100 text-emerald-800',
};

const STATUS_OPTIONS = [
  { value: 0, label: 'Open' },
  { value: 1, label: 'In Progress' },
  { value: 2, label: 'Assigned' },
  { value: 3, label: 'Cancel' },
  { value: 4, label: 'Completed' },
  { value: 5, label: 'All' },
];
const REQUEST_FOR_OPTIONS = [
  { value: 0, label: 'All' },
  { value: 1, label: 'Job ID' },
  { value: 2, label: 'New City' },
];

const todayYmd = () => new Date().toISOString().slice(0, 10);

/* Build the list query string from applied filters + paging (1-indexed page). */
function buildListQuery(f: Filters, page: number, pageSize: number): string {
  const p = new URLSearchParams();
  p.set('page', String(page));
  p.set('pageSize', String(pageSize));
  if (f.zonalManager) p.set('zonalManager', String(f.zonalManager));
  p.set('supplyStatus', String(f.supplyStatus));
  if (f.requestFor) p.set('requestFor', String(f.requestFor));
  if (f.startDate) p.set('startDate', f.startDate);
  if (f.endDate) p.set('endDate', f.endDate);
  if (f.searchText.trim()) p.set('searchText', f.searchText.trim());
  return p.toString();
}

export default function SupplyGapPage() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY]);
  const canView = flags[ACTION_KEY];

  const lookup = useLookup();
  // Zonal Manager options — tbl_user.state_user owners aren't a dedicated
  // lookup; admin users are the superset (matches the legacy zonal list).
  const zonalOptions = useMemo(() => lookup.toOpts.adminUsers, [lookup.toOpts.adminUsers]);

  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0); // 0-indexed for TablePagination
  const [pageSize, setPageSize] = useState<TablePageSize>(10);

  const effSize = pageSizeToLimit(pageSize, MAX_PAGE_SIZE);

  /* Serialized key → re-fetch only when applied filters / paging change. */
  const listKey = useMemo(
    () => (canView ? `${API_BASE}?${buildListQuery(applied, page + 1, effSize)}` : null),
    [canView, applied, page, effSize],
  );
  const { data, loading, error } = useFetch<ListResponse>(listKey);

  const rows = data?.data ?? [];
  const total = data?.totalRecords ?? 0;
  const is403 =
    canView === false ||
    (error != null && /access|permission|forbidden/i.test(error));
  const accessDenied = is403;
  const isEmpty = !loading && !error && rows.length === 0;

  /* ── Detail modal (eye icon) ───────────────────────────────────────── */
  const [detailId, setDetailId] = useState<number | null>(null);
  const detailKey = useMemo(
    () => (detailId != null ? `${API_BASE}/${detailId}` : null),
    [detailId],
  );
  const detail = useFetch<DetailRow>(detailKey, { enabled: detailId != null });

  /* ── Allocations drawer ("Added Tx :N") ────────────────────────────── */
  const [allocId, setAllocId] = useState<number | null>(null);
  const allocKey = useMemo(
    () => (allocId != null ? `${API_BASE}/${allocId}/allocations` : null),
    [allocId],
  );
  const allocations = useFetch<AllocationRow[]>(allocKey, { enabled: allocId != null });

  /* ── Export ────────────────────────────────────────────────────────── */
  const [downloading, setDownloading] = useState(false);
  const onDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const qs = buildListQuery(applied, 1, effSize);
      const base = process.env.NEXT_PUBLIC_API_URL || '/api';
      const token =
        typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
      const resp = await fetch(`${base}${API_BASE}?${qs}&format=xlsx`, {
        method: 'GET',
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'supply-gap-analysis.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch {
      /* keep page chrome silent; busy state clears */
    } finally {
      setDownloading(false);
    }
  }, [applied, effSize]);

  const applyFilters = () => {
    setApplied(draft);
    setPage(0);
  };
  const resetFilters = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(0);
  };

  return (
    <ReportPageScaffold
      title="Supply Gap Analysis"
      subtitle="Open city supply requests — allocation, status and remarks."
      icon={LayoutGrid}
      loading={loading}
      error={is403 ? null : error}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={onDownload}
      downloading={downloading}
      filters={
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Zone Name">
              <SearchSelect
                value={draft.zonalManager || ''}
                onChange={(v) =>
                  setDraft((d) => ({ ...d, zonalManager: v ? Number(v) : 0 }))
                }
                options={zonalOptions}
                placeholder="All Zones"
              />
            </Field>
            <Field label="Status">
              <Select
                value={draft.supplyStatus}
                options={STATUS_OPTIONS}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, supplyStatus: Number(e.target.value) }))
                }
              />
            </Field>
            <Field label="Requested For">
              <Select
                value={draft.requestFor}
                options={REQUEST_FOR_OPTIONS}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, requestFor: Number(e.target.value) }))
                }
              />
            </Field>
            <Field label="Ticket Created Date (From)">
              <Input
                type="date"
                value={draft.startDate}
                max={draft.endDate || todayYmd()}
                onChange={(e) => setDraft((d) => ({ ...d, startDate: e.target.value }))}
              />
            </Field>
            <Field label="Ticket Created Date (To)">
              <Input
                type="date"
                value={draft.endDate}
                min={draft.startDate || undefined}
                max={todayYmd()}
                onChange={(e) => setDraft((d) => ({ ...d, endDate: e.target.value }))}
              />
            </Field>
            <Field label="Search">
              <Input
                value={draft.searchText}
                placeholder="Gap ID, Pin Code, Job ID, City, Category, State"
                onChange={(e) => setDraft((d) => ({ ...d, searchText: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyFilters();
                }}
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button onClick={applyFilters} disabled={loading}>
              Filter
            </Button>
            <Button variant="outline" onClick={resetFilters} disabled={loading}>
              Reset
            </Button>
          </div>
        </div>
      }
    >
      {/* ── List table ── */}
      <div className="space-y-3">
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-left">Gap ID</th>
                <th className="!text-left">Gap For</th>
                <th className="!text-center">Gap Days</th>
                <th className="!text-left">Pin Code</th>
                <th className="!text-left">City</th>
                <th className="!text-left">Category</th>
                <th className="!text-left">Status</th>
                <th className="!text-left">Action By</th>
                <th className="!text-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.openCityId}>
                  <td className="!text-left font-medium">{r.openCityId}</td>
                  <td className="!text-left">
                    {r.requestFor === 1 ? (
                      <span className="inline-flex flex-col">
                        <span className="font-medium">JobId</span>
                        {r.refId && (
                          <span className="text-xs text-muted-foreground">{r.refId}</span>
                        )}
                      </span>
                    ) : r.requestFor === 2 ? (
                      'NewCity'
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="!text-center">{r.gapAge}</td>
                  <td className="!text-left">{r.pinCode ?? '-'}</td>
                  <td className="!text-left">
                    {r.cityName ?? '-'}
                    {r.stateName ? (
                      <span className="block text-xs text-muted-foreground">{r.stateName}</span>
                    ) : null}
                  </td>
                  <td className="!text-left">{r.category ?? '-'}</td>
                  <td className="!text-left">
                    <span className="inline-flex flex-col items-start gap-1">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                          STATUS_CLASS[r.status ?? -1] ?? 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {STATUS_LABEL[r.status ?? -1] ?? `Status ${r.status}`}
                      </span>
                      {![0, 1, 2, 4].includes(r.status ?? -1) && r.allocationCount > 0 && (
                        <button
                          type="button"
                          className="text-xs font-medium text-primary hover:underline"
                          onClick={() => setAllocId(r.openCityId)}
                        >
                          Added Tx :{r.allocationCount}
                        </button>
                      )}
                    </span>
                  </td>
                  <td className="!text-left">{renderActionBy(r)}</td>
                  <td className="!text-center">
                    <button
                      type="button"
                      aria-label="View details"
                      title="View Details"
                      className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => setDetailId(r.openCityId)}
                    >
                      <Eye className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(s) => {
            setPageSize(s);
            setPage(0);
          }}
        />
      </div>

      {/* ── Detail modal (eye icon) ── */}
      <Dialog
        open={detailId != null}
        // eslint-disable-next-line no-restricted-syntax -- read-only drill-down modal — no form state to guard
        onOpenChange={(o) => !o && setDetailId(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader className="bg-sidebar text-sidebar-foreground">
            <DialogTitle>Supply Gap #{detailId}</DialogTitle>
          </DialogHeader>
          {detail.loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" /> Loading…
            </div>
          ) : detail.error ? (
            <div className="p-8 text-center text-sm text-red-600">{detail.error}</div>
          ) : detail.data ? (
            <DetailGrid d={detail.data} />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ── Allocations drawer ("Added Tx :N") ── */}
      <Dialog
        open={allocId != null}
        // eslint-disable-next-line no-restricted-syntax -- read-only drill-down modal — no form state to guard
        onOpenChange={(o) => !o && setAllocId(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader className="bg-sidebar text-sidebar-foreground">
            <DialogTitle>
              Added Technicians — Gap #{allocId}
              {allocations.data ? ` (${allocations.data.length})` : ''}
            </DialogTitle>
          </DialogHeader>
          {allocations.loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" /> Loading…
            </div>
          ) : allocations.error ? (
            <div className="p-8 text-center text-sm text-red-600">{allocations.error}</div>
          ) : (allocations.data?.length ?? 0) === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No Record Found.</div>
          ) : (
            <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="!text-left">Supply Name</th>
                    <th className="!text-left">Supply No</th>
                    <th className="!text-left">Type</th>
                    <th className="!text-left">Status</th>
                    <th className="!text-left">Remarks</th>
                    <th className="!text-left">Added By</th>
                    <th className="!text-left">Added On</th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.data!.map((a) => (
                    <tr key={a.supplyId}>
                      <td className="!text-left">{a.supplyName ?? '-'}</td>
                      <td className="!text-left">{a.supplyNo ?? '-'}</td>
                      <td className="!text-left">{a.actionType}</td>
                      <td className="!text-left">{a.supplyStatus ?? '-'}</td>
                      <td className="!text-left">{a.remarks ?? '-'}</td>
                      <td className="!text-left">{a.createdBy ?? '-'}</td>
                      <td className="!text-left">{a.createdOn ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </ReportPageScaffold>
  );
}

/* Action By column: status 3/4 → closeBy+closeOn, 2 → actionBy+actionOn,
 * else → initiatedBy+initiatedOn (each name on first line, date on second). */
function renderActionBy(r: ListRow) {
  let name: string | null;
  let when: string | null;
  if (r.status === 3 || r.status === 4) {
    name = r.closeBy;
    when = r.closeOn;
  } else if (r.status === 2) {
    name = r.actionBy;
    when = r.actionOn;
  } else {
    name = r.initiatedBy;
    when = r.initiatedOn;
  }
  return (
    <span className="inline-flex flex-col">
      <span className="font-medium">{name ?? '-'}</span>
      {when ? <span className="text-xs text-muted-foreground">{when}</span> : null}
    </span>
  );
}

/* Read-only detail grid for the eye-icon modal. */
function DetailGrid({ d }: { d: DetailRow }) {
  const items: Array<[string, React.ReactNode]> = [
    ['Gap ID', d.id],
    ['Gap For', d.requestFor === 1 ? 'Job ID' : d.requestFor === 2 ? 'New City' : '-'],
    ['Job ID', d.referenceId ?? '-'],
    ['Client', d.clientName ?? '-'],
    ['Pin Code', d.pin ?? '-'],
    ['City', d.cityName ?? '-'],
    ['District', d.districtName ?? '-'],
    ['State', d.stateName ?? '-'],
    ['Zonal Manager', d.stateUserName ?? '-'],
    ['Category', d.catgName ?? '-'],
    ['Status', STATUS_LABEL[d.status ?? -1] ?? `Status ${d.status}`],
    ['Escalated', d.isJobEscalated === 1 ? 'Yes' : 'No'],
    ['Open Remarks', d.comments ?? '-'],
    ['Opened By', d.initiatedByUser ?? '-'],
    ['Opened On', d.initiatedOn ?? '-'],
    ['Tx Details', txDetailsText(d)],
    ['Action Remarks', d.actionRemarks ?? '-'],
    ['Action By', d.actionUserName ?? '-'],
    ['Action On', d.actionDate ?? '-'],
    ['Closed By', d.closedByUser ?? '-'],
    ['Closed On', d.closedOn ?? '-'],
  ];
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-2 p-4 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="flex flex-col">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <span className="text-sm">{value}</span>
        </div>
      ))}
    </div>
  );
}

function txDetailsText(d: DetailRow): string {
  if (d.newSupplyName || d.newSupplyNumber) {
    return [d.newSupplyName, d.newSupplyNumber].filter(Boolean).join(' - ');
  }
  if (d.oldSupplyId) return String(d.oldSupplyId);
  return '-';
}

/* Small labelled wrapper for filter fields (Title-Case label). */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
