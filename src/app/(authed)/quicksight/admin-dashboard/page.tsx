'use client';

/*
 * QuickSight — Admin Dashboard (Floor Discipline / Employee Productivity
 * admin-level dashboard) report page.
 *
 *   registry slug : adminDashboard   ·   urlBase: admin-dashboard
 *   action key    : isQuickSightAdminDashboardView
 *   BE endpoints  : POST  /api/admin/quicksight/admin-dashboard/open-orders
 *                   POST  /api/admin/quicksight/admin-dashboard/employee-productivity?page=&size=
 *                   POST  /api/admin/quicksight/admin-dashboard/kra-metrics
 *                   POST  /api/admin/quicksight/admin-dashboard/cancellation-details
 *                   GET   /api/admin/quicksight/admin-dashboard/manager-team
 *                   GET   /api/admin/quicksight/admin-dashboard/vertical-managers?verticalId=
 *                   GET   /api/admin/quicksight/admin-dashboard/rm-team-users?verticalId=&reportingManagerId=
 *
 * Native rebuild of the legacy Angular ProductivityComponent (the real
 * admin-level dashboard the `adminDashboard` stub fronted). Composes: KRA
 * metric tiles, three open-order count cards, cancellation bar + donut, a
 * paginated Employee Productivity table (XLSX export replaces the legacy
 * clipboard "Copy Data"), and an org-chart dialog.
 *
 * Gating: per-report action key via actionFlags (family key + Admin-only are
 * enforced server-side). A 403 from any endpoint flips the scaffold's
 * accessDenied panel.
 *
 * Fetch hygiene: POST data comes through the shared `usePostFetch` (from
 * `@/lib/hooks`); GET lookups use `useGetFetch` (report-local, below). Both
 * carry the same dedup / Strict-Mode / cancellation guards as the shared
 * `useFetch`, which is GET-only and can't POST a Joi-validated filter body.
 * We never write a raw useEffect+api.get.
 *
 * Faithful-migration quirks preserved:
 *   - KRA ignores Appointment Type (sends findByDateType='') and open-order
 *     counts are NOT date-filtered (sends empty dates).
 *   - cancellation call is skipped when either date is empty.
 *   - call-later buckets use the CORRECTED labels (0-1/2-3/4-5/>5 times);
 *     the legacy FE '3-4 times' mismatch is dropped (handled BE-side).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutDashboard, Loader2, Network } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePostFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useLookup } from '@/lib/use-lookup';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import {
  ChartCard,
  QsBarChart,
  QsDonut,
  QsKpiTile,
  QS_COLORS,
  QS_SEMANTIC,
} from '@/components/quicksight/charts';
import {
  BadgeCheck,
  CalendarClock,
  IndianRupee,
  Star,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { DownloadButton } from '@/components/ui/download-button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const ACTION_KEY = 'isQuickSightAdminDashboardView';
const API_BASE = '/admin/quicksight/admin-dashboard';
const PAGE_SIZES = [10, 50, 80];
const EXPORT_MAX = 500; // BE Joi size.max() — used for the export "all rows" pull.

/* ── Response/row types (mirror the BE service responses) ─────────────── */
type Bucket = { label: string; count: number };
type OpenOrderTile = {
  title: string;
  description: string;
  basedOn: string;
  totalCount: number;
  buckets: Bucket[];
};
type OpenOrderResponse = { dashboardDate: string; tiles: OpenOrderTile[] };

type KraMetrics = {
  sdaPercentage: string;
  otaPercentage: string;
  avgTat: number;
  avgRating: number;
  avgTicketSize: number;
  unconfirmed: number;
  callLater: number;
  margin: string;
  revenue: number;
};

type CancellationResponse = {
  summary: {
    totalOrderCancelled: number;
    beforeAllocation: number;
    afterAllocation: number;
  };
  bucketData: { timeBucket: string; totalJobs: number }[];
};

type ProductivityRow = {
  userId: number;
  userName: string;
  booked: number;
  scheduled: number;
  audit: number;
  closedCount: number;
  revenue: number;
  cancelCount: number;
};
type ProductivityResponse = {
  totalRecords: number;
  pageNumber: number;
  pageSize: number;
  totalPages: number;
  data: ProductivityRow[];
};

type OrgNode = {
  id: number;
  name: string;
  title: string;
  imageUrl: string | null;
  teamSize: number;
  children: OrgNode[];
};

type FilterState = {
  startDate: string;
  endDate: string;
  verticalId: number;
  reportingManagerId: number;
  zonalManagerId: number;
  userId: number;
  findByDateType: 'original' | 'requested';
};

/* ── useGetFetch — GET hook that also surfaces the HTTP status (for 403) ─ */
function useGetFetch<T>(key: string | null, options: { enabled?: boolean } = {}) {
  const enabled = options.enabled !== false && key != null;
  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    error: string | null;
    status: number | null;
  }>({ data: null, loading: enabled, error: null, status: null });

  useEffect(() => {
    if (!enabled || !key) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null, status: null }));
    // eslint-disable-next-line no-restricted-syntax -- local GET hook that surfaces HTTP status for 403 access-panel detection (shared useFetch does not expose status); Strict-Mode-safe via the `cancelled` guard.
    api
      .get<T>(key)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null, status: 200 });
      })
      .catch((e) => {
        if (cancelled) return;
        const status = e instanceof ApiError ? e.status : 0;
        const error = e instanceof ApiError ? e.message : 'Failed to load';
        setState({ data: null, loading: false, error, status });
      });
    return () => {
      cancelled = true;
    };
  }, [key, enabled]);

  return state;
}

/* POST-based XLSX download (the shared download-xlsx helper is GET-only). */
async function downloadXlsxPost(path: string, body: unknown, filename: string) {
  const base = process.env.NEXT_PUBLIC_API_URL || '/api';
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.error) msg = String(j.error);
    } catch {
      /* non-JSON body — keep the HTTP code */
    }
    throw new Error(msg);
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

/* Yesterday as 'YYYY-MM-DD' (the legacy default date range). */
function yesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const Y = yesterdayIso();

function makeDefaultFilters(): FilterState {
  return {
    startDate: Y,
    endDate: Y,
    verticalId: 0,
    reportingManagerId: 0,
    zonalManagerId: 0,
    userId: 0,
    findByDateType: 'requested',
  };
}

export default function AdminDashboardPage() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY]);
  const canView = flags[ACTION_KEY];

  const lookup = useLookup();

  /* ── Filter state (applied vs draft) ─────────────────────────────── */
  const [draft, setDraft] = useState<FilterState>(makeDefaultFilters);
  const [applied, setApplied] = useState<FilterState>(makeDefaultFilters);

  /* ── Vertical-dependent RM dropdown options (BE lookup) ──────────── */
  const rmKey = canView
    ? `${API_BASE}/vertical-managers?verticalId=${draft.verticalId}`
    : null;
  const rmList = useGetFetch<{ userId: string; userName: string }[]>(rmKey, {
    enabled: canView,
  });
  const rmOptions: SearchOption[] = useMemo(
    () => (rmList.data ?? []).map((r) => ({ value: Number(r.userId), label: r.userName })),
    [rmList.data],
  );

  /* ── RM-dependent User dropdown options (BE lookup) ──────────────── */
  const userLookupKey = canView
    ? `${API_BASE}/rm-team-users?verticalId=${draft.verticalId}&reportingManagerId=${draft.reportingManagerId}`
    : null;
  const userList = useGetFetch<
    { userId: string; userName: string }[]
  >(userLookupKey, { enabled: canView });
  const userOptions: SearchOption[] = useMemo(
    () => (userList.data ?? []).map((u) => ({ value: Number(u.userId), label: u.userName })),
    [userList.data],
  );

  /* Vertical / Zonal options from the shared lookup. */
  const verticalOptions: SearchOption[] = useMemo(
    () => lookup.verticals.map((v) => ({ value: v.vertical_id, label: v.vertical_name })),
    [lookup.verticals],
  );
  const zonalOptions: SearchOption[] = useMemo(
    () => lookup.toOpts.adminUsers,
    [lookup.toOpts.adminUsers],
  );

  /* ── KRA metrics — ignores appointment type (findByDateType=''). ─── */
  const kraBody = useMemo(
    () => ({ ...applied, findByDateType: '' as const }),
    [applied],
  );
  const kra = usePostFetch<KraMetrics>(
    canView ? `${API_BASE}/kra-metrics` : null,
    kraBody,
    { enabled: canView },
  );

  /* ── Open-order counts — NOT date-filtered (empty dates). ─────────── */
  const openBody = useMemo(
    () => ({ ...applied, startDate: '', endDate: '' }),
    [applied],
  );
  const openOrders = usePostFetch<OpenOrderResponse>(
    canView ? `${API_BASE}/open-orders` : null,
    openBody,
    { enabled: canView },
  );

  /* ── Cancellation — skipped when either date is empty. ────────────── */
  const cancelEnabled = canView && !!applied.startDate && !!applied.endDate;
  const cancellation = usePostFetch<CancellationResponse>(
    cancelEnabled ? `${API_BASE}/cancellation-details` : null,
    applied,
    { enabled: cancelEnabled },
  );

  /* ── Employee Productivity (paginated). ──────────────────────────── */
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZES[0]);
  // Reset to page 1 whenever the applied filter or page size changes.
  useEffect(() => {
    setPage(1);
  }, [applied, size]);
  const prod = usePostFetch<ProductivityResponse>(
    canView
      ? `${API_BASE}/employee-productivity?page=${page}&size=${size}`
      : null,
    applied,
    { enabled: canView },
  );

  /* The page's primary request drives the scaffold state. */
  const primaryLoading = prod.loading || kra.loading || openOrders.loading;
  const accessDenied =
    canView === false ||
    prod.status === 403 ||
    kra.status === 403 ||
    openOrders.status === 403;
  const primaryError =
    [prod, kra, openOrders].find((s) => s.error && s.status !== 403)?.error ?? null;
  const prodRows = prod.data?.data ?? [];
  const isEmpty =
    !primaryLoading &&
    !primaryError &&
    !accessDenied &&
    prodRows.length === 0 &&
    (openOrders.data?.tiles?.every((t) => t.totalCount === 0) ?? true);

  /* ── Org-chart dialog ─────────────────────────────────────────────── */
  const [orgOpen, setOrgOpen] = useState(false);
  const orgKey = orgOpen ? `${API_BASE}/manager-team` : null;
  const org = useGetFetch<OrgNode>(orgKey, { enabled: orgOpen });

  /* ── XLSX export (replaces legacy clipboard "Copy Data"). ─────────── */
  const [downloading, setDownloading] = useState(false);
  const onDownload = useCallback(async () => {
    setDownloading(true);
    try {
      // Pull all rows in one shot (size capped at the BE Joi max).
      await downloadXlsxPost(
        `${API_BASE}/employee-productivity?page=1&size=${EXPORT_MAX}`,
        { ...applied, format: 'xlsx' },
        'employee-productivity.xlsx',
      );
    } catch {
      /* keep page chrome silent; busy state clears */
    } finally {
      setDownloading(false);
    }
  }, [applied]);

  /* ── Filter apply / reset ─────────────────────────────────────────── */
  const onApply = () => setApplied(draft);
  const onReset = () => {
    const def = makeDefaultFilters();
    setDraft(def);
    setApplied(def);
  };

  return (
    <ReportPageScaffold
      title="Admin Dashboard"
      subtitle="Floor discipline — KRA metrics, open orders, cancellations & employee productivity."
      icon={LayoutDashboard}
      loading={primaryLoading}
      error={primaryError}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={onDownload}
      downloading={downloading}
      filters={
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* Appointment Type */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Appointment Type
              </label>
              <div className="flex items-center gap-4 pt-1">
                {(['original', 'requested'] as const).map((v) => (
                  <label key={v} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name="findByDateType"
                      checked={draft.findByDateType === v}
                      onChange={() => setDraft((d) => ({ ...d, findByDateType: v }))}
                    />
                    {v === 'original' ? 'Original' : 'Current'}
                  </label>
                ))}
              </div>
            </div>

            {/* Date Range */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">From Date</label>
              <Input
                type="date"
                value={draft.startDate}
                onChange={(e) => setDraft((d) => ({ ...d, startDate: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">To Date</label>
              <Input
                type="date"
                value={draft.endDate}
                onChange={(e) => setDraft((d) => ({ ...d, endDate: e.target.value }))}
              />
            </div>

            {/* Vertical */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Vertical</label>
              <SearchSelect
                value={draft.verticalId || ''}
                onChange={(v) =>
                  setDraft((d) => ({
                    ...d,
                    verticalId: Number(v) || 0,
                    // Vertical change resets RM + User (legacy behaviour).
                    reportingManagerId: 0,
                    userId: 0,
                  }))
                }
                options={verticalOptions}
                placeholder="All Verticals"
              />
            </div>

            {/* Reporting Manager */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Reporting Manager
              </label>
              <SearchSelect
                value={draft.reportingManagerId || ''}
                onChange={(v) =>
                  setDraft((d) => ({
                    ...d,
                    reportingManagerId: Number(v) || 0,
                    userId: 0,
                  }))
                }
                options={rmOptions}
                placeholder="All Managers"
              />
            </div>

            {/* Zonal Manager */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Zonal Manager
              </label>
              <SearchSelect
                value={draft.zonalManagerId || ''}
                onChange={(v) => setDraft((d) => ({ ...d, zonalManagerId: Number(v) || 0 }))}
                options={zonalOptions}
                placeholder="All Managers"
              />
            </div>

            {/* User */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">User</label>
              <SearchSelect
                value={draft.userId || ''}
                onChange={(v) => setDraft((d) => ({ ...d, userId: Number(v) || 0 }))}
                options={userOptions}
                placeholder="All Users"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onApply} disabled={primaryLoading}>
              Apply
            </Button>
            <Button variant="outline" onClick={onReset} disabled={primaryLoading}>
              Reset
            </Button>
            <Button variant="outline" onClick={() => setOrgOpen(true)}>
              <Network className="mr-1.5 size-4" /> Org Chart
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        {/* ── Graphical View (colorful charts over the same fetched data) ── */}
        <GraphicalView
          kra={kra.data}
          tiles={openOrders.data?.tiles ?? []}
          cancellation={cancellation.data}
          cancelEnabled={cancelEnabled}
          prodRows={prodRows}
          prodTotal={prod.data?.totalRecords ?? 0}
        />

        {/* ── KRA Metrics tiles ── */}
        <KraTiles kra={kra.data} />

        {/* ── Open-order count cards ── */}
        <OpenOrderCards tiles={openOrders.data?.tiles ?? []} />

        {/* ── Cancellation stats (bars + donut) ── */}
        <CancellationStats
          data={cancellation.data}
          loading={cancellation.loading}
          enabled={cancelEnabled}
        />

        {/* ── Employee Productivity table ── */}
        <ProductivityTable
          rows={prodRows}
          total={prod.data?.totalRecords ?? 0}
          page={page}
          size={size}
          totalPages={prod.data?.totalPages ?? 0}
          onPage={setPage}
          onSize={(s) => setSize(s)}
          loading={prod.loading}
        />
      </div>

      {/* ── Org Chart dialog ── */}
      <Dialog open={orgOpen} onOpenChange={setOrgOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader className="bg-sidebar text-sidebar-foreground">
            <DialogTitle>Organization Chart</DialogTitle>
          </DialogHeader>
          {org.loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" /> Loading…
            </div>
          ) : org.error ? (
            <div className="p-8 text-center text-sm text-red-600">{org.error}</div>
          ) : !org.data ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No Organization Data Found
            </div>
          ) : (
            <div className="max-h-[65vh] overflow-auto p-2">
              <OrgTree node={org.data} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </ReportPageScaffold>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * Graphical View — colorful charts derived (useMemo) entirely from the data
 * the page already fetched. No new API calls. Renders above the KRA tiles +
 * data table. Each block self-guards on empty data.
 * ════════════════════════════════════════════════════════════════════════ */
function GraphicalView({
  kra,
  tiles,
  cancellation,
  cancelEnabled,
  prodRows,
  prodTotal,
}: {
  kra: KraMetrics | null;
  tiles: OpenOrderTile[];
  cancellation: CancellationResponse | null;
  cancelEnabled: boolean;
  prodRows: ProductivityRow[];
  prodTotal: number;
}) {
  /* KPI headline tiles from KRA totals. */
  const revenue = kra ? Math.round(kra.revenue) : null;

  /* Open-order totals → bar chart (one bar per order category). */
  const openOrderBars = useMemo(
    () =>
      tiles
        .map((t) => ({ name: t.title.trim(), count: t.totalCount }))
        .filter((d) => d.name),
    [tiles],
  );
  const openOrderTotal = useMemo(
    () => openOrderBars.reduce((s, d) => s + d.count, 0),
    [openOrderBars],
  );

  /* Cancellation before/after → donut. */
  const cancelDonut = useMemo(() => {
    if (!cancellation) return [];
    const { beforeAllocation, afterAllocation } = cancellation.summary;
    const rows = [
      { name: 'Before Allocation', value: beforeAllocation },
      { name: 'After Allocation', value: afterAllocation },
    ].filter((d) => d.value > 0);
    return rows;
  }, [cancellation]);

  /* Cancellation time buckets → horizontal bar. */
  const cancelBuckets = useMemo(
    () =>
      (cancellation?.bucketData ?? [])
        .map((b) => ({ name: b.timeBucket, jobs: b.totalJobs }))
        .filter((d) => d.name),
    [cancellation],
  );

  /* Employee Productivity (current page) → grouped bar of top performers. */
  const prodBars = useMemo(
    () =>
      [...prodRows]
        .sort((a, b) => b.closedCount - a.closedCount)
        .slice(0, 8)
        .map((r) => ({
          name: r.userName,
          booked: r.booked,
          closed: r.closedCount,
          cancelled: r.cancelCount,
        })),
    [prodRows],
  );

  const hasAnything =
    kra != null ||
    openOrderBars.some((d) => d.count > 0) ||
    cancelDonut.length > 0 ||
    cancelBuckets.length > 0 ||
    prodBars.length > 0;

  if (!hasAnything) return null;

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-slate-800">Graphical View</h2>

      {/* ── KPI tile row ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <QsKpiTile
          label="Revenue"
          value={revenue != null ? revenue.toLocaleString('en-IN') : '—'}
          accent={QS_COLORS[1]}
          icon={<IndianRupee className="size-5" />}
        />
        <QsKpiTile
          label="On-Time Appointment %"
          value={kra?.otaPercentage ?? '—'}
          accent={QS_COLORS[0]}
          icon={<BadgeCheck className="size-5" />}
        />
        <QsKpiTile
          label="Avg TAT (Days)"
          value={kra ? String(kra.avgTat) : '—'}
          accent={QS_COLORS[2]}
          icon={<CalendarClock className="size-5" />}
        />
        <QsKpiTile
          label="Avg Rating"
          value={kra ? String(kra.avgRating) : '—'}
          accent={QS_COLORS[4]}
          icon={<Star className="size-5" />}
        />
      </div>

      {/* ── Charts grid ── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Open orders by category (bar). */}
        {openOrderBars.some((d) => d.count > 0) && (
          <ChartCard
            title="Open Orders By Category"
            subtitle={`${openOrderTotal.toLocaleString('en-IN')} Open Orders Total`}
          >
            <QsBarChart
              data={openOrderBars}
              xKey="name"
              series={[{ key: 'count', label: 'Open Orders', color: QS_COLORS[0] }]}
            />
          </ChartCard>
        )}

        {/* Cancellations before vs after allocation (donut). */}
        {cancelEnabled && cancelDonut.length > 0 && (
          <ChartCard
            title="Cancellations By Allocation"
            subtitle={`${(cancellation?.summary.totalOrderCancelled ?? 0).toLocaleString('en-IN')} Cancelled Total`}
          >
            <QsDonut
              data={cancelDonut}
              nameKey="name"
              valueKey="value"
              colors={[QS_SEMANTIC.good, QS_SEMANTIC.bad]}
            />
          </ChartCard>
        )}

        {/* Cancellations by time bucket (horizontal bar). */}
        {cancelEnabled && cancelBuckets.length > 0 && (
          <ChartCard
            title="Cancellations By Time Bucket"
            subtitle="Days From Booking To Cancellation"
          >
            <QsBarChart
              data={cancelBuckets}
              xKey="name"
              series={[{ key: 'jobs', label: 'Cancelled Jobs', color: QS_SEMANTIC.warn }]}
              layout="vertical"
            />
          </ChartCard>
        )}

        {/* Employee productivity — top performers (grouped bar). */}
        {prodBars.length > 0 && (
          <ChartCard
            title="Top Performers — Booked vs Closed"
            subtitle={`Current Page · ${prodTotal.toLocaleString('en-IN')} Employees Total`}
          >
            <QsBarChart
              data={prodBars}
              xKey="name"
              series={[
                { key: 'booked', label: 'Booked', color: QS_COLORS[0] },
                { key: 'closed', label: 'Closed', color: QS_SEMANTIC.good },
                { key: 'cancelled', label: 'Cancelled', color: QS_SEMANTIC.bad },
              ]}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Charts reflect the current page.
            </p>
          </ChartCard>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * KRA Metrics tile grid (8 tiles).
 * ════════════════════════════════════════════════════════════════════════ */
function KraTiles({ kra }: { kra: KraMetrics | null }) {
  const tiles: { label: string; value: string }[] = [
    { label: 'OTA %', value: kra?.otaPercentage ?? '—' },
    { label: 'SDA %', value: kra?.sdaPercentage ?? '—' },
    { label: 'TAT Days', value: kra ? String(kra.avgTat) : '—' },
    { label: 'Ticket Size', value: kra ? String(kra.avgTicketSize) : '—' },
    { label: 'Margin %', value: kra?.margin ?? '—' },
    { label: 'Rating', value: kra ? String(kra.avgRating) : '—' },
    { label: 'Unconfirmed', value: kra ? String(kra.unconfirmed) : '—' },
    { label: 'Call Later', value: kra ? String(kra.callLater) : '—' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((t) => (
        <Card key={t.label}>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold">{t.value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t.label}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * Open-order count cards (one card per tile, per-bucket badges + total).
 * ════════════════════════════════════════════════════════════════════════ */
const BADGE_CYCLE = [
  'bg-primary/10 text-primary',
  'bg-amber-100 text-amber-700',
  'bg-sky-100 text-sky-700',
  'bg-red-100 text-red-700',
  'bg-slate-100 text-slate-700',
];

function OpenOrderCards({ tiles }: { tiles: OpenOrderTile[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {tiles.map((tile) => (
        <Card key={tile.title}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">{tile.title.trim()}</div>
              <div className="text-lg font-bold">{tile.totalCount}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {tile.buckets.length === 0 ? (
                <span className="text-xs text-muted-foreground">No Data</span>
              ) : (
                tile.buckets.map((b, i) => (
                  <span
                    key={b.label}
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      BADGE_CYCLE[i % BADGE_CYCLE.length]
                    }`}
                  >
                    {b.label}: {b.count}
                  </span>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * Cancellation stats — horizontal bars + before/after donut.
 * ════════════════════════════════════════════════════════════════════════ */
const BAR_COLORS: Record<string, string> = {
  '0-1 days': '#E53935',
  '2-3 days': '#FB8C00',
  '4-5 days': '#FDD835',
  '>5 days': '#43A047',
};

function CancellationStats({
  data,
  loading,
  enabled,
}: {
  data: CancellationResponse | null;
  loading: boolean;
  enabled: boolean;
}) {
  if (!enabled) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Cancellation Stats — select a date range to view.
        </CardContent>
      </Card>
    );
  }
  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading cancellation stats…
        </CardContent>
      </Card>
    );
  }
  const buckets = data?.bucketData ?? [];
  const maxVal = Math.max(1, ...buckets.map((b) => b.totalJobs));
  const before = data?.summary.beforeAllocation ?? 0;
  const after = data?.summary.afterAllocation ?? 0;
  const total = data?.summary.totalOrderCancelled ?? 0;

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {/* Bars */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 text-sm font-semibold">Cancellation Stats</div>
          <div className="space-y-2">
            {buckets.map((b) => (
              <div key={b.timeBucket} className="flex items-center gap-2">
                <div className="w-16 shrink-0 text-xs text-muted-foreground">
                  {b.timeBucket}
                </div>
                <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                  <div
                    className="h-full rounded"
                    style={{
                      width: `${(b.totalJobs / maxVal) * 100}%`,
                      backgroundColor: BAR_COLORS[b.timeBucket] ?? '#94a3b8',
                    }}
                  />
                </div>
                <div className="w-8 shrink-0 text-right text-xs font-medium">
                  {b.totalJobs}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Donut (before / after allocation) */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 text-sm font-semibold">Cancellation By Allocation</div>
          <div className="flex items-center gap-6">
            <Donut after={after} before={before} total={total} />
            <div className="space-y-2 text-sm">
              <LegendRow color="#6366f1" label="After Allocation" value={after} total={total} />
              <LegendRow color="#10b981" label="Before Allocation" value={before} total={total} />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Donut({ after, before, total }: { after: number; before: number; total: number }) {
  const sum = after + before;
  const afterPct = sum > 0 ? (after / sum) * 100 : 0;
  // CSS conic-gradient donut: after (#6366f1) then before (#10b981).
  const bg =
    sum > 0
      ? `conic-gradient(#6366f1 0% ${afterPct}%, #10b981 ${afterPct}% 100%)`
      : 'conic-gradient(#e2e8f0 0% 100%)';
  return (
    <div
      className="relative grid size-28 shrink-0 place-items-center rounded-full"
      style={{ background: bg }}
    >
      <div className="grid size-16 place-items-center rounded-full bg-background text-center">
        <div>
          <div className="text-lg font-bold leading-none">{total}</div>
          <div className="text-[10px] text-muted-foreground">Total</div>
        </div>
      </div>
    </div>
  );
}

function LegendRow({
  color,
  label,
  value,
  total,
}: {
  color: string;
  label: string;
  value: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="size-3 rounded-sm" style={{ backgroundColor: color }} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">
        {value} ({pct}%)
      </span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * Employee Productivity table (paginated, cancelled-badge thresholds).
 * ════════════════════════════════════════════════════════════════════════ */
function cancelledBadgeClass(n: number): string {
  if (n === 0) return 'bg-slate-100 text-slate-600';
  if (n <= 1) return 'bg-emerald-100 text-emerald-700';
  if (n <= 2) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
}

function ProductivityTable({
  rows,
  total,
  page,
  size,
  totalPages,
  onPage,
  onSize,
  loading,
}: {
  rows: ProductivityRow[];
  total: number;
  page: number;
  size: number;
  totalPages: number;
  onPage: (p: number) => void;
  onSize: (s: number) => void;
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 text-sm font-semibold">Employee Productivity</div>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-left">Employee</th>
                <th className="!text-center">Booked</th>
                <th className="!text-center">Scheduled</th>
                <th className="!text-center">Audit</th>
                <th className="!text-center">Closed</th>
                <th className="!text-center">Revenue</th>
                <th className="!text-center">Cancelled</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="!text-center text-muted-foreground">
                    {loading ? 'Loading…' : 'No Data'}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.userId}>
                    <td className="!text-left font-medium">{r.userName}</td>
                    <td className="!text-center">{r.booked}</td>
                    <td className="!text-center">{r.scheduled}</td>
                    <td className="!text-center">{r.audit}</td>
                    <td className="!text-center">{r.closedCount}</td>
                    <td className="!text-center">{Math.round(r.revenue)}</td>
                    <td className="!text-center">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cancelledBadgeClass(
                          r.cancelCount,
                        )}`}
                      >
                        {r.cancelCount}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Rows per page</span>
            <select
              className="rounded border border-border bg-background px-2 py-1"
              value={size}
              onChange={(e) => onSize(Number(e.target.value))}
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground">{total} total</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => onPage(Math.max(1, page - 1))}
              disabled={page <= 1 || loading}
            >
              Prev
            </Button>
            <span className="text-muted-foreground">
              Page {page} / {Math.max(1, totalPages)}
            </span>
            <Button
              variant="outline"
              onClick={() => onPage(page + 1)}
              disabled={page >= totalPages || loading}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * Org-chart tree (recursive indented list).
 * ════════════════════════════════════════════════════════════════════════ */
function OrgTree({ node, depth = 0 }: { node: OrgNode; depth?: number }) {
  return (
    <div>
      <div
        className="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/50"
        style={{ paddingLeft: depth * 18 + 8 }}
      >
        <span className="font-medium">{node.name}</span>
        <span className="text-xs text-muted-foreground">· {node.title}</span>
        {node.teamSize > 0 && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            {node.teamSize}
          </span>
        )}
      </div>
      {node.children.map((c) => (
        <OrgTree key={c.id} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}
