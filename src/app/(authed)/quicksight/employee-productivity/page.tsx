'use client';

/*
 * QuickSight — Employee Productivity (floor discipline).
 *
 * Native rebuild of the legacy Angular `productivity` report. MVP scope per
 * the build spec = the paginated per-employee productivity table + the KRA
 * metrics tile strip. (Dashboard tiles + cancellation bars/donut are a
 * phase-2 follow-up; the BE endpoints already exist for them.)
 *
 * Conventions honoured:
 *   - Fetches ONLY via useFetch / useFetchOnce keyed on the serialized filter
 *     state (mandatory fetch-hooks rule — no raw useEffect+api.get).
 *   - ReportPageScaffold for the header band + the four mutually-exclusive
 *     states. Bespoke cascading filter row (vertical → RM → users) because
 *     these are single-select dependent lookups, not the shared multi-select
 *     QuickSightFilterBar set.
 *   - DownloadButton wired to the BE ?format=xlsx endpoint via downloadXlsx.
 *   - "Copy Data" button replicates the legacy TSV clipboard for parity
 *     (walks all pages at 500/page).
 *   - Page gated on actionFlags(me, [actionKey]); a 403 from the endpoint
 *     surfaces the scaffold's accessDenied panel.
 *   - Title Case labels; .data-table density; numeric columns right-aligned;
 *     Cancelled column rendered as a tone-coded badge.
 *
 * Filter behaviour (legacy parity):
 *   - Appointment Type radio (original|requested) default requested — affects
 *     the dashboard Open-Orders tile only (sent on every request for parity).
 *   - Date Range default Yesterday → Yesterday; NO max-days cap.
 *   - Vertical 0=All; changing it resets Reporting Manager + reloads RM list.
 *   - Reporting Manager 0=All; loads the RM team into Users.
 *   - Zonal Manager 0=All.
 *   - Users 0=All (searchable) — a specific user wins over the RM scope (BE).
 *   - Changing any filter / page-size resets to page 1.
 */

import { useMemo, useState } from 'react';
import { Users, CalendarCheck, CheckCircle2, IndianRupee, XCircle } from 'lucide-react';
import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import {
  ChartCard,
  QsBarChart,
  QsKpiTile,
  QS_COLORS,
  QS_SEMANTIC,
} from '@/components/quicksight/charts';
import { DateRangePopover } from '@/components/ui/date-range-popover';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { Button } from '@/components/ui/button';
import { useFetch, useFetchOnce } from '@/lib/hooks';
import { api } from '@/lib/api';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

const ACTION_KEY = 'isQuickSightEmployeeProductivityView';
const BASE = '/admin/quicksight/employee-productivity';

type AppointmentType = 'original' | 'requested';

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

type KraMetrics = {
  sdaPercentage: string;
  otaPercentage: string;
  avgTat: number;
  avgRating: number;
  margin: string;
  avgTicketSize: number;
  revenue: number;
  unconfirmed: number;
  callLater: number;
};

type Vertical = { vertical_id: number; vertical_name: string };
type ManagerLite = { user_id: number; user_name: string };

/* ── date helpers (Yesterday default; no TZ math beyond local calendar) ── */
function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* Number formatter for the Revenue column ("1,234"). */
function fmtNum(n: number): string {
  return (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

/* Cancelled-count badge tone (legacy: 0 neutral / <=1 success / <=2 warning / else danger). */
function cancelBadgeClass(n: number): string {
  if (n <= 0) return 'bg-muted text-muted-foreground';
  if (n <= 1) return 'bg-emerald-100 text-emerald-700';
  if (n <= 2) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
}

/* Build the shared query string (table JSON + xlsx). page/size appended by caller. */
function buildFilterParams(opts: {
  startDate: string;
  endDate: string;
  verticalId: number;
  reportingManagerId: number;
  zonalManagerId: number;
  userId: number;
  appointmentType: AppointmentType;
}): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set('startDate', opts.startDate);
  qs.set('endDate', opts.endDate);
  qs.set('verticalId', String(opts.verticalId));
  qs.set('reportingManagerId', String(opts.reportingManagerId));
  qs.set('zonalManagerId', String(opts.zonalManagerId));
  qs.set('userId', String(opts.userId));
  qs.set('findByDateType', opts.appointmentType);
  return qs;
}

export default function EmployeeProductivityPage() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY]);
  const canView = flags[ACTION_KEY];

  // ── filter state ──
  const yesterday = useMemo(() => isoDaysAgo(1), []);
  const [startDate, setStartDate] = useState(yesterday);
  const [endDate, setEndDate] = useState(yesterday);
  const [appointmentType, setAppointmentType] = useState<AppointmentType>('requested');
  const [verticalId, setVerticalId] = useState(0);
  const [reportingManagerId, setReportingManagerId] = useState(0);
  const [zonalManagerId, setZonalManagerId] = useState(0);
  const [userId, setUserId] = useState(0);

  const [page, setPage] = useState(0); // 0-indexed (TablePagination contract)
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  const [downloading, setDownloading] = useState(false);
  const [copying, setCopying] = useState(false);

  // ── static + dependent lookups (fetch-hooks only) ──
  const verticalsRes = useFetchOnce<Vertical[]>('/shared/lookup/verticals');
  const zonalRes = useFetchOnce<ManagerLite[]>('/shared/lookup/zonal-managers');

  // Reporting Managers — reload when vertical changes (key includes verticalId).
  const rmRes = useFetch<ManagerLite[]>(
    canView ? `${BASE}/reporting-managers?verticalId=${verticalId}` : null,
  );
  // Users — reload when vertical OR RM changes.
  const usersRes = useFetch<ManagerLite[]>(
    canView ? `${BASE}/rm-team-users?verticalId=${verticalId}&reportingManagerId=${reportingManagerId}` : null,
  );

  const verticalOptions = useMemo<SearchOption[]>(
    () => [
      { value: 0, label: 'All Verticals' },
      ...(verticalsRes.data ?? []).map((v) => ({ value: v.vertical_id, label: v.vertical_name })),
    ],
    [verticalsRes.data],
  );
  const zonalOptions = useMemo<SearchOption[]>(
    () => [
      { value: 0, label: 'All Zonal Managers' },
      ...(zonalRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    ],
    [zonalRes.data],
  );
  const rmOptions = useMemo<SearchOption[]>(
    () => [
      { value: 0, label: 'All Reporting Managers' },
      ...(rmRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    ],
    [rmRes.data],
  );
  const userOptions = useMemo<SearchOption[]>(
    () => [
      { value: 0, label: 'All Users' },
      ...(usersRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    ],
    [usersRes.data],
  );

  // ── main table fetch — keyed on the full serialized filter + page state ──
  const tableQuery = useMemo(() => {
    const qs = buildFilterParams({
      startDate, endDate, verticalId, reportingManagerId, zonalManagerId, userId, appointmentType,
    });
    qs.set('page', String(page + 1)); // BE is 1-indexed
    qs.set('size', String(pageSizeToLimit(pageSize, 500)));
    return qs.toString();
  }, [startDate, endDate, verticalId, reportingManagerId, zonalManagerId, userId, appointmentType, page, pageSize]);

  const tableKey = canView ? `${BASE}/employee-productivity?${tableQuery}` : null;
  const { data: tableData, loading: tableLoading, error: tableError } = useFetch<ProductivityResponse>(tableKey);

  // ── KRA metrics fetch — keyed on the filter state (no pagination) ──
  const kraQuery = useMemo(
    () => buildFilterParams({
      startDate, endDate, verticalId, reportingManagerId, zonalManagerId, userId, appointmentType,
    }).toString(),
    [startDate, endDate, verticalId, reportingManagerId, zonalManagerId, userId, appointmentType],
  );
  const kraKey = canView ? `${BASE}/kra-metrics?${kraQuery}` : null;
  const { data: kra } = useFetch<KraMetrics>(kraKey);

  const rows = tableData?.data ?? [];
  const total = tableData?.totalRecords ?? 0;

  /* ── Chart transforms (derived from the SAME page rows — no new fetch) ──
   * The table is server-paginated, so charts reflect the CURRENT page slice.
   * A muted note is rendered alongside the Graphical View to make that clear. */

  // Page-level aggregate KPIs (sum across the current page's rows).
  const pageTotals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.booked += r.booked ?? 0;
        acc.scheduled += r.scheduled ?? 0;
        acc.closed += r.closedCount ?? 0;
        acc.revenue += r.revenue ?? 0;
        acc.cancelled += r.cancelCount ?? 0;
        return acc;
      },
      { booked: 0, scheduled: 0, closed: 0, revenue: 0, cancelled: 0 },
    );
  }, [rows]);

  // Top employees by activity (booked + scheduled + closed), capped for legibility.
  const TOP_N = 10;
  const activityByEmployee = useMemo(() => {
    return [...rows]
      .map((r) => ({
        name: r.userName || '—',
        booked: r.booked ?? 0,
        scheduled: r.scheduled ?? 0,
        closed: r.closedCount ?? 0,
      }))
      .sort(
        (a, b) =>
          b.booked + b.scheduled + b.closed - (a.booked + a.scheduled + a.closed),
      )
      .slice(0, TOP_N);
  }, [rows]);

  // Top employees by revenue (horizontal bars read best for a single ranked metric).
  const revenueByEmployee = useMemo(() => {
    return [...rows]
      .filter((r) => (r.revenue ?? 0) > 0)
      .map((r) => ({ name: r.userName || '—', revenue: r.revenue ?? 0 }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, TOP_N);
  }, [rows]);

  const hasCharts = rows.length > 0;

  // 403 → access panel. useFetch flattens the error to a string.
  const accessDenied =
    !canView ||
    (!!tableError && /permission|quicksight access|access denied/i.test(tableError));
  const genericError = tableError && !accessDenied ? tableError : null;
  const isEmpty = !tableLoading && !genericError && !accessDenied && rows.length === 0;

  /* Reset to page 1 on any filter change. */
  function onFilterChange<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setPage(0); };
  }
  // Vertical change also resets the dependent RM filter (legacy behaviour).
  function changeVertical(v: number) {
    setVerticalId(v);
    setReportingManagerId(0);
    setUserId(0);
    setPage(0);
  }
  // RM change resets the dependent Users filter.
  function changeReportingManager(v: number) {
    setReportingManagerId(v);
    setUserId(0);
    setPage(0);
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      const qs = buildFilterParams({
        startDate, endDate, verticalId, reportingManagerId, zonalManagerId, userId, appointmentType,
      });
      qs.set('page', String(page + 1));
      qs.set('size', String(pageSizeToLimit(pageSize, 500)));
      qs.set('format', 'xlsx');
      await downloadXlsx({
        url: `${BASE}/employee-productivity?${qs.toString()}`,
        filename: `employee-productivity-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
    } catch {
      // eslint-disable-next-line no-alert
      alert('Could not download the report. Please retry.');
    } finally {
      setDownloading(false);
    }
  }

  /* Copy Data — legacy parity. Walks ALL pages at 500/page and copies a TSV
   * with the canonical header. */
  async function handleCopy() {
    setCopying(true);
    try {
      const header = ['Employee', 'Booked', 'Scheduled', 'Audit', 'Closed', 'Revenue', 'Cancelled'];
      const all: ProductivityRow[] = [];
      let pageNo = 1;
      // Cap the walk at a generous number of pages to avoid runaway loops.
      for (let guard = 0; guard < 200; guard++) {
        const qs = buildFilterParams({
          startDate, endDate, verticalId, reportingManagerId, zonalManagerId, userId, appointmentType,
        });
        qs.set('page', String(pageNo));
        qs.set('size', '500');
        const res = await api.get<ProductivityResponse>(`${BASE}/employee-productivity?${qs.toString()}`);
        all.push(...res.data);
        if (pageNo >= res.totalPages || res.data.length === 0) break;
        pageNo += 1;
      }
      const lines = [header.join('\t')];
      for (const r of all) {
        lines.push([r.userName, r.booked, r.scheduled, r.audit, r.closedCount, r.revenue, r.cancelCount].join('\t'));
      }
      const text = lines.join('\n');
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        // eslint-disable-next-line no-alert
        alert('Employee productivity data copied to clipboard');
      }
    } catch {
      // eslint-disable-next-line no-alert
      alert('Could not copy the data. Please retry.');
    } finally {
      setCopying(false);
    }
  }

  const filters = (
    <div className="space-y-3">
      {/* Appointment Type radio + Copy Data */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <span className="text-xs font-medium text-muted-foreground">Appointment Type</span>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="appointmentType"
              checked={appointmentType === 'requested'}
              onChange={() => onFilterChange<AppointmentType>(setAppointmentType)('requested')}
            />
            Requested
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="appointmentType"
              checked={appointmentType === 'original'}
              onChange={() => onFilterChange<AppointmentType>(setAppointmentType)('original')}
            />
            Original
          </label>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          disabled={copying || tableLoading || rows.length === 0}
          title={rows.length === 0 ? 'No rows to copy' : undefined}
        >
          {copying ? 'Copying…' : 'Copy Data'}
        </Button>
      </div>

      {/* Filter grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Date Range</label>
          <DateRangePopover
            from={startDate}
            to={endDate}
            onChange={({ from, to }) => { setStartDate(from); setEndDate(to); setPage(0); }}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Vertical</label>
          <SearchSelect
            value={verticalId}
            onChange={(v) => changeVertical(Number(v) || 0)}
            options={verticalOptions}
            placeholder="All Verticals"
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Reporting Manager</label>
          <SearchSelect
            value={reportingManagerId}
            onChange={(v) => changeReportingManager(Number(v) || 0)}
            options={rmOptions}
            placeholder="All Reporting Managers"
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Zonal Manager</label>
          <SearchSelect
            value={zonalManagerId}
            onChange={(v) => onFilterChange<number>(setZonalManagerId)(Number(v) || 0)}
            options={zonalOptions}
            placeholder="All Zonal Managers"
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Users</label>
          <SearchSelect
            value={userId}
            onChange={(v) => onFilterChange<number>(setUserId)(Number(v) || 0)}
            options={userOptions}
            placeholder="All Users"
            required
          />
        </div>
      </div>
    </div>
  );

  return (
    <ReportPageScaffold
      title="Employee Productivity"
      subtitle="CRM-user activity and productivity roll-up."
      icon={Users}
      filters={filters}
      loading={tableLoading}
      error={genericError}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={handleDownload}
      downloading={downloading}
    >
      <div className="space-y-4">
        {/* KRA tile strip */}
        {kra && <KraTiles kra={kra} />}

        {/* Graphical View — derived from the current page of rows. */}
        {hasCharts && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800">Graphical View</h2>
              <span className="text-xs text-muted-foreground">Charts reflect the current page.</span>
            </div>

            {/* Aggregate KPI row (sum of the current page). */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <QsKpiTile
                label="Booked"
                value={fmtNum(pageTotals.booked)}
                accent={QS_COLORS[0]}
                icon={<CalendarCheck className="h-5 w-5" />}
              />
              <QsKpiTile
                label="Closed"
                value={fmtNum(pageTotals.closed)}
                accent={QS_SEMANTIC.good}
                icon={<CheckCircle2 className="h-5 w-5" />}
              />
              <QsKpiTile
                label="Revenue"
                value={fmtNum(pageTotals.revenue)}
                accent={QS_COLORS[2]}
                icon={<IndianRupee className="h-5 w-5" />}
              />
              <QsKpiTile
                label="Cancelled"
                value={fmtNum(pageTotals.cancelled)}
                accent={QS_SEMANTIC.bad}
                icon={<XCircle className="h-5 w-5" />}
              />
            </div>

            {/* Charts grid. */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <ChartCard
                title="Activity By Employee"
                subtitle={`Top ${Math.min(TOP_N, activityByEmployee.length)} by Booked + Scheduled + Closed`}
              >
                <QsBarChart
                  data={activityByEmployee}
                  xKey="name"
                  series={[
                    { key: 'booked', label: 'Booked', color: QS_COLORS[0] },
                    { key: 'scheduled', label: 'Scheduled', color: QS_COLORS[4] },
                    { key: 'closed', label: 'Closed', color: QS_SEMANTIC.good },
                  ]}
                />
              </ChartCard>

              <ChartCard
                title="Revenue By Employee"
                subtitle={`Top ${Math.min(TOP_N, revenueByEmployee.length)} by Revenue`}
              >
                {revenueByEmployee.length > 0 ? (
                  <QsBarChart
                    data={revenueByEmployee}
                    xKey="name"
                    layout="vertical"
                    series={[{ key: 'revenue', label: 'Revenue', color: QS_COLORS[2] }]}
                  />
                ) : (
                  <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                    No Revenue On This Page
                  </div>
                )}
              </ChartCard>
            </div>
          </section>
        )}

        {/* Productivity table */}
        <div className="overflow-x-auto rounded-md border">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">Employee</th>
                <th className="!text-right">Booked</th>
                <th className="!text-right">Scheduled</th>
                <th className="!text-right">Audit</th>
                <th className="!text-right">Closed</th>
                <th className="!text-right">Revenue</th>
                <th className="!text-center">Cancelled</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId}>
                  <td className="!text-left">{r.userName || '—'}</td>
                  <td className="!text-right tabular-nums">{r.booked}</td>
                  <td className="!text-right tabular-nums">{r.scheduled}</td>
                  <td className="!text-right tabular-nums">{r.audit}</td>
                  <td className="!text-right tabular-nums">{r.closedCount}</td>
                  <td className="!text-right tabular-nums">{fmtNum(r.revenue)}</td>
                  <td className="!text-center">
                    <span className={`inline-flex min-w-6 justify-center rounded-full px-2 py-0.5 text-xs font-medium ${cancelBadgeClass(r.cancelCount)}`}>
                      {r.cancelCount}
                    </span>
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
          onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
        />
      </div>
    </ReportPageScaffold>
  );
}

/* KRA metric tile strip — 8 tiles per spec (OTA / SDA / Avg TAT (Days) /
 * Avg Ticket Size / Margin / Avg Rating / Unconfirmed / Call Later). */
function KraTiles({ kra }: { kra: KraMetrics }) {
  const tiles: Array<{ label: string; value: string }> = [
    { label: 'OTA', value: kra.otaPercentage },
    { label: 'SDA', value: kra.sdaPercentage },
    { label: 'Avg TAT (Days)', value: String(kra.avgTat) },
    { label: 'Avg Ticket Size', value: fmtNum(kra.avgTicketSize) },
    { label: 'Margin', value: kra.margin },
    { label: 'Avg Rating', value: String(kra.avgRating) },
    { label: 'Unconfirmed', value: String(kra.unconfirmed) },
    { label: 'Call Later', value: String(kra.callLater) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-md border bg-card p-3 text-center">
          <div className="text-lg font-semibold tabular-nums">{t.value}</div>
          <div className="text-xs text-muted-foreground">{t.label}</div>
        </div>
      ))}
    </div>
  );
}
