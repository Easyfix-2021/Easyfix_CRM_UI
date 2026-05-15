'use client';
import { useMemo, useState } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from './utils';

/*
 * Sort utilities — one canonical implementation shared by every
 * sortable table (Manage Users, Manage Roles, Tools, Service Types,
 * etc.). Three pieces ship from this module:
 *
 *   1. `cycleSort()` — pure helper that returns the NEXT sort state
 *      given the current state + clicked column. Encodes the
 *      3-click cycle:
 *           1st click on a column   → asc
 *           2nd click (same column) → desc
 *           3rd click (same column) → null  (unsorted; backend reverts
 *                                            to its default order)
 *           click on another column → asc on that column
 *
 *   2. `<SortHeader>` — clickable <th> that renders the column label
 *      with an arrow icon **only on the column that is currently
 *      active**. Idle columns show NO icon — operators told us the
 *      grey placeholder arrows on every header read as "the table
 *      is broken / unsortable" rather than "click to sort". Hover
 *      gives a subtle bg shift so the affordance is still
 *      discoverable.
 *
 *   3. `useSort<T>(rows)` — small client-side sort hook for pages
 *      that paginate a fully-loaded list in memory (Tools, Service
 *      Categories, etc.). Returns `{ sorted, sortKey, sortDir,
 *      toggle }` where `sortKey` may be null (the 3rd-click state).
 *      When null, `sorted === rows` (original order preserved).
 *
 * Server-side sort pages (Manage Users / Manage Roles) DON'T use the
 * hook — they own `sortBy` / `sortDir` state directly and call
 * `cycleSort()` to compute next state, then refetch. They still use
 * `<SortHeader>` for the visual.
 */

export type SortDir = 'asc' | 'desc';

/*
 * Pure cycle helper. Given the currently-active column + direction
 * and the column the user just clicked, returns what the new state
 * should be. Caller's responsibility to apply it (setState, refetch,
 * etc.). Pure function so it's safe to call inline.
 */
export function cycleSort<K>(
  clicked: K,
  current: { sortBy: K | null; sortDir: SortDir },
): { sortBy: K | null; sortDir: SortDir } {
  if (current.sortBy !== clicked) {
    // Clicking a different column: start fresh at ascending.
    return { sortBy: clicked, sortDir: 'asc' };
  }
  if (current.sortDir === 'asc') {
    // Same column, asc → desc.
    return { sortBy: clicked, sortDir: 'desc' };
  }
  // Same column at desc → unsort (3rd click). Direction reset to
  // 'asc' for the NEXT first-click on any column; the null sortBy
  // is what tells the backend "use default order".
  return { sortBy: null, sortDir: 'asc' };
}

/*
 * Clickable <th> for a sortable column. The icon appears ONLY when
 * this column is the currently-active sort target. `align` controls
 * the th's text alignment AND the icon's position relative to the
 * label (e.g. center-aligned headers put the icon to the right of
 * the label inside the centered cluster).
 *
 * Generic over the column-key type so server-side callers with a
 * narrow SortKey union get type-checked props.
 */
/*
 * Generic K rather than K extends string — column keys in the
 * codebase are either string literals (manage-users SortKey) or
 * `keyof Row` (jobs/my-orders/EscalatedJobsModal). The latter can be
 * `string | number | symbol`, so we don't constrain. All real
 * callsites use string keys.
 */
export function SortHeader<K>({
  col,
  align = 'left',
  sortBy,
  sortDir,
  onSort,
  children,
  className,
}: {
  col: K;
  align?: 'left' | 'center' | 'right';
  sortBy: K | null;
  sortDir: SortDir;
  onSort: (col: K) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const isActive = sortBy === col;
  const alignCls = align === 'left' ? '!text-left'
                 : align === 'right' ? '!text-right'
                 : '!text-center';
  const justify  = align === 'left' ? 'justify-start'
                 : align === 'right' ? 'justify-end'
                 : 'justify-center';
  return (
    <th
      className={cn(
        alignCls,
        'cursor-pointer select-none hover:bg-muted/40 transition-colors whitespace-nowrap overflow-hidden',
        className,
      )}
      onClick={() => onSort(col)}
      role="button"
      aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', justify)}>
        {children}
        {/* Arrow appears ONLY on the active column. Idle columns
            stay icon-less so the table doesn't look "broken". The
            cursor-pointer + hover bg on the cell signals the
            affordance for non-active columns. */}
        {isActive && (
          sortDir === 'asc'
            ? <ArrowUp className="size-3 shrink-0 text-foreground" />
            : <ArrowDown className="size-3 shrink-0 text-foreground" />
        )}
      </span>
    </th>
  );
}

/*
 * Client-side sort hook for pages that hold a full list in memory.
 *
 * Sorts the currently-loaded array — not the full dataset. For long
 * paginated lists (>1000 rows) prefer server-side sort via the
 * `cycleSort` helper + raw `<SortHeader>` so the BE owns ordering.
 *
 * Returns null sortKey in the 3rd-click state — when null, `sorted`
 * is just the input array unmodified (caller's natural order).
 */
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
    const next = cycleSort<keyof T>(k, { sortBy: key, sortDir: dir });
    setKey(next.sortBy);
    setDir(next.sortDir);
  }

  return { sorted, sortKey: key, sortDir: dir, toggle };
}
