'use client';

import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type CSSProperties } from 'react';

/*
 * usePopoverPosition — fixed-positioned popover anchored under the
 * trigger, with smooth (rAF-driven) tracking when the trigger moves.
 *
 * Behaviour:
 *   - Always positions directly BELOW the trigger (no flip-above).
 *   - Width matches the trigger (default) so the popover lines up
 *     under the closed button visually.
 *   - `maxHeight` is computed dynamically from viewport space below
 *     the trigger, clamped to [minHeight, maxHeight]. Combined with
 *     `overflow-hidden` + flex layout on the popover root, this gives
 *     the inner ul a clean, reliable height budget to scroll within.
 *   - **Tracks the trigger via `requestAnimationFrame`** so when the
 *     modal body (or any ancestor) scrolls, the popover follows
 *     smoothly on every paint. No React state in the loop — the rAF
 *     callback writes `style.top/left` directly to the popover DOM
 *     node, so there's zero render-cycle lag. This eliminates the
 *     "chase-glitch" of state-driven tracking.
 *
 * Why rAF instead of a scroll listener:
 *   A scroll listener fires per scroll event, which the browser may
 *   throttle. setState inside the listener won't land in the DOM
 *   until React's next render → paint cycle (1–2 frames later).
 *   On a 60fps modal scroll that's enough lag to look like the
 *   popover is chasing. rAF runs synchronously with each paint, and
 *   imperative `style.top = …` mutates the DOM before the same frame
 *   commits, so the popover moves with the trigger pixel-perfect.
 *
 * Returns:
 *   - `style`: initial style for first paint. Spread onto the popover
 *     root. The rAF loop will OVERWRITE `top` and `left` directly on
 *     the DOM node after mount — the React style only seeds the
 *     first frame so the popover doesn't flash at (0,0).
 *   - `popoverRef`: ref the caller MUST attach to the popover root.
 *     The rAF loop uses this to write style imperatively.
 */

type Options = {
  /* Gap between trigger bottom and popover top. Default 4px. */
  gap?: number;
  /* Match trigger width (default) vs use as minWidth only. */
  matchTriggerWidth?: boolean;
  /* Upper bound on popover height (px). Default 400. */
  maxHeight?: number;
  /* Floor when the trigger sits low in the viewport (px). Default 200. */
  minHeight?: number;
};

export function usePopoverPosition(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  options: Options = {},
): { style: CSSProperties } {
  const {
    gap = 4,
    matchTriggerWidth = true,
    maxHeight = 400,
    minHeight = 200,
  } = options;

  const [style, setStyle] = useState<CSSProperties>({});
  const rafRef = useRef<number | null>(null);

  // Compute the initial style synchronously so first paint is correct.
  // After mount, the rAF loop owns top/left and overwrites them.
  useLayoutEffect(() => {
    if (!open) return;
    if (!triggerRef.current) return;

    const t = triggerRef.current;
    const r = t.getBoundingClientRect();
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;

    const spaceBelow = viewH - r.bottom - gap - 8;
    const finalMaxHeight = Math.max(minHeight, Math.min(maxHeight, spaceBelow));

    const desiredWidth = matchTriggerWidth ? r.width : Math.max(r.width, 220);
    const maxLeft = viewW - desiredWidth - 8;
    const left = Math.min(Math.max(8, r.left), Math.max(8, maxLeft));

    setStyle({
      position: 'fixed',
      left,
      top: r.bottom + gap,
      ...(matchTriggerWidth ? { width: r.width } : { minWidth: r.width }),
      maxHeight: finalMaxHeight,
      zIndex: 60,
      // Defensive: Radix Dialog sets `pointer-events: none` on <body>
      // when modal=true. Our portaled popover is a body-level sibling
      // of the dialog overlay. pointer-events doesn't inherit by
      // default, but some browsers / wrapped layouts have caused it
      // to silently drop wheel/click events on body-portaled siblings
      // in past investigations. Explicit `auto` here is a belt-and-
      // suspenders guarantee that the popover always receives events.
      pointerEvents: 'auto',
    });
  }, [open, triggerRef, gap, matchTriggerWidth, maxHeight, minHeight]);

  // rAF loop: imperatively update the popover's top/left every frame
  // while open. This is what makes scroll-tracking smooth — no React
  // state in the hot path, no render-cycle lag.
  useEffect(() => {
    if (!open) return;

    let lastTop = -1;
    let lastLeft = -1;
    let lastWidth = -1;
    let lastMaxH = -1;

    function tick() {
      const t = triggerRef.current;
      const p = popoverRef.current;
      if (t && p) {
        const r = t.getBoundingClientRect();
        const viewH = window.innerHeight;
        const viewW = window.innerWidth;

        const spaceBelow = viewH - r.bottom - gap - 8;
        const finalMaxHeight = Math.max(minHeight, Math.min(maxHeight, spaceBelow));

        const desiredWidth = matchTriggerWidth ? r.width : Math.max(r.width, 220);
        const maxLeft = viewW - desiredWidth - 8;
        const left = Math.min(Math.max(8, r.left), Math.max(8, maxLeft));
        const top = r.bottom + gap;

        // Only write to DOM when something changed — avoids needless
        // style recalculations on idle frames.
        if (top !== lastTop || left !== lastLeft) {
          p.style.top = `${top}px`;
          p.style.left = `${left}px`;
          lastTop = top;
          lastLeft = left;
        }
        if (matchTriggerWidth && r.width !== lastWidth) {
          p.style.width = `${r.width}px`;
          lastWidth = r.width;
        }
        if (finalMaxHeight !== lastMaxH) {
          p.style.maxHeight = `${finalMaxHeight}px`;
          lastMaxH = finalMaxHeight;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [open, triggerRef, popoverRef, gap, matchTriggerWidth, maxHeight, minHeight]);

  // Clear computed style on close so the next open doesn't briefly
  // paint at the last position.
  useEffect(() => {
    if (!open) setStyle({});
  }, [open]);

  return { style };
}
