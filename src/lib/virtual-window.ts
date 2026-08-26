/*
 * The arithmetic behind table row virtualisation (components/ui/virtual-rows.tsx).
 *
 * Split out of the hook for one reason: this is the part that can be WRONG in a
 * way a build never catches. A window that runs past the end, a negative spacer,
 * or a total height that drifts from the row count all render "fine" and simply
 * scroll wrong — and the failure only shows up on the 26,000-row window nobody
 * loads while developing. Pure functions with a test are cheaper than finding
 * that in production.
 */

/* Rows kept mounted beyond each edge of the viewport, so a fast flick shows
   rows rather than blank space while the next frame computes. */
export const OVERSCAN = 12;

/*
 * Below this, virtualisation is off entirely. A few hundred rows render and
 * scroll fine, and a scroll box around them is a downgrade — it traps the page
 * scroll and hides the footer totals.
 */
export const VIRTUALISE_ABOVE = 200;

/* First-paint guess only. Replaced by a real measurement before the user sees it. */
export const FALLBACK_ROW_PX = 41;

export type Window = {
  /* First row index to render. */
  start: number;
  /* One PAST the last row index to render (slice-style, so end - start = count). */
  end: number;
  /* Spacer heights standing in for the rows outside the window. */
  padTop: number;
  padBottom: number;
};

/*
 * Which rows to render for a given scroll position, and how tall the spacers
 * either side must be.
 *
 * INVARIANTS, all pinned by tests/virtual-window.test.js:
 *   - 0 <= start <= end <= total. Never a window past the end of the data.
 *   - padTop and padBottom are never negative — a negative height silently
 *     collapses to 0 in the browser, which shifts every row above the fold and
 *     makes the scrollbar lie.
 *   - padTop + (end - start) * rowPx + padBottom === total * rowPx. The scroll
 *     height must not depend on where you are in it, or the scrollbar thumb
 *     resizes as you drag it.
 *   - The window always covers the visible band plus OVERSCAN on both sides,
 *     so a scroll never exposes an unrendered gap before the next frame.
 *
 * `rowPx` is a MEASURED average, not a constant: these rows are not fixed
 * height (a "Called By" cell lists one line per caller). It is guarded against
 * 0/NaN here because a bad measurement would divide by zero and produce an
 * Infinity window — one that renders every row, which is the very thing this
 * exists to prevent.
 */
export function computeWindow(
  total: number,
  scrollTop: number,
  viewportPx: number,
  rowPx: number,
): Window {
  const px = rowPx > 0 && Number.isFinite(rowPx) ? rowPx : FALLBACK_ROW_PX;
  const rows = Math.max(0, Math.floor(total) || 0);
  const top = Math.max(0, scrollTop) || 0;
  const view = Math.max(0, viewportPx) || 0;

  const firstVisible = Math.floor(top / px);
  const start = Math.min(Math.max(0, firstVisible - OVERSCAN), rows);
  const visibleCount = Math.ceil(view / px) + OVERSCAN * 2;
  const end = Math.min(rows, start + visibleCount);

  return {
    start,
    end,
    padTop: start * px,
    // From `end`, NOT from start + slice length: they are the same number, and
    // deriving it from the one that was already clamped is what keeps the total
    // height constant at the bottom of the list.
    padBottom: Math.max(0, rows - end) * px,
  };
}
