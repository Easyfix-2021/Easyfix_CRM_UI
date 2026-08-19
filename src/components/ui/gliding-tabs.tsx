'use client';

/*
 * GlidingTabs — a segmented tab strip whose active "pill" SLIDES between tabs
 * instead of snapping.
 *
 * Visually identical to the Radix `Tabs`/`TabsList` pair in ./tabs.tsx (same
 * muted track, same white active pill) — the only difference is that the pill
 * is one absolutely-positioned element that animates its `left`/`width` rather
 * than a background toggling on each trigger.
 *
 * WHY NOT just animate the shared TabsList: it is used in 11 places (JobModal,
 * finance, clients, three other QuickSight reports…). Changing the shared
 * primitive would restyle all of them at once. This is a separate, opt-in
 * component; if the motion is liked, folding it into TabsList is a follow-up
 * with a much bigger blast radius.
 *
 * Measurement details that matter (the naive version gets these wrong):
 *   - useLayoutEffect, not useEffect — measuring after paint makes the pill
 *     visibly jump on first render.
 *   - The pill is not rendered at all until measured, so it never animates in
 *     from left:0/width:0.
 *   - A ResizeObserver re-measures on container OR label resize. Without it the
 *     pill drifts out of alignment when the window resizes or when the webfont
 *     (Mulish, loaded async by next/font) swaps in and changes label widths.
 *   - Keyed by tab VALUE, not index, so reordering tabs can't silently move the
 *     selection.
 *
 * Controlled only — the caller owns `value`, so the tab can be synced to URL
 * state or reset by a filter change.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export type GlidingTabItem = {
  value: string;
  label: string;
  /** Optional trailing count chip, e.g. row totals per tab. */
  count?: number;
};

export function GlidingTabs({
  tabs, value, onChange, className, ariaLabel,
}: {
  tabs: GlidingTabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const btnRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const [pill, setPill] = React.useState<{ left: number; width: number } | null>(null);

  const measure = React.useCallback(() => {
    const el = btnRefs.current[value];
    // offsetLeft is relative to the nearest positioned ancestor — the container
    // below is `relative`, so these coordinates are already pill-space.
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value]);

  // Before paint, so the pill is never seen in the wrong place.
  React.useLayoutEffect(() => { measure(); }, [measure, tabs.length]);

  React.useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(list);
    for (const el of Object.values(btnRefs.current)) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [measure, tabs.length]);

  // Roving arrow-key navigation — a plain <button> row gives none of this for
  // free (the Radix version does, which is why this is the one place we
  // re-implement it rather than dropping the a11y).
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex((t) => t.value === value);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].value);
    btnRefs.current[tabs[next].value]?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'relative inline-flex h-9 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground',
        className,
      )}
    >
      {pill && (
        <span
          aria-hidden
          className="absolute top-1 bottom-1 rounded-sm bg-background shadow"
          style={{
            left: pill.left,
            width: pill.width,
            transition: 'left .4s cubic-bezier(.65,0,.35,1), width .4s cubic-bezier(.65,0,.35,1)',
          }}
        />
      )}
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            // Only the active tab is in the tab order; arrows move within the
            // strip (the standard tablist pattern).
            tabIndex={active ? 0 : -1}
            // Block body: a concise arrow would RETURN the element, which React
            // treats as a ref cleanup function (and errors on in React 19).
            ref={(el) => { btnRefs.current[t.value] = el; }}
            onClick={() => onChange(t.value)}
            className={cn(
              'relative z-10 inline-flex items-center justify-center gap-1.5 whitespace-nowrap',
              'rounded-sm px-3 py-1 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'text-foreground' : 'hover:text-foreground/80',
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="rounded-full bg-muted-foreground/15 px-1.5 text-xs font-semibold tabular-nums">
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
