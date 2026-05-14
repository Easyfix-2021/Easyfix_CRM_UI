'use client';

/*
 * DateRangePopover — single-control past-date range picker.
 *
 * Renders the calendar as a normal absolute-positioned child of the
 * trigger wrapper (NOT a portal). Keeping it inside the modal's DOM
 * tree is crucial: Radix's Dialog.Content `onPointerDownOutside`
 * fires for any `pointerdown` whose native target isn't a descendant
 * of DialogContent — a portalled popover would be a sibling of
 * DialogContent in document.body, so every click on the calendar
 * arrows / dates was flagged "outside the modal" and Radix closed
 * the dialog. Staying inside the modal lets Radix's default
 * outside-click logic Just Work.
 *
 * Clipping caveat: the parent modal (e.g. CallInfoModal) must NOT
 * apply `overflow-hidden` to its DialogContent so this popover can
 * visually extend past the modal's bottom edge. The modal's own
 * scrollable inner section keeps its own `overflow-y-auto` for the
 * table — no horizontal scrollbar regression.
 *
 * Interaction model:
 *   - First day click → pending start (no commit yet).
 *   - Second day click → commits the range (auto-swap if end < start)
 *     and closes the popover.
 *   - Swipe left within the calendar  → next month (locked at today).
 *   - Swipe right within the calendar → previous month.
 *   - `maxDate` (default = today) hard-caps the visible / clickable days.
 */

import * as React from 'react';
import { Calendar } from 'lucide-react';

type ISO = string; // 'YYYY-MM-DD'

function toIso(d: Date): ISO {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fromIso(s: ISO): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtDisplay(s: ISO): string {
  if (!s) return '—';
  const d = fromIso(s);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function DateRangePopover({
  from, to, onChange, maxDate, className,
}: {
  from: ISO; to: ISO;
  onChange: (next: { from: ISO; to: ISO }) => void;
  /** Defaults to today. Days after this are disabled. */
  maxDate?: ISO;
  className?: string;
}) {
  const today = toIso(new Date());
  const cap = maxDate || today;
  const [open, setOpen] = React.useState(false);
  const [month, setMonth] = React.useState<Date>(() => fromIso(from || today));
  // After the first day click, `pendingStart` holds the chosen start;
  // the next click commits the end. null = we're picking start.
  const [pendingStart, setPendingStart] = React.useState<ISO | null>(null);
  const [hover, setHover] = React.useState<ISO | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  // Touch-swipe state. Ref (not useState) so we don't re-render mid-swipe.
  const touchStartX = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setPendingStart(null);
        setHover(null);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Anchor the visible month to `from` whenever it changes externally
  // (e.g. modal reopen resets the range).
  React.useEffect(() => {
    if (from) setMonth(fromIso(from));
  }, [from]);

  function onDayClick(d: Date) {
    const iso = toIso(d);
    if (iso > cap) return;
    if (!pendingStart) {
      setPendingStart(iso);
    } else {
      const final = iso < pendingStart
        ? { from: iso, to: pendingStart }
        : { from: pendingStart, to: iso };
      onChange(final);
      setPendingStart(null);
      setHover(null);
      setOpen(false);
    }
  }

  // Visual range = committed (from/to) OR pending (pendingStart + hover).
  const visStart = pendingStart || from;
  const visEnd   = pendingStart ? (hover || pendingStart) : to;
  const [lo, hi] = (visStart && visEnd && visStart <= visEnd)
    ? [visStart, visEnd]
    : [visEnd || '', visStart || ''];

  // Month grid cells (with leading blanks for the first DOW).
  const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const firstDow = firstOfMonth.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: Array<Date | null> = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let i = 1; i <= daysInMonth; i++) cells.push(new Date(month.getFullYear(), month.getMonth(), i));

  const todayDate = new Date();
  const onCurrentMonth = month.getFullYear() === todayDate.getFullYear() && month.getMonth() >= todayDate.getMonth();

  return (
    <div ref={wrapRef} className={`relative ${className || ''}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full h-9 px-3 rounded-md border border-input bg-white text-left text-sm flex items-center gap-2 hover:bg-muted/40"
      >
        <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="truncate">
          <span className="text-muted-foreground">From:</span> {fmtDisplay(from)}
          <span className="mx-2 text-muted-foreground">→</span>
          <span className="text-muted-foreground">To:</span> {fmtDisplay(to)}
        </span>
      </button>
      {open && (
        <div
          className="absolute z-50 mt-1 bg-white border rounded-md shadow-lg p-3 w-[280px] select-none touch-pan-y"
          /*
           * Swipe-to-navigate. Records the first touch's X on
           * touchstart, computes delta on touchend; ≥40 px triggers a
           * month change. `touch-pan-y` lets vertical scrolling still
           * work natively while horizontal gestures route to us.
           */
          onTouchStart={(e) => {
            const t = e.touches[0];
            if (t) touchStartX.current = t.clientX;
          }}
          onTouchEnd={(e) => {
            if (touchStartX.current == null) return;
            const endX = e.changedTouches[0]?.clientX;
            if (endX == null) return;
            const dx = endX - touchStartX.current;
            touchStartX.current = null;
            if (Math.abs(dx) < 40) return;
            if (dx < 0) {
              // Swipe LEFT → next month (mirrors › disabled state).
              if (!onCurrentMonth) setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1));
            } else {
              // Swipe RIGHT → previous month.
              setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1));
            }
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
              className="px-2 h-7 rounded hover:bg-muted text-sm"
              aria-label="Previous month"
            >‹</button>
            <div className="text-sm font-medium">
              {month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
            </div>
            <button
              type="button"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
              className="px-2 h-7 rounded hover:bg-muted text-sm disabled:text-muted-foreground/40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              disabled={onCurrentMonth}
              aria-label="Next month"
            >›</button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground mb-1">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i}>{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d, i) => {
              if (!d) return <div key={i} />;
              const iso = toIso(d);
              const disabled = iso > cap;
              const inRange = iso >= lo && iso <= hi && !!lo && !!hi;
              const isEdge = iso === lo || iso === hi;
              const isToday = iso === today;
              return (
                <button
                  key={i}
                  type="button"
                  disabled={disabled}
                  onClick={() => onDayClick(d)}
                  onMouseEnter={() => pendingStart && setHover(iso)}
                  className={[
                    'h-7 text-xs rounded transition-colors',
                    disabled ? 'text-muted-foreground/30 cursor-not-allowed' : 'hover:bg-muted',
                    inRange && !disabled && !isEdge ? 'bg-sky-100' : '',
                    isEdge && !disabled ? 'bg-sky-600 text-white hover:bg-sky-700' : '',
                    isToday && !isEdge && !disabled ? 'ring-1 ring-sky-400' : '',
                  ].join(' ')}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          {pendingStart && (
            <div className="text-[11px] text-muted-foreground mt-2 text-center">
              Now pick the end date.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
