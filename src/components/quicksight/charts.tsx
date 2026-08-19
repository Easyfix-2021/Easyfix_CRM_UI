'use client';

/*
 * Shared QuickSight chart kit (2026-06-15) — colorful, consistent
 * visualizations for the native QuickSight report pages, built on recharts.
 *
 * Why a shared kit: each report adds 1-3 charts derived from the SAME data
 * it already fetches (no new endpoints — charts are pure presentation). This
 * file centralizes the palette + attractive defaults (rounded bars, gradient
 * fills, styled tooltips/legends, responsive sizing) so all 10 reports read
 * as one family instead of 10 ad-hoc chart styles.
 *
 * All exports are client components (recharts is browser-only). Drop a chart
 * inside <ChartCard> for the framed, titled look; ResponsiveContainer makes
 * them fill the card width and reflow on resize.
 */

import type { ReactNode } from 'react';
import {
  ResponsiveContainer,
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { Card, CardContent } from '@/components/ui/card';

/*
 * Vibrant but harmonious palette (Tailwind-derived 500/600 hues). Ordered
 * so adjacent series stay visually distinct. Use QS_COLORS[i % length].
 */
export const QS_COLORS = [
  '#6366f1', // indigo
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#0ea5e9', // sky
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#f97316', // orange
  '#ec4899', // pink
  '#84cc16', // lime
];

/* Semantic colors for status-like series (reuse across reports). */
export const QS_SEMANTIC = {
  good: '#10b981',
  warn: '#f59e0b',
  bad: '#ef4444',
  info: '#0ea5e9',
  neutral: '#94a3b8',
};

const AXIS_TICK = { fontSize: 11, fill: '#64748b' };
const GRID_STROKE = '#e2e8f0';

/* Shared styled tooltip — rounded, soft shadow, slate text. */
const TOOLTIP_STYLE = {
  borderRadius: 10,
  border: '1px solid #e2e8f0',
  boxShadow: '0 4px 16px rgba(15,23,42,0.08)',
  fontSize: 12,
};

/* ── Framed card wrapper ─────────────────────────────────────────── */
export function ChartCard({
  title, subtitle, children, className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

type Series = { key: string; label?: string; color?: string };

/* ── Bar chart (vertical) — rounded tops, optional stacked, gradient ── */
export function QsBarChart({
  data, xKey, series, height = 280, stacked = false, layout = 'horizontal',
}: {
  data: Array<Record<string, unknown>>;
  xKey: string;
  series: Series[];
  height?: number;
  stacked?: boolean;
  /* 'horizontal' = vertical bars (category on X); 'vertical' = horizontal bars (category on Y). */
  layout?: 'horizontal' | 'vertical';
}) {
  const vertical = layout === 'vertical';
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={layout} margin={{ top: 8, right: 12, bottom: 4, left: vertical ? 8 : 0 }}>
        <defs>
          {series.map((s, i) => {
            const c = s.color || QS_COLORS[i % QS_COLORS.length];
            return (
              <linearGradient key={s.key} id={`qsbar-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={c} stopOpacity={0.95} />
                <stop offset="100%" stopColor={c} stopOpacity={0.7} />
              </linearGradient>
            );
          })}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={vertical} horizontal={!vertical} />
        {vertical ? (
          <>
            <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey={xKey} tick={AXIS_TICK} axisLine={false} tickLine={false} width={120} />
          </>
        ) : (
          <>
            <XAxis dataKey={xKey} tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} angle={data.length > 6 ? -20 : 0} textAnchor={data.length > 6 ? 'end' : 'middle'} height={data.length > 6 ? 50 : 30} />
            <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
          </>
        )}
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(99,102,241,0.06)' }} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label || s.key}
            stackId={stacked ? 'stack' : undefined}
            fill={`url(#qsbar-${s.key})`}
            radius={stacked ? 0 : (vertical ? [0, 6, 6, 0] : [6, 6, 0, 0])}
            maxBarSize={48}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Donut / pie — colored cells, center hole, legend ──────────────── */
export function QsDonut({
  data, nameKey, valueKey, height = 280, colors = QS_COLORS, innerRadius = 60, outerRadius = 100,
}: {
  data: Array<Record<string, unknown>>;
  nameKey: string;
  valueKey: string;
  height?: number;
  colors?: string[];
  innerRadius?: number;
  outerRadius?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey={valueKey}
          nameKey={nameKey}
          cx="50%"
          cy="50%"
          innerRadius={innerRadius}
          outerRadius={outerRadius}
          paddingAngle={2}
          stroke="#fff"
          strokeWidth={2}
        >
          {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

/* ── Line / area — smooth, gradient area fill, dots ────────────────── */
export function QsLineChart({
  data, xKey, series, height = 280, area = false,
}: {
  data: Array<Record<string, unknown>>;
  xKey: string;
  series: Series[];
  height?: number;
  area?: boolean;
}) {
  const Chart = area ? AreaChart : LineChart;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <Chart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
        <defs>
          {series.map((s, i) => {
            const c = s.color || QS_COLORS[i % QS_COLORS.length];
            return (
              <linearGradient key={s.key} id={`qsarea-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={c} stopOpacity={0.35} />
                <stop offset="100%" stopColor={c} stopOpacity={0.02} />
              </linearGradient>
            );
          })}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
        <XAxis dataKey={xKey} tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {series.map((s, i) => {
          const c = s.color || QS_COLORS[i % QS_COLORS.length];
          return area ? (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.label || s.key} stroke={c} strokeWidth={2} fill={`url(#qsarea-${s.key})`} dot={{ r: 3 }} activeDot={{ r: 5 }} />
          ) : (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.label || s.key} stroke={c} strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
          );
        })}
      </Chart>
    </ResponsiveContainer>
  );
}

/* ── KPI stat tile — for dashboard-style headline numbers ──────────── */
export function QsKpiTile({
  label, value, accent = QS_COLORS[0], icon,
}: {
  label: string;
  value: ReactNode;
  accent?: string;
  icon?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className="rounded-xl p-2.5" style={{ background: `${accent}1a`, color: accent }}>
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-semibold text-ink-900 tabular-nums truncate">{value}</div>
          <div className="text-xs text-muted-foreground truncate">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}
