'use client';

/*
 * QuickSight — MTD, section 1: Tickets created vs completed.
 *
 * The MIS report's first card, rebuilt over live data. It plots, per day (or
 * per Monday-start week once the range is wider than MAX_DAY_BUCKETS days):
 *
 *   - GROUPED BARS   tickets created, by ticket-created date, and jobs
 *                    completed, by checkout date
 *   - A LINE PER BAR SERIES, joining the same two numbers, so the shape of the
 *                    month is readable across bars that are individually short
 *   - A SECOND LINE ON ITS OWN RIGHT-HAND AXIS: the OPEN BACKLOG at the end of
 *                    each bucket's last day. It is on its own scale because it
 *                    is a stock, not a flow — it is routinely an order of
 *                    magnitude larger than a single day's bars, and sharing
 *                    their axis would flatten both.
 *   - A DASHED FORECAST for the next day, the average of the last two COMPLETE
 *                    buckets.
 *
 * TWO THINGS THE CHART MUST NOT DO, AND THE BACKEND HAS ALREADY DECIDED BOTH.
 *
 *   A bucket whose `open` is null is a GAP IN THE LINE, never a zero. Those
 *   days are before the earliest closure the window holds, so the backlog for
 *   them cannot be reconstructed from these jobs at all — drawing them as zero
 *   would invent a history the data does not have. `connectNulls` is off on
 *   that line for exactly this reason.
 *
 *   The forecast is NOT one of `daily.buckets`. It is drawn as its own dashed
 *   series so nothing can mistake it for a day that happened: it either lands
 *   on today's part-day bar (`beyondRange` false) or on the day after the
 *   range (`beyondRange` true), and in the second case it is the one extra
 *   category on the axis.
 *
 * WHY recharts DIRECTLY AND NOT QsBarChart / QsLineChart. The shared kit
 * (@/components/quicksight/charts) has a bar chart and a line chart, and this
 * card is one chart that is both at once plus a second Y axis — no component
 * in the kit composes those, and splitting the card into two charts would
 * break the one thing it exists to show (created, completed and backlog read
 * against the same days). So the MARKUP is recharts, which is the kit's own
 * charting library and already a dependency, and everything else comes from
 * the kit and the brand: the series palette is QS_COLORS / QS_SEMANTIC, and
 * the axis, grid and cursor styling are brand tokens. No SVG is hand-rolled
 * and no library is added.
 */

import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  type TooltipContentProps,
} from 'recharts';
import { Table2 } from 'lucide-react';
import { QS_COLORS, QS_SEMANTIC } from '@/components/quicksight/charts';
import { Button } from '@/components/ui/button';
import { MAX_DAY_BUCKETS } from '../api';
import type { MtdDaily, MtdDailyBucket } from '../types';
import { LegendKey, LocalTable, SectionCard, num, type Column } from './shared';

/*
 * Axis, grid and cursor styling.
 *
 * The shared kit (components/quicksight/charts.tsx) keeps its equivalents
 * private, so they cannot be imported; they are expressed here as BRAND TOKENS
 * rather than copied as the hex literals that file is allowed to hold. That is
 * the house rule (scripts/check-brand-tokens.js) and it is also better for the
 * chart: a token follows the theme, where a copied slate hex would stay light
 * grey when everything around it went dark.
 */
const AXIS_TICK = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };
const GRID_STROKE = 'hsl(var(--border))';
/** The band that highlights under the pointer — the muted surface, kept faint. */
const CURSOR_FILL = { fill: 'hsl(var(--muted))', fillOpacity: 0.35 };

/*
 * The series colours, from the QuickSight palette only — the MIS report's own
 * greens and pinks are not copied. The two bar hues are the two the palette
 * leads with, the two line hues are deliberately different from their bars
 * (the MIS draws the lines in their own colours so a line is never mistaken
 * for the top edge of its bar), the backlog gets the pink that nothing else
 * on the tab uses, and the forecast is the palette's neutral because it is the
 * one series that is not a measurement.
 */
const C_CREATED = QS_COLORS[0];        // indigo
const C_COMPLETED = QS_COLORS[1];      // emerald
const C_CREATED_LINE = QS_COLORS[5];   // violet
const C_COMPLETED_LINE = QS_COLORS[7]; // orange
const C_OPEN = QS_COLORS[8];           // pink
const C_FORECAST = QS_SEMANTIC.neutral;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' → '4 Sep'. Never builds a Date: no browser timezone can move the day. */
function dayMon(ymd: string): string {
  const [, m, d] = ymd.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m}`;
}

/** 'YYYY-MM-DD' → '4 Sep 2026'. */
function dayMonYear(ymd: string): string {
  return `${dayMon(ymd)} ${ymd.slice(0, 4)}`;
}

/** What one bucket is called in a tooltip, a table row and a screen reader. */
function bucketName(from: string, to: string): string {
  return from === to ? dayMonYear(from) : `${dayMon(from)} – ${dayMonYear(to)}`;
}

/*
 * One row of the chart's data.
 *
 * `x` is the bucket's first day, which is UNIQUE — it is the category key, so
 * two 15ths in a two-month day view can never collapse into one band. The axis
 * shows a short label through a tick formatter instead.
 *
 * `fcCreated` / `fcCompleted` are non-null on exactly two rows: the last
 * complete bucket (the anchor the dashed segment starts from, carrying that
 * bucket's real value) and the forecast day itself.
 */
type ChartRow = {
  x: string;
  name: string;
  created: number | null;
  completed: number | null;
  open: number | null;
  partial: boolean;
  isForecast: boolean;
  fcCreated: number | null;
  fcCompleted: number | null;
};

function buildRows(daily: MtdDaily): ChartRow[] {
  const rows: ChartRow[] = daily.buckets.map((b) => ({
    x: b.from,
    name: bucketName(b.from, b.to),
    created: b.created,
    completed: b.completed,
    open: b.open,
    partial: b.partial,
    isForecast: false,
    fcCreated: null,
    fcCompleted: null,
  }));

  const fc = daily.forecast;
  if (!fc) return rows;

  /*
   * The dashed segment runs from the LAST BUCKET THE AVERAGE WAS TAKEN OVER to
   * the forecast day. `basisDays` names those buckets by their last day, so
   * the anchor is found from the contract rather than guessed at by counting
   * backwards from the end and hoping the partial bar is where we think it is.
   */
  const anchorTo = fc.basisDays[fc.basisDays.length - 1];
  const anchor = rows.find((r) => r.x === anchorTo || daily.buckets.some((b) => b.from === r.x && b.to === anchorTo));
  if (anchor) {
    anchor.fcCreated = anchor.created;
    anchor.fcCompleted = anchor.completed;
  }

  // beyondRange false: the forecast lands on a bucket already on the axis
  // (today's part-day bar). True: it is one more category after the range.
  const landing = rows.find((r) => r.x === fc.day);
  if (landing) {
    landing.fcCreated = fc.created;
    landing.fcCompleted = fc.completed;
  } else {
    rows.push({
      x: fc.day,
      name: `${dayMonYear(fc.day)} (forecast)`,
      created: null,
      completed: null,
      open: null,
      partial: false,
      isForecast: true,
      fcCreated: fc.created,
      fcCompleted: fc.completed,
    });
  }
  return rows;
}

/* ── tooltip ──────────────────────────────────────────────────────────────── */

function TooltipLine({ color, label, value, dashed }: { color: string; label: string; value: string; dashed?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-block w-3 shrink-0 rounded"
        style={{ borderTopWidth: 3, borderTopStyle: dashed ? 'dashed' : 'solid', borderTopColor: color }}
        aria-hidden
      />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-semibold tabular-nums text-ink-900">{value}</span>
    </div>
  );
}

/**
 * The tooltip is rendered from the ROW, not from recharts' payload list.
 *
 * Two of the series share a dataKey with a bar (the lines that trace them) and
 * two are non-null on only two rows (the forecast), so the raw payload would
 * repeat some numbers and print blanks for others. Reading the row once gives
 * one honest block per bucket — and it is the only place that can say "still
 * filling" about the part-day bar.
 */
function DailyTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as ChartRow | undefined;
  if (!row) return null;

  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-semibold text-ink-900">{row.name}</div>
      <div className="space-y-0.5">
        {row.isForecast ? (
          <>
            <TooltipLine color={C_FORECAST} label="Created (forecast)" value={num(row.fcCreated)} dashed />
            <TooltipLine color={C_FORECAST} label="Completed (forecast)" value={num(row.fcCompleted)} dashed />
          </>
        ) : (
          <>
            <TooltipLine color={C_CREATED} label="Created" value={num(row.created)} />
            <TooltipLine color={C_COMPLETED} label="Completed" value={num(row.completed)} />
            <TooltipLine
              color={C_OPEN}
              label="Open at end of day"
              /* null is a gap, not a zero — say why rather than printing one. */
              value={row.open === null ? 'not known' : num(row.open)}
            />
          </>
        )}
      </div>
      {row.partial && <div className="mt-1 text-muted-foreground">Still filling — today is not over yet.</div>}
    </div>
  );
}

/* ── the table behind the chart ───────────────────────────────────────────── */

type TableRow = MtdDailyBucket & { name: string };

const TABLE_COLUMNS: ReadonlyArray<Column<TableRow>> = [
  { key: 'name', label: 'Period', sticky: true },
  { key: 'created', label: 'Created', align: 'right', render: (r) => num(r.created) },
  { key: 'completed', label: 'Completed', align: 'right', render: (r) => num(r.completed) },
  {
    key: 'open',
    label: 'Open At End',
    align: 'right',
    // The same null the line leaves a gap for. An em dash, never a zero.
    render: (r) => (r.open === null ? '—' : num(r.open)),
  },
];

/* ── the section ──────────────────────────────────────────────────────────── */

export function TicketsCreatedVsCompletedSection({ daily }: { daily: MtdDaily }) {
  const [showTable, setShowTable] = useState(false);
  const rows = useMemo(() => buildRows(daily), [daily]);
  const tableRows = useMemo<TableRow[]>(
    () => daily.buckets.map((b) => ({ ...b, name: bucketName(b.from, b.to) })),
    [daily.buckets],
  );

  const weekly = daily.granularity === 'week';
  const fc = daily.forecast;
  const hasOpenLine = daily.buckets.some((b) => b.open !== null);

  const subtitle = weekly
    ? `Week-wise (the range is longer than ${MAX_DAY_BUCKETS} days) · created by ticket created date, completed by closure date`
    : 'Day-wise · created by ticket created date, completed by closure date';

  const tools = (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <LegendKey color={C_CREATED} label="Created" value={num(daily.totals.created)} />
        <LegendKey color={C_COMPLETED} label="Completed" value={num(daily.totals.completed)} />
        <LegendKey color={C_CREATED_LINE} label="Created line" line />
        <LegendKey color={C_COMPLETED_LINE} label="Completed line" line />
        {hasOpenLine && <LegendKey color={C_OPEN} label="Open jobs (right scale)" line />}
        {fc && <LegendKey color={C_FORECAST} label="Forecast" line dashed />}
      </div>
      <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setShowTable((s) => !s)}>
        <Table2 className="size-4" />
        {showTable ? 'Hide table' : 'Show table'}
      </Button>
    </>
  );

  return (
    <SectionCard title="Tickets Created Vs Completed" subtitle={subtitle} tools={tools}>
      {fc && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Forecast for {dayMonYear(fc.day)}</span>
          {' · '}created <span className="font-semibold tabular-nums text-ink-900">{fc.created.toFixed(1)}</span>
          {', '}completed <span className="font-semibold tabular-nums text-ink-900">{fc.completed.toFixed(1)}</span>
          {' — the average of the last '}{fc.window}{' complete '}{weekly ? 'weeks' : 'days'}
          {' ('}{fc.basisDays.map(dayMon).join(', ')}{'). '}
          {fc.beyondRange
            ? 'It is the day after this range, so it is the last point on the chart.'
            : 'It lands on today, which is still filling, so the dashed line ends on that bar.'}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No days in this range — nothing was created and nothing was completed.
        </p>
      ) : (
        <div
          role="img"
          aria-label={
            `Tickets created and completed per ${weekly ? 'week' : 'day'}: `
            + `${num(daily.totals.created)} created, ${num(daily.totals.completed)} completed over `
            + `${rows.length} ${weekly ? 'weeks' : 'days'}.`
          }
        >
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="x"
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                minTickGap={8}
                tickFormatter={dayMon}
              />
              <YAxis yAxisId="left" tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
              {/* The backlog's own scale — a stock beside two flows. Hidden
                  entirely when no bucket can carry a backlog at all. */}
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
                hide={!hasOpenLine}
              />
              <Tooltip content={(props) => <DailyTooltip {...props} />} cursor={CURSOR_FILL} />

              <Bar yAxisId="left" dataKey="created" name="Created" fill={C_CREATED} radius={[4, 4, 0, 0]} maxBarSize={36} />
              <Bar yAxisId="left" dataKey="completed" name="Completed" fill={C_COMPLETED} radius={[4, 4, 0, 0]} maxBarSize={36} />

              <Line yAxisId="left" type="monotone" dataKey="created" name="Created line" stroke={C_CREATED_LINE} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
              <Line yAxisId="left" type="monotone" dataKey="completed" name="Completed line" stroke={C_COMPLETED_LINE} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />

              {/* connectNulls STAYS FALSE: a null backlog is a day we cannot
                  reconstruct, and bridging it would draw a history the data
                  does not support. */}
              {hasOpenLine && (
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="open"
                  name="Open jobs"
                  stroke={C_OPEN}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                />
              )}

              {/* The two dashed segments. connectNulls IS true here, and only
                  here: these series are non-null on exactly the two rows the
                  segment joins, so the nulls between them are the segment. */}
              {fc && (
                <>
                  <Line yAxisId="left" type="linear" dataKey="fcCreated" name="Created forecast" stroke={C_CREATED_LINE} strokeWidth={2.5} strokeDasharray="6 5" dot={{ r: 3 }} connectNulls />
                  <Line yAxisId="left" type="linear" dataKey="fcCompleted" name="Completed forecast" stroke={C_COMPLETED_LINE} strokeWidth={2.5} strokeDasharray="6 5" dot={{ r: 3 }} connectNulls />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {showTable && (
        <LocalTable<TableRow>
          rows={tableRows}
          columns={TABLE_COLUMNS}
          rowKey={(r) => r.from}
          emptyText="No days in this range."
          scroll
        />
      )}
    </SectionCard>
  );
}
