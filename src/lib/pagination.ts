/*
 * The arithmetic behind the table footer (components/ui/table-pagination.tsx).
 *
 * Split out for the same reason as virtual-window.ts: this is the part that can
 * be WRONG without anything throwing. Hand the footer a `page` index past the
 * last page — which is what a filter that shrinks the result set does to an
 * operator sitting on page 3 — and it renders "Showing 21-1 of 1" next to a box
 * reading "3 / 1", over an empty table. No build, type check or lint can see
 * that; only arithmetic on the numbers can.
 *
 * The one rule the whole file exists to enforce: every number the footer shows
 * is derived from `safePage`, never from the raw `page` it was handed. The
 * original bug was exactly a half-application of that — `rangeEnd` was bounded
 * by `total` while `rangeStart` was not, so the two ends crossed.
 */

/* Mirrors TablePageSize in components/ui/table-pagination.tsx. Widened to
   `number` here so the component keeps owning its own literal union and this
   module stays free of React-land imports (it compiles standalone for tests). */
export type PageSizeInput = number | 'all';

export type PageView = {
  /* Always >= 1, so "1 / 1" renders on an empty list rather than "1 / 0". */
  totalPages: number;
  /* `page` clamped into [0, totalPages - 1]. The only page index the footer
     should render or navigate from. */
  safePage: number;
  /* 1-indexed inclusive row numbers for the "Showing a-b of n" hint.
     Both 0 when there are no rows. */
  rangeStart: number;
  rangeEnd: number;
};

export function computePageView(page: number, pageSize: PageSizeInput, total: number): PageView {
  const isAll = pageSize === 'all';
  // A non-finite or negative total comes from a parent whose fetch failed or
  // hasn't landed; treat it as an empty list rather than propagating NaN into
  // every number below (NaN renders as "NaN" and compares false everywhere).
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const effectiveSize = Math.max(1, isAll ? safeTotal : Math.floor(pageSize as number));
  const totalPages = isAll ? 1 : Math.max(1, Math.ceil(safeTotal / effectiveSize));

  const raw = Number.isFinite(page) ? Math.floor(page) : 0;
  const safePage = Math.min(Math.max(0, raw), totalPages - 1);

  const rangeStart = safeTotal === 0 ? 0 : isAll ? 1 : safePage * effectiveSize + 1;
  const rangeEnd = safeTotal === 0
    ? 0
    : isAll
      ? safeTotal
      : Math.min((safePage + 1) * effectiveSize, safeTotal);

  return { totalPages, safePage, rangeStart, rangeEnd };
}
