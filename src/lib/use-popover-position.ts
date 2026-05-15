'use client';

import { useEffect, useLayoutEffect, useState, type RefObject, type CSSProperties } from 'react';

/*
 * usePopoverPosition — viewport-aware fixed positioning for a popover
 * (combobox / dropdown / menu) that renders via a portal.
 *
 * Solves two problems the older inline `position: absolute` popovers
 * could not:
 *
 *  1. ESCAPE OVERFLOW. Inside a Dialog (or any container with
 *     `overflow-y-auto` / `overflow-hidden`), an absolutely-positioned
 *     popover gets clipped at the container edge — the option list
 *     disappears off the bottom or auto-scrolls the modal body. Portals
 *     + `position: fixed` (relative to the viewport) sidestep both.
 *
 *  2. FLIP UP WHEN BELOW IS TIGHT. The hook measures the trigger's
 *     viewport rectangle on every open, scroll, and resize. If there
 *     isn't enough room below for the popover's max height, it places
 *     the popover above the trigger instead (and shrinks it to the
 *     larger of the two gaps if neither side is comfortable). The
 *     caller doesn't pick a direction — the hook decides per render.
 *
 * Returns:
 *   - `style`: a CSSProperties object the caller spreads onto the
 *     portal popover root. Includes `position: fixed`, `left`, `width`,
 *     `top` or `bottom` (depending on flip), `maxHeight`, and `zIndex`.
 *   - `placement`: `"bottom"` or `"top"` — useful if the caller wants
 *     to flip a corner radius / arrow / shadow direction.
 *
 * Notes:
 *   - The scroll listener uses capture (`true` 3rd arg) so it fires
 *     when ANY ancestor scroll container moves (e.g. a Dialog body) —
 *     not only the document. Without capture, scrolling inside the
 *     modal would leave the popover stuck at the wrong screen position.
 *   - `useLayoutEffect` keeps the popover painted at the right place on
 *     first render; using `useEffect` would briefly flash the popover
 *     at (0,0) before the position kicks in.
 */

type Options = {
  /*
   * Hard cap on popover height in pixels. The hook will shrink the
   * computed maxHeight further when there isn't enough space on
   * either side. Default 320px matches Tailwind's `max-h-80`, which
   * comfortably holds 8–10 dropdown rows + filter input + footer.
   */
  maxHeight?: number;
  /*
   * Gap in pixels between the trigger edge and the popover edge.
   * Default 4px — matches the old `mt-1` (4px) spacing.
   */
  gap?: number;
  /*
   * When true (default), the popover width matches the trigger width
   * exactly. When false, the popover gets `minWidth` of the trigger
   * but can grow wider — useful for option lists with long labels.
   */
  matchTriggerWidth?: boolean;
};

export function usePopoverPosition(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  options: Options = {},
): { style: CSSProperties; placement: 'top' | 'bottom' } {
  const { maxHeight = 320, gap = 4, matchTriggerWidth = true } = options;

  const [style, setStyle] = useState<CSSProperties>({});
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');

  // useLayoutEffect so the popover gets its first paint at the correct
  // place — preventing the (0,0) flash you get with useEffect.
  useLayoutEffect(() => {
    if (!open) return;
    const trig = triggerRef.current;
    if (!trig) return;

    function update() {
      const t = triggerRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const viewH = window.innerHeight;
      const viewW = window.innerWidth;

      const spaceBelow = viewH - r.bottom - gap;
      const spaceAbove = r.top - gap;

      // Prefer below when it fits the requested maxHeight. Only flip
      // above if (a) below is too tight AND (b) above has more room.
      // This avoids unnecessary flips when both directions are
      // adequate — operators expect "down" by default.
      const flipUp = spaceBelow < maxHeight && spaceAbove > spaceBelow;
      const chosenSpace = flipUp ? spaceAbove : spaceBelow;
      // Leave at least 8px from the viewport edge so the popover
      // doesn't kiss the bottom of the screen.
      const finalMaxH = Math.max(120, Math.min(maxHeight, chosenSpace - 8));

      // Clamp `left` so the popover doesn't run off the right edge of
      // the viewport on narrow screens or when the trigger is near
      // the right side. The 8px padding keeps it visually inset.
      const desiredWidth = matchTriggerWidth ? r.width : Math.max(r.width, 220);
      const maxLeft = viewW - desiredWidth - 8;
      const left = Math.min(Math.max(8, r.left), Math.max(8, maxLeft));

      const next: CSSProperties = {
        position: 'fixed',
        left,
        ...(matchTriggerWidth ? { width: r.width } : { minWidth: r.width }),
        maxHeight: finalMaxH,
        // Above the Dialog overlay (which sits at z-50). Anything that
        // floats over modals lives at z-[60]+ in this app.
        zIndex: 60,
      };
      if (flipUp) {
        next.bottom = viewH - r.top + gap;
      } else {
        next.top = r.bottom + gap;
      }
      setStyle(next);
      setPlacement(flipUp ? 'top' : 'bottom');
    }

    update();

    // Capture mode so we hear scrolls from ancestor scroll containers
    // (Dialog body, page, sidebar) — not just window scroll. Without
    // this, scrolling the modal would leave the popover stranded at
    // a stale screen position.
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, triggerRef, maxHeight, gap, matchTriggerWidth]);

  // When the popover closes, clear the computed style so the next open
  // doesn't briefly paint at the LAST position before recomputing.
  useEffect(() => {
    if (!open) setStyle({});
  }, [open]);

  return { style, placement };
}
