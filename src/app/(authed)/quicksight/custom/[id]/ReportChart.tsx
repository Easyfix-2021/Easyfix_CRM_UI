'use client';

import { ChartCard, QsBarChart, QsLineChart, QsDonut } from '@/components/quicksight/charts';
import type { ChartResponse } from './types';

/*
 * Renders a Custom Report's chart from GET /:id/chart (or the public
 * .../chart equivalent — same shape). Pure presentational: no `color` is
 * ever hand-picked here, so the series/colors arrays stay clear of
 * local/no-duplicate-chart-series-color — QsBarChart / QsLineChart / QsDonut
 * rotate through QS_COLORS themselves.
 *
 * `series` (from the API) drives the legend; `points` are the rows. Donut
 * charts use exactly one series (the contract guarantees y.length===1 for
 * pie), so we feed QsDonut the first point-set reshaped to {name, value}.
 */
export function ReportChart({ data }: { data: ChartResponse }) {
  const { chart, series, points } = data;
  if (!chart) return null;

  if (chart.type === 'pie') {
    const s = series[0];
    const donutData = points.map((p) => ({ name: p.x, value: s ? p[s.key] : 0 }));
    return (
      <ChartCard title="Chart">
        <QsDonut data={donutData} nameKey="name" valueKey="value" />
      </ChartCard>
    );
  }

  const chartSeries = series.map((s) => ({ key: s.key, label: s.name }));
  return (
    <ChartCard title="Chart">
      {chart.type === 'bar' ? (
        <QsBarChart data={points} xKey="x" series={chartSeries} />
      ) : (
        <QsLineChart data={points} xKey="x" series={chartSeries} />
      )}
    </ChartCard>
  );
}
