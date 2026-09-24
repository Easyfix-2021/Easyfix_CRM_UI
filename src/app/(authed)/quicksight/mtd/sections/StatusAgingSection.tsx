'use client';

/*
 * QuickSight — MTD Client Report, sections 9 and 10, and the card that holds
 * section 11.
 *
 *   9   Jobs By Status And Aging   the card
 *   10  Jobs By Days Open          the matrix inside it
 *   11  Open Jobs                  the list beside it (./OpenJobsSection)
 *
 * EVERY JOB IN HAND IS IN EXACTLY ONE CELL. Completed, cancelled and open down
 * the side; six days-open bands across the top. The three row totals are the
 * KPI tiles' Completed, Cancelled and Open, and the grand total is their sum —
 * `inHand`. Orders Created is NOT here and cannot be: it counts tickets raised
 * this window, which is a different set of jobs entirely.
 *
 * ⚠ THESE SIX BANDS ARE NOT SECTION 3's FOUR. 0–3 / 4–5 / 6–9 / 10–15 / 16–30
 * / over 30 here; 0–2 / 3–5 / 6–9 / over 9 there. The owner asked for both
 * splits and the backend keeps them as two separate constants. Nothing in this
 * file may be reused for that one — which is why the bands are read from the
 * response and are not written down here at all.
 *
 * OPEN JOBS AGE TO NOW. A completed or cancelled job's days open is fixed at
 * its closure; an open job's keeps growing, so the right-hand bands fill up on
 * their own as a window ages. That is the point of the matrix.
 *
 * EVERY NUMBER IS A BUTTON, and lists those jobs beside it. A zero is not:
 * there is nothing to list, and a clickable zero that opened an empty list
 * would only be a way to lose the list you were reading. Clicking the number
 * already being listed goes back to all open jobs, which is where the card
 * starts — the MIS report's own default, and the most useful list on the tab.
 *
 * THE MATRIX DOES NOT SORT. It is three rows in a fixed, meaningful order and
 * the columns are a scale; there is nothing here a sort would reveal.
 */

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import type { MtdChecks, MtdJobStatus, MtdStatusAging } from '../types';
import type { MtdFilters } from '../api';
import { SectionCard, SubHeading, num } from './shared';
import { ReconcileNote } from './report-parts';
import { OpenJobsSection } from './OpenJobsSection';

/** Which cell of the matrix the job list beside it is showing. */
export type MatrixCell = {
  status: MtdJobStatus | 'all';
  /** A statusAging bucket key, or 'all' for the whole row. */
  bucket: string;
};

/*
 * Where the card starts: every open job, every band. It is the MIS report's
 * own default (SA_DEFAULT) and the question the tab exists to answer — what is
 * still open and how old is it — so the list is useful before anything has
 * been clicked.
 */
const DEFAULT_CELL: MatrixCell = { status: 'open', bucket: 'all' };

const sameCell = (a: MatrixCell, b: MatrixCell) => a.status === b.status && a.bucket === b.bucket;

export function StatusAgingSection({
  statusAging,
  filters,
  checks,
  enabled = true,
}: {
  statusAging: MtdStatusAging;
  /** Resolved filters — the job list sends the report's own window and pickers. */
  filters: MtdFilters;
  checks?: MtdChecks;
  /** False while the viewer has no access, so the job list does not fetch. */
  enabled?: boolean;
}) {
  const [pick, setPick] = useState<MatrixCell>(DEFAULT_CELL);

  const bucketAt = useMemo(
    () => new Map(statusAging.buckets.map((b, i) => [b.key, i])),
    [statusAging.buckets],
  );

  /**
   * The matrix's own number for a cell. This is what the job list's
   * `cell.total` is checked against: the two are built from the same rows on
   * the server, so a disagreement means they are describing different job sets
   * and the list must say so rather than quietly look right.
   */
  const countAt = (cell: MatrixCell): number => {
    const col = cell.bucket === 'all' ? -1 : bucketAt.get(cell.bucket) ?? -1;
    if (cell.status === 'all') return col < 0 ? statusAging.grand : (statusAging.columnTotals[col] ?? 0);
    const row = statusAging.rows.find((r) => r.status === cell.status);
    if (!row) return 0;
    return col < 0 ? row.total : (row.counts[col] ?? 0);
  };

  /*
   * A filter change can empty the cell that was being listed. Falling back to
   * the default during THIS render means the empty list never paints and no
   * request goes out for a cell with nothing in it. It converges: the fallback
   * is only applied to a cell that is not already the default.
   */
  let cell = pick;
  if (countAt(cell) === 0 && !sameCell(cell, DEFAULT_CELL)) {
    setPick(DEFAULT_CELL);
    cell = DEFAULT_CELL;
  }

  const bandLabel = (key: string) => statusAging.buckets.find((b) => b.key === key)?.label ?? key;

  /** What the list beside the matrix is called — the MIS report's own wording. */
  const titleOf = (c: MatrixCell): string => {
    const who = c.status === 'all' ? 'All Jobs'
      : c.status === 'open' ? 'Open Jobs'
        : statusAging.rows.find((r) => r.status === c.status)?.label ?? c.status;
    return c.bucket === 'all' ? who : `${who} · ${bandLabel(c.bucket)}`;
  };

  /* Clicking the cell already being listed goes back to all open jobs. */
  const onPick = (next: MatrixCell) => setPick((cur) => (sameCell(cur, next) ? DEFAULT_CELL : next));

  /*
   * A plain function, deliberately not a nested component: a component
   * declared inside a render is a NEW type on every render, so React would
   * unmount and remount every button in the matrix each time — losing the
   * keyboard focus of whoever had just pressed one.
   */
  const countCell = (target: MatrixCell) => {
    const value = countAt(target);
    if (value === 0) return <span className="text-muted-foreground">0</span>;
    const on = sameCell(cell, target);
    return (
      <button
        type="button"
        aria-pressed={on}
        onClick={() => onPick(target)}
        title={on ? 'Showing these jobs — click again for all open jobs' : `List these ${num(value)} jobs`}
        aria-label={`${num(value)} ${titleOf(target).toLowerCase()}${on ? ', listed beside the matrix' : ', show the list'}`}
        className={cn(
          'rounded px-1.5 py-0.5 tabular-nums underline-offset-2 hover:underline',
          on ? 'bg-primary/15 font-semibold text-foreground' : 'text-primary',
        )}
      >
        {num(value)}
      </button>
    );
  };

  const footCell = 'border-t-2 border-border bg-muted/60 font-semibold';

  return (
    <SectionCard
      title="9. Jobs By Status And Aging"
      subtitle={`${num(statusAging.grand)} jobs in hand split by days open — the export's Aging column, and for open jobs the days so far · the same completed, cancelled and open jobs as the tiles at the top`}
    >
      <ReconcileNote checks={checks} keys={['statusAging']} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="space-y-3">
          <div className="space-y-0.5">
            <SubHeading>10. Jobs By Days Open</SubHeading>
            <p className="text-xs text-muted-foreground">Click any number to list those jobs beside the matrix</p>
          </div>
          <div className="overflow-x-auto rounded-md border">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="!text-left">Job Status</th>
                  {statusAging.buckets.map((b) => (
                    <th key={b.key} className="!text-right" title={`${b.label} open`}>{b.short}</th>
                  ))}
                  <th className="!text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {statusAging.rows.map((row) => (
                  <tr key={row.status}>
                    <td className="whitespace-nowrap">{row.label}</td>
                    {statusAging.buckets.map((b) => (
                      <td key={b.key} className="!text-right">
                        {countCell({ status: row.status, bucket: b.key })}
                      </td>
                    ))}
                    <td className="!text-right">{countCell({ status: row.status, bucket: 'all' })}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className={cn(footCell, 'whitespace-nowrap')}>Total</td>
                  {statusAging.buckets.map((b) => (
                    <td key={b.key} className={cn(footCell, '!text-right')}>
                      {/* A column total is a cell in its own right: it lists
                          every job in that band whatever its status. */}
                      {countCell({ status: 'all', bucket: b.key })}
                    </td>
                  ))}
                  <td className={cn(footCell, '!text-right')}>{countCell({ status: 'all', bucket: 'all' })}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Completed jobs are counted on their checkout date and cancelled jobs on their cancel date; open
            jobs are every job still open that was raised on or before the end of the selected dates, and they
            age to today. These six bands are not the four in{' '}
            <span className="font-medium text-foreground">By Days Open</span> above — the owner asked for both
            splits, and the two are counted separately.
          </p>
        </div>

        <OpenJobsSection
          filters={filters}
          cell={cell}
          title={titleOf(cell)}
          expectedTotal={countAt(cell)}
          isDefaultCell={sameCell(cell, DEFAULT_CELL)}
          onReset={() => setPick(DEFAULT_CELL)}
          enabled={enabled}
        />
      </div>
    </SectionCard>
  );
}
