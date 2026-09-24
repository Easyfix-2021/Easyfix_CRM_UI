'use client';

/*
 * QuickSight — MTD: the building blocks the section components in this folder
 * share, following the Employee tab's kit
 * (quicksight/employee-performance/sections/shared.tsx) rather than inventing
 * a second set of conventions for one more tab.
 *
 *   SectionCard   the Card + heading every section sits in
 *   SubHeading    the small uppercase heading of a sub-block inside a card
 *   LocalTable    a summary table over rows the report already carries:
 *                 client-side sort (useSort) and, with `pageSize`, in-memory
 *                 TablePagination
 *   MiniStat      a labelled figure inside a card
 *   num / pct1 /  the display rules every figure on the tab goes through
 *   pctFraction
 *
 * Cells: `.data-table` density, numbers `!text-right tabular-nums`, a frozen
 * first column is `stick-col stick-left` (td) / `stick-col-head stick-left`
 * (th). No fetching here — a section that pages on the server calls useFetch
 * itself.
 *
 * THE ONE RULE WORTH READING: a percentage whose denominator is zero is an EN
 * DASH, never "0%". `MtdPct.pct` is null in that case, and null means "there
 * was nothing to measure" — printing 0% there would be a claim about jobs that
 * do not exist. `pct1` below is the only place the tab turns one into text.
 */

import { useState, type ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import { SortHeader, useSort, type SortDir } from '@/lib/use-sort';
import { computePageView } from '@/lib/pagination';
import { cn } from '@/lib/utils';
import type { MtdPct } from '../types';

/* ── display ──────────────────────────────────────────────────────────────── */

// Built once: an Intl.NumberFormat is far cheaper to reuse than toLocaleString per cell.
const EN_IN = new Intl.NumberFormat('en-IN');

/** 1,23,456 — counts, Indian grouping, as every other QuickSight tab prints them. */
export function num(n: number | null | undefined): string {
  return EN_IN.format(Number(n || 0));
}

/** The en dash a percentage with no denominator prints. Not a hyphen, not "0%". */
export const NO_VALUE = '–';

/**
 * 89.1% — one decimal, and NO_VALUE when the denominator was zero.
 *
 * Takes the whole {num, den, pct} rather than a bare number so a caller cannot
 * accidentally pass `pct ?? 0` and turn "nothing to measure" into "none of
 * them".
 */
export function pct1(p: MtdPct | null | undefined): string {
  if (!p || p.pct === null) return NO_VALUE;
  return `${p.pct.toFixed(1)}%`;
}

/** '124 of 310' — the two counts a percentage was made of, for a tile's sub-line. */
export function pctFraction(p: MtdPct | null | undefined): string {
  if (!p) return NO_VALUE;
  return `${num(p.num)} of ${num(p.den)}`;
}

/** 0 to 1, for a meter's width. Zero when there is nothing to measure. */
export function pctWidth(p: MtdPct | null | undefined): number {
  if (!p || p.pct === null || p.den <= 0) return 0;
  return Math.max(0, Math.min(1, p.num / p.den));
}

/** '—' for null / undefined / '' — the MIS engine prints blanks, the CRM never does. */
export function dash(value: unknown): string {
  return value == null || value === '' ? '—' : String(value);
}

/* ── layout ───────────────────────────────────────────────────────────────── */

export function SectionCard({
  title,
  subtitle,
  tools,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Legend, toggles or a search box, aligned opposite the heading. */
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-base font-semibold text-ink-900">{title}</h2>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {tools && <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{tools}</div>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
  );
}

/** A labelled figure inside a card. */
export function MiniStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/40 px-3 py-2">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-lg font-semibold tabular-nums text-ink-900">{value}</div>
    </div>
  );
}

/**
 * One key of a chart's legend. `line` draws the 2px rule a line series uses
 * instead of the square a bar series uses, and `dashed` the forecast's.
 */
export function LegendKey({
  color, label, value, line, dashed,
}: {
  color: string;
  label: string;
  value?: ReactNode;
  line?: boolean;
  dashed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      {line ? (
        <span
          className="inline-block w-4 shrink-0 rounded"
          style={{ borderTopWidth: 2.5, borderTopStyle: dashed ? 'dashed' : 'solid', borderTopColor: color }}
          aria-hidden
        />
      ) : (
        <span className="inline-block size-3 shrink-0 rounded-sm" style={{ background: color }} aria-hidden />
      )}
      {label}
      {value !== undefined && <span className="font-semibold tabular-nums text-ink-900">{value}</span>}
    </span>
  );
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

function renderCell<T, K extends string>(row: T, c: Column<T, K>): ReactNode {
  if (c.render) return c.render(row);
  return dash((row as Record<string, unknown>)[c.key]);
}

export function TableFrame({
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
        scroll && 'max-h-[420px] overflow-y-auto',
        dim && 'opacity-60',
      )}
    >
      <table className={cn('data-table w-full', scroll && 'head-sticky')}>{children}</table>
    </div>
  );
}

export function TableHead<K extends string>({
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

export function MessageRow({
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

export function BodyRows<T, K extends string>({
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
 * A summary table over rows the report already carries. Sorting cycles
 * asc → desc → the order the server sent. With `pageSize` it pages in memory;
 * without it every row renders, and `scroll` caps the height with a sticky
 * header. A new `rows` array (a filter change) or a new sort returns to the
 * first page.
 */
export function LocalTable<T>({
  rows,
  columns,
  rowKey,
  emptyText,
  pageSize: initialPageSize,
  scroll,
  footer,
}: {
  rows: T[];
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T, index: number) => string;
  emptyText: string;
  pageSize?: TablePageSize;
  scroll?: boolean;
  /** A pinned totals row, rendered in `tfoot` below every page. */
  footer?: ReactNode;
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
        {footer && visible.length > 0 && <tfoot>{footer}</tfoot>}
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
