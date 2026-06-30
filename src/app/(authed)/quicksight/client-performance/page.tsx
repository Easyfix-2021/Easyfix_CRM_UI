'use client';

/*
 * QuickSight — Client Performance (monthly / weekly).
 *
 * Native rebuild of the legacy Angular `performance` report. One row per
 * client (grouped by Project Manager via rowspan), with 3 period column-
 * blocks of 7 metrics each: Tkt Received · Enq% · Canc Post Allocation ·
 * Avg Tkt Size · Revenue · TAT · ESC%.
 *
 * Conventions honoured:
 *   - Fetches ONLY via useFetch keyed on the serialized filter/period state
 *     (mandatory fetch-hooks rule — no raw useEffect+api.get).
 *   - ReportPageScaffold for the header band + the four mutually-exclusive
 *     states; QuickSightFilterBar for the multi-select filters.
 *   - DownloadButton wired to the BE ?format=xlsx endpoint via downloadXlsx.
 *   - "Copy Data" button replicates the legacy TSV clipboard for parity.
 *   - Page gated on actionFlags(me, [actionKey]); a 403 from the endpoint
 *     surfaces the scaffold's accessDenied panel.
 *   - CORRECTED legacy header/field alignment (Copy-Data canonical intent),
 *     NOT the legacy display bug.
 *   - Title Case labels; .data-table density; numeric columns right-aligned.
 */

import { useEffect, useMemo, useState } from 'react';
import { Gauge, Ticket, IndianRupee, Receipt, Users } from 'lucide-react';
import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QuickSightFilterBar } from '@/components/quicksight/QuickSightFilterBar';
import {
  ChartCard,
  QsBarChart,
  QsLineChart,
  QsKpiTile,
  QS_COLORS,
  QS_SEMANTIC,
} from '@/components/quicksight/charts';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/ui/toast';
import { useFetch } from '@/lib/hooks';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import type { SearchOption } from '@/components/ui/search-select';

const ACTION_KEY = 'isQuickSightClientPerformanceView';

type Period = 'monthly' | 'weekly';

type PeriodBucket = {
  label: string;
  week: string | null;
  month: string | null;
  startDate: string;
  endDate: string;
  ticketCreated: number;
  enquiryPercentage: number;
  cancellationAfterAllocation: number;
  averageTicketSize: number;
  sumOfTotalCharge: number;
  averageTat: number;
  escalationPercentage: number;
};

type ClientPerfRow = {
  clientId: number;
  clientName: string;
  projectManager: string;
  periods: PeriodBucket[];
};

type ManagerLite = { user_id: number; user_name: string };

/* Date-only formatter for weekly period headers ("Jun 1, 2026"); the BE
 * returns weekly labels as "YYYY-MM-DD - YYYY-MM-DD". Monthly labels are the
 * month name and pass through untouched. */
function fmtDateOnly(iso: string): string {
  const d = new Date(`${iso}T00:00:00+05:30`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
}

/* Compact Indian-locale number for KPI tiles (₹1,23,456 / 1,234). */
function fmtInt(n: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n));
}

/* Render a period header: month name as-is; week range with formatted dates. */
function periodHeader(p: PeriodBucket, period: Period): string {
  if (period === 'monthly') return p.month ?? p.label;
  return `${fmtDateOnly(p.startDate)} - ${fmtDateOnly(p.endDate)}`;
}

/* Build the query string shared by the JSON fetch + the xlsx download. */
function buildQuery(
  period: Period,
  clients: Array<string | number>,
  verticals: Array<string | number>,
  serviceCategories: Array<string | number>,
  zonalManagers: Array<string | number>,
  projectManagers: Array<string | number>,
): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set('period', period);
  clients.forEach((v) => qs.append('clientId', String(v)));
  verticals.forEach((v) => qs.append('verticalId', String(v)));
  serviceCategories.forEach((v) => qs.append('serviceCategoryId', String(v)));
  zonalManagers.forEach((v) => qs.append('zonalManagerId', String(v)));
  projectManagers.forEach((v) => qs.append('projectManagerId', String(v)));
  return qs;
}

const METRIC_HEADERS = [
  'Tkt Received',
  'Enq%',
  'Canc Post Allocation',
  'Avg Tkt Size',
  'Revenue',
  'TAT',
  'ESC%',
] as const;

export default function ClientPerformancePage() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY]);
  const canView = flags[ACTION_KEY];

  const [period, setPeriod] = useState<Period>('monthly');
  const [clients, setClients] = useState<Array<string | number>>([]);
  const [verticals, setVerticals] = useState<Array<string | number>>([]);
  const [serviceCategories, setServiceCategories] = useState<Array<string | number>>([]);
  const [zonalManagers, setZonalManagers] = useState<Array<string | number>>([]);
  const [projectManagers, setProjectManagers] = useState<Array<string | number>>([]);
  const [downloading, setDownloading] = useState(false);

  // Zonal + Project Manager options aren't in useLookup — pull from the shared
  // lookup endpoints, SCOPED to the selected Client/Vertical so each picker
  // narrows to owners relevant to that client/vertical (refetch on change;
  // unfiltered ⇒ full global lists). Zonal = owners of cities backing the
  // client/vertical's jobs; PM = user_type=1 (Primary SPOC) on that mapping.
  const ownerScopeQs = useMemo(() => {
    const qs = new URLSearchParams();
    clients.forEach((v) => qs.append('clientId', String(v)));
    verticals.forEach((v) => qs.append('verticalId', String(v)));
    return qs.toString();
  }, [clients, verticals]);
  const zonalRes = useFetch<ManagerLite[]>(
    ownerScopeQs ? `/shared/lookup/zonal-managers?${ownerScopeQs}` : '/shared/lookup/zonal-managers',
  );
  const pmRes = useFetch<ManagerLite[]>(
    `/shared/lookup/project-managers?userType=1${ownerScopeQs ? `&${ownerScopeQs}` : ''}`,
  );

  const zonalManagerOptions = useMemo<SearchOption[]>(
    () => (zonalRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [zonalRes.data],
  );
  const projectManagerOptions = useMemo<SearchOption[]>(
    () => (pmRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [pmRes.data],
  );
  // Keep selected owners valid as the scoped option sets change.
  useEffect(() => {
    if (!zonalRes.data) return;
    const valid = new Set(zonalManagerOptions.map((o) => Number(o.value)));
    setZonalManagers((prev) => {
      const next = prev.filter((v) => valid.has(Number(v)));
      return next.length === prev.length ? prev : next;
    });
  }, [zonalManagerOptions, zonalRes.data]);
  useEffect(() => {
    if (!pmRes.data) return;
    const valid = new Set(projectManagerOptions.map((o) => Number(o.value)));
    setProjectManagers((prev) => {
      const next = prev.filter((v) => valid.has(Number(v)));
      return next.length === prev.length ? prev : next;
    });
  }, [projectManagerOptions, pmRes.data]);

  // Fetch key — includes period + every serialized filter so any change
  // refetches. Deferred until the page is viewable (canView gate).
  const queryString = useMemo(
    () =>
      buildQuery(period, clients, verticals, serviceCategories, zonalManagers, projectManagers).toString(),
    [period, clients, verticals, serviceCategories, zonalManagers, projectManagers],
  );
  const fetchKey = canView ? `/admin/quicksight/client-performance?${queryString}` : null;

  const { data, loading, error } = useFetch<ClientPerfRow[]>(fetchKey);

  const rows = data ?? [];

  // Sort by Project Manager for the rowspan grouping (legacy sortField). Stable
  // secondary sort by client name keeps the grouped block deterministic.
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const pm = a.projectManager.localeCompare(b.projectManager);
      if (pm !== 0) return pm;
      return a.clientName.localeCompare(b.clientName);
    });
  }, [rows]);

  // Compute rowspans: how many consecutive rows share each PM (first row of a
  // group renders the PM cell with rowspan; the rest omit it).
  const pmSpans = useMemo(() => {
    const spans: Array<{ render: boolean; span: number }> = [];
    let i = 0;
    while (i < sortedRows.length) {
      let j = i + 1;
      while (j < sortedRows.length && sortedRows[j].projectManager === sortedRows[i].projectManager) j++;
      const span = j - i;
      spans.push({ render: true, span });
      for (let k = i + 1; k < j; k++) spans.push({ render: false, span: 0 });
      i = j;
    }
    return spans;
  }, [sortedRows]);

  // Period headers (3 blocks). Derived from row[0] when present, else from the
  // returned data is empty — we then fall back to nothing (empty state shows).
  const periodHeaders = useMemo(() => {
    const sample = sortedRows[0]?.periods ?? [];
    return sample.map((p) => periodHeader(p, period));
  }, [sortedRows, period]);

  // ── Graphical View transforms ──────────────────────────────────────
  // All derived from the SAME `sortedRows` the table renders (no new fetch).
  // The response is a full (un-paginated) array, so charts cover all rows.

  // Period axis labels (short) for the cross-period charts.
  const chartPeriodLabels = useMemo(
    () => periodHeaders.map((lbl) => (period === 'monthly' ? lbl : lbl.replace(/, \d{4}/g, ''))),
    [periodHeaders, period],
  );

  // Index of the "current" period — the LAST bucket the BE returns (most
  // recent), used for the headline KPIs and the per-client bar chart.
  const currentIdx = useMemo(
    () => Math.max(0, (sortedRows[0]?.periods.length ?? 0) - 1),
    [sortedRows],
  );

  // Headline KPI totals for the current period across all rows.
  const kpis = useMemo(() => {
    let tickets = 0;
    let revenue = 0;
    const clientSet = new Set<number>();
    for (const row of sortedRows) {
      const p = row.periods[currentIdx];
      if (!p) continue;
      tickets += p.ticketCreated;
      revenue += p.sumOfTotalCharge;
      clientSet.add(row.clientId);
    }
    const avgTicketSize = tickets > 0 ? revenue / tickets : 0;
    return { tickets, revenue, avgTicketSize, clients: clientSet.size };
  }, [sortedRows, currentIdx]);

  // Tickets Received per client for the current period (top 8 by volume so the
  // bars stay readable; the table still shows the full list).
  const ticketsByClient = useMemo(() => {
    return sortedRows
      .map((row) => {
        const p = row.periods[currentIdx];
        return {
          client: row.clientName || '—',
          tickets: p?.ticketCreated ?? 0,
        };
      })
      .filter((d) => d.tickets > 0)
      .sort((a, b) => b.tickets - a.tickets)
      .slice(0, 8);
  }, [sortedRows, currentIdx]);

  // Revenue summed across all clients, one point per period (trend line).
  const revenueTrend = useMemo(() => {
    const n = sortedRows[0]?.periods.length ?? 0;
    return Array.from({ length: n }, (_, i) => {
      let revenue = 0;
      let tickets = 0;
      for (const row of sortedRows) {
        const p = row.periods[i];
        if (!p) continue;
        revenue += p.sumOfTotalCharge;
        tickets += p.ticketCreated;
      }
      return { period: chartPeriodLabels[i] ?? `P${i + 1}`, revenue, tickets };
    });
  }, [sortedRows, chartPeriodLabels]);

  const hasCharts = sortedRows.length > 0;

  // 403 → access panel. useFetch flattens the error to a string; the BE 403
  // messages ("insufficient permissions", "Missing permission: …", "You do
  // not have QuickSight access") all imply a denial. We also treat the static
  // permission gate (no action key) as denied.
  const accessDenied =
    !canView ||
    (!!error &&
      /permission|quicksight access|access denied/i.test(error));

  const genericError = error && !accessDenied ? error : null;

  const isEmpty = !loading && !genericError && !accessDenied && sortedRows.length === 0;

  async function handleDownload() {
    setDownloading(true);
    try {
      const qs = buildQuery(period, clients, verticals, serviceCategories, zonalManagers, projectManagers);
      qs.set('format', 'xlsx');
      await downloadXlsx({
        url: `/admin/quicksight/client-performance?${qs.toString()}`,
        filename: `client-performance-${period}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
    } catch {
      // downloadXlsx throws a human-readable Error; surfaced via toast for
      // parity with the legacy clipboard alert.
      showToast({ variant: 'error', message: 'Could not download the report. Please retry.' });
    } finally {
      setDownloading(false);
    }
  }

  function handleCopy() {
    // Legacy "Copy Data" parity — TAB-separated text. Header row mirrors the
    // canonical Copy-Data intent; 3 period blocks of the 7 metrics.
    const head = ['Project Manager', 'Client'];
    periodHeaders.forEach((lbl) => {
      METRIC_HEADERS.forEach((h) => head.push(`${lbl} ${h}`));
    });
    const lines = [head.join('\t')];
    for (const row of sortedRows) {
      const cells: Array<string | number> = [row.projectManager, row.clientName];
      for (const p of row.periods) {
        cells.push(
          p.ticketCreated,
          p.enquiryPercentage,
          p.cancellationAfterAllocation,
          p.averageTicketSize,
          p.sumOfTotalCharge,
          p.averageTat.toFixed(2),
          p.escalationPercentage,
        );
      }
      lines.push(cells.join('\t'));
    }
    const text = lines.join('\n');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast({ variant: 'success', message: 'Job data copied to clipboard' }),
        () => showToast({ variant: 'error', message: 'Could not copy to clipboard' }),
      );
    }
  }

  const filters = (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Tabs value={period} onValueChange={(v) => setPeriod(v as Period)}>
          <TabsList>
            <TabsTrigger value="monthly">Monthly</TabsTrigger>
            <TabsTrigger value="weekly">Weekly</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          disabled={loading || sortedRows.length === 0}
          title={sortedRows.length === 0 ? 'No rows to copy' : undefined}
        >
          Copy Data
        </Button>
      </div>
      <QuickSightFilterBar
        show={{
          clients: true,
          verticals: true,
          serviceCategories: true,
          zonalManagers: true,
          projectManagers: true,
        }}
        clients={clients}
        onClientsChange={setClients}
        verticals={verticals}
        onVerticalsChange={setVerticals}
        serviceCategories={serviceCategories}
        onServiceCategoriesChange={setServiceCategories}
        zonalManagers={zonalManagers}
        onZonalManagersChange={setZonalManagers}
        zonalManagerOptions={zonalManagerOptions}
        projectManagers={projectManagers}
        onProjectManagersChange={setProjectManagers}
        projectManagerOptions={projectManagerOptions}
        disabled={loading}
      />
    </div>
  );

  return (
    <ReportPageScaffold
      title="Client Performance"
      subtitle="Monthly / weekly client KPIs grouped by project manager."
      icon={Gauge}
      filters={filters}
      loading={loading}
      error={genericError}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={handleDownload}
      downloading={downloading}
    >
      {hasCharts && (
        <section className="mb-6 space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-800">Graphical View</h2>
            <span className="text-xs text-muted-foreground">
              Current Period: {periodHeaders[currentIdx] ?? '—'}
            </span>
          </div>

          {/* KPI tiles — current-period totals across all rows. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <QsKpiTile
              label="Tickets Received"
              value={fmtInt(kpis.tickets)}
              accent={QS_COLORS[0]}
              icon={<Ticket size={18} />}
            />
            <QsKpiTile
              label="Total Revenue"
              value={`₹${fmtInt(kpis.revenue)}`}
              accent={QS_SEMANTIC.good}
              icon={<IndianRupee size={18} />}
            />
            <QsKpiTile
              label="Avg Ticket Size"
              value={`₹${fmtInt(kpis.avgTicketSize)}`}
              accent={QS_COLORS[2]}
              icon={<Receipt size={18} />}
            />
            <QsKpiTile
              label="Active Clients"
              value={fmtInt(kpis.clients)}
              accent={QS_COLORS[5]}
              icon={<Users size={18} />}
            />
          </div>

          {/* Charts grid. */}
          <div className="grid gap-4 md:grid-cols-2">
            <ChartCard
              title="Tickets Received By Client"
              subtitle="Top Clients — Current Period"
            >
              {ticketsByClient.length > 0 ? (
                <QsBarChart
                  data={ticketsByClient}
                  xKey="client"
                  layout="vertical"
                  series={[{ key: 'tickets', label: 'Tickets Received', color: QS_COLORS[0] }]}
                  height={300}
                />
              ) : (
                <EmptyChart label="No tickets in the current period." />
              )}
            </ChartCard>

            <ChartCard
              title="Revenue Trend"
              subtitle={`Total Revenue Across ${period === 'monthly' ? 'Months' : 'Weeks'}`}
            >
              {revenueTrend.length > 0 ? (
                <QsLineChart
                  data={revenueTrend}
                  xKey="period"
                  area
                  series={[{ key: 'revenue', label: 'Revenue', color: QS_SEMANTIC.good }]}
                  height={300}
                />
              ) : (
                <EmptyChart label="No revenue to plot." />
              )}
            </ChartCard>
          </div>
        </section>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th rowSpan={2} className="!text-left sticky left-0 z-10 bg-muted">Project Manager</th>
              <th rowSpan={2} className="!text-left">Client</th>
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
            {sortedRows.map((row, idx) => {
              const span = pmSpans[idx];
              return (
                <tr key={row.clientId}>
                  {span.render && (
                    <td
                      rowSpan={span.span}
                      className="!text-left align-top font-medium sticky left-0 z-10 bg-background"
                    >
                      {row.projectManager || '—'}
                    </td>
                  )}
                  <td className="!text-left">{row.clientName || '—'}</td>
                  {row.periods.map((p, i) => (
                    <PeriodCells key={i} p={p} firstOfBlock />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ReportPageScaffold>
  );
}

/* Tiny in-card empty state so a chart with no plottable data never crashes
 * (recharts on an empty array renders a bare axis box). */
function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

/* The 7 numeric cells for one period block. `firstOfBlock` adds the left
 * border so the three blocks read apart. Field order matches the CORRECTED
 * header alignment: ticketCreated, enquiryPercentage,
 * cancellationAfterAllocation, averageTicketSize, sumOfTotalCharge,
 * averageTat, escalationPercentage. */
function PeriodCells({ p, firstOfBlock }: { p: PeriodBucket; firstOfBlock?: boolean }) {
  const cls = '!text-right whitespace-nowrap';
  return (
    <>
      <td className={`${cls} ${firstOfBlock ? 'border-l' : ''}`}>{p.ticketCreated}</td>
      <td className={cls}>{p.enquiryPercentage}%</td>
      <td className={cls}>{p.cancellationAfterAllocation}</td>
      <td className={cls}>{p.averageTicketSize}</td>
      <td className={cls}>{p.sumOfTotalCharge}</td>
      <td className={cls}>{p.averageTat.toFixed(2)}</td>
      <td className={cls}>{p.escalationPercentage}%</td>
    </>
  );
}
