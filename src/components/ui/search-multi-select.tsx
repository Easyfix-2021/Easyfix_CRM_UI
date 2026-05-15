'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePopoverPosition } from '@/lib/use-popover-position';
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
  const { style: popStyle } = usePopoverPosition(open, triggerRef);

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

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); }, [open]);
  useEffect(() => { if (!open) setQuery(''); }, [open]);

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
       * Portaled popover — same rationale as SearchSelect:
       *   - escapes Dialog `overflow-y-auto` clipping
       *   - `position: fixed` follows the trigger across ancestor scrolls
       *   - auto-flips above the trigger when below is tight
       *   - flex column + min-h-0 lets the option list scroll within
       *     whatever viewport space the hook allocates
       */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          style={popStyle}
          /*
           * `data-portal-popover` is the marker our Dialog primitive's
           * `onInteractOutside` looks for to keep the dialog open and
           * let clicks through. Without it, Radix DismissableLayer
           * intercepts every click inside this popover. See dialog.tsx.
           *
           * `overflow-hidden` is LOAD-BEARING — see search-select.tsx
           * for the rationale. Without it the inner <ul> won't scroll
           * even though it has `flex-1 min-h-0 overflow-y-auto`,
           * because `max-height` alone doesn't actually clip content.
           */
          data-portal-popover=""
          /*
           * `overscroll-contain` blocks scroll-chaining into the modal
           * body. Without it, scrolling inside the popover would bubble
           * up once the ul hits its top/bottom or when there's no
           * overflow at all — making the modal scroll instead.
           */
          className="flex flex-col overflow-hidden overscroll-contain rounded-md border bg-white shadow-lg"
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
            {filtered.map((opt) => {
              const key = String(opt.value);
              const isSel = selectedSet.has(key);
              return (
                <li
                  key={key}
                  role="option"
                  aria-selected={isSel}
                  onClick={() => toggle(opt)}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted',
                    isSel && 'bg-muted/40',
                  )}
                >
                  {/* Checkbox-style left indicator. Click target is the
                      whole row, not just the box. */}
                  <span
                    className={cn(
                      'h-4 w-4 shrink-0 rounded-sm border flex items-center justify-center',
                      isSel ? 'bg-primary border-primary text-white' : 'border-muted-foreground/40',
                    )}
                  >
                    {isSel && <Check className="h-3 w-3" />}
                  </span>
                  <span className="truncate flex-1">{opt.label}</span>
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
