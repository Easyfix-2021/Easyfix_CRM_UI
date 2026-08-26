'use client';

/*
 * Row virtualisation for the dense `.data-table` grids.
 *
 * ─── WHY ───────────────────────────────────────────────────────────────────
 *
 * The QuickSight Call Tracking report used to cap its result set server-side
 * (5,000 rows). The cap is gone — it was silently answering a question five
 * times smaller than the one asked — and an eight-month window now returns
 * ~26,000 rows, a two-year one roughly 135,000. At twelve cells a row that is
 * over 1.5 million DOM nodes: React does not render it slowly, it stops
 * responding.
 *
 * "Don't truncate the data" and "send every row into the DOM" are separate
 * problems that the cap was conflating. The data stays complete — the export,
 * the totals, the sorting and the search all still see every row — and only the
 * DRAWING is bounded. Bounding the drawing is honest in a way that bounding the
 * data was not: nobody reads 135,000 rows, but the footer that sums them has to
 * be right.
 *
 * ─── HOW ───────────────────────────────────────────────────────────────────
 *
 * A window of rows around the scroll position, with two spacer <tr>s standing in
 * for everything above and below. Nothing exotic:
 *
 *   - INACTIVE BELOW `VIRTUALISE_ABOVE` ROWS. Small tables render exactly as
 *     they did before this file existed — no scroll box, no spacers, no measure
 *     pass. The common case must not pay for the pathological one.
 *   - ROW HEIGHT IS MEASURED, NOT ASSUMED. These rows are NOT fixed height: a
 *     "Called By" cell lists one line per caller, so a job with five callers is
 *     five lines tall. A fixed constant would drift the scrollbar badly over
 *     tens of thousands of rows. The rendered slice is measured after paint and
 *     the estimate converges within a frame or two.
 *   - THE SPACERS CARRY A `<td colSpan>`. A <tr> with no cells collapses to zero
 *     height in every browser, so the height goes on a single empty cell with
 *     its padding and border zeroed (the `.data-table td` rule would otherwise
 *     add 16px and a line to each spacer).
 *
 * ─── WHAT IT COSTS ─────────────────────────────────────────────────────────
 *
 * Ctrl+F only finds rows currently in the DOM. That is inherent to windowing
 * and equally true of pagination, which is the alternative; the tables that use
 * this already carry their own search box over the FULL array, which is the
 * answer to it. Print / "save as PDF" of a virtualised table gives you the
 * visible window, not the whole set — the XLSX export is the way out, and it
 * always was for 26,000 rows.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/*
 * The arithmetic lives in lib/ and is unit-tested there
 * (tests/virtual-window.test.js). It is separated because every way it can be
 * wrong is invisible — a window past the end, a negative spacer, a scroll height
 * that changes as you scroll — and none of it reproduces on the row counts
 * anyone loads while developing. This file owns the React and the DOM; that one
 * owns the numbers.
 */
import { computeWindow, FALLBACK_ROW_PX, VIRTUALISE_ABOVE } from '@/lib/virtual-window';


export type VirtualRows<T> = {
  /* False when the table is short enough to render whole (see the threshold). */
  active: boolean;
  /*
   * Put on the scrolling wrapper — the element with `containerClass`.
   *
   * A CALLBACK ref, not a ref object, and that is load-bearing. These tables are
   * mounted and unmounted by tab: with a plain ref the scroll listener's effect
   * runs once while the element is still null, returns early, and never runs
   * again — the deps have not changed — so the table mounts later with no
   * listener and a window frozen at row 0. A callback ref stores the node in
   * state, which re-runs the effect exactly when the node appears or goes away.
   */
  scrollRef: (el: HTMLDivElement | null) => void;
  /* Put on the <tbody>. Used to measure real row heights. */
  bodyRef: React.MutableRefObject<HTMLTableSectionElement | null>;
  /* The rows to actually render. The full array when inactive. */
  slice: T[];
  /* Heights for the two spacer rows; 0 means "render nothing". */
  padTop: number;
  padBottom: number;
  /*
   * Append to the wrapper's className. Empty while inactive, so a short table
   * keeps the page as its scroller and its header keeps scrolling with it.
   */
  containerClass: string;
};

export function useVirtualRows<T>(rows: T[]): VirtualRows<T> {
  // The scroll container lives in STATE so effects re-run when it mounts — see
  // the note on scrollRef above. setState identities are stable, so passing the
  // setter straight through as the ref never causes a detach/attach churn.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement | null>(null);
  const rowPx = useRef(FALLBACK_ROW_PX);

  const total = rows.length;
  const active = total > VIRTUALISE_ABOVE;

  const [range, setRange] = useState({ start: 0, end: VIRTUALISE_ABOVE });

  const recompute = useCallback(() => {
    const el = scrollEl;
    if (!el) return;
    const { start, end } = computeWindow(total, el.scrollTop, el.clientHeight, rowPx.current);
    // Bail out on an unchanged window — this runs on every scroll frame, and a
    // fresh object each time would re-render the whole slice for nothing.
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, [scrollEl, total]);

  /*
   * Back to the top whenever the row set changes (a tab switch, a new filter,
   * a re-sort). The functional form is load-bearing, NOT tidiness: callers pass
   * `data?.rows ?? []`, which is a brand-new array identity on every render
   * while data is null. An unconditional setState would re-render, produce
   * another new array, and loop forever. Returning `r` unchanged bails out.
   */
  useEffect(() => {
    if (scrollEl) scrollEl.scrollTop = 0;
    setRange((r) => (r.start === 0 && r.end === VIRTUALISE_ABOVE ? r : { start: 0, end: VIRTUALISE_ABOVE }));
  }, [rows, scrollEl]);

  useEffect(() => {
    const el = scrollEl;
    if (!el || !active) return;
    let frame = 0;
    const onScroll = () => {
      // Coalesce to one recompute per animation frame. A scroll event can fire
      // far more often than the display refreshes.
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; recompute(); });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    recompute();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [active, recompute, scrollEl]);

  /*
   * Measure what actually rendered, and re-window if the estimate was off by
   * more than 5%.
   *
   * No dependency array on purpose: it must run after every paint, because the
   * mix of tall and short rows changes as you scroll. It converges — the second
   * pass lands inside the 5% band and stops — and the band is what stops it
   * oscillating between two neighbouring estimates forever.
   *
   * Spacers are skipped by their data attribute rather than every DATA row
   * carrying one: there are exactly two spacers and up to tens of thousands of
   * rows, so marking the small set is the cheaper contract for callers.
   */
  useLayoutEffect(() => {
    if (!active) return;
    const body = bodyRef.current;
    if (!body) return;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < body.rows.length; i += 1) {
      const tr = body.rows[i];
      if (tr.dataset.vpad != null) continue;
      sum += tr.offsetHeight;
      count += 1;
    }
    if (count < 3) return;
    const avg = sum / count;
    if (avg > 0 && Math.abs(avg - rowPx.current) / rowPx.current > 0.05) {
      rowPx.current = avg;
      recompute();
    }
  });

  /*
   * Re-clamped at render, not trusted from state: `rows` can shrink between the
   * scroll frame that set the range and this render (a filter keystroke), and a
   * stale end would slice past the array — which yields a short page under a
   * full-height spacer, i.e. a gap at the bottom that never fills.
   */
  const start = active ? Math.min(range.start, total) : 0;
  const end = active ? Math.min(total, range.end) : total;

  return {
    active,
    scrollRef: setScrollEl,
    bodyRef,
    slice: active ? rows.slice(start, end) : rows,
    padTop: active ? start * (rowPx.current || FALLBACK_ROW_PX) : 0,
    padBottom: active ? Math.max(0, total - end) * (rowPx.current || FALLBACK_ROW_PX) : 0,
    /*
     * `head-sticky` pins the header inside the scroll box (globals.css). Without
     * it a 70vh box scrolls its own header away, which is worse than the page
     * scroll it replaces.
     */
    containerClass: active ? 'max-h-[70vh] overflow-y-auto' : '',
  };
}

/*
 * The spacer standing in for the rows above or below the window.
 *
 * `data-vpad` is how the measure pass tells it apart from a real row; padding
 * and border are zeroed inline because `.data-table td` would otherwise add
 * 16px and a rule to each end of the window.
 */
export function VirtualPad({ height, colSpan }: { height: number; colSpan: number }) {
  if (height <= 0) return null;
  return (
    <tr data-vpad="" aria-hidden="true">
      <td colSpan={colSpan} style={{ height, padding: 0, border: 0 }} />
    </tr>
  );
}
