'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePopoverPosition } from '@/lib/use-popover-position';

/*
 * Typeahead/combobox replacement for <select> when the option list is long
 * (cities, clients, users). Native <select> on a 1000-row list is punishing —
 * the user has to scroll through 250+ cities to find "Pune" even after typing
 * "p". This component:
 *   - filters options as you type (case-insensitive substring)
 *   - shows the currently selected value as the input placeholder when closed
 *   - clears the query on close so reopening starts fresh
 *   - supports keyboard: ↑/↓ to navigate, Enter to select, Esc to close
 *
 * The caller controls `value` + `onChange` just like a normal input, so it
 * drops in wherever a <Select /> was used.
 */

export type SearchOption = { value: string | number; label: string };

export function SearchSelect({
  value, onChange, options, placeholder = 'Select…',
  disabled, required, className, emptyText = 'No matches',
}: {
  value: string | number | '';
  onChange: (v: string) => void;
  options: SearchOption[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /*
   * `triggerRef` measures the button for popover positioning; `popoverRef`
   * exists so the outside-click listener can tell apart "clicked the
   * portaled popover" (keep open) from "clicked outside everything"
   * (close). The popover is no longer a DOM descendant of `wrapRef`
   * after the portal switch, so a single wrap-based check would close
   * the popover on every option click.
   */
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // popoverRef is passed in so the hook's rAF loop can write
  // `style.top/left/maxHeight` directly to the DOM node — bypassing
  // React state for smooth modal-scroll tracking.
  const { style: popStyle } = usePopoverPosition(open, triggerRef, popoverRef);

  /*
   * Deduplicate by `value` — if the caller passes rows with identical values
   * (common when lookups are keyed by name and upstream data has duplicates,
   * e.g. tbl_service_type has several "Treadmill" / "Estimate On VISIT"
   * entries), rendering them all would (a) trigger React's duplicate-key
   * warning and (b) show the user two indistinguishable rows. First-wins keeps
   * the list usable without needing every caller to sanitise first.
   */
  const uniqueOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: SearchOption[] = [];
    for (const o of options) {
      const k = String(o.value);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(o);
    }
    return out;
  }, [options]);

  const filtered = useMemo(() => {
    if (!query) return uniqueOptions;
    const q = query.toLowerCase();
    return uniqueOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [query, uniqueOptions]);

  const selected = uniqueOptions.find((o) => String(o.value) === String(value));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      // Clicks inside the trigger wrap OR the portaled popover both
      // keep it open. Anything else closes.
      const inWrap = wrapRef.current?.contains(target);
      const inPopover = popoverRef.current?.contains(target);
      if (!inWrap && !inPopover) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); }, [open]);
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  useEffect(() => { setActiveIdx(0); }, [query, open]);

  /*
   * Wheel-trap for the trackpad-swipe case.
   *
   * The scrollbar-drag case already works (proven by user testing) — the
   * ul IS scrollable, `scrollTop` writes land correctly. What doesn't
   * work is the trackpad/mousewheel gesture. The culprit: Radix Dialog
   * with `modal=true` ships `react-remove-scroll`, which attaches a
   * document-level wheel listener that `preventDefault`s scroll events
   * on elements outside its allowed scroll zone. Our body-portaled
   * popover is "outside" by that accounting, so its native wheel-driven
   * scroll is suppressed.
   *
   * Workaround: this handler runs in CAPTURE phase on the popover root,
   * which fires AFTER document-level capture (Radix) but BEFORE any
   * descendant handler. We:
   *   1. Read deltaY, normalising for `deltaMode` (some trackpads
   *      report line-mode with tiny deltas like 1–3 that scroll
   *      imperceptibly without the multiplier).
   *   2. Advance the ul's `scrollTop` directly — direct property
   *      mutation, not a "default action", so it works even if Radix
   *      already preventDefault'd the native scroll.
   *   3. `stopPropagation` so the event doesn't bubble to the modal
   *      body and trigger any other ancestor scroll machinery.
   *
   * `passive: false` is required for the listener to be able to call
   * preventDefault (React's onWheel prop is passive — no good).
   */
  useEffect(() => {
    if (!open) return;
    const root = popoverRef.current;
    if (!root) return;

    const handler = (e: WheelEvent) => {
      const ul = root.querySelector('ul') as HTMLUListElement | null;
      if (!ul) return;
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;          // line mode → ~16px/line
      else if (e.deltaMode === 2) delta *= ul.clientHeight; // page mode
      ul.scrollTop += delta;
      e.preventDefault();
      e.stopPropagation();
    };

    root.addEventListener('wheel', handler, { passive: false, capture: true });
    return () => root.removeEventListener('wheel', handler, { capture: true });
  }, [open]);

  function pick(opt: SearchOption) {
    onChange(String(opt.value));
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter')     { e.preventDefault(); if (filtered[activeIdx]) pick(filtered[activeIdx]); }
    else if (e.key === 'Escape')    { setOpen(false); }
  }

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      {/* The "closed" button looks like a native select. */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm',
          // Was: `focus:ring-1 focus:ring-ring` which fired on every
          // click. Replaced with a subtle border-color shift that only
          // appears on keyboard focus, so mouse-clicked triggers don't
          // get the blue ring outline the user asked us to remove.
          'focus:outline-none focus-visible:outline-none focus-visible:border-foreground/40',
          disabled && 'cursor-not-allowed opacity-50',
          !selected && 'text-muted-foreground'
        )}
      >
        <span className="truncate">{selected ? selected.label : placeholder}</span>
        <div className="flex items-center gap-1">
          {selected && !required && (
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); onChange(''); }}
              className="rounded hover:bg-muted p-0.5"
              aria-label="Clear selection"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          )}
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        </div>
      </button>

      {/*
       * Popover renders through a portal into <body> so it escapes the
       * Dialog's `overflow-y-auto` clip. Positioning is `fixed` directly
       * BELOW the trigger (no flip — see `usePopoverPosition`).
       *
       * Layout is plain block flow (NOT flex). The popover root has no
       * max-height; total height = filter input + ul (capped at
       * `max-h-72`). This keeps the scrollable region size predictable
       * regardless of viewport — long lists scroll the ul, short lists
       * just fit. The wheel-trap useEffect above intercepts wheels
       * inside the popover unconditionally.
       *
       * `data-portal-popover` is the marker `dialog.tsx`'s
       * `onInteractOutside` looks for to keep the dialog open when
       * a click lands inside this popover (clicks on body-level
       * portal siblings are "outside" by Radix's accounting).
       */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          style={popStyle}
          data-portal-popover=""
          /*
           * Flex column so the inner ul fills whatever vertical
           * space the hook's `maxHeight` allocates minus the filter
           * row. `overflow-hidden` enforces the maxHeight cap (CSS
           * max-height alone doesn't actually clip content — it
           * advisory-caps but lets overflow paint past).
           */
          className="flex flex-col overflow-hidden rounded-md border bg-white shadow-lg"
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder="Type to filter…"
              className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
            />
          </div>
          {/* `flex-1 min-h-0` = fills remaining height + can shrink
              below content size. `overflow-y-auto overscroll-contain`
              = native scrollbar + boundary chain stops here. */}
          <ul className="flex-1 min-h-0 overflow-y-auto overscroll-contain py-1 text-sm" role="listbox">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-muted-foreground">{emptyText}</li>
            )}
            {filtered.map((opt, i) => {
              const isSel = String(opt.value) === String(value);
              const isActive = i === activeIdx;
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={isSel}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => pick(opt)}
                  className={cn(
                    'flex items-center justify-between px-3 py-1.5 cursor-pointer',
                    isActive ? 'bg-muted' : '',
                    isSel ? 'text-foreground font-medium' : 'text-foreground/90'
                  )}
                >
                  <span className="truncate">{opt.label}</span>
                  {isSel && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                </li>
              );
            })}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}
