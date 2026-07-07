'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Minus, Plus, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePopoverPosition } from '@/lib/use-popover-position';
import { PORTAL_POPOVER_ATTR } from '@/lib/portal-markers';
import type { SearchOption } from './search-select';

/*
 * Multi-select sibling of `SearchSelect`. Visually mirrors the same
 * "button-as-input + popover with filter" pattern, but each row toggles
 * inclusion in `value` (an array). Replaces the older "checkbox list with
 * chips above" pattern in Manage Users — that pattern crowded the form,
 * pushed the chips into the operator's reading flow before they'd
 * finished selecting, and made long lists (cities, clients) feel heavy.
 *
 * Caller renders the selected chips wherever they want (typically below
 * the picker, since chips ABOVE the picker create a weird "selected,
 * then search, then more options" reading order). This component only
 * owns the trigger + popover.
 *
 * Props:
 *   value             — current selected values (strings/numbers)
 *   onChange          — replacement array on every toggle
 *   options           — full option list (dedup by value applied internally)
 *   placeholder       — closed-state hint text
 *   summarize         — optional formatter for the closed trigger label
 *                       (defaults to "N selected" / "Select…")
 *   onSelectAll       — optional callback to bulk-select currently
 *                       filtered options (visible in the popover footer).
 *                       Receives the currently-filtered values.
 *   onClearAll        — optional callback; if provided, a "Clear" footer
 *                       button shows when at least one option is selected.
 */

export function SearchMultiSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  className,
  disabled,
  emptyText = 'No matches',
  summarize,
  selectedLabel,
  indicator = 'checkbox',
}: {
  value: Array<string | number>;
  onChange: (next: Array<string | number>) => void;
  options: SearchOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  emptyText?: string;
  /* Custom trigger label generator. Receives the count of selected. */
  summarize?: (count: number) => string;
  /* Word for the selected unit, e.g. "cities" → "12 cities selected". */
  selectedLabel?: string;
  /*
   * Left-of-row affordance. 'checkbox' (default) = the square tick used by
   * Manage Users etc. 'plusminus' = a + (add, unselected) / − (remove,
   * selected) icon — clearer when the picker is paired with a chip list and
   * the action is "add this / drop this" rather than "tick this".
   */
  indicator?: 'checkbox' | 'plusminus';
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Dual-ref outside-click + portal positioning — see search-select.tsx
  // for the rationale (the portaled popover isn't a DOM descendant of
  // wrapRef, so a single wrap check would close on every option click).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // popoverRef goes into the hook's rAF tracker so the popover follows
  // the trigger imperatively on every paint frame (no chase-glitch).
  const { style: popStyle } = usePopoverPosition(open, triggerRef, popoverRef);

  // Dedup by value (same rationale as SearchSelect — upstream lookups
  // occasionally have duplicate rows we don't want to render twice).
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

  const selectedSet = useMemo(
    () => new Set(value.map((v) => String(v))),
    [value],
  );

  const filtered = useMemo(() => {
    if (!query) return uniqueOptions;
    const q = query.toLowerCase();
    return uniqueOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [query, uniqueOptions]);

  // Cap how many rows we PAINT. Some option sets are huge (e.g. the ~11k city
  // master), and rendering every <li> janks the popover. "Select filtered/all"
  // and the count both keep operating on the full `filtered` set below — only
  // the visible paint is capped, so bulk-select still covers everything.
  const RENDER_CAP = 300;
  const visible = filtered.length > RENDER_CAP ? filtered.slice(0, RENDER_CAP) : filtered;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      const inWrap = wrapRef.current?.contains(target);
      const inPopover = popoverRef.current?.contains(target);
      if (!inWrap && !inPopover) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  /*
   * Focus the filter input on open. Plain `.focus()` works reliably
   * now that our `Dialog` primitive defaults to `modal={false}` —
   * there's no FocusScope trap to fight, so a single call sticks.
   * If a caller forces `modal={true}` on a dialog that wraps this
   * component, the input will still focus initially but Radix may
   * pull it back; see dialog.tsx for that trade-off.
   */
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  /*
   * Wheel-trap to work around Radix Dialog's `react-remove-scroll` body
   * lock — see SearchSelect for the full rationale. Capture-phase
   * listener on the popover root fires after document-capture but before
   * descendants; manually advances ul.scrollTop and stopPropagation()s
   * so the event never reaches Radix's lock or the modal body.
   *
   * `deltaMode` normalisation matters for trackpad swipes that report
   * line-mode (deltaMode=1) with tiny line counts — without the
   * multiplier the scroll is imperceptible.
   */
  useEffect(() => {
    if (!open) return;
    const root = popoverRef.current;
    if (!root) return;

    const handler = (e: WheelEvent) => {
      const ul = root.querySelector('ul') as HTMLUListElement | null;
      if (!ul) return;
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;
      else if (e.deltaMode === 2) delta *= ul.clientHeight;
      ul.scrollTop += delta;
      e.preventDefault();
      e.stopPropagation();
    };

    root.addEventListener('wheel', handler, { passive: false, capture: true });
    return () => root.removeEventListener('wheel', handler, { capture: true });
  }, [open]);


  function toggle(opt: SearchOption) {
    const key = String(opt.value);
    if (selectedSet.has(key)) {
      onChange(value.filter((v) => String(v) !== key));
    } else {
      onChange([...value, opt.value]);
    }
  }

  function selectAllFiltered() {
    // Union of current selection + everything currently in the filtered
    // popover. "Select all" while a filter is active selects only what's
    // visible — matches the legacy form's behaviour.
    const next = new Set(value.map(String));
    for (const o of filtered) next.add(String(o.value));
    // Preserve original option types (number vs string) on the way out.
    const lookup = new Map(uniqueOptions.map((o) => [String(o.value), o.value]));
    onChange(Array.from(next).map((k) => lookup.get(k) ?? k));
  }

  function clearAll() {
    onChange([]);
  }

  const count = selectedSet.size;
  const label = summarize
    ? summarize(count)
    : count === 0
      ? placeholder
      : `${count}${selectedLabel ? ` ${selectedLabel}` : ''} selected`;

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm',
          // Matches SearchSelect — no ring on click, subtle border-color
          // shift on keyboard focus only.
          'focus:outline-none focus-visible:outline-none focus-visible:border-foreground/40',
          disabled && 'cursor-not-allowed opacity-50',
          count === 0 && 'text-muted-foreground',
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
      </button>

      {/*
       * Portaled popover, ALWAYS below the trigger (no flip). Plain
       * block layout — popover root has no max-height; the inner
       * `<ul max-h-72>` owns the scroll region. The wheel-trap
       * useEffect intercepts wheels inside the popover unconditionally
       * so the modal never scrolls. `PORTAL_POPOVER_ATTR` spreads the
       * `data-portal-popover` marker that keeps the dialog open when
       * clicking inside (see dialog.tsx + src/lib/portal-markers.ts).
       */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          style={popStyle}
          {...PORTAL_POPOVER_ATTR}
          /*
           * Flex column. The hook's `maxHeight` caps the popover;
           * `overflow-hidden` enforces the cap; filter + footer are
           * `shrink-0`; the ul gets `flex-1 min-h-0` to fill the
           * remaining height and scroll within it.
           */
          className="flex flex-col overflow-hidden rounded-md border bg-white shadow-lg"
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to filter…"
              className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="rounded hover:bg-muted p-0.5"
                aria-label="Clear filter"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
          {/* Footer-style bulk actions on top so they stay visible without
              scrolling. "Select filtered" reads "Select all" when the
              query box is empty — matches operator intent without an
              extra prop. */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b bg-slate-50 shrink-0">
            <span className="text-[11px] text-muted-foreground">
              {filtered.length} option{filtered.length === 1 ? '' : 's'} · {count} selected
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={selectAllFiltered}
                className="text-[11px] text-primary hover:underline"
              >
                Select {query.trim() ? 'filtered' : 'all'}
              </button>
              {count > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-[11px] text-muted-foreground hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          <ul className="flex-1 min-h-0 overflow-y-auto overscroll-contain py-1 text-sm" role="listbox" aria-multiselectable>
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-muted-foreground">{emptyText}</li>
            )}
            {/* Group-aware rendering — when options carry a `group`
                field, insert a non-clickable section header above the
                first option of each new group. Caller must sort by
                group; the renderer just detects group transitions. */}
            {(() => {
              const out: ReactNode[] = [];
              let lastGroup: string | undefined;
              visible.forEach((opt) => {
                if (opt.group && opt.group !== lastGroup) {
                  out.push(
                    <li
                      key={`__group:${opt.group}`}
                      className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide font-semibold text-muted-foreground bg-slate-50 border-b sticky top-0"
                      aria-hidden="true"
                    >
                      Service Category — {opt.group}
                    </li>
                  );
                  lastGroup = opt.group;
                }
                const key = String(opt.value);
                const isSel = selectedSet.has(key);
                out.push(
                  <li
                    key={key}
                    role="option"
                    aria-selected={isSel}
                    onClick={() => toggle(opt)}
                    className={cn(
                      'flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted',
                      // Selected rows read as clearly picked: a tinted bg +
                      // solid foreground text + medium weight, not the old
                      // barely-there bg-muted/40 wash.
                      isSel && 'bg-primary/10 text-foreground font-medium hover:bg-primary/15',
                    )}
                  >
                    {/* Left indicator. 'plusminus' = +/- (add / drop), used by
                        chip-paired pickers; otherwise the checkbox tick. Click
                        target is the whole row, not just the indicator. */}
                    {indicator === 'plusminus' ? (
                      <span
                        className={cn(
                          'h-4 w-4 shrink-0 flex items-center justify-center rounded-full',
                          // Selected: a filled red "remove" chip so the minus
                          // unmistakably reads as "click to drop". Unselected:
                          // a quiet outlined + "add".
                          isSel
                            ? 'bg-red-600 text-white'
                            : 'border border-muted-foreground/40 text-muted-foreground',
                        )}
                      >
                        {isSel ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                      </span>
                    ) : (
                      <span
                        className={cn(
                          'h-4 w-4 shrink-0 rounded-sm border flex items-center justify-center',
                          isSel ? 'bg-primary border-primary text-white' : 'border-muted-foreground/40',
                        )}
                      >
                        {isSel && <Check className="h-3 w-3" />}
                      </span>
                    )}
                    <span className="truncate flex-1">{opt.label}</span>
                  </li>
                );
              });
              if (filtered.length > visible.length) {
                out.push(
                  <li
                    key="__more"
                    className="px-3 py-2 text-[11px] text-muted-foreground bg-slate-50 border-t sticky bottom-0"
                    aria-hidden="true"
                  >
                    Showing first {visible.length} of {filtered.length} — type to narrow…
                  </li>
                );
              }
              return out;
            })()}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}
