'use client';
import { useMemo, useState } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from './utils';

/*
 * Lightweight client-side sort for table pages. Sorts the currently-loaded
 * page — not the full dataset. That's a practical compromise: with 384k jobs
 * server-side sort on arbitrary columns would need indexes on each column,
 * which we don't have. The user still gets useful in-page reordering (e.g.
 * by customer name, city, status within the 50 rows they're looking at).
 *
 * For true dataset-wide ordering use backend filters (status tabs) that map
 * to indexed columns.
 */

type SortDir = 'asc' | 'desc';

export function useSort<T>(rows: T[], initialKey?: keyof T) {
  const [key, setKey] = useState<keyof T | null>(initialKey ?? null);
  const [dir, setDir] = useState<SortDir>('asc');

  const sorted = useMemo(() => {
    if (!key) return rows;
    const arr = rows.slice();
    arr.sort((a, b) => {
      const av = (a as Record<string, unknown>)[key as string];
      const bv = (b as Record<string, unknown>)[key as string];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      // Numeric comparison when both look like numbers, otherwise string.
      const na = Number(av), nb = Number(bv);
      const cmp = (!Number.isNaN(na) && !Number.isNaN(nb) && typeof av !== 'string')
        ? na - nb
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [rows, key, dir]);

  function toggle(k: keyof T) {
    if (k === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setKey(k); setDir('asc'); }
  }

  return { sorted, sortKey: key, sortDir: dir, toggle };
}

/*
 * Clickable <th> for a sortable column. Shows a neutral double-chevron when
 * idle, an up/down arrow when this column is the active sort.
 */
export function SortHeader<T>({
  colKey, sortKey, sortDir, onToggle, children, className,
}: {
  colKey: keyof T;
  sortKey: keyof T | null;
  sortDir: 'asc' | 'desc';
  onToggle: (k: keyof T) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const active = sortKey === colKey;
  const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      onClick={() => onToggle(colKey)}
      className={cn('cursor-pointer select-none hover:bg-muted/70 transition-colors', className)}
      role="button"
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <Icon className={cn('h-3 w-3', active ? 'opacity-80' : 'opacity-40')} />
      </span>
    </th>
  );
}
