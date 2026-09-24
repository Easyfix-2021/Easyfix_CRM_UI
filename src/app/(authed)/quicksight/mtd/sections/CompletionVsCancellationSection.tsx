'use client';

/*
 * QuickSight — MTD, sections 2, 3 and 4, in ONE card, because that is what the
 * MIS report is: "Completion vs cancellation" is a single card holding the
 * donut, the days-open bars and the days-open breakdown side by side, and the
 * three only make sense read together.
 *
 *   2  Completion vs cancellation   donut: completed vs cancelled
 *   3  By days open                 grouped bars, four bands, two series
 *   4  Days open breakdown          the same four numbers as tiles, with the
 *                                   cancel rate and a meter, plus an All days
 *                                   tile over the totals
 *
 * FINISHED JOBS ONLY, ALL THREE OF THEM. Open jobs are in none of this — the
 * days-open bands are the export's Aging column, which is the run from ticket
 * to closure or cancellation, so a job that has not closed has no value to
 * band. Sections 9 and 10 are where open jobs are aged, against a different
 * set of six bands on purpose.
 *
 * THE DONUT'S RATE IS NOT THE COMPLETION % TILE, and the card says so on
 * screen. `completionVsCancellation.completionRate` is completed / (completed
 * + cancelled) — finished jobs only. `kpis.completionPct` is (completed +
 * open) / everything in hand. The donut's number is always the higher one.
 * Both are correct, they answer different questions, and nothing here tries to
 * reconcile them.
 *
 * THE TILES ARE THE FILTER FOR SECTIONS 5 TO 7. Clicking a band narrows "Why
 * cancelled" below to the jobs that stayed open that long. The selection lives
 * in the body (MtdBody) because two cards share it, and it never refetches:
 * every reason and theme arrives with its own per-band breakdown, so the
 * narrowing is a client-side re-sum.
 *
 * Charts are the shared kit's (@/components/quicksight/charts) — QsDonut and
 * QsBarChart — in the QuickSight palette. The MIS chart TYPES are matched; its
 * colours and its markup are not copied.
 */

import { useMemo } from 'react';
import { Check } from 'lucide-react';
import { QsBarChart, QsDonut, QS_SEMANTIC } from '@/components/quicksight/charts';
import { cn } from '@/lib/utils';
import type { MtdByDaysOpen, MtdCompletionVsCancellation, MtdDaysOpenBucket } from '../types';
import { LegendKey, SectionCard, SubHeading, num, pct1, NO_VALUE } from './shared';

/*
 * Completed is the palette's "good" and cancelled its "bad" — the same two
 * semantic colours the Employee tab gives the same two ideas, so a reader
 * moving between tabs does not have to relearn which half of a chart is which.
 */
const C_COMPLETED = QS_SEMANTIC.good;
const C_CANCELLED = QS_SEMANTIC.bad;

/**
 * A bare ratio as a percentage, with the same rule the API's own percentages
 * follow: a zero denominator is an en dash, never 0%.
 *
 * Used only for the two figures the insight line derives itself (what share of
 * ALL cancellations fell in one band), which the API does not pre-compute.
 */
function ratio1(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : NO_VALUE;
}

/* ── section 4: one days-open tile ────────────────────────────────────────── */

function AgeTile({
  label, completed, cancelled, rateText, rateWidth, pressed, worst, onClick,
}: {
  label: string;
  completed: number;
  cancelled: number;
  rateText: string;
  /** 0 to 1 — the meter under the counts. */
  rateWidth: number;
  pressed: boolean;
  worst: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors',
        'hover:border-muted-foreground/50',
        pressed ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border bg-card',
      )}
      title={
        `${label}: ${num(cancelled)} cancelled, ${num(completed)} completed, cancel rate ${rateText}. `
        + (pressed ? 'Selected — click to clear.' : 'Click to narrow Why Cancelled to these jobs.')
      }
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'grid size-4 shrink-0 place-items-center rounded border',
            pressed ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
          )}
          aria-hidden
        >
          {pressed && <Check className="size-3" />}
        </span>
        <span className="truncate text-sm font-semibold text-ink-900">{label}</span>
        <span
          className={cn('ml-auto shrink-0 text-sm font-semibold tabular-nums', worst ? 'text-urgent-strong' : 'text-ink-900')}
          title="Cancel rate"
        >
          {rateText}
        </span>
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        <span className="font-semibold text-ink-700">{num(cancelled)}</span> cancelled
        {' · '}
        <span className="font-semibold text-ink-700">{num(completed)}</span> completed
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className="block h-full rounded-full" style={{ width: `${(rateWidth * 100).toFixed(1)}%`, background: C_CANCELLED }} />
      </span>
    </button>
  );
}

/* ── the card ─────────────────────────────────────────────────────────────── */

export function CompletionVsCancellationSection({
  completionVsCancellation: cvc,
  byDaysOpen,
  selectedBuckets,
  onToggleBucket,
}: {
  completionVsCancellation: MtdCompletionVsCancellation;
  byDaysOpen: MtdByDaysOpen;
  /** Days-open bucket keys currently narrowing sections 5 to 7. Empty = all days. */
  selectedBuckets: readonly string[];
  /** A bucket key toggles it; null is the All days tile and clears the selection. */
  onToggleBucket: (key: string | null) => void;
}) {
  const donutData = useMemo(
    () => [
      { name: 'Completed', value: cvc.completed },
      { name: 'Cancelled', value: cvc.cancelled },
    ],
    [cvc.completed, cvc.cancelled],
  );

  const bandData = useMemo(
    () => byDaysOpen.buckets.map((b: MtdDaysOpenBucket) => ({
      band: b.label,
      completed: b.completed,
      cancelled: b.cancelled,
    })),
    [byDaysOpen.buckets],
  );

  const totals = byDaysOpen.totals;
  const worstKey = byDaysOpen.worstBucket;
  const worstBucket = byDaysOpen.buckets.find((b) => b.key === worstKey) ?? null;
  const allSelected = selectedBuckets.length === 0;

  // The template's own two figures: how cancellations are spread between the
  // fastest band and the slowest one.
  const first = byDaysOpen.buckets[0];
  const last = byDaysOpen.buckets[byDaysOpen.buckets.length - 1];

  const tools = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <LegendKey color={C_COMPLETED} label="Completed" value={num(cvc.completed)} />
      <LegendKey color={C_CANCELLED} label="Cancelled" value={num(cvc.cancelled)} />
    </div>
  );

  return (
    <SectionCard
      title="Completion Vs Cancellation"
      subtitle="Finished jobs (completed + cancelled), and how many days each stayed open before it closed or was cancelled"
      tools={tools}
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* ── section 2 ─────────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-2">
          <SubHeading>Completion rate</SubHeading>
          {cvc.finished === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Nothing finished in this window — no job was completed or cancelled.
            </p>
          ) : (
            <>
              <QsDonut
                data={donutData}
                nameKey="name"
                valueKey="value"
                height={200}
                colors={[C_COMPLETED, C_CANCELLED]}
                innerRadius={48}
                outerRadius={72}
              />
              <div className="rounded-md border bg-muted/40 px-3 py-2">
                <div className="text-xs text-muted-foreground">Completion rate of finished jobs</div>
                <div className="text-2xl font-semibold tabular-nums text-ink-900">{pct1(cvc.completionRate)}</div>
                <div className="text-xs tabular-nums text-muted-foreground">
                  {num(cvc.completed)} completed of {num(cvc.finished)} finished
                </div>
              </div>
              {/*
                * Said here rather than left to be discovered: the two numbers
                * are both right and a reader WILL notice they differ.
                */}
              <p className="text-xs text-muted-foreground">
                This counts finished jobs only, so it is higher than the{' '}
                <span className="font-medium text-foreground">Completion %</span> tile above, which also counts
                the jobs still open.
              </p>
            </>
          )}
        </div>

        {/* ── section 3 ─────────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-2">
          <SubHeading>By days open</SubHeading>
          {totals.total === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No finished jobs to band by days open.
            </p>
          ) : (
            <div
              role="img"
              aria-label={
                'Completed and cancelled jobs by days open: '
                + byDaysOpen.buckets
                  .map((b) => `${b.label}, ${b.completed} completed, ${b.cancelled} cancelled`)
                  .join('; ')
              }
            >
              <QsBarChart
                data={bandData}
                xKey="band"
                height={220}
                series={[
                  { key: 'completed', label: 'Completed', color: C_COMPLETED },
                  { key: 'cancelled', label: 'Cancelled', color: C_CANCELLED },
                ]}
              />
            </div>
          )}
        </div>

        {/* ── section 4 ─────────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-2">
          <SubHeading>Days open breakdown</SubHeading>
          <p className="text-xs text-muted-foreground">
            {allSelected
              ? 'Click a band to narrow Why Cancelled below to those jobs.'
              : 'Why Cancelled below now shows only the selected bands. Click again to clear.'}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {byDaysOpen.buckets.map((b) => (
              <AgeTile
                key={b.key}
                label={b.label}
                completed={b.completed}
                cancelled={b.cancelled}
                rateText={pct1(b.cancelRate)}
                rateWidth={b.total > 0 ? b.cancelled / b.total : 0}
                pressed={selectedBuckets.includes(b.key)}
                /* Highest cancel RATE, not most cancellations — and never
                   highlighted when nothing was cancelled at all. */
                worst={totals.cancelled > 0 && b.key === worstKey}
                onClick={() => onToggleBucket(b.key)}
              />
            ))}
            <div className="sm:col-span-2">
              <AgeTile
                label="All days"
                completed={totals.completed}
                cancelled={totals.cancelled}
                rateText={pct1(totals.cancelRate)}
                rateWidth={totals.total > 0 ? totals.cancelled / totals.total : 0}
                pressed={allSelected}
                worst={false}
                onClick={() => onToggleBucket(null)}
              />
            </div>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {totals.cancelled === 0 ? (
              'No cancellations in this view.'
            ) : (
              <>
                <span className="font-semibold text-ink-900">{ratio1(first?.cancelled ?? 0, totals.cancelled)}</span>
                {' of cancellations happen within '}{first?.label.toLowerCase() ?? 'the first band'}{'; '}
                <span className="font-semibold text-ink-900">{ratio1(last?.cancelled ?? 0, totals.cancelled)}</span>
                {' in '}{last?.label.toLowerCase() ?? 'the last band'}{'. '}
                {worstBucket && (
                  <>
                    {'Cancel rate is highest for jobs open '}
                    <span className="font-semibold text-ink-900">{worstBucket.label.toLowerCase()}</span>
                    {' ('}{pct1(worstBucket.cancelRate)}{').'}
                  </>
                )}
              </>
            )}
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
