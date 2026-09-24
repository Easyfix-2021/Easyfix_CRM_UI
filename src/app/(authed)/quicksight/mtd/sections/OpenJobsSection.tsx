'use client';

/*
 * QuickSight — MTD Client Report, section 11: Open Jobs.
 *
 * The jobs behind one cell of section 10's matrix, paged. It opens on EVERY
 * OPEN JOB — the MIS report's own default, and the question the tab exists to
 * answer — and changes only when a reader clicks a number in the matrix.
 *
 * ONE SERVER READ, NOT TWO. GET /jobs shares the report's cache entry on the
 * backend: it re-reads nothing, it filters and pages the rows the report has
 * already built. That is why this is a fetch rather than a slice of a
 * thousands-strong array shipped to the browser — the page stays small and the
 * click stays cheap.
 *
 * `cell.total` IS CHECKED AGAINST THE MATRIX. The number the reader clicked
 * and the size of the set they are now looking at come from the same rows on
 * the server, so they must be equal. When they are not, the two were read
 * either side of a change and the list says so rather than quietly looking
 * right under the wrong heading.
 *
 * THE SEARCH NARROWS THE LIST, NOT THE CELL. `q` matches a Job ID or a job
 * status as a substring; it changes `total` (how many match) but never
 * `cell.total` (how big the cell is), so "12 match" is read against a real
 * denominator. Clicking a different cell clears the box, because a search
 * carried into a set it was never typed for finds nothing and reads as an
 * empty cell.
 *
 * SORT IS THE SERVER'S. The list can be thousands of rows and only one page of
 * them is here, so sorting in the browser would sort the page and mislabel it
 * as sorting the list. The third click on a column therefore returns to the
 * report's default order (days open, longest first) rather than to "unsorted",
 * which the endpoint has no way to give.
 */

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { TablePagination, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';
import { cycleSort, type SortDir } from '@/lib/use-sort';
import { useDebouncedValue, useFetch } from '@/lib/hooks';
import {
  DEFAULT_JOB_SORT_BY, DEFAULT_JOB_SORT_DIR, MAX_JOB_PAGE_SIZE, jobsKey,
  type MtdFilters, type MtdJobSortKey,
} from '../api';
import type { MtdJobRow, MtdJobsResponse } from '../types';
import { BodyRows, MessageRow, SubHeading, TableFrame, TableHead, num, type Column } from './shared';
import { FindBox, ScopeChip } from './report-parts';
import type { MatrixCell } from './StatusAgingSection';

/*
 * No 'All': the endpoint caps `size`, so an All option would render one
 * un-navigable page whose range hint lies the moment a cell is bigger than the
 * cap.
 */
const PAGE_SIZE_OPTIONS: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
];

const COLUMNS: ReadonlyArray<Column<MtdJobRow, MtdJobSortKey>> = [
  { key: 'jobId', label: 'Job ID' },
  { key: 'jobStatus', label: 'Job Status' },
  { key: 'daysOpen', label: 'Days Open', align: 'right', render: (r) => num(r.daysOpen) },
];

/**
 * Page and search text, reset together when the cell changes.
 *
 * Held as ONE object with the signature that produced it so the reset happens
 * during render: page 3 of the old cell is not page 3 of the new one and may
 * not exist, and a request for it would be a round trip to an empty table.
 */
type ListState = { signature: string; q: string; page: number };

export function OpenJobsSection({
  filters,
  cell,
  title,
  expectedTotal,
  isDefaultCell,
  onReset,
  enabled = true,
}: {
  filters: MtdFilters;
  cell: MatrixCell;
  /** What the chosen cell is called — the heading, and the scope chip's value. */
  title: string;
  /** The matrix's own count for this cell, checked against `cell.total`. */
  expectedTotal: number;
  isDefaultCell: boolean;
  onReset: () => void;
  enabled?: boolean;
}) {
  const signature = `${cell.status}|${cell.bucket}`;
  const [list, setList] = useState<ListState>({ signature, q: '', page: 0 });
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  /* Mirrors the server's default so the arrow tells the truth about the order
   * the first page actually arrives in. */
  const [sort, setSort] = useState<{ sortBy: MtdJobSortKey; sortDir: SortDir }>({
    sortBy: DEFAULT_JOB_SORT_BY, sortDir: DEFAULT_JOB_SORT_DIR,
  });

  let current = list;
  if (list.signature !== signature) {
    current = { signature, q: '', page: 0 };
    setList(current);
  }

  /*
   * The box is debounced so a six-digit Job ID is one request and not six. An
   * EMPTY box takes effect immediately rather than after the delay: clearing
   * the search, and switching cells (which clears it above), must not spend
   * 300ms fetching the set the reader has just left.
   */
  const debounced = useDebouncedValue(current.q, 300);
  const needle = current.q.trim() === '' ? '' : debounced.trim();

  const key = enabled
    ? jobsKey(filters, {
      status: cell.status,
      bucket: cell.bucket,
      q: needle,
      page: current.page + 1, // the endpoint counts pages from 1
      size: pageSizeToLimit(pageSize, MAX_JOB_PAGE_SIZE),
      sortBy: sort.sortBy,
      sortDir: sort.sortDir,
    })
    : null;
  const res = useFetch<MtdJobsResponse>(key);
  const d = res.data;
  const rows = d?.data ?? [];
  // useFetch keeps the previous page on screen while a new key loads.
  const stale = !!d && (res.refreshing || res.dataKey !== key);

  const setPage = (page: number) => setList((cur) => ({ ...cur, page }));

  const toggleSort = (col: MtdJobSortKey) => {
    setSort((cur) => {
      const next = cycleSort<MtdJobSortKey>(col, cur);
      return next.sortBy
        ? { sortBy: next.sortBy, sortDir: next.sortDir }
        : { sortBy: DEFAULT_JOB_SORT_BY, sortDir: DEFAULT_JOB_SORT_DIR };
    });
    setPage(0);
  };

  /*
   * The cell the list is actually showing, as the server counted it. Only
   * trusted once the response is for THIS key — a stale payload still on
   * screen describes the previous cell, and comparing it would raise a
   * mismatch warning on every click.
   */
  const fresh = d && res.dataKey === key ? d : null;
  const mismatch = fresh !== null && fresh.cell.total !== expectedTotal;
  const searching = needle !== '';

  let body;
  if (res.error) {
    /* useFetch keeps the previous page on error; showing it under the new
       heading would mislabel it, so the error replaces the rows. */
    body = <MessageRow colSpan={COLUMNS.length} tone="error">{res.error}</MessageRow>;
  } else if (res.loading && !d) {
    body = <MessageRow colSpan={COLUMNS.length}>Loading…</MessageRow>;
  } else if (rows.length === 0) {
    body = (
      <MessageRow colSpan={COLUMNS.length}>
        {searching ? `No job matches “${needle}”.` : 'No jobs here.'}
      </MessageRow>
    );
  } else {
    body = <BodyRows rows={rows} columns={COLUMNS} rowKey={(r) => String(r.jobId)} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <SubHeading>11. {title}</SubHeading>
          <p className="text-xs text-muted-foreground">
            {num(expectedTotal)} {expectedTotal === 1 ? 'job' : 'jobs'} in this cell
          </p>
        </div>
        <FindBox
          value={current.q}
          onChange={(q) => setList((cur) => ({ ...cur, q, page: 0 }))}
          placeholder="Job ID or status"
          label="Find a job by ID or status"
        />
      </div>

      <div className="flex min-h-7 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {isDefaultCell ? (
          <span>Every open job in view. Click a number in the matrix to change the list.</span>
        ) : (
          <ScopeChip label="Showing:" value={title} onClear={onReset} clearLabel="Back to all open jobs" />
        )}
        {searching && fresh && <span>· {num(fresh.total)} match “{needle}”</span>}
      </div>

      {mismatch && (
        <p className="flex items-start gap-2 rounded-md border border-urgent-strong/40 bg-urgent-tint/40 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-urgent-strong" aria-hidden />
          <span>
            <span className="font-medium text-foreground">This list and the matrix disagree.</span>{' '}
            The list holds {num(fresh.cell.total)} jobs where the matrix counts {num(expectedTotal)} for the
            same cell. The two were read a moment apart; reload the tab before acting on either number.
          </span>
        </p>
      )}

      <TableFrame scroll dim={stale}>
        <TableHead<MtdJobSortKey>
          columns={COLUMNS}
          sortBy={sort.sortBy}
          sortDir={sort.sortDir}
          onSort={toggleSort}
        />
        <tbody>{body}</tbody>
      </TableFrame>

      <TablePagination
        page={current.page}
        pageSize={pageSize}
        total={res.error ? 0 : (d?.total ?? 0)}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        loading={res.loading || stale}
      />
    </div>
  );
}
