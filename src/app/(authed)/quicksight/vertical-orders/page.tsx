'use client';

/*
 * QuickSight — Vertical Orders report page (native rebuild of the legacy
 * Angular "vertical" slug).
 *
 * Legacy source: Angular_ClientDashboard vertical.component.{ts,html}.
 * Single endpoint:  GET /admin/quicksight/vertical-orders?flag=<csv>
 *
 * UI parity:
 *   - 4 multi-select toggle buttons (Technician Unallocated [default ON],
 *     Running Late, Waiting To Close On App, Under Audit). Selected flags
 *     are joined as CSV and drive the fetch (re-fetch on every toggle).
 *   - 2 KPI badges: Unconfirmed Orders and Open Escalation (count + %).
 *   - Table "Vertical-Wise Job Count Analysis": one row per vertical
 *     (Retail / OEM) pivoted across Today / Yesterday / 2-7 Days /
 *     More Than 7 Days + Total Count, then a synthetic 'Total' row summing
 *     each age column (Total Count blank on that row — legacy parity).
 *
 * Data fetching uses the mandatory useFetch hook (keyed on the serialized
 * flag CSV) — never raw useEffect+api.get. Permission gating mirrors the
 * BE requireQuickSight contract: the page is gated on the ef-QuickSight
 * family key + the per-report isQuickSightVerticalOrdersView key via
 * actionFlags; a missing key (or a BE 403) renders the scaffold's
 * accessDenied panel.
 *
 * Excel export is an enhancement (legacy had none) wired to the shared
 * ?format=xlsx endpoint per the registry exporter decision.
 */

import { useMemo, useState } from 'react';
import { Layers, FileQuestion, FolderOpen, AlertTriangle, Percent } from 'lucide-react';
import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import {
  ChartCard,
  QsBarChart,
  QsDonut,
  QsKpiTile,
  QS_COLORS,
  QS_SEMANTIC,
} from '@/components/quicksight/charts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useFetch } from '@/lib/hooks';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { cn } from '@/lib/utils';

const FAMILY_KEY = 'ef-QuickSight';
const ACTION_KEY = 'isQuickSightVerticalOrdersView';

// Toggle definitions — order + Title-Case labels + flag tokens match spec.
type ToggleDef = { flag: string; label: string; active: string };
const TOGGLES: ToggleDef[] = [
  { flag: 'waitingtx', label: 'Technician Unallocated', active: 'bg-urgent hover:bg-urgent-strong text-white border-urgent' },
  { flag: 'runninglate', label: 'Running Late', active: 'bg-warning hover:bg-warning-strong text-white border-warning' },
  { flag: 'openonapp', label: 'Waiting To Close On App', active: 'bg-info hover:bg-info-strong text-white border-info' },
  { flag: 'underaudit', label: 'Under Audit', active: 'bg-success hover:bg-success-strong text-white border-success' },
];

// ── API response types (field names match the legacy DTO 1:1) ──────────
type OpenVerticalOrderCell = {
  jobCount: number;
  jobAgeCategory: 'Today' | 'Yesterday' | 'TwoToSeven' | 'MoreThanSeven';
  verticalCategory: string;
  totalCount: number;
  ageCategoryTotalCount: number;
};
type VerticalOrdersData = {
  openOrderByGroup: OpenVerticalOrderCell[];
  countOfEscalatedOrders: number;
  countOfUnconfirmedOrders: number;
  countOfOpenOrders: number;
  escalatedOrderPercentage: number;
};

const AGE_COLUMNS: Array<{ key: OpenVerticalOrderCell['jobAgeCategory']; label: string }> = [
  { key: 'Today', label: 'Today' },
  { key: 'Yesterday', label: 'Yesterday' },
  { key: 'TwoToSeven', label: '2-7 Days' },
  { key: 'MoreThanSeven', label: 'More Than 7 Days' },
];

// Pivoted table row.
type PivotRow = {
  verticalCategory: string;
  Today: number;
  Yesterday: number;
  TwoToSeven: number;
  MoreThanSeven: number;
  TotalCount: number | null; // null on the synthetic Total row (legacy blank)
  isTotal: boolean;
};

/*
 * Reshape the 8 cells into the on-screen pivot: one row per vertical with
 * the 4 age columns + per-vertical Total Count, then a synthetic 'Total'
 * row summing each age column across verticals (legacy vertical.component.ts
 * 104-137). The Total row leaves Total Count blank.
 */
function pivotRows(cells: OpenVerticalOrderCell[]): PivotRow[] {
  const byVertical = new Map<string, PivotRow>();
  for (const c of cells) {
    let row = byVertical.get(c.verticalCategory);
    if (!row) {
      row = {
        verticalCategory: c.verticalCategory,
        Today: 0, Yesterday: 0, TwoToSeven: 0, MoreThanSeven: 0,
        TotalCount: c.totalCount,
        isTotal: false,
      };
      byVertical.set(c.verticalCategory, row);
    }
    row[c.jobAgeCategory] = c.jobCount;
    row.TotalCount = c.totalCount;
  }

  const rows = Array.from(byVertical.values());
  const totalRow: PivotRow = {
    verticalCategory: 'Total',
    Today: 0, Yesterday: 0, TwoToSeven: 0, MoreThanSeven: 0,
    TotalCount: null,
    isTotal: true,
  };
  for (const r of rows) {
    for (const col of AGE_COLUMNS) totalRow[col.key] += r[col.key];
  }
  rows.push(totalRow);
  return rows;
}

export default function VerticalOrdersPage() {
  const { me } = useMe();
  const flags = actionFlags(me, [FAMILY_KEY, ACTION_KEY]);
  const hasAccess = flags[FAMILY_KEY] && flags[ACTION_KEY];

  // Multi-select toggles; default = ['waitingtx'] (legacy init).
  const [selected, setSelected] = useState<string[]>(['waitingtx']);
  const [downloading, setDownloading] = useState(false);

  // CSV in canonical toggle order for a stable fetch key.
  const flagCsv = useMemo(
    () => TOGGLES.filter((t) => selected.includes(t.flag)).map((t) => t.flag).join(','),
    [selected],
  );

  // Only fetch when the user has access AND at least one toggle is on
  // (the BE rejects an empty flag with a 400 — mirror the legacy default
  // of always having ≥1 toggle selected).
  const fetchKey = hasAccess && flagCsv
    ? `/admin/quicksight/vertical-orders?flag=${encodeURIComponent(flagCsv)}`
    : null;
  const { data, loading, error } = useFetch<VerticalOrdersData>(fetchKey);

  // BE hard-403 fallback: if the endpoint returns 403 the error message
  // carries the permission text — surface the access panel rather than a
  // raw error string.
  const beDenied = !!error && /permission|quicksight access/i.test(error);
  const accessDenied = !hasAccess || beDenied;

  const rows = useMemo(
    () => (data?.openOrderByGroup ? pivotRows(data.openOrderByGroup) : []),
    [data],
  );

  // ── Chart transforms (derived from the SAME fetched data) ──────────
  // Grouped bar: one X-category per age bucket, one series per vertical
  // (skip the synthetic Total row so it reads as Retail vs OEM per bucket).
  const verticalRows = useMemo(() => rows.filter((r) => !r.isTotal), [rows]);
  const ageBarData = useMemo(
    () =>
      AGE_COLUMNS.map((col) => {
        const point: Record<string, unknown> = { age: col.label };
        for (const r of verticalRows) point[r.verticalCategory] = r[col.key];
        return point;
      }),
    [verticalRows],
  );
  const barSeries = useMemo(
    () =>
      verticalRows.map((r, i) => ({
        key: r.verticalCategory,
        label: r.verticalCategory,
        color: QS_COLORS[i % QS_COLORS.length],
      })),
    [verticalRows],
  );

  // Donut: jobs by age category (totals across verticals = the Total row).
  const totalRow = useMemo(() => rows.find((r) => r.isTotal), [rows]);
  const ageDonutData = useMemo(
    () =>
      totalRow
        ? AGE_COLUMNS.map((col) => ({ name: col.label, value: totalRow[col.key] }))
        : [],
    [totalRow],
  );
  const hasDonutData = useMemo(
    () => ageDonutData.some((d) => d.value > 0),
    [ageDonutData],
  );
  const hasBarData = useMemo(
    () => verticalRows.some((r) => AGE_COLUMNS.some((c) => r[c.key] > 0)),
    [verticalRows],
  );

  function toggleFlag(flag: string) {
    setSelected((prev) =>
      prev.includes(flag) ? prev.filter((f) => f !== flag) : [...prev, flag],
    );
  }

  async function handleDownload() {
    if (!flagCsv) return;
    setDownloading(true);
    try {
      await downloadXlsx({
        url: `/admin/quicksight/vertical-orders?flag=${encodeURIComponent(flagCsv)}&format=xlsx`,
        filename: 'vertical-orders.xlsx',
      });
    } catch {
      // The scaffold surfaces fetch errors; a failed export is non-fatal.
    } finally {
      setDownloading(false);
    }
  }

  // Empty = no data rows OR the user turned every toggle off (no flag).
  const isEmpty = !accessDenied && !loading && !error && (!flagCsv || rows.length === 0);

  return (
    <ReportPageScaffold
      title="Vertical Orders"
      subtitle="Open-Order Aging Across Verticals By Alert Category"
      icon={Layers}
      loading={loading}
      error={accessDenied ? null : error}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={handleDownload}
      downloading={downloading}
      filters={
        <div className="space-y-3">
          {/* Toggle buttons — multi-select. */}
          <div className="flex flex-wrap gap-2">
            {TOGGLES.map((t) => {
              const on = selected.includes(t.flag);
              return (
                <Button
                  key={t.flag}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={on}
                  onClick={() => toggleFlag(t.flag)}
                  className={cn(on && t.active)}
                >
                  {t.label}
                </Button>
              );
            })}
          </div>

          {/* KPI badges — always render (mirror legacy). */}
          <div className="flex flex-wrap gap-2">
            <Badge className="bg-ink-100 text-ink-700 border border-ink-100">
              Unconfirmed Orders - {data?.countOfUnconfirmedOrders ?? 0}
            </Badge>
            <Badge className="bg-urgent-tint text-urgent-strong border border-urgent/30">
              Open Escalation - {data?.countOfEscalatedOrders ?? 0} ({data?.escalatedOrderPercentage ?? 0}%)
            </Badge>
          </div>
        </div>
      }
    >
      {/* ── Graphical View — derived from the same fetched data ───────── */}
      <div className="space-y-3 mb-6">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Graphical View</h2>
          <span className="text-xs text-muted-foreground">
            Charts Reflect The Current Selection
          </span>
        </div>

        {/* KPI row — the 3 unconditional counts + the escalation percentage. */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <QsKpiTile
            label="Unconfirmed Orders"
            value={data?.countOfUnconfirmedOrders ?? 0}
            accent={QS_COLORS[0]}
            icon={<FileQuestion className="h-5 w-5" />}
          />
          <QsKpiTile
            label="Open Orders"
            value={data?.countOfOpenOrders ?? 0}
            accent={QS_SEMANTIC.info}
            icon={<FolderOpen className="h-5 w-5" />}
          />
          <QsKpiTile
            label="Open Escalation"
            value={data?.countOfEscalatedOrders ?? 0}
            accent={QS_SEMANTIC.bad}
            icon={<AlertTriangle className="h-5 w-5" />}
          />
          <QsKpiTile
            label="Escalation Percentage"
            value={`${data?.escalatedOrderPercentage ?? 0}%`}
            accent={QS_SEMANTIC.warn}
            icon={<Percent className="h-5 w-5" />}
          />
        </div>

        {/* Bar + Donut grid. */}
        <div className="grid md:grid-cols-2 gap-3">
          <ChartCard
            title="Open Orders By Age Category"
            subtitle="Job Count Per Vertical Across Aging Buckets"
          >
            {hasBarData ? (
              <QsBarChart data={ageBarData} xKey="age" series={barSeries} height={280} />
            ) : (
              <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                No Open Orders For The Current Selection
              </div>
            )}
          </ChartCard>

          <ChartCard
            title="Jobs By Age Category"
            subtitle="Share Of Open Orders Across Aging Buckets"
          >
            {hasDonutData ? (
              <QsDonut data={ageDonutData} nameKey="name" valueKey="value" height={280} />
            ) : (
              <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                No Open Orders For The Current Selection
              </div>
            )}
          </ChartCard>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-base font-semibold">Vertical-Wise Job Count Analysis</h2>
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-center">Vertical Category</th>
                {AGE_COLUMNS.map((c) => (
                  <th key={c.key} className="!text-center">{c.label}</th>
                ))}
                <th className="!text-center">Total Count</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.verticalCategory} className={cn(r.isTotal && 'font-semibold bg-ink-50')}>
                  <td className="!text-center">{r.verticalCategory}</td>
                  {AGE_COLUMNS.map((c) => (
                    <td key={c.key} className="!text-center">{r[c.key]}</td>
                  ))}
                  <td className="!text-center">{r.TotalCount ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </ReportPageScaffold>
  );
}
