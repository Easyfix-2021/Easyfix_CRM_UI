'use client';

/*
 * MinDateCalendar — a single-date picker that greys out every day before
 * `minDate`, rendered by us instead of the browser.
 *
 * Why not <input type="date" min>: iOS Safari's native calendar ignores `min`
 * and leaves every day tappable (Android Chrome honours it). The only way to
 * block past days on iPhone is to draw the month ourselves.
 *
 * Inline, not a popover: it expands inside the dialog under its trigger, so
 * there is no portal / outside-click / clipping to manage on a public page.
 *
 * All values are naive 'YYYY-MM-DD' strings — they sort chronologically, so
 * "before the floor" is a string compare with no timezone math.
 */

import * as React from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** Pure: is this day blocked? Exported for tests. */
export function isDayBlocked(iso: string, minDate?: string, maxDate?: string, isDateDisabled?: (iso: string) => boolean): boolean {
  return (!!minDate && iso < minDate) || (!!maxDate && iso > maxDate) || !!isDateDisabled?.(iso);
}

export function MinDateCalendar({
  value, minDate, maxDate, isDateDisabled, inline = false, onChange, placeholder = 'Select A Date', disabled,
}: {
  value: string;
  /** Days before this 'YYYY-MM-DD' are disabled. Omitted = nothing is blocked. */
  minDate?: string;
  /** Days after this 'YYYY-MM-DD' are disabled. */
  maxDate?: string;
  /** Extra per-day block (e.g. a day with no free slot). */
  isDateDisabled?: (iso: string) => boolean;
  /** Always-open month grid, no trigger button (for a calendar view inside a form). */
  inline?: boolean;
  onChange: (iso: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [minY, minM] = (minDate || '').split('-').map(Number);
  const start = (value || minDate || new Date().toISOString().slice(0, 10)).split('-').map(Number);
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState({ y: start[0], m: start[1] - 1 });

  const firstDow = new Date(view.y, view.m, 1).getDay();
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const atFloorMonth = !!minDate && (view.y < minY || (view.y === minY && view.m <= minM - 1));
  const [maxY, maxM] = (maxDate || '').split('-').map(Number);
  const atCeilMonth = !!maxDate && (view.y > maxY || (view.y === maxY && view.m >= maxM - 1));
  const shift = (delta: number) => {
    const d = new Date(view.y, view.m + delta, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };

  const label = value
    ? new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    })
    : placeholder;

  const showGrid = inline || open;
  return (
    <div>
      {!inline && <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full items-center gap-2 rounded-md border border-input bg-card px-3 py-2 text-base text-left focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className={value ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
      </button>}
      {showGrid && !disabled && (
        <div className={(inline ? '' : 'mt-2 ') + 'rounded-md border border-input bg-card p-3 select-none'}>
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => shift(-1)}
              disabled={atFloorMonth}
              aria-label="Previous Month"
              className="rounded p-1.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm font-semibold text-foreground">
              {new Date(view.y, view.m, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
            </div>
            <button
              type="button"
              onClick={() => shift(1)}
              disabled={atCeilMonth}
              aria-label="Next Month"
              className="rounded p-1.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="mb-1 grid grid-cols-7 text-center text-xs font-medium text-muted-foreground">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d}>{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: firstDow }, (_, i) => <div key={`b${i}`} />)}
            {Array.from({ length: days }, (_, i) => {
              const iso = toIso(view.y, view.m, i + 1);
              const blocked = isDayBlocked(iso, minDate, maxDate, isDateDisabled);
              const selected = iso === value;
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={blocked}
                  aria-pressed={selected}
                  onClick={() => { onChange(iso); if (!inline) setOpen(false); }}
                  className={
                    'h-9 rounded-full text-sm transition-colors '
                    + (blocked
                      ? 'cursor-not-allowed text-muted-foreground/50 line-through'
                      : selected
                        ? 'bg-success text-white'
                        : 'text-foreground hover:bg-muted')
                  }
                >
                  {i + 1}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
