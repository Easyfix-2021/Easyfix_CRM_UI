'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/*
 * OptionChipList — generic chip-list with overflow handling.
 *
 * Renders the first `maxVisible` items as colour-toned chips inline,
 * then a "+N more" affordance for the rest. The full list is always
 * available via the chip-group's `title` attribute (native browser
 * tooltip) so hovering reveals everything even when N > maxVisible.
 *
 * Common uses:
 *   - "Service Categories" / "Service Types" cells on Manage
 *     Easyfixers (use `onOverflow={() => openCsvModal(...)}` for a
 *     search-modal drill-in).
 *   - "Mapped Options" cell on the Deep Skill ↔ Easyfixer mapping
 *     modal (no `onOverflow` — tooltip-only is enough).
 *
 * Source items can be plain strings OR { label, key? } objects.
 * Defensive fallbacks:
 *   - Null / empty `items` → renders the `emptyFallback` (default em-dash).
 *   - `count` prop (when supplied) lets callers surface a BE-side
 *     count that disagrees with the parsed list length (e.g. the
 *     SQL GROUP_CONCAT had a comma inside an option name and
 *     truncated). Shown as a "(N reported)" hint after the chips
 *     ONLY when overflow=0 AND count > parsed-length.
 */

type OptionChipItem = string | { label: string; key?: string | number };

export type OptionChipTone = 'teal' | 'sky' | 'slate' | 'emerald' | 'amber' | 'red';

const TONE_CLASSES: Record<OptionChipTone, string> = {
  teal:    'bg-teal-50 border-teal-200 text-teal-800',
  sky:     'bg-sky-50 border-sky-200 text-sky-800',
  slate:   'bg-slate-100 border-slate-200 text-slate-700',
  emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  amber:   'bg-amber-50 border-amber-200 text-amber-800',
  red:     'bg-red-50 border-red-200 text-red-800',
};

export type OptionChipListProps = {
  /** The list to render. Accepts plain strings OR { label, key? } objects. */
  items: ReadonlyArray<OptionChipItem> | null | undefined;
  /** Max chips rendered inline before the "+N more" pill. Default 3. */
  maxVisible?: number;
  /** Chip colour. Default 'teal' (matches the Deep Skill mapping flow). */
  tone?: OptionChipTone;
  /**
   * Optional click handler for the "+N more" pill. When provided the
   * pill becomes a button (e.g. opens a search modal); when omitted
   * it renders as plain text — operators still see the full list in
   * the title-attribute tooltip on hover.
   */
  onOverflow?: () => void;
  /**
   * Optional BE-side count for the "(N reported)" defensive hint
   * when parsing may have under-counted (e.g. SQL GROUP_CONCAT had
   * commas inside an item label).
   */
  count?: number;
  /** Max-width on the chip wrapper (Tailwind class string). Default `max-w-[28ch]`. */
  className?: string;
  /** Rendered when items is null/empty. Default: a muted em-dash. */
  emptyFallback?: React.ReactNode;
};

function toLabel(item: OptionChipItem): string {
  return typeof item === 'string' ? item : item.label;
}
function toKey(item: OptionChipItem, idx: number): string | number {
  if (typeof item === 'string') return item || idx;
  return item.key ?? item.label ?? idx;
}

export function OptionChipList({
  items,
  maxVisible = 3,
  tone = 'teal',
  onOverflow,
  count,
  className,
  emptyFallback = <span className="text-xs text-muted-foreground">—</span>,
}: OptionChipListProps) {
  const list = (items ?? []).filter((x) => toLabel(x).trim().length > 0);
  if (list.length === 0) return <>{emptyFallback}</>;

  const visible = list.slice(0, maxVisible);
  const overflow = list.length - visible.length;
  const fullText = list.map(toLabel).join(', ');

  return (
    <span
      className={cn('inline-flex flex-wrap items-center gap-1', className ?? 'max-w-[28ch]')}
      title={fullText}
    >
      {visible.map((item, idx) => (
        <span
          key={toKey(item, idx)}
          className={cn(
            'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-none whitespace-nowrap',
            TONE_CLASSES[tone],
          )}
        >
          {toLabel(item)}
        </span>
      ))}
      {overflow > 0 && (
        onOverflow ? (
          <button
            type="button"
            onClick={onOverflow}
            className="text-[11px] text-muted-foreground hover:text-foreground hover:underline whitespace-nowrap"
            title={fullText}
          >
            +{overflow} more
          </button>
        ) : (
          <span className="text-[11px] text-muted-foreground whitespace-nowrap">
            +{overflow} more
          </span>
        )
      )}
      {/*
        * Defensive: if BE-side count disagrees with the parsed list
        * length (e.g. GROUP_CONCAT truncated on an embedded comma),
        * surface a secondary hint so we don't silently undercount.
        * Only fires when overflow=0 (otherwise the +N already covers
        * it) AND count > parsed length.
        */}
      {overflow === 0 && typeof count === 'number' && count > list.length && (
        <span
          className="text-[11px] text-muted-foreground whitespace-nowrap"
          title={`${count} mappings reported by server`}
        >
          ({count})
        </span>
      )}
    </span>
  );
}
