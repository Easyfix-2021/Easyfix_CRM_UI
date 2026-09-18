'use client';

/*
 * QuickSight — Employee Performance: building blocks shared by the section
 * components in this folder (the Employee tab's body renders the sections).
 *
 *   SectionCard       the Card + numbered Title Case heading every section uses
 *   LocalTable        a summary table: client-side sort (useSort) and, when
 *                     `pageSize` is given, in-memory TablePagination
 *   useServerTable    page / page size / sort state of a server-paged table;
 *                     resets to the first page whenever `v` or the filters change
 *   ServerPagedTable  renders a /open-jobs or /technicians page with that state
 *
 * Cells: `.data-table` density, numbers `!text-right tabular-nums`, a frozen
 * first column is `stick-col stick-left` (td) / `stick-col-head stick-left` (th).
 * No fetching here — the two server-paged sections call useFetch themselves.
 */

import { useState, type ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { TablePagination, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';
import { SortHeader, cycleSort, useSort, type SortDir } from '@/lib/use-sort';
import { computePageView } from '@/lib/pagination';
import { cn } from '@/lib/utils';
import { MAX_PAGE_SIZE, filtersQuery } from '../api';
import { rosterEmptyText, rosterGap } from '../visibility';
import type { Filters, LiveSummaryResponse, PagedRows, Paging } from '../types';

/* ── props every section takes ────────────────────────────────────────────── */

/* The live response, meta included: every section's empty text depends on it. */
export type Summary = LiveSummaryResponse;
export type SummaryProps = { summary: Summary };
/** Sections with a server-paged table also need the snapshot version and the filters. */
export type PagedSectionProps = SummaryProps & { v: string; filters: Filters };

/*
 * What an empty section should say. A section that belongs to a PERSON — their
 * revenue against their target, their productivity — has nothing to show when
 * the window can name nobody (no emp detail uploaded for one of the months, or
 * nobody on ALL of the selected months' sheets), and there "No Data For The
 * Selected Filters" reads as a bug rather than as "nothing uploaded yet". The
 * roster explanation replaces the section's own wording in that case; otherwise
 * the table is genuinely empty for these filters and `fallback` stands.
 *
 * The job tables (clients, city, TAT / SDA, open jobs, zonal) usually still
 * have rows then: the work of everyone the window cannot name is on the
 * Unattributed buckets, which are ordinary SPOC entries to the backend. Such a
 * table never reaches this helper, so the two stay consistent without either
 * knowing about the other. See ../visibility.ts.
 */
export function emptyTableText(summary: Summary, fallback: string): string {
  return rosterEmptyText(rosterGap(summary.meta, summary.team.members.length), fallback);
}

/* ── layout ───────────────────────────────────────────────────────────────── */

export function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold text-ink-900">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold text-ink-700">{children}</h3>;
}

/* ── tables ───────────────────────────────────────────────────────────────── */

export type Align = 'left' | 'right' | 'center';

export type Column<T, K extends string = Extract<keyof T, string>> = {
  /** Sort key; also the field shown when there is no `render`. */
  key: K;
  label: string;
  align?: Align;
  /** Freeze this (first) column while the table scrolls sideways. */
  sticky?: boolean;
  /** Let long text wrap (with a minimum width) instead of one line. */
  wrap?: boolean;
  render?: (row: T) => ReactNode;
};

type ColumnLayout = { align?: Align; sticky?: boolean; wrap?: boolean };

function cellClass(c: ColumnLayout): string {
  return cn(
    c.wrap ? 'min-w-48' : 'whitespace-nowrap',
    c.align === 'right' && '!text-right tabular-nums',
    c.align === 'center' && '!text-center',
    c.sticky && 'stick-col stick-left',
  );
}

/** '—' for null / undefined / '' — the dashboard prints blanks, the CRM never does. */
export function dash(value: unknown): string {
  return value == null || value === '' ? '—' : String(value);
}

function renderCell<T, K extends string>(row: T, c: Column<T, K>): ReactNode {
  if (c.render) return c.render(row);
  return dash((row as Record<string, unknown>)[c.key]);
}

function TableFrame({
  scroll,
  dim,
  children,
}: {
  scroll?: boolean;
  dim?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-md border transition-opacity',
        scroll && 'max-h-[480px] overflow-y-auto',
        dim && 'opacity-60',
      )}
    >
      <table className={cn('data-table w-full', scroll && 'head-sticky')}>{children}</table>
    </div>
  );
}

function TableHead<K extends string>({
  columns,
  sortBy,
  sortDir,
  onSort,
}: {
  columns: ReadonlyArray<{ key: K; label: string; align?: Align; sticky?: boolean }>;
  sortBy: K | null;
  sortDir: SortDir;
  onSort: (col: K) => void;
}) {
  return (
    <thead>
      <tr>
        {columns.map((c) => (
          <SortHeader<K>
            key={c.key}
            col={c.key}
            align={c.align ?? 'left'}
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={onSort}
            className={c.sticky ? 'stick-col-head stick-left' : undefined}
          >
            {c.label}
          </SortHeader>
        ))}
      </tr>
    </thead>
  );
}

function MessageRow({
  colSpan,
  tone = 'muted',
  children,
}: {
  colSpan: number;
  tone?: 'muted' | 'error';
  children: ReactNode;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className={cn('!text-center py-6', tone === 'error' ? 'text-urgent-strong' : 'text-muted-foreground')}
      >
        {children}
      </td>
    </tr>
  );
}

function BodyRows<T, K extends string>({
  rows,
  columns,
  rowKey,
}: {
  rows: readonly T[];
  columns: ReadonlyArray<Column<T, K>>;
  rowKey: (row: T, index: number) => string;
}) {
  return (
    <>
      {rows.map((row, i) => (
        <tr key={rowKey(row, i)}>
          {columns.map((c) => (
            <td key={c.key} className={cellClass(c)}>{renderCell(row, c)}</td>
          ))}
        </tr>
      ))}
    </>
  );
}

/*
 * A summary table (rows already in the /summary response). Sorting cycles
 * asc → desc → uploaded order. With `pageSize` it pages in memory; without it
 * every row renders, and `scroll` caps the height with a sticky header (the
 * date-wise tables, which are bounded by the snapshot's dates).
 * A new `rows` array (a filter change) or a new sort returns to the first page.
 */
export function LocalTable<T>({
  rows,
  columns,
  rowKey,
  emptyText,
  pageSize: initialPageSize,
  scroll,
}: {
  rows: T[];
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T, index: number) => string;
  emptyText: string;
  pageSize?: TablePageSize;
  scroll?: boolean;
}) {
  const { sorted, sortKey, sortDir, toggle } = useSort<T>(rows);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(initialPageSize ?? 'all');

  // New rows (filters changed) → back to the first page, applied during render
  // so the stale page never paints.
  const [seenRows, setSeenRows] = useState(rows);
  let currentPage = page;
  if (seenRows !== rows) {
    setSeenRows(rows);
    setPage(0);
    currentPage = 0;
  }

  const paged = initialPageSize != null;
  let visible: T[] = sorted;
  if (paged && pageSize !== 'all') {
    const { safePage } = computePageView(currentPage, pageSize, sorted.length);
    visible = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);
  }

  type K = Extract<keyof T, string>;
  const onSort = (col: K) => {
    toggle(col);
    setPage(0);
  };

  return (
    <div className="space-y-2">
      <TableFrame scroll={scroll}>
        <TableHead<K> columns={columns} sortBy={sortKey as K | null} sortDir={sortDir} onSort={onSort} />
        <tbody>
          {visible.length === 0
            ? <MessageRow colSpan={columns.length}>{emptyText}</MessageRow>
            : <BodyRows rows={visible} columns={columns} rowKey={rowKey} />}
        </tbody>
      </TableFrame>
      {paged && sorted.length > 0 && (
        <TablePagination
          page={currentPage}
          pageSize={pageSize}
          total={sorted.length}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
        />
      )}
    </div>
  );
}

/* ── server-paged tables (/open-jobs, /technicians) ───────────────────────── */

/* No 'All': the endpoints cap pageSize at MAX_PAGE_SIZE (200). */
const SERVER_PAGE_SIZE_OPTIONS: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
];

export type ServerTableState<K extends string> = {
  /** Ready for openJobsKey / techniciansKey (1-based page). */
  paging: Paging<K>;
  /** 0-based, for TablePagination. */
  page: number;
  pageSize: TablePageSize;
  sortBy: K | null;
  sortDir: SortDir;
  setPage: (next: number) => void;
  setPageSize: (next: TablePageSize) => void;
  toggleSort: (col: K) => void;
};

/*
 * Page, page size and sort of one server-paged table. A change of `v` (a new
 * upload) or of the filters returns to the first page in the same render, so
 * no request goes out for a page the new result may not have. Sort survives
 * filter changes, as the dashboard's shared sort state does.
 */
export function useServerTable<K extends string>(
  v: string,
  filters: Filters,
  initialPageSize: TablePageSize = 20,
): ServerTableState<K> {
  const signature = `${v}\n${filtersQuery(filters)}`;
  const [seenSignature, setSeenSignature] = useState(signature);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(initialPageSize);
  const [sort, setSort] = useState<{ sortBy: K | null; sortDir: SortDir }>({ sortBy: null, sortDir: 'asc' });

  let currentPage = page;
  if (seenSignature !== signature) {
    setSeenSignature(signature);
    setPage(0);
    currentPage = 0;
  }

  return {
    paging: {
      page: currentPage + 1,
      pageSize: pageSizeToLimit(pageSize, MAX_PAGE_SIZE),
      sortBy: sort.sortBy,
      sortDir: sort.sortBy ? sort.sortDir : null,
    },
    page: currentPage,
    pageSize,
    sortBy: sort.sortBy,
    sortDir: sort.sortDir,
    setPage,
    setPageSize: (next) => { setPageSize(next); setPage(0); },
    toggleSort: (col) => { setSort((cur) => cycleSort(col, cur)); setPage(0); },
  };
}

type PageFetch<Row, K extends string> = {
  data: PagedRows<Row, K> | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
};

export function ServerPagedTable<Row, K extends string>({
  columns,
  table,
  res,
  rowKey,
  emptyText,
}: {
  columns: ReadonlyArray<Column<Row, K>>;
  table: ServerTableState<K>;
  res: PageFetch<Row, K>;
  rowKey: (row: Row, index: number) => string;
  emptyText: string;
}) {
  const rows = res.data?.rows ?? [];
  let body: ReactNode;
  if (res.error) {
    // useFetch keeps the previous page on error; showing it under the new
    // page number would mislabel it, so the error replaces the rows.
    body = <MessageRow colSpan={columns.length} tone="error">{res.error}</MessageRow>;
  } else if (res.loading && !res.data) {
    body = <MessageRow colSpan={columns.length}>Loading…</MessageRow>;
  } else if (rows.length === 0) {
    body = <MessageRow colSpan={columns.length}>{emptyText}</MessageRow>;
  } else {
    body = <BodyRows rows={rows} columns={columns} rowKey={rowKey} />;
  }

  return (
    <div className="space-y-2">
      <TableFrame dim={res.refreshing}>
        <TableHead<K> columns={columns} sortBy={table.sortBy} sortDir={table.sortDir} onSort={table.toggleSort} />
        <tbody>{body}</tbody>
      </TableFrame>
      <TablePagination
        page={table.page}
        pageSize={table.pageSize}
        total={res.error ? 0 : res.data?.total ?? 0}
        onPageChange={table.setPage}
        onPageSizeChange={table.setPageSize}
        pageSizeOptions={SERVER_PAGE_SIZE_OPTIONS}
        loading={res.loading || res.refreshing}
      />
    </div>
  );
}

/* ── small pieces ─────────────────────────────────────────────────────────── */

/** A labelled figure inside a card (Performance / chart cards). */
export function MiniStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/40 px-3 py-2">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-lg font-semibold tabular-nums text-ink-900">{value}</div>
    </div>
  );
}
