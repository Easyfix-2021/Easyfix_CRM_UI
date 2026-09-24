'use client';

import { Search, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import type { Column } from './types';

/*
 * Server-paged / sorted / searched data table for a Custom Report's rows.
 * Pure presentational — the parent (report view page or the public page)
 * owns the fetch and the query state; this only renders what it's given and
 * reports intent (sort a column, change page, type a search term) upward.
 *
 * Cells render VERBATIM — date cells are already 'YYYY-MM-DD' strings and
 * number cells are already numbers/null off the wire (per the BE contract);
 * no client-side Date parsing or formatting, ever.
 */
export function ReportDataTable({
  columns,
  rows,
  total,
  loading,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  sortBy,
  sortDir,
  onSortChange,
  q,
  onSearchChange,
}: {
  columns: Column[];
  rows: Array<Record<string, string | number | null>>;
  total: number;
  loading: boolean;
  /* 0-indexed, matches TablePagination's convention. */
  page: number;
  pageSize: TablePageSize;
  onPageChange: (next: number) => void;
  onPageSizeChange: (next: TablePageSize) => void;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  onSortChange: (columnKey: string) => void;
  q: string;
  onSearchChange: (q: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search rows…"
          className="pl-9"
        />
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sortBy === c.key;
                const SortIcon = active ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                return (
                  <th key={c.key} className={c.type === 'number' ? '!text-right' : '!text-left'}>
                    <button
                      type="button"
                      onClick={() => onSortChange(c.key)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                    >
                      {c.name}
                      <SortIcon className={`size-3 ${active ? '' : 'opacity-40'}`} />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length || 1} className="text-center text-muted-foreground">
                  {loading ? 'Loading…' : 'No rows.'}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.type === 'number' ? '!text-right' : '!text-left'}>
                      {row[c.key] == null ? '' : String(row[c.key])}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <TablePagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        loading={loading}
        // The endpoint caps at 500 — 'all' maps to that cap (pageSizeToLimit
        // in the parent), so there's no benefit offering the 100 tier here.
        pageSizeOptions={[
          { value: 10, label: '10' },
          { value: 20, label: '20' },
          { value: 50, label: '50' },
          { value: 'all', label: 'All' },
        ]}
      />
    </div>
  );
}
