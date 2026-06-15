'use client';

/*
 * Graphical View for the Material Report — a colorful chart section rendered
 * ABOVE the data table. Built ENTIRELY from the rows the page already fetched
 * (no new API calls): the parent passes the current `rows` and we aggregate
 * them with useMemo into the shapes the shared chart kit expects.
 *
 * The Material Report is a flat detail list (one row per element-deployed
 * line). Numeric fields: `unit` (Qty), `cxCharge` (Rate), `totalCost`
 * (Total Amount). Categorical: `serviceType` (Service / Material),
 * `serviceName` (Element Deployed), `cityName`. We derive:
 *   - KPI tiles: Total Jobs (distinct jobId), Total Elements (row count),
 *     Total Quantity (Σ unit), Total Amount (Σ totalCost).
 *   - Bar: Total Amount By Element Deployed (Top 8) — horizontal bars.
 *   - Donut: Elements By Service Type (Service vs Material).
 *   - Bar: Total Quantity By City (Top 8).
 *
 * All visuals use ONLY the shared kit (ChartCard / QsBarChart / QsDonut /
 * QsKpiTile / palettes) so every report reads as one family. Renders nothing
 * when there are no rows, so the section never crashes on empty data.
 */

import { useMemo } from 'react';
import { Briefcase, IndianRupee, Layers, Ruler } from 'lucide-react';

import {
  ChartCard,
  QsBarChart,
  QsDonut,
  QsKpiTile,
  QS_COLORS,
  QS_SEMANTIC,
} from '@/components/quicksight/charts';

// Minimal row contract — only the fields the charts read (the parent's
// MaterialRow is a superset). Kept local so this stays a drop-in sub-component.
type ChartRow = {
  jobId: number;
  serviceType: 'Service' | 'Material';
  serviceName: string | null;
  unit: number;
  totalCost: number;
  cityName: string | null;
};

const TOP_N = 8;

function fmtInt(n: number): string {
  return (n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function fmtCurrency(n: number): string {
  return `₹${(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

// Truncate long element/city names so horizontal-bar Y-axis labels stay tidy.
function shortLabel(s: string, max = 22): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function MaterialReportCharts({ rows }: { rows: ChartRow[] }) {
  // ── KPI headline numbers ────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const jobIds = new Set<number>();
    let qty = 0;
    let amount = 0;
    for (const r of rows) {
      jobIds.add(r.jobId);
      qty += Number(r.unit) || 0;
      amount += Number(r.totalCost) || 0;
    }
    return {
      jobs: jobIds.size,
      elements: rows.length,
      qty,
      amount,
    };
  }, [rows]);

  // ── Total Amount by Element Deployed (Top N) — horizontal bars ───────────
  const amountByElement = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const name = (r.serviceName ?? '').trim() || 'Unspecified';
      m.set(name, (m.get(name) ?? 0) + (Number(r.totalCost) || 0));
    }
    return [...m.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([name, amount]) => ({ name: shortLabel(name), amount }));
  }, [rows]);

  // ── Elements by Service Type (Service vs Material) — donut ───────────────
  const byServiceType = useMemo(() => {
    let service = 0;
    let material = 0;
    for (const r of rows) {
      if (r.serviceType === 'Material') material += 1;
      else service += 1;
    }
    return [
      { type: 'Service', count: service },
      { type: 'Material', count: material },
    ].filter((d) => d.count > 0);
  }, [rows]);

  // ── Total Quantity by City (Top N) — vertical bars ───────────────────────
  const qtyByCity = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const city = (r.cityName ?? '').trim() || 'Unknown';
      m.set(city, (m.get(city) ?? 0) + (Number(r.unit) || 0));
    }
    return [...m.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([city, qty]) => ({ city: shortLabel(city, 16), qty }));
  }, [rows]);

  if (rows.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Graphical View</h2>
        <p className="text-xs text-muted-foreground">Charts Reflect The Loaded Records</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <QsKpiTile
          label="Total Jobs"
          value={fmtInt(kpis.jobs)}
          accent={QS_COLORS[0]}
          icon={<Briefcase className="h-5 w-5" />}
        />
        <QsKpiTile
          label="Total Elements Deployed"
          value={fmtInt(kpis.elements)}
          accent={QS_COLORS[1]}
          icon={<Layers className="h-5 w-5" />}
        />
        <QsKpiTile
          label="Total Quantity"
          value={fmtInt(kpis.qty)}
          accent={QS_COLORS[2]}
          icon={<Ruler className="h-5 w-5" />}
        />
        <QsKpiTile
          label="Total Amount"
          value={fmtCurrency(kpis.amount)}
          accent={QS_COLORS[3]}
          icon={<IndianRupee className="h-5 w-5" />}
        />
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {amountByElement.length > 0 && (
          <ChartCard
            title="Total Amount By Element Deployed"
            subtitle={`Top ${Math.min(TOP_N, amountByElement.length)} By Amount`}
          >
            <QsBarChart
              data={amountByElement}
              xKey="name"
              layout="vertical"
              series={[{ key: 'amount', label: 'Total Amount', color: QS_COLORS[0] }]}
              height={300}
            />
          </ChartCard>
        )}

        {byServiceType.length > 0 && (
          <ChartCard
            title="Elements By Service Type"
            subtitle="Service Vs Material Split"
          >
            <QsDonut
              data={byServiceType}
              nameKey="type"
              valueKey="count"
              colors={[QS_SEMANTIC.info, QS_SEMANTIC.warn]}
              height={300}
            />
          </ChartCard>
        )}

        {qtyByCity.length > 0 && (
          <ChartCard
            title="Total Quantity By City"
            subtitle={`Top ${Math.min(TOP_N, qtyByCity.length)} By Quantity`}
            className="md:col-span-2"
          >
            <QsBarChart
              data={qtyByCity}
              xKey="city"
              series={[{ key: 'qty', label: 'Total Quantity', color: QS_COLORS[4] }]}
              height={280}
            />
          </ChartCard>
        )}
      </div>
    </div>
  );
}
