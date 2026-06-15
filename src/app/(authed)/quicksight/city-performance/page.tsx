'use client';

/*
 * QuickSight — City Performance (monthly / weekly).
 *
 * Native rebuild of the legacy Angular `cityperformance` report. A 3-period
 * (last 3 months OR last 3 weeks) per-city scorecard: each city row shows, per
 * period, 4 metrics — Ticket Created · SDA% · TAT% · Open Orders. Above the
 * table sits a TAT-summary highlights widget (cities meeting TAT >= 85 vs < 85)
 * the operator steps through period-by-period.
 *
 * Powered by TWO BE endpoints sharing the same flag + filter state:
 *   GET /admin/quicksight/city-performance            → paginated table
 *   GET /admin/quicksight/city-performance/tat-summary → highlights widget
 *
 * Conventions honoured:
 *   - Fetches ONLY via useFetch keyed on the serialized filter/flag/page state
 *     (mandatory fetch-hooks rule — no raw useEffect+api.get).
 *   - ReportPageScaffold for the header band + the four mutually-exclusive
 *     states; QuickSightFilterBar for the multi-select filters.
 *   - DownloadButton wired to the BE ?format=xlsx endpoint via downloadXlsx.
 *   - Page gated on actionFlags(me, [actionKey]); a 403 from the endpoint
 *     surfaces the scaffold's accessDenied panel.
 *   - Title Case labels; .data-table density; numeric columns right-aligned.
 *   - NO City filter (legacy hides it; the endpoint ignores cityId). NO Project
 *     Manager filter (commented out in legacy; the table endpoint would accept
 *     it but the UI never exposed it). NO date pickers (window is implicit).
 *   - The tat-summary widget deliberately ignores Vertical (legacy asymmetry):
 *     vertical affects the TABLE only, so the widget refetch drops verticalId.
 */

import { useMemo, useState } from 'react';
import { Building2, ChevronLeft, ChevronRight } from 'lucide-react';
import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QuickSightFilterBar } from '@/components/quicksight/QuickSightFilterBar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { TablePagination, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';
import { useFetch, useFetchOnce } from '@/lib/hooks';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import type { SearchOption } from '@/components/ui/search-select';

const ACTION_KEY = 'isQuickSightCityPerformanceView';

// Max pageSize the BE Joi schema accepts (city-performance.js tableSchema).
const PAGE_SIZE_MAX = 200;

type Flag = 'monthly' | 'weekly';

type CityPeriod = {
  detailsFor: string; // "JUNE" (monthly) | "Week 1" (weekly)
  startDate: string;
  endDate: string;
  cityTktCreated: number;
  cityOpenOrders: number;
  processJobs: number;
  citySdaCount: number;
  citySdaPercentage: number | null;
  cityTatPercentage: number | null;
};

type CityRow = {
  cityId: number | null;
  cityName: string;
  stateId: number | null;
  stateName: string;
  cityPerformanceDataDateWise: CityPeriod[];
};

type CityPerformancePayload = {
  data: CityRow[];
  page: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
};

type TatSummary = {
  summaryOf: string;
  startDate: string;
  endDate: string;
  tatMoreThan85: number;
  tatLessThan85: number;
  tatMoreThan85Percentage: number | null;
  tatLessThan85Percentage: number | null;
  failedOrders: number;
  failedOrderPercentage: number;
};

type TatSummaryPayload = { periodSummaries: TatSummary[] };

type ManagerLite = { user_id: number; user_name: string };

/* Date-only formatter for weekly headers ("Jun 7, 2026"). Monthly periods use
 * the month name (detailsFor) directly. */
function fmtDateOnly(iso: string): string {
  const d = new Date(`${iso}T00:00:00+05:30`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
}

/* Group header: month name as-is (monthly); formatted week range (weekly). */
function periodHeader(p: { detailsFor: string; startDate: string; endDate: string }, flag: Flag): string {
  if (flag === 'monthly') return p.detailsFor;
  return `${fmtDateOnly(p.startDate)} - ${fmtDateOnly(p.endDate)}`;
}

/* Build the shared filter query string for the TABLE endpoint (all filters). */
function buildTableQuery(
  flag: Flag,
  page: number,
  pageSize: number,
  clients: Array<string | number>,
  verticals: Array<string | number>,
  serviceCategories: Array<string | number>,
  zonalManagers: Array<string | number>,
): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set('flag', flag);
  qs.set('page', String(page));
  qs.set('pageSize', String(pageSize));
  clients.forEach((v) => qs.append('clientId', String(v)));
  verticals.forEach((v) => qs.append('verticalId', String(v)));
  serviceCategories.forEach((v) => qs.append('serviceCategoryId', String(v)));
  zonalManagers.forEach((v) => qs.append('zonalManagerId', String(v)));
  return qs;
}

/* TAT-summary query — NO verticalId (legacy asymmetry), NO pagination. */
function buildSummaryQuery(
  flag: Flag,
  clients: Array<string | number>,
  serviceCategories: Array<string | number>,
  zonalManagers: Array<string | number>,
): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set('flag', flag);
  clients.forEach((v) => qs.append('clientId', String(v)));
  serviceCategories.forEach((v) => qs.append('serviceCategoryId', String(v)));
  zonalManagers.forEach((v) => qs.append('zonalManagerId', String(v)));
  return qs;
}

const METRIC_HEADERS = ['Ticket Created', 'SDA%', 'TAT%', 'Open Orders'] as const;

export default function CityPerformancePage() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY]);
  const canView = flags[ACTION_KEY];

  const [flag, setFlag] = useState<Flag>('monthly');
  const [clients, setClients] = useState<Array<string | number>>([]);
  const [verticals, setVerticals] = useState<Array<string | number>>([]);
  const [serviceCategories, setServiceCategories] = useState<Array<string | number>>([]);
  const [zonalManagers, setZonalManagers] = useState<Array<string | number>>([]);
  // stateId is a first-class filter for this report — sourced from the shared
  // states lookup (not in QuickSightFilterBar, so injected as an extra row).
  const [states, setStates] = useState<Array<string | number>>([]);
  const [page, setPage] = useState(0); // 0-indexed (TablePagination convention)
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  const [downloading, setDownloading] = useState(false);
  const [tatIndex, setTatIndex] = useState(0); // highlights stepper position

  // Zonal Managers + State options aren't in useLookup — pull from shared
  // lookup endpoints (fired once; static for the session).
  const zonalRes = useFetchOnce<ManagerLite[]>('/shared/lookup/zonal-managers');
  const stateRes = useFetchOnce<Array<{ state_id: number; state_name: string }>>('/shared/lookup/states');

  const zonalManagerOptions = useMemo<SearchOption[]>(
    () => (zonalRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [zonalRes.data],
  );
  const stateOptions = useMemo<SearchOption[]>(
    () => (stateRes.data ?? []).map((s) => ({ value: s.state_id, label: s.state_name })),
    [stateRes.data],
  );

  const limit = pageSizeToLimit(pageSize, PAGE_SIZE_MAX);

  // Table fetch — keyed on flag + every serialized filter + page/size.
  const tableQuery = useMemo(
    () => buildTableQuery(flag, page + 1, limit, clients, verticals, serviceCategories, zonalManagers).toString(),
    [flag, page, limit, clients, verticals, serviceCategories, zonalManagers],
  );
  // stateId appended separately so the key still changes when states change.
  const stateQs = useMemo(() => states.map((v) => `stateId=${v}`).join('&'), [states]);
  const tableKey = canView
    ? `/admin/quicksight/city-performance?${tableQuery}${stateQs ? `&${stateQs}` : ''}`
    : null;

  const { data: tableData, loading: tableLoading, error: tableError } =
    useFetch<CityPerformancePayload>(tableKey);

  // Highlights fetch — flag + the 3 filters the widget honours (NO vertical).
  const summaryQuery = useMemo(
    () => buildSummaryQuery(flag, clients, serviceCategories, zonalManagers).toString(),
    [flag, clients, serviceCategories, zonalManagers],
  );
  const summaryStateQs = stateQs; // same stateId selection
  const summaryKey = canView
    ? `/admin/quicksight/city-performance/tat-summary?${summaryQuery}${summaryStateQs ? `&${summaryStateQs}` : ''}`
    : null;

  const { data: summaryData } = useFetch<TatSummaryPayload>(summaryKey);

  const payload = tableData;
  const rows = payload?.data ?? [];
  const totalRecords = payload?.totalRecords ?? 0;
  const summaries = summaryData?.periodSummaries ?? [];

  // Period group headers (3 blocks) derived from the first row's periods.
  const periodHeaders = useMemo(() => {
    const sample = rows[0]?.cityPerformanceDataDateWise ?? [];
    return sample.map((p) => periodHeader(p, flag));
  }, [rows, flag]);

  // 403 → access panel. useFetch flattens the error to a string; the BE 403
  // messages all imply a denial. The static permission gate counts too.
  const accessDenied =
    !canView ||
    (!!tableError && /permission|quicksight access|access denied/i.test(tableError));

  const genericError = tableError && !accessDenied ? tableError : null;

  // The BE returns a synthetic "No city" row (totalRecords=0) when there are no
  // matching cities; treat totalRecords===0 as empty (parity with legacy
  // noData1 gate) so the scaffold shows its empty panel.
  const isEmpty = !tableLoading && !genericError && !accessDenied && totalRecords === 0;

  async function handleDownload() {
    setDownloading(true);
    try {
      const qs = buildTableQuery(flag, 1, limit, clients, verticals, serviceCategories, zonalManagers);
      states.forEach((v) => qs.append('stateId', String(v)));
      qs.set('format', 'xlsx');
      await downloadXlsx({
        url: `/admin/quicksight/city-performance?${qs.toString()}`,
        filename: `city-performance-${flag}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
    } catch {
      // eslint-disable-next-line no-alert
      alert('Could not download the report. Please retry.');
    } finally {
      setDownloading(false);
    }
  }

  // Reset to page 0 + highlights step 0 whenever a filter or the tab changes.
  function resetView() {
    setPage(0);
    setTatIndex(0);
  }

  const filters = (
    <div className="space-y-3">
      <Tabs
        value={flag}
        onValueChange={(v) => { setFlag(v as Flag); resetView(); }}
      >
        <TabsList>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
          <TabsTrigger value="weekly">Weekly</TabsTrigger>
        </TabsList>
      </Tabs>

      <StateFilter
        value={states}
        options={stateOptions}
        onChange={(v) => { setStates(v); resetView(); }}
        disabled={tableLoading}
      />

      <QuickSightFilterBar
        show={{
          clients: true,
          verticals: true,
          serviceCategories: true,
          zonalManagers: true,
        }}
        clients={clients}
        onClientsChange={(v) => { setClients(v); resetView(); }}
        verticals={verticals}
        onVerticalsChange={(v) => { setVerticals(v); resetView(); }}
        serviceCategories={serviceCategories}
        onServiceCategoriesChange={(v) => { setServiceCategories(v); resetView(); }}
        zonalManagers={zonalManagers}
        onZonalManagersChange={(v) => { setZonalManagers(v); resetView(); }}
        zonalManagerOptions={zonalManagerOptions}
        disabled={tableLoading}
      />
    </div>
  );

  return (
    <ReportPageScaffold
      title="City Performance"
      subtitle="Monthly / weekly per-city scorecard — Ticket Created, SDA%, TAT% and Open Orders."
      icon={Building2}
      filters={filters}
      loading={tableLoading}
      error={genericError}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={handleDownload}
      downloading={downloading}
    >
      <div className="space-y-4">
        <TatHighlights
          summaries={summaries}
          flag={flag}
          index={tatIndex}
          onStep={setTatIndex}
        />

        <div className="overflow-x-auto rounded-md border">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th rowSpan={2} className="!text-left sticky left-0 z-10 bg-muted">State Name</th>
                <th rowSpan={2} className="!text-left">City Name</th>
                {periodHeaders.map((lbl, i) => (
                  <th key={i} colSpan={METRIC_HEADERS.length} className="!text-center border-l">
                    {lbl}
                  </th>
                ))}
              </tr>
              <tr>
                {periodHeaders.map((_, i) =>
                  METRIC_HEADERS.map((h, j) => (
                    <th
                      key={`${i}-${j}`}
                      className={`!text-right whitespace-nowrap ${j === 0 ? 'border-l' : ''}`}
                    >
                      {h}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={row.cityId ?? `synthetic-${idx}`}>
                  <td className="!text-left sticky left-0 z-10 bg-background">{row.stateName || '—'}</td>
                  <td className="!text-left">{row.cityName || '—'}</td>
                  {row.cityPerformanceDataDateWise.map((p, i) => (
                    <PeriodCells key={i} p={p} firstOfBlock />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <TablePagination
          page={page}
          pageSize={pageSize}
          total={totalRecords}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
        />
      </div>
    </ReportPageScaffold>
  );
}

/* The 4 numeric cells for one period block. SDA%/TAT% render '-' when null,
 * green when >= 85, red when < 85. Open Orders cell forced amber + bold
 * (legacy #f2bd5d). `firstOfBlock` adds the left border so the blocks read
 * apart. Field order matches the on-screen header: Ticket Created, SDA%, TAT%,
 * Open Orders. */
function PeriodCells({ p, firstOfBlock }: { p: CityPeriod; firstOfBlock?: boolean }) {
  const base = '!text-right whitespace-nowrap';
  return (
    <>
      <td className={`${base} ${firstOfBlock ? 'border-l' : ''}`}>{p.cityTktCreated}</td>
      <td className={`${base} ${pctClass(p.citySdaPercentage)}`}>{pctText(p.citySdaPercentage)}</td>
      <td className={`${base} ${pctClass(p.cityTatPercentage)}`}>{pctText(p.cityTatPercentage)}</td>
      <td className={`${base} font-bold`} style={{ backgroundColor: '#f2bd5d' }}>{p.cityOpenOrders}</td>
    </>
  );
}

function pctText(v: number | null): string {
  return v == null ? '-' : `${v}%`;
}
function pctClass(v: number | null): string {
  if (v == null) return '';
  return v >= 85 ? 'text-green-700 font-medium' : 'text-red-700 font-medium';
}

/* The State filter is not part of QuickSightFilterBar (which only DRYs the
 * client/vertical/category/zonal/PM set), so it gets its own labelled row
 * matching the bar's grid layout + Title-Case label treatment. */
function StateFilter({
  value,
  options,
  onChange,
  disabled,
}: {
  value: Array<string | number>;
  options: SearchOption[];
  onChange: (next: Array<string | number>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">State Name</label>
        <SearchMultiSelect
          value={value}
          onChange={onChange}
          options={options}
          placeholder="All States"
          selectedLabel="states"
          disabled={disabled}
        />
      </div>
    </div>
  );
}

/* TAT highlights widget — steps through the 3 period summaries. Each period
 * shows "X% (n) TAT >= 85" (green dot) and "Y% (m) TAT < 85" (red dot). Header
 * is the month label (monthly) or the formatted week range (weekly). Only
 * renders when there is at least one period summary (legacy getDoughnut gate).
 */
function TatHighlights({
  summaries,
  flag,
  index,
  onStep,
}: {
  summaries: TatSummary[];
  flag: Flag;
  index: number;
  onStep: (next: number) => void;
}) {
  if (summaries.length === 0) return null;
  const safeIndex = Math.min(Math.max(index, 0), summaries.length - 1);
  const s = summaries[safeIndex];
  // TatSummary names the period field `summaryOf` (vs CityPeriod's `detailsFor`);
  // adapt to the shared periodHeader contract.
  const header = periodHeader({ detailsFor: s.summaryOf, startDate: s.startDate, endDate: s.endDate }, flag);

  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-4">
        <button
          type="button"
          aria-label="Previous period"
          disabled={safeIndex <= 0}
          onClick={() => onStep(safeIndex - 1)}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="size-4" />
        </button>

        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">TAT — {header}</div>
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <span className="inline-flex items-center gap-2">
              <span className="size-2.5 rounded-full bg-green-600" />
              <span className="font-medium">{s.tatMoreThan85Percentage ?? 0}%</span>
              <span className="text-muted-foreground">({s.tatMoreThan85}) TAT &gt;= 85</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="size-2.5 rounded-full bg-red-600" />
              <span className="font-medium">{s.tatLessThan85Percentage ?? 0}%</span>
              <span className="text-muted-foreground">({s.tatLessThan85}) TAT &lt; 85</span>
            </span>
          </div>
        </div>

        <div className="text-xs text-muted-foreground tabular-nums">
          {safeIndex + 1} / {summaries.length}
        </div>

        <button
          type="button"
          aria-label="Next period"
          disabled={safeIndex >= summaries.length - 1}
          onClick={() => onStep(safeIndex + 1)}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronRight className="size-4" />
        </button>
      </CardContent>
    </Card>
  );
}
