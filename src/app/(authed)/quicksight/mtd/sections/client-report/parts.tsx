'use client';

/*
 * QuickSight — MTD Client Report: the pieces the per-client document is built
 * from that ../shared and ../report-parts do not already have.
 *
 *   UnwiredValue   what a KPI tile shows in place of a figure the backend
 *                  cannot answer
 *   UnwiredPanel   what a whole section shows when none of it can be answered
 *   BasisNote      the line a real figure carries when it is counted on a
 *                  different date from the one v2 asks for
 *   DocHeading     the document's own section heading, inside the card
 *   ClientKpiTile  one of the seven tiles, which may hold an unwired value
 *   DayWiseBlock   a bar chart with a trend line, and the same figures as a
 *                  per-day table with a Total column
 *
 * EVERYTHING ELSE COMES FROM ../shared — num, pct1, SectionCard, SubHeading,
 * TableFrame. This folder adds no second table kit and no second display rule;
 * the only thing it genuinely needed that the tab did not have is an honest
 * way to render a figure that does not exist yet.
 *
 * THE UNWIRED STATE IS DELIBERATELY LOUD. It is a dashed border, a muted
 * italic label and a tooltip that names the missing field. A reader skimming
 * the seven tiles has to be able to tell, at a glance and without hovering,
 * which of them are measurements and which are placeholders — and no rendering
 * of 0, '—' or 'n/a' does that, because all three are things a real metric
 * says on a quiet month.
 *
 * WHY recharts DIRECTLY AND NOT QsBarChart. The day-wise block is ONE chart
 * that is a bar series and a line series at once; the shared kit has a bar
 * chart and a line chart and composes neither with the other. This is the same
 * call ../TicketsCreatedVsCompletedSection made for the same reason, and it is
 * made the same way: the markup is recharts (the kit's own library, already a
 * dependency), the series colours are QS_COLORS, and the axis, grid and cursor
 * are brand tokens. No SVG is hand-rolled and no library is added.
 */

import type { ReactNode } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  type TooltipContentProps,
} from 'recharts';
import { CircleHelp } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { QS_COLORS } from '@/components/quicksight/charts';
import { cn } from '@/lib/utils';
import { LegendKey, num } from '../shared';
import { dayLabel, type DayBlock, type DayCell } from './derive';

/* Axis, grid and cursor styling — brand tokens, as ../TicketsCreatedVsCompletedSection keeps them. */
const AXIS_TICK = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };
const GRID_STROKE = 'hsl(var(--border))';
const CURSOR_FILL = { fill: 'hsl(var(--muted))', fillOpacity: 0.35 };

/*
 * The two day-wise blocks get the two hues the tab already reads Created and
 * Completed in, so a reader moving between section 1 and this document does
 * not have to re-learn the colours. Each block's trend line takes a hue of its
 * own, for the reason the MIS gives: a line drawn in its bar's colour reads as
 * the top edge of the bar rather than as a second series.
 */
export const C_CREATED = QS_COLORS[0];        // indigo
export const C_CREATED_LINE = QS_COLORS[5];   // violet
export const C_COMPLETED = QS_COLORS[1];      // emerald
export const C_COMPLETED_LINE = QS_COLORS[7]; // orange

/* ── the unwired states ───────────────────────────────────────────────────── */

/**
 * What a tile shows where a figure would be, when there is no backend for it.
 *
 * It is NOT a number and it must never be mistaken for one, so it renders as
 * words at the tile's label size rather than at its figure size: a placeholder
 * that borrows the figure's weight is a placeholder somebody will screenshot.
 */
export function UnwiredValue({ why }: { why: string }) {
  return (
    <span
      title={why}
      className="inline-flex items-center gap-1.5 text-sm font-medium italic text-muted-foreground"
    >
      <CircleHelp className="size-4 shrink-0" aria-hidden />
      Not wired yet
    </span>
  );
}

/**
 * What a whole section shows when nothing in it can be answered yet.
 *
 * The heading stays, and so does the explanation of what the section WILL
 * hold: this layout exists to be reviewed, and a section that simply vanished
 * would be reviewed as though the owner had never asked for it.
 */
export function UnwiredPanel({ title, why, children }: { title: string; why: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center">
      <p className="text-sm font-medium text-foreground">{title} — not wired yet</p>
      <p className="mx-auto mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">{why}</p>
      {children && <div className="mx-auto mt-3 max-w-prose text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

/** The line a REAL figure carries when it is counted on a different date from the one v2 asks for. */
export function BasisNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      <span className="font-medium text-foreground">Basis differs from the MIS.</span> {children}
    </p>
  );
}

/* ── the document's own furniture ─────────────────────────────────────────── */

/** A heading inside the document, matching the MIS file's numbered section heads. */
export function DocHeading({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-semibold text-ink-900">{children}</h3>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/**
 * One of the seven KPI tiles.
 *
 * Its own small card rather than QsKpiTile, for one reason: QsKpiTile is built
 * around an icon block and a figure, and half of what these tiles have to be
 * able to say is "there is no figure". A tile whose value is an UnwiredValue
 * needs the placeholder to sit at label weight beside a dashed edge, which the
 * shared tile has no way to express. Everything else — the Card, the tabular
 * numerals, the muted label — is the same kit.
 */
export function ClientKpiTile({
  label, value, unwired,
}: {
  label: string;
  value: ReactNode;
  /** Draw the tile as a placeholder: dashed edge, no filled surface. */
  unwired?: boolean;
}) {
  return (
    <Card className={cn('h-full', unwired && 'border-dashed bg-muted/20')}>
      <CardContent className="flex h-full flex-col justify-center gap-1 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={cn('text-xl font-semibold tabular-nums text-ink-900', unwired && 'font-normal')}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── the day-wise block ───────────────────────────────────────────────────── */

/** What one bucket is called in a tooltip and a column head. */
function cellName(c: DayCell): string {
  return c.from === c.to ? dayLabel(c.from) : `${dayLabel(c.from)} – ${dayLabel(c.to)}`;
}

/** The short label the axis and the table head use — '22 Sep', without the year. */
function shortName(c: DayCell): string {
  return cellName(c).replace(/ \d{4}/g, '');
}

function DayTooltip({ active, payload, metricLabel, color }: TooltipContentProps & { metricLabel: string; color: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as DayCell | undefined;
  if (!row) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-semibold text-ink-900">{cellName(row)}</div>
      <div className="flex items-center gap-2">
        <span className="inline-block size-3 shrink-0 rounded-sm" style={{ background: color }} aria-hidden />
        <span className="text-muted-foreground">{metricLabel}</span>
        <span className="ml-auto font-semibold tabular-nums text-ink-900">{num(row.value)}</span>
      </div>
      {row.partial && <div className="mt-1 text-muted-foreground">Still filling — today is not over yet.</div>}
    </div>
  );
}

/**
 * One metric, twice: a bar per bucket with a trend line over it, and the same
 * figures beneath as a table with a Total column.
 *
 * THE TABLE IS TRANSPOSED, which is not how any other table on the tab is laid
 * out and is deliberate: this is the MIS Word file's own shape (one row of
 * days, one row of counts, Total at the end), and the point of this layout is
 * for the owner to recognise the document they already send. It scrolls
 * sideways with the metric name frozen, using the tab's own `stick-col`
 * convention, so a thirty-one-day month does not squeeze the figures to
 * nothing.
 *
 * THE TREND LINE SKIPS PART DAYS AND SPANS THE GAP (`connectNulls`). A part
 * day's bar is short because the day is not over; letting the trend dive to
 * meet it would draw a fall that has not happened.
 */
export function DayWiseBlock({
  title,
  note,
  block,
  metricLabel,
  barColor,
  lineColor,
  weekly,
}: {
  title: string;
  note?: ReactNode;
  block: DayBlock;
  /** The row label in the table, the legend and the tooltip: 'Created' / 'Completed'. */
  metricLabel: string;
  barColor: string;
  lineColor: string;
  weekly: boolean;
}) {
  const { cells, total } = block;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <DocHeading note={note}>{title}</DocHeading>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <LegendKey color={barColor} label={metricLabel} value={num(total)} />
          <LegendKey color={lineColor} label="Trend" line />
        </div>
      </div>

      {cells.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No {weekly ? 'weeks' : 'days'} in this range — there is nothing to plot.
        </p>
      ) : (
        <>
          <div
            role="img"
            aria-label={`${title}: ${num(total)} over ${cells.length} ${weekly ? 'weeks' : 'days'}.`}
          >
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={cells} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
                <XAxis
                  dataKey="key"
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={8}
                  tickFormatter={(v: string) => dayLabel(v).replace(/ \d{4}$/, '')}
                />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip
                  content={(props) => <DayTooltip {...props} metricLabel={metricLabel} color={barColor} />}
                  cursor={CURSOR_FILL}
                />
                <Bar dataKey="value" name={metricLabel} fill={barColor} radius={[4, 4, 0, 0]} maxBarSize={34} />
                {/* connectNulls: the nulls are the part days the line steps
                    over, not days the data is missing. */}
                <Line
                  type="monotone"
                  dataKey="trend"
                  name="Trend"
                  stroke={lineColor}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <table className="data-table w-full">
              <caption className="sr-only">{`${title} per ${weekly ? 'week' : 'day'}, with a total`}</caption>
              <thead>
                <tr>
                  <th className="stick-col-head stick-left !text-left">{weekly ? 'Week' : 'Day'}</th>
                  {cells.map((c) => (
                    <th key={c.key} className="!text-right whitespace-nowrap" title={cellName(c)}>
                      {shortName(c)}
                      {c.partial && <span className="text-muted-foreground"> *</span>}
                    </th>
                  ))}
                  <th className="!text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="stick-col stick-left whitespace-nowrap font-medium">{metricLabel}</td>
                  {cells.map((c) => (
                    <td key={c.key} className="!text-right tabular-nums">{num(c.value)}</td>
                  ))}
                  <td className="!text-right tabular-nums font-semibold">{num(total)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {cells.some((c) => c.partial) && (
            <p className="text-xs text-muted-foreground">
              * Still filling — that {weekly ? 'week' : 'day'} is not over yet, so its bar is short and the trend
              line steps over it.
            </p>
          )}
        </>
      )}
    </section>
  );
}
