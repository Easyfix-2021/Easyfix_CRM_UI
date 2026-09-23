'use client';

import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type CSSProperties } from 'react';

/*
 * usePopoverPosition — fixed-positioned popover anchored under the
 * trigger, with smooth (rAF-driven) tracking when the trigger moves.
 *
 * Behaviour:
 *   - Positions directly BELOW the trigger whenever there is room.
 *     It flips ABOVE only when the space below is smaller than
 *     `minHeight` AND there is more room above — see the note below.
 *   - Width matches the trigger (default) so the popover lines up
 *     under the closed button visually.
 *   - `maxHeight` is the space on the chosen side, capped by the
 *     `maxHeight` option. Combined with `overflow-hidden` + flex
 *     layout on the popover root, this gives the inner ul a clean,
 *     reliable height budget to scroll within.
 *
 * Why it flips (2026-09-23):
 *   `maxHeight` used to be `max(minHeight, min(maxHeight, spaceBelow))`.
 *   That FLOOR could exceed the real room below, so a trigger low in
 *   the viewport rendered a popover past the viewport bottom. The
 *   hidden rows were unreachable: the popover's own scrollbar only
 *   scrolls WITHIN its box, and the clipped part of that box is off
 *   screen — measured at 900px tall viewport, an 8-row multi-select
 *   with 150/90/40px below the trigger lost 56/116/166px off screen,
 *   which is how the last role in a dialog's role picker vanished.
 *   Now the height never exceeds the space on the side it is drawn,
 *   so nothing can land off screen. With >= `minHeight` below, the
 *   placement and height are byte-identical to the old behaviour —
 *   only the cases that used to clip changed.
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
  /*
   * How little room below the trigger counts as "too cramped" (px).
   * Below this, the popover flips above when there is more room there.
   * Default 200. It is a THRESHOLD, never a floor that could push the
   * popover off screen — see the header note.
   */
  minHeight?: number;
};

type Placement = {
  place: 'below' | 'above';
  /* Exactly one of top/bottom is set; the other side is released. */
  top: number | null;
  bottom: number | null;
  left: number;
  maxHeight: number;
};

/*
 * One source of truth for the geometry. The first-paint effect and the
 * rAF loop both call it, so they cannot drift — they used to carry
 * copy-pasted copies of this arithmetic.
 */
export function computePlacement(
  r: DOMRect,
  viewH: number,
  viewW: number,
  { gap, matchTriggerWidth, maxHeight, minHeight }: Required<Options>,
): Placement {
  const below = viewH - r.bottom - gap - 8;
  const above = r.top - gap - 8;
  // Prefer below — that is the long-standing behaviour and what every
  // caller's markup expects. Flip up only when below is unusable AND
  // above is genuinely roomier.
  const place: 'below' | 'above' = below < minHeight && above > below ? 'above' : 'below';
  const space = place === 'above' ? above : below;

  const desiredWidth = matchTriggerWidth ? r.width : Math.max(r.width, 220);
  const maxLeft = viewW - desiredWidth - 8;

  return {
    place,
    // Never larger than the room on the chosen side, so the popover
    // cannot extend past the viewport edge and strand its own rows.
    maxHeight: Math.max(0, Math.min(maxHeight, space)),
    left: Math.min(Math.max(8, r.left), Math.max(8, maxLeft)),
    top: place === 'below' ? r.bottom + gap : null,
    // Anchor the BOTTOM edge just above the trigger: the popover then
    // grows upward on its own, so nothing has to measure its height.
    bottom: place === 'above' ? viewH - r.top + gap : null,
  };
}

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
    const p = computePlacement(r, window.innerHeight, window.innerWidth, {
      gap, matchTriggerWidth, maxHeight, minHeight,
    });

    setStyle({
      position: 'fixed',
      left: p.left,
      // Only the anchored side is set; the other stays `auto` so the
      // popover grows away from the trigger.
      ...(p.place === 'below' ? { top: p.top as number } : { bottom: p.bottom as number }),
      ...(matchTriggerWidth ? { width: r.width } : { minWidth: r.width }),
      maxHeight: p.maxHeight,
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

    let lastOffset = -1;
    let lastLeft = -1;
    let lastWidth = -1;
    let lastMaxH = -1;
    let lastPlace: 'below' | 'above' | '' = '';

    function tick() {
      const t = triggerRef.current;
      const p = popoverRef.current;
      if (t && p) {
        const r = t.getBoundingClientRect();
        const pl = computePlacement(r, window.innerHeight, window.innerWidth, {
          gap, matchTriggerWidth, maxHeight, minHeight,
        });
        const offset = (pl.place === 'below' ? pl.top : pl.bottom) as number;

        // Only write to DOM when something changed — avoids needless
        // style recalculations on idle frames. A flip must also RELEASE
        // the side it no longer anchors, or the popover would be pinned
        // top AND bottom and stretch between them.
        if (offset !== lastOffset || pl.left !== lastLeft || pl.place !== lastPlace) {
          if (pl.place === 'below') {
            p.style.bottom = '';
            p.style.top = `${offset}px`;
          } else {
            p.style.top = '';
            p.style.bottom = `${offset}px`;
          }
          p.style.left = `${pl.left}px`;
          lastOffset = offset;
          lastLeft = pl.left;
          lastPlace = pl.place;
        }
        if (matchTriggerWidth && r.width !== lastWidth) {
          p.style.width = `${r.width}px`;
          lastWidth = r.width;
        }
        if (pl.maxHeight !== lastMaxH) {
          p.style.maxHeight = `${pl.maxHeight}px`;
          lastMaxH = pl.maxHeight;
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
