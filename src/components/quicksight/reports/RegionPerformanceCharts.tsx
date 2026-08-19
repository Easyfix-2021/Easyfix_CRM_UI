'use client';

/*
 * Graphical View for the STATE / USER Performance reports.
 *
 * Mirrors TechnicianPerformanceCharts' layout so all the performance tabs read
 * as one report: "Graphical View" heading + "Charts reflect the current page."
 * caption, a 4-tile KPI row, then a 2-column chart grid.
 *
 * ⚠ PERCENTAGES ARE RECOMPUTED FROM SUMMED COUNTS, never averaged across rows.
 * The API returns sdaCount/processJobs and tatCount/completedOrders precisely so
 * this file can do that: averaging the per-row percentages would weight a 2-job
 * state the same as a 2000-job one and quietly misreport the page.
 *
 * ⚠ The share-of-tickets DONUT renders for STATE only. Every job belongs to
 * exactly one state, so a state donut is a true share of 100%. Users' regions
 * OVERLAP (see the report's note), so a user donut would present slices summing
 * past 100% as if they were a partition — the one chart that would actively
 * mislead, so it is omitted rather than footnoted.
 *
 * There is deliberately NO "Top N by tickets" bar chart: it plotted the same
 * latest-period numbers as the donut, so it was dropped (2026-07-30) rather than
 * shown twice. Ranking by tickets is what the TABLE below is for; the charts
 * cover share, trend and quality. Consequence: the USER tab has no
 * latest-period-per-row chart at all, which is why the trend goes full width.
 */

import { useMemo } from 'react';
import { MapPin, Ticket, Layers, Gauge } from 'lucide-react';

import {
  ChartCard, QsBarChart, QsDonut, QsKpiTile, QS_COLORS, QS_SEMANTIC,
} from '@/components/quicksight/charts';

type Bucket = {
  detailsFor: string;
  tktCreated: number; openOrders: number; processJobs: number;
  sdaCount: number; tatCount: number; completedOrders: number;
  sdaPercentage: number | null; tatPercentage: number | null;
};
type Row = {
  stateId?: number | null; stateName?: string;
  userId?: number | null; userName?: string;
  allRegions?: boolean;
  periods: Bucket[];
};

// Keep the charts legible — beyond ~10 categories labels and slices collide.
const TOP_N = 10;

/*
 * One colour per METRIC, shared by the KPI tiles and the bars so a tile and its
 * bar always agree.
 *
 * ⚠ Never pick QS_COLORS[2] for a series drawn beside an open/pending series:
 * QS_COLORS[2] and QS_SEMANTIC.warn are the SAME hex (#f59e0b), so both bars
 * render identical amber and the legend stops distinguishing anything. That is
 * exactly how this chart shipped first.
 */
const C_TICKETS = QS_COLORS[4]; // sky
const C_OPEN = QS_SEMANTIC.warn; // amber
const pctFrom = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : null);
const fmt = (n: number) => n.toLocaleString('en-IN');

export function RegionPerformanceCharts({
  rows, dimension,
}: {
  rows: Row[];
  dimension: 'state' | 'user';
}) {
  const isUser = dimension === 'user';
  const label = isUser ? 'User' : 'State';
  const nameOf = (r: Row) => (isUser ? (r.userName || '—') : (r.stateName || '—'));

  const charts = useMemo(() => {
    // periods[0] is the most recent (the service returns most-recent-first).
    const latest = (r: Row) => r.periods?.[0];
    const periodLabel = rows[0]?.periods?.[0]?.detailsFor ?? '';

    // ── KPI row — page totals for the LATEST period ──
    const sum = (pick: (b: Bucket) => number) =>
      rows.reduce((acc, r) => acc + (latest(r) ? pick(latest(r)!) : 0), 0);
    const tickets = sum((b) => b.tktCreated);
    const open = sum((b) => b.openOrders);
    const sdaPct = pctFrom(sum((b) => b.sdaCount), sum((b) => b.processJobs));
    const tatPct = pctFrom(sum((b) => b.tatCount), sum((b) => b.completedOrders));

    // ── Quality: SDA% vs TAT% (latest period), top by SDA ──
    const qualityBars = rows
      .map((r) => ({
        name: nameOf(r),
        sda: latest(r)?.sdaPercentage ?? 0,
        tat: latest(r)?.tatPercentage ?? 0,
      }))
      .filter((d) => d.sda > 0 || d.tat > 0)
      .sort((a, b) => b.sda - a.sda)
      .slice(0, TOP_N);

    /*
     * ── Period trend — page totals per period, OLDEST → newest ──
     * The service returns most-recent-first (the table reads that way); a trend
     * chart has to run left-to-right in time, so this reverses it. Reading the
     * API order straight into a chart would show the trend backwards.
     */
    const periodCount = rows[0]?.periods?.length ?? 0;
    const trend = Array.from({ length: periodCount }, (_, i) => {
      const idx = periodCount - 1 - i;
      const buckets = rows.map((r) => r.periods?.[idx]).filter(Boolean) as Bucket[];
      return {
        name: buckets[0]?.detailsFor ?? '',
        tickets: buckets.reduce((a, b) => a + b.tktCreated, 0),
        open: buckets.reduce((a, b) => a + b.openOrders, 0),
      };
    });

    // ── Share of tickets, latest period (STATE only — see the header) ──
    const share = isUser ? [] : rows
      .map((r) => ({ name: nameOf(r), value: latest(r)?.tktCreated ?? 0 }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, TOP_N);

    return { periodLabel, tickets, open, sdaPct, tatPct, qualityBars, trend, share };
  }, [rows, isUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nothing to draw (empty page) — the table's own empty state covers it.
  if (rows.length === 0) return null;

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink-900">Graphical View</h2>
        <span className="text-xs text-muted-foreground">Charts reflect the current page.</span>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <QsKpiTile
          label={isUser ? 'Users On Page' : 'States On Page'}
          value={fmt(rows.length)}
          accent={QS_COLORS[0]}
          icon={isUser ? <Gauge size={18} /> : <MapPin size={18} />}
        />
        <QsKpiTile
          label="Tickets Created"
          value={fmt(charts.tickets)}
          accent={C_TICKETS}
          icon={<Ticket size={18} />}
        />
        <QsKpiTile
          label="Open Orders"
          value={fmt(charts.open)}
          accent={C_OPEN}
          icon={<Layers size={18} />}
        />
        <QsKpiTile
          label="SDA % / TAT %"
          value={`${charts.sdaPct ?? '—'}% / ${charts.tatPct ?? '—'}%`}
          accent={QS_SEMANTIC.good}
          icon={<Gauge size={18} />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* STATE: a true share of 100%. USER: omitted — regions overlap. */}
        {charts.share.length > 0 && (
          <ChartCard
            title="Share Of Tickets By State"
            subtitle={`Latest Period — ${charts.periodLabel}`}
          >
            <QsDonut data={charts.share} nameKey="name" valueKey="value" height={300} />
          </ChartCard>
        )}

        {charts.trend.length > 0 && (
          <ChartCard
            title="Tickets Across Periods"
            subtitle="Page totals, oldest to newest"
            /*
             * On the USER tab there is no donut beside it, so span the full row —
             * a lone half-width card next to dead space reads as a chart that
             * failed to render.
             */
            className={charts.share.length > 0 ? undefined : 'md:col-span-2'}
          >
            <QsBarChart
              data={charts.trend}
              xKey="name"
              height={300}
              series={[
                { key: 'tickets', label: 'Tickets Created', color: C_TICKETS },
                { key: 'open', label: 'Open Orders', color: C_OPEN },
              ]}
            />
          </ChartCard>
        )}

        {charts.qualityBars.length > 0 && (
          <ChartCard
            title={`SDA % Vs TAT % By ${label}`}
            subtitle={`Top By SDA % — Latest Period — ${charts.periodLabel}`}
            className="md:col-span-2"
          >
            <QsBarChart
              data={charts.qualityBars}
              xKey="name"
              height={300}
              series={[
                { key: 'sda', label: 'SDA %', color: QS_COLORS[5] },
                { key: 'tat', label: 'TAT %', color: QS_COLORS[6] },
              ]}
            />
          </ChartCard>
        )}
      </div>
    </section>
  );
}
