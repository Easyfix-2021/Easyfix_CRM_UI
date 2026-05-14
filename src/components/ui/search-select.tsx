'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

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
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); }, [open]);
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  useEffect(() => { setActiveIdx(0); }, [query, open]);

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

      {open && (
        // Explicit `bg-white` (instead of `bg-popover`) guarantees the dropdown
        // is fully opaque even when it floats over form inputs inside a modal.
        // Previously the `bg-popover` token was resolving translucent, so the
        // Schedule section text bled through behind the options list.
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-white shadow-lg">
          <div className="flex items-center gap-2 px-3 py-2 border-b">
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
          <ul className="max-h-64 overflow-y-auto py-1 text-sm" role="listbox">
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
        </div>
      )}
    </div>
  );
}
