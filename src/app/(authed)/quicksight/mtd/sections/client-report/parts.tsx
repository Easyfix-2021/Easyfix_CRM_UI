'use client';

/*
 * QuickSight — MTD Client Report: the pieces the per-client document is built
 * from that ../shared and ../report-parts do not already have.
 *
 *   DocHeading          the document's own section heading, inside the card
 *   ClientKpiTile       one of the seven tiles, with an optional sub-line
 *   CompletedBasisPanel the Completed count on BOTH date bases, side by side
 *   EscalatedSplit      where the escalations sit, under the Escalated tile
 *   DayWiseBlock        a bar chart with a trend line, and the same figures as
 *                       a per-day table with a Total column
 *
 * EVERYTHING ELSE COMES FROM ../shared — num, pct1, SectionCard, SubHeading,
 * TableFrame. This folder adds no second table kit and no second display rule.
 *
 * THERE IS NO UNWIRED PANEL IN HERE ANY MORE. It was the loud dashed placeholder
 * a section showed when none of it could be answered, and the tier matrix was
 * its last user; Escalated, SDA % and now tier are all measurements, so the
 * component went with the last call site rather than staying behind as a kit
 * nothing builds with. The rule it enforced outlives it: if a figure with no
 * backend is ever added to this document, it is shown as an explicit placeholder
 * naming the missing field and never as 0, '—' or 'n/a', because all three are
 * things a real metric says on a quiet month.
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
import { Card, CardContent } from '@/components/ui/card';
import { QS_COLORS } from '@/components/quicksight/charts';
import { cn } from '@/lib/utils';
import { LegendKey, TableFrame, num } from '../shared';
import {
  BASIS_LABEL,
  dayLabel,
  type CompletedBases,
  type DayBlock,
  type DayCell,
  type EscalatedPart,
} from './derive';

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

/*
 * The SECOND completed series — the same closures on their App CheckIn day.
 *
 * A hue of its own, not a lighter emerald: these two bars are not a whole and
 * a part, they are two different ways of counting the same jobs, and a shade
 * of the first colour would read as "some of the green ones".
 */
export const C_COMPLETED_CHECKIN = QS_COLORS[4]; // sky

/**
 * A titled caveat under a figure that needs one.
 *
 * The title is a PROP rather than a constant in here. It used to read "Basis
 * differs from the MIS." in every instance, which was true while Completed was
 * counted on one date and v2 counted it on another. It is not true any more —
 * the document now carries both bases — and a lead line that keeps asserting a
 * mismatch that has been fixed is worse than no lead line at all.
 */
function NoteBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      <span className="font-medium text-foreground">{title}</span> {children}
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
 * around an icon block, and seven icons across one row of a document reads as
 * a dashboard rather than as the Word file's KPI strip. Everything else — the
 * Card, the tabular numerals, the muted label, the sub-line under the figure —
 * is the same kit, and `note` is the same shape as the tab's own TileValue.
 *
 * `note` IS WHERE A DENOMINATOR IS NAMED, and on this row that matters: three
 * of the seven are percentages of three different things. It wraps freely and
 * the tile is `min-w-0`, so a long note softens the tile rather than pushing
 * the seven-column grid wider than its card.
 */
export function ClientKpiTile({
  label, value, note,
}: {
  label: string;
  value: ReactNode;
  /** The small line under the figure — usually the fraction the percentage came from. */
  note?: ReactNode;
}) {
  return (
    <Card className="h-full min-w-0">
      <CardContent className="flex h-full flex-col justify-center gap-1 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums text-ink-900">{value}</div>
        {note && <div className="text-xs font-medium leading-snug text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  );
}

/* ── the two figures that need more than a tile ───────────────────────────── */

/**
 * Where the escalations sit — completed, cancelled, open — under the tile.
 *
 * This exists to make the DENOMINATOR self-evident. The tile says "N% of jobs
 * in hand" and a reader's first instinct is that a quality metric ought to be
 * over completed jobs; seeing that most of the escalations are on jobs that
 * are still open answers that before it becomes a question, and makes it
 * obvious why counting them over closures would hide them.
 */
export function EscalatedSplit({ parts, total }: { parts: readonly EscalatedPart[]; total: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{num(total)} escalated</span>
      {parts.map((p) => (
        <span key={p.key}>
          {p.label} <span className="font-semibold tabular-nums text-ink-900">{num(p.count)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The Completed count on BOTH date bases, side by side.
 *
 * WHY IT IS A PANEL AND NOT AN EIGHTH TILE. The KPI strip is v2's, and it has
 * seven columns; an eighth would break the shape the owner is meant to
 * recognise, and it would put two numbers with the same label next to each
 * other in a row read left to right as one set of definitions. Here the two
 * are labelled by their date, the difference between them is stated rather
 * than left to be worked out — whenever both sides are counts — and the
 * reasons for that difference sit underneath.
 *
 * THE CHECK-IN FIGURE IS MARKED AS A FLOOR WHEN IT IS ONE. A window ending in
 * the past cannot see a job that checked in inside it and was audited after
 * it, so `floor` turns the figure into "at least N" and says why. Presenting
 * that number as v2's would invite a comparison against the owner's file that
 * is guaranteed to come up short.
 */
export function CompletedBasisPanel({ bases }: { bases: CompletedBases }) {
  const { closure, checkin, delta, floor, held, fellBack } = bases;

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
        <BasisFigure
          label={BASIS_LABEL.closure}
          value={num(closure)}
          note="The tile above, and the basis the rest of this row is counted on"
        />
        <BasisFigure
          label={BASIS_LABEL.checkin}
          value={floor ? `At least ${num(checkin)}` : num(checkin)}
          note={floor
            ? 'The MIS v2 basis — a floor for this window, not a figure to compare'
            : 'The MIS v2 basis — the figure to compare against the owner’s Word file'}
        />
        {/*
          * The difference is only shown when both sides are counts. Against a
          * FLOOR it would not be a difference at all — it would be a bound on
          * one, and a reader who took it for the gap between the two bases
          * would be reading a number that can only grow.
          */}
        {!floor && (
          <BasisFigure
            label="Difference"
            value={`${delta > 0 ? '+' : ''}${num(delta)}`}
            note={delta === 0
              ? 'The two bases agree over this window'
              : 'Jobs that checked in and closed on different sides of these dates'}
          />
        )}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Both counts are of the same closures — only the date they are placed on differs. The MIS v2 counts a
        completed job on the day the technician checked in; this tab has always counted it on the Audit and
        Checkout day, and it still does, because Completion %, TAT % and SDA % are all measured over that same
        set of closures.
        {fellBack > 0 && (
          <>
            {' '}
            {num(fellBack)} of these closures had no App CheckIn date recorded and fall back to their closure
            day on both bases, exactly as the MIS file does.
          </>
        )}
      </p>

      {floor && (
        <NoteBox title="This window ends in the past.">
          The {BASIS_LABEL.checkin} figure can only be a floor here: a job that checked in inside these dates
          but was audited after them was never read by this report at all, because the completed jobs are read
          on their closure date. Do not compare it against the owner&rsquo;s file — on the month-to-date view,
          which is what this tab opens on, the two bases cover exactly the same jobs.
        </NoteBox>
      )}

      {held.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Counted here but not on the check-in basis</span>
          {held.map((h) => (
            <span key={h.key}>
              {h.label} <span className="font-semibold tabular-nums text-ink-900">{num(h.count)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** One labelled figure inside the basis panel. */
function BasisFigure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-ink-900">{value}</div>
      <div className="max-w-xs text-xs leading-snug text-muted-foreground">{note}</div>
    </div>
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

/** One coloured line inside the day-wise tooltip. */
function TooltipRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block size-3 shrink-0 rounded-sm" style={{ background: color }} aria-hidden />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-semibold tabular-nums text-ink-900">{num(value)}</span>
    </div>
  );
}

function DayTooltip({
  active, payload, metricLabel, color, compare,
}: TooltipContentProps & { metricLabel: string; color: string; compare?: CompareSeries }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as DayCell | undefined;
  if (!row) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-semibold text-ink-900">{cellName(row)}</div>
      <TooltipRow color={color} label={metricLabel} value={row.value} />
      {compare && row.alt !== null && (
        <TooltipRow color={compare.color} label={compare.label} value={row.alt} />
      )}
      {row.partial && <div className="mt-1 text-muted-foreground">Still filling — today is not over yet.</div>}
    </div>
  );
}

/**
 * The SECOND series a day-wise block can carry: the same jobs counted on a
 * different date.
 *
 * Only the completed block has one — its closures placed on their App CheckIn
 * day. The two bars are drawn side by side rather than stacked because they
 * are not parts of a whole: every job is in both series, on whichever day each
 * basis puts it, so stacking them would double the month.
 */
export type CompareSeries = {
  /** What the second bar is called in the legend, the tooltip and the table. */
  label: string;
  color: string;
  /** The second basis's total. Not necessarily the first's — that is the point. */
  total: number;
  /** A line under the table when the second total is a floor rather than a count. */
  caveat?: ReactNode;
};

/**
 * One metric, twice: a bar per bucket with a trend line over it, and the same
 * figures beneath as a table with a Total column. With `compare`, a second bar
 * and a second table row for the same jobs counted on another date.
 *
 * THE TABLE IS TRANSPOSED, which is not how any other table on the tab is laid
 * out and is deliberate: this is the MIS Word file's own shape (one row of
 * days, one row of counts, Total at the end), and the point of this layout is
 * for the owner to recognise the document they already send.
 *
 * WHICH MAKES IT THE WIDEST TABLE ON THE PAGE. Thirty-one days is thirty-three
 * columns, roughly two thousand pixels, against a card that is about half of
 * that on a 1560px screen. It is handled exactly as the tab's other wide
 * tables are and NOT by letting the page stretch: ../shared's `TableFrame` is
 * the same scroll box they use, the basis column is frozen with the tab's own
 * `stick-col` convention so the row never loses its name, and `label` gives
 * the box a tab stop so the columns past the right edge can be reached without
 * a mouse. Nothing here may be given a width in pixels — the frame is what
 * bounds it, and a min-width on the table would push the card open instead.
 *
 * THE TREND LINE SKIPS PART DAYS AND SPANS THE GAP (`connectNulls`). A part
 * day's bar is short because the day is not over; letting the trend dive to
 * meet it would draw a fall that has not happened. It traces the FIRST series
 * only, even when a second is drawn: two trend lines over two bars is four
 * things moving at once, and the second series is here to be compared with the
 * first rather than followed on its own.
 */
export function DayWiseBlock({
  title,
  note,
  block,
  metricLabel,
  barColor,
  lineColor,
  weekly,
  compare,
}: {
  title: string;
  note?: ReactNode;
  block: DayBlock;
  /** The row label in the table, the legend and the tooltip: 'Created' / 'Closure Date'. */
  metricLabel: string;
  barColor: string;
  lineColor: string;
  weekly: boolean;
  /** The same jobs on a second date. Only the completed block passes one. */
  compare?: CompareSeries;
}) {
  const { cells, total } = block;
  const unit = weekly ? 'week' : 'day';
  /* The second series is only drawn when the cells actually carry it, so a
     caller cannot ask for a bar that would render as a row of zeroes. */
  const withCompare = compare != null && cells.some((c) => c.alt !== null);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <DocHeading note={note}>{title}</DocHeading>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <LegendKey color={barColor} label={metricLabel} value={num(total)} />
          {withCompare && compare && (
            <LegendKey color={compare.color} label={compare.label} value={num(compare.total)} />
          )}
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
            aria-label={
              `${title}: ${metricLabel} ${num(total)}`
              + (withCompare && compare ? `, ${compare.label} ${num(compare.total)}` : '')
              + ` over ${cells.length} ${weekly ? 'weeks' : 'days'}.`
            }
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
                  content={(props) => (
                    <DayTooltip
                      {...props}
                      metricLabel={metricLabel}
                      color={barColor}
                      compare={withCompare ? compare : undefined}
                    />
                  )}
                  cursor={CURSOR_FILL}
                />
                <Bar dataKey="value" name={metricLabel} fill={barColor} radius={[4, 4, 0, 0]} maxBarSize={34} />
                {withCompare && compare && (
                  <Bar
                    dataKey="alt"
                    name={compare.label}
                    fill={compare.color}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={34}
                  />
                )}
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

          <TableFrame label={`${title} per ${unit} — scrollable`}>
            <caption className="sr-only">
              {`${title} per ${unit}, with a total`}
              {withCompare && compare ? `, on both the ${metricLabel} and ${compare.label} bases` : ''}
            </caption>
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
              {withCompare && compare && (
                <tr>
                  <td className="stick-col stick-left whitespace-nowrap font-medium">{compare.label}</td>
                  {cells.map((c) => (
                    <td key={c.key} className="!text-right tabular-nums">{num(c.alt)}</td>
                  ))}
                  <td className="!text-right tabular-nums font-semibold">{num(compare.total)}</td>
                </tr>
              )}
            </tbody>
          </TableFrame>

          {withCompare && compare?.caveat && (
            <p className="text-xs leading-relaxed text-muted-foreground">{compare.caveat}</p>
          )}

          {cells.some((c) => c.partial) && (
            <p className="text-xs text-muted-foreground">
              * Still filling — that {unit} is not over yet, so its bar is short and the trend line steps over
              it.
            </p>
          )}
        </>
      )}
    </section>
  );
}
