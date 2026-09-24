'use client';

/*
 * QuickSight — MTD Client Report, sections 5, 6 and 7: Why Cancelled.
 *
 *   5  Why Cancelled              the card, and the days-open scope it is read in
 *   6  Top Cancel Reasons         the reason PICKED on each cancelled job
 *   7  What The Comments Say      the same jobs grouped by what the comment says
 *
 * One card with two sub-blocks, as the MIS report has it: the two lists answer
 * the same question from two different columns of the export, and reading them
 * side by side is the point. A job's picked reason and what its comment
 * actually says routinely disagree, which is the most useful thing on the card.
 *
 * THE DAYS-OPEN CLICK COSTS NO REQUEST. Section 4's tiles (the card above) let
 * a reader tick one or more days-open bands, and this card then narrows to the
 * cancellations inside them. That works entirely in memory because every entry
 * arrives with `byBucket` — its count split across the four bands — so
 * narrowing is a re-total and a re-sort of numbers the page already holds. The
 * parent owns the selection; this card only reads it and offers to clear it.
 *
 * Ticking ALL FOUR bands is the same as ticking none, and is treated as no
 * filter at all — the MIS template clears the selection at that point, and a
 * chip reading "Days open: 0–2 days, 3–5 days, 6–9 days, Over 9 days" would
 * claim a narrowing that is not one.
 *
 * THE TOP-7 RULE IS OURS, NOT THE SERVER'S. The backend sends every reason and
 * every theme, sorted. A chart with forty bars is unreadable, so beyond eight
 * entries the chart shows the top seven and rolls the remainder into a single
 * "All other reasons (n)" bar — exactly as the MIS report does. THE FULL LIST
 * IS ALWAYS UNDER THE CHART, in the table, where nothing is rolled up: the
 * chart is the summary, the table is the record.
 *
 * PERCENTAGES ARE AGAINST THE CURRENT SCOPE. Every share on this card is out
 * of the cancellations in the days-open bands being shown, not out of every
 * cancellation in the window — so the shares on screen always add to 100%.
 */

import { useMemo } from 'react';
import { QsBarChart, QS_COLORS, QS_SEMANTIC } from '@/components/quicksight/charts';
import type { MtdByDaysOpen, MtdCancelEntry, MtdChecks, MtdWhyCancelled } from '../types';
import { LocalTable, SectionCard, SubHeading, num, type Column } from './shared';
import { ReconcileNote, ScopeChip } from './report-parts';

/*
 * Cancellations read as the bad half of the report everywhere else on the tab,
 * so the reason bars take the same red. The comment themes are a different cut
 * of the SAME jobs, not a second metric, so they take a plainly different hue
 * rather than a second shade of red that would imply a comparison.
 */
const C_REASON = QS_SEMANTIC.bad;
const C_THEME = QS_COLORS[5];

/** Beyond this many entries the chart rolls up; `TOP_N` of them stay as themselves. */
const ROLLUP_ABOVE = 8;
const TOP_N = 7;

/** One entry re-totalled for the days-open bands currently being shown. */
type ScopedEntry = {
  name: string;
  total: number;
  /** Share of the cancellations in scope; null when there are none to share. */
  sharePct: number | null;
};

/** One bar of the chart: an entry, or the rolled-up remainder. */
type BarRow = { name: string; jobs: number };

/** The backend's own rounding, so a figure computed here matches one sent from there. */
const shareOf = (value: number, den: number): number | null => (
  den > 0 ? Math.round((value / den) * 1000) / 10 : null
);

const pctText = (p: number | null) => (p === null ? '–' : `${p.toFixed(1)}%`);

/**
 * Re-total a list for a subset of the days-open bands.
 *
 * `indices` null means every band, and the server's own order (total
 * descending, ties by name) already holds — the totals are taken as sent.
 * Otherwise every entry is summed over the chosen bands, entries that fall to
 * zero are DROPPED (a reason with no cancellations in the chosen bands is not
 * a row with a zero in it, it is not a row), and the survivors are re-sorted
 * by the same rule the server sorts by, so the two orders never differ.
 */
function scopeEntries(
  entries: readonly MtdCancelEntry[],
  indices: readonly number[] | null,
  scopeTotal: number,
): ScopedEntry[] {
  const totals = indices === null
    ? entries.map((e) => ({ name: e.name, total: e.total }))
    : entries
      .map((e) => ({ name: e.name, total: indices.reduce((s, i) => s + (e.byBucket[i] ?? 0), 0) }))
      .filter((e) => e.total > 0)
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return totals.map((e) => ({ ...e, sharePct: shareOf(e.total, scopeTotal) }));
}

/** The chart's bars: the top seven and, past eight entries, the rest as one. */
function barRows(entries: readonly ScopedEntry[], restLabel: string): BarRow[] {
  if (entries.length <= ROLLUP_ABOVE) return entries.map((e) => ({ name: e.name, jobs: e.total }));
  const rest = entries.slice(TOP_N).reduce((s, e) => s + e.total, 0);
  return [
    ...entries.slice(0, TOP_N).map((e) => ({ name: e.name, jobs: e.total })),
    { name: `${restLabel} (${entries.length - TOP_N})`, jobs: rest },
  ];
}

/*
 * A horizontal bar per entry, so the longest label still fits on its own line.
 * The height grows with the number of bars rather than squeezing them into a
 * fixed box — eight bars in a 280px chart are four pixels of bar and seven of
 * gap.
 */
const chartHeight = (bars: number) => Math.max(160, bars * 34 + 48);

/** One sub-block: the heading, the bars, and the full list under them. */
function CancelList({
  heading,
  hint,
  entries,
  scopeTotal,
  restLabel,
  firstColumn,
  colour,
  swatchOf,
  emptyText,
}: {
  heading: string;
  hint: string;
  entries: ScopedEntry[];
  scopeTotal: number;
  restLabel: string;
  firstColumn: string;
  colour: string;
  /** A stable colour for this name, where the list has one (the themes do). */
  swatchOf?: (name: string) => string | null;
  emptyText: string;
}) {
  const bars = useMemo(() => barRows(entries, restLabel), [entries, restLabel]);

  const columns: ReadonlyArray<Column<ScopedEntry>> = [
    {
      key: 'name',
      label: firstColumn,
      wrap: true,
      render: (r) => {
        const swatch = swatchOf?.(r.name) ?? null;
        return (
          <span className="inline-flex items-center gap-2">
            {swatch && <span className="size-2.5 shrink-0 rounded-sm" style={{ background: swatch }} aria-hidden />}
            <span title={r.name}>{r.name}</span>
          </span>
        );
      },
    },
    { key: 'total', label: 'Jobs', align: 'right', render: (r) => num(r.total) },
    { key: 'sharePct', label: '% Of Scope', align: 'right', render: (r) => pctText(r.sharePct) },
  ];

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <SubHeading>{heading}</SubHeading>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {entries.length === 0 ? (
        <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <>
          <QsBarChart
            data={bars}
            xKey="name"
            layout="vertical"
            height={chartHeight(bars.length)}
            series={[{ key: 'jobs', label: 'Jobs', color: colour }]}
          />
          {entries.length > ROLLUP_ABOVE && (
            <p className="text-xs text-muted-foreground">
              The chart shows the top {TOP_N} and rolls the remaining {num(entries.length - TOP_N)} into one bar.
              Every one of them is in the table below.
            </p>
          )}
          <LocalTable<ScopedEntry>
            rows={entries}
            columns={columns}
            rowKey={(r) => r.name}
            emptyText={emptyText}
            pageSize={10}
            footer={(
              <tr>
                <td className="border-t-2 border-border bg-muted/60 font-semibold">Total</td>
                <td className="border-t-2 border-border bg-muted/60 !text-right font-semibold tabular-nums">
                  {num(scopeTotal)}
                </td>
                <td className="border-t-2 border-border bg-muted/60 !text-right font-semibold tabular-nums">
                  {scopeTotal > 0 ? '100.0%' : '–'}
                </td>
              </tr>
            )}
          />
        </>
      )}
    </div>
  );
}

export function WhyCancelledSection({
  whyCancelled,
  byDaysOpen,
  checks,
  selectedBuckets,
  onClearBuckets,
}: {
  whyCancelled: MtdWhyCancelled;
  byDaysOpen: MtdByDaysOpen;
  checks?: MtdChecks;
  /**
   * The days-open band keys ticked in section 4. Empty (or every band) is no
   * narrowing at all. Optional so the card renders correctly before the tiles
   * are wired to it.
   */
  selectedBuckets?: readonly string[];
  onClearBuckets?: () => void;
}) {
  const bands = whyCancelled.buckets;

  /*
   * The selection, reduced to a VALUE the memos below can depend on.
   *
   * A caller is free to hand this prop a fresh array on every render. If the
   * memos keyed on that array's identity, every render would produce new
   * `reasons` and `themes` arrays, and the tables under them return to page
   * one whenever their rows array changes — a loop that no parent should be
   * able to cause by writing `selectedBuckets={[...picked]}`.
   */
  const selectedKey = JSON.stringify([...(selectedBuckets ?? [])].sort());
  const picked = useMemo(() => new Set<string>(JSON.parse(selectedKey) as string[]), [selectedKey]);

  /*
   * Which band positions are in scope, and what they are called.
   *
   * Only keys the report actually sent count — a stale selection left over
   * from a previous window must narrow to nothing rather than to a band that
   * no longer exists. All four selected is no filter, as above.
   */
  const scope = useMemo(() => {
    const indices = bands.map((b, i) => (picked.has(b.key) ? i : -1)).filter((i) => i >= 0);
    const active = indices.length > 0 && indices.length < bands.length;
    return {
      active,
      indices: active ? indices : null,
      label: indices.map((i) => bands[i].label).join(', '),
      /*
       * The header count: the cancellations in the chosen bands, taken from
       * section 3's own totals rather than re-summed here, so the two cards can
       * never print different numbers for the same bands.
       */
      cancelled: active
        ? indices.reduce((s, i) => s + (byDaysOpen.buckets[i]?.cancelled ?? 0), 0)
        : whyCancelled.cancelled,
    };
  }, [bands, byDaysOpen.buckets, picked, whyCancelled.cancelled]);

  const reasons = useMemo(
    () => scopeEntries(whyCancelled.reasons, scope.indices, scope.cancelled),
    [whyCancelled.reasons, scope.indices, scope.cancelled],
  );
  const themes = useMemo(
    () => scopeEntries(whyCancelled.themes, scope.indices, scope.cancelled),
    [whyCancelled.themes, scope.indices, scope.cancelled],
  );

  /*
   * A theme keeps ONE colour for the life of the tab, taken from its position
   * in the engine's own fourteen-name list rather than from its rank in this
   * window. A theme that is third this month and ninth next month is the same
   * theme, and a swatch that moved would say otherwise.
   */
  const themeColour = useMemo(() => {
    const at = new Map(whyCancelled.themeNames.map((name, i) => [name, QS_COLORS[i % QS_COLORS.length]]));
    return (name: string) => at.get(name) ?? null;
  }, [whyCancelled.themeNames]);

  const subtitle = scope.active
    ? `${num(scope.cancelled)} of ${num(whyCancelled.cancelled)} cancelled jobs · open ${scope.label.toLowerCase()}`
    : `${num(whyCancelled.cancelled)} cancelled jobs in view`;

  const empty = scope.active ? 'No cancellations in these days-open bands.' : 'No cancellations in this view.';

  return (
    <SectionCard
      title="5. Why Cancelled"
      subtitle={subtitle}
      tools={scope.active ? (
        <ScopeChip
          label="Days open:"
          value={scope.label}
          onClear={onClearBuckets}
          clearLabel="Clear the days open filter"
        />
      ) : undefined}
    >
      <ReconcileNote checks={checks} keys={['reasons', 'themes', 'cancelBands']} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <CancelList
          heading="6. Top Cancel Reasons"
          hint="From the cancel reason picked on each job"
          entries={reasons}
          scopeTotal={scope.cancelled}
          restLabel="All other reasons"
          firstColumn="Cancel Reason"
          colour={C_REASON}
          emptyText={empty}
        />
        <CancelList
          heading="7. What The Comments Say"
          hint="Cancel comments grouped into themes by keyword"
          entries={themes}
          scopeTotal={scope.cancelled}
          restLabel="All other themes"
          firstColumn="Comment Theme"
          colour={C_THEME}
          swatchOf={themeColour}
          emptyText={empty}
        />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        A cancelled job with no reason picked is the row{' '}
        <span className="font-medium text-foreground">(No reason picked)</span> rather than a job left out, and
        a comment with no usable text counts as{' '}
        <span className="font-medium text-foreground">No reason in comment</span>. Both lists cover the same
        cancelled jobs from two different columns of the export, so each adds up to {num(scope.cancelled)} —
        a job&rsquo;s picked reason and what its comment says need not agree.
      </p>
    </SectionCard>
  );
}
