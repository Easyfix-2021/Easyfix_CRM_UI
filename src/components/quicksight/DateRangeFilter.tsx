'use client';

/*
 * QuickSight — the Date Range control the report tabs share.
 *
 * The 2026-09-20 MIS dashboard replaced its Month select with one Date Range
 * menu — six presets over a From / To pair — and hid the Month select behind
 * it. This is that control in the CRM's own parts: the trigger is the
 * SearchSelect button, the menu is the same body-portaled popover the other
 * filters use, and the custom range is two Inputs and a Button.
 *
 * Built for the Employee Performance tab, it now serves MTD as well, which is
 * why it lives here rather than in either tab's folder. It holds NO report's
 * rules: the dates it offers come from the shared window helpers
 * (@/lib/report-window), and the one report-specific thing a picker needs —
 * how wide a window that report allows — arrives as the `allDates` prop.
 *
 * THREE OWNER DECISIONS PART FROM THE DASHBOARD FILE:
 *
 *   1. The dashboard anchors every preset to DR_MAX, the latest date in the
 *      snapshot it was built from. We read jobs live, so there is no snapshot
 *      and no latest date: presets anchor to TODAY in IST, the same day the
 *      body defaults the window to (the tab's `today`, from lib/due-date
 *      istToday). The anchor is passed in rather than read here so the whole
 *      tab shares one idea of "today".
 *
 *   2. "All dates" is not unbounded. The dashboard's snapshot is a few months
 *      of rows already in the page; ours is the live job table, where an
 *      unbounded window is a scan of the entire job history. All Dates is the
 *      widest range the CALLING tab allows — Employee Performance's
 *      MAX_RANGE_MONTHS, MTD's MAX_WINDOW_DAYS — handed in as `allDates` with
 *      the label that says which range that is, rather than promising dates it
 *      will not fetch. A tab that passes nothing simply has no All Dates row.
 *
 *   3. The cap is kept, and a range beyond it is REFUSED, not truncated: the
 *      body validates and toasts exactly as it did for the calendar this
 *      replaces. That is why `onChange` returns a boolean — false leaves the
 *      menu open on the dates the reader still has to fix, so the message and
 *      the fields it is about are on screen together.
 *
 * Every preset resolves through the shared date helpers (monthToDate,
 * monthWindow, recentMonths, shiftYmd) — the picker adds no second date rule
 * of its own, and Month To Date is every tab's default window, so "nothing
 * chosen" and "Month To Date" are the same dates and the same fetch key.
 *
 * The active preset is DERIVED from the window the body holds, never stored
 * here: Reset Filters, or any other change to from / to, moves the tick and
 * the trigger label with it and cannot desync.
 *
 * Keyboard: the trigger opens the menu and focus lands on the active preset;
 * ↑ / ↓ / Home / End move between presets, Enter or Space picks one, Tab
 * carries on into From / To / Apply Range (Enter applies from either field),
 * Escape closes and returns focus to the trigger, and tabbing past the last
 * control closes the menu behind you.
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { showToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { usePopoverPosition } from '@/lib/use-popover-position';
import { PORTAL_POPOVER_ATTR } from '@/lib/portal-markers';
import {
  fmtDayRange, monthToDate, monthWindow, recentMonths, shiftYmd, type DateWindow,
} from '@/lib/report-window';

type Preset = {
  /** Stable id: the DOM marker keyboard navigation walks, and the active tick's key. */
  id: string;
  label: string;
  window: DateWindow;
};

/** What a tab's widest allowed window is, and what to call it in the menu. */
export type AllDatesPreset = { window: DateWindow; label: string };

/**
 * The dashboard's six presets, anchored to `today` (IST) instead of its
 * DR_MAX, each one asking a shared window helper for its dates:
 *
 *   Today / Yesterday / Last 7 Days   shiftYmd, inclusive of both ends
 *   Month To Date                     monthToDate: the 1st .. today
 *   Last Month                        monthWindow on the previous IST month,
 *                                     which is whole — its last day is past
 *   All Dates                         the caller's `allDates`, omitted entirely
 *                                     when the caller passes none
 *
 * Last 7 Days counts today as one of the seven (today − 6), as the dashboard
 * does; it is not the seven days before today.
 */
function buildPresets(today: string, allDates?: AllDatesPreset): Preset[] {
  const yesterday = shiftYmd(today, -1);
  const lastMonth = recentMonths(today, 2)[1];
  const presets: Preset[] = [
    { id: 'today', label: 'Today', window: { from: today, to: today } },
    { id: 'yesterday', label: 'Yesterday', window: { from: yesterday, to: yesterday } },
    { id: 'last7', label: 'Last 7 Days', window: { from: shiftYmd(today, -6), to: today } },
    { id: 'mtd', label: 'Month To Date', window: monthToDate(today) },
    { id: 'lastMonth', label: 'Last Month', window: monthWindow(lastMonth, today) },
  ];
  if (allDates) presets.push({ id: 'all', label: allDates.label, window: allDates.window });
  return presets;
}

export function DateRangeFilter({
  from, to, today, onChange, allDates, className,
}: {
  /** The effective window the body is showing (the tab's resolveWindow), 'YYYY-MM-DD'. */
  from: string;
  to: string;
  /** The IST day the tab opened on: every preset is anchored here, and no later date is offered. */
  today: string;
  /**
   * Applies a window. TRUE when the body accepted it — the menu then closes;
   * false when the body refused it (over the cap, back to front, after today)
   * and has toasted why, and the menu stays open on those dates.
   */
  onChange: (next: DateWindow) => boolean;
  /**
   * The widest window this report allows, and what to call it — the All Dates
   * row. The cap itself is the tab's rule (it is the tab that refuses a range
   * beyond it), so the picker only shows what the tab says. Omit it and the
   * row is not offered at all.
   */
  allDates?: AllDatesPreset;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // The custom From / To fields, seeded from the live window each time the menu
  // opens so they start on whatever is being shown, edited freely while open,
  // and thrown away on close — the window itself is the body's state, not ours.
  const [draft, setDraft] = useState<DateWindow>({ from, to });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fieldId = useId();

  /*
   * Same body portal as SearchSelect and SearchMultiSelect beside it: fixed
   * under the trigger, tracked on every frame so scrolling never detaches it,
   * and marked so a Dialog's outside-click guard treats a click in here as
   * inside. matchTriggerWidth is off because the preset rows carry their dates
   * on the same line — the menu sets its own width and only grows to the
   * trigger's when that is wider.
   */
  const { style: popStyle } = usePopoverPosition(open, triggerRef, popoverRef, {
    matchTriggerWidth: false,
    maxHeight: 520,
    minHeight: 280,
  });

  // Cheap enough to rebuild whenever the caller hands over a fresh `allDates`
  // object (most callers compute one inline); the memo is for `today` alone.
  const presets = useMemo(() => buildPresets(today, allDates), [today, allDates]);
  const active = presets.find((p) => p.window.from === from && p.window.to === to) ?? null;
  const activeId = active?.id ?? null;
  const rangeText = fmtDayRange(from, to);

  const openMenu = () => {
    setDraft({ from, to });
    setOpen(true);
  };
  const closeMenu = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  /* A click anywhere else closes the menu, and leaves focus where it landed. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /*
   * Focus the active preset when the menu opens (the first one when the window
   * is a custom range), so a keyboard user lands on what is currently chosen
   * rather than at the top of a list. preventScroll: the popover is portaled to
   * the end of <body> and fixed-positioned, so the browser's "scroll it into
   * view" would drag the page instead.
   */
  useEffect(() => {
    if (!open) return;
    const items = presetButtons(listRef.current);
    const target = items.find((b) => b.dataset.preset === activeId) ?? items[0];
    target?.focus({ preventScroll: true });
  }, [open, activeId]);

  const apply = (next: DateWindow) => {
    if (onChange(next)) closeMenu(true);
  };

  const applyCustom = () => {
    if (!draft.from || !draft.to) {
      showToast({ variant: 'error', message: 'Pick both a From and a To date for a custom range' });
      return;
    }
    apply({ from: draft.from, to: draft.to });
  };

  /* ↑ / ↓ / Home / End walk the presets; the browser's own Enter / Space press them. */
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const items = presetButtons(listRef.current);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    if (e.key === 'ArrowDown') items[i < 0 ? 0 : Math.min(i + 1, items.length - 1)]?.focus();
    else if (e.key === 'ArrowUp') items[i < 0 ? 0 : Math.max(i - 1, 0)]?.focus();
    else if (e.key === 'Home') items[0]?.focus();
    else items[items.length - 1]?.focus();
  };

  return (
    <div className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Date Range: ${active ? `${active.label}, ` : ''}${rangeText}`}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={(e) => { if (e.key === 'Escape' && open) closeMenu(true); }}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm',
          // The filters' shared focus treatment: no ring on a mouse click, a
          // darker border for the keyboard (see SearchSelect).
          'focus:outline-none focus-visible:outline-none focus-visible:border-foreground/40',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Calendar className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">
            {active ? (
              <>
                {active.label}
                <span className="text-muted-foreground"> · {rangeText}</span>
              </>
            ) : rangeText}
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          style={popStyle}
          {...PORTAL_POPOVER_ATTR}
          role="dialog"
          aria-label="Date Range"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(true); } }}
          /*
           * Tabbing (or clicking) out of the last control closes the menu
           * behind you. A null relatedTarget is the window losing focus, not a
           * move within the page, and must NOT close it — switching to another
           * app and back should find the menu as you left it.
           */
          onBlur={(e) => {
            const next = e.relatedTarget as Node | null;
            if (!next) return;
            if (e.currentTarget.contains(next) || triggerRef.current?.contains(next)) return;
            setOpen(false);
          }}
          className="flex w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-md border bg-popover shadow-lg"
        >
          <div
            ref={listRef}
            role="group"
            aria-label="Date Range Presets"
            onKeyDown={onListKey}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          >
            {presets.map((p) => {
              const isActive = p.id === activeId;
              return (
                <button
                  key={p.id}
                  type="button"
                  data-preset={p.id}
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => apply(p.window)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm',
                    'hover:bg-muted focus:outline-none focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-foreground/30',
                    isActive ? 'bg-ink-100 font-semibold text-foreground' : 'text-foreground/90',
                  )}
                >
                  <span className="truncate">{p.label}</span>
                  {/* The dates a preset resolves to, as the dashboard shows them. */}
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {fmtDayRange(p.window.from, p.window.to)}
                    {isActive && <Check className="size-3.5 text-primary" aria-hidden />}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="shrink-0 border-t bg-muted/30 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Custom Range
            </div>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <label htmlFor={`${fieldId}-from`} className="block text-xs font-medium text-muted-foreground">From</label>
                <Input
                  id={`${fieldId}-from`}
                  type="date"
                  value={draft.from}
                  max={today}
                  onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustom(); } }}
                />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <label htmlFor={`${fieldId}-to`} className="block text-xs font-medium text-muted-foreground">To</label>
                <Input
                  id={`${fieldId}-to`}
                  type="date"
                  value={draft.to}
                  max={today}
                  onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustom(); } }}
                />
              </div>
            </div>
            <Button type="button" size="sm" className="mt-3 w-full" onClick={applyCustom}>
              Apply Range
            </Button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** The preset rows in DOM order — the one list keyboard navigation and the open-focus share. */
function presetButtons(list: HTMLDivElement | null): HTMLButtonElement[] {
  return list ? Array.from(list.querySelectorAll<HTMLButtonElement>('button[data-preset]')) : [];
}
