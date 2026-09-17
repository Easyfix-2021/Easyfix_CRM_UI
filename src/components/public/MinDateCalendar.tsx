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

export function MinDateCalendar({
  value, minDate, onChange, placeholder = 'Select A Date',
}: {
  value: string;
  minDate: string;
  onChange: (iso: string) => void;
  placeholder?: string;
}) {
  const [minY, minM] = minDate.split('-').map(Number);
  const start = (value || minDate).split('-').map(Number);
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState({ y: start[0], m: start[1] - 1 });

  const firstDow = new Date(view.y, view.m, 1).getDay();
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const atFloorMonth = view.y < minY || (view.y === minY && view.m <= minM - 1);
  const shift = (delta: number) => {
    const d = new Date(view.y, view.m + delta, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };

  const label = value
    ? new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    })
    : placeholder;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md border border-ink-300 bg-card px-3 py-2 text-base text-left focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <Calendar className="h-4 w-4 shrink-0 text-ink-500" />
        <span className={value ? 'text-ink-900' : 'text-ink-500'}>{label}</span>
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-ink-300 bg-card p-3 select-none">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => shift(-1)}
              disabled={atFloorMonth}
              aria-label="Previous Month"
              className="rounded p-1.5 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm font-semibold text-ink-900">
              {new Date(view.y, view.m, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
            </div>
            <button
              type="button"
              onClick={() => shift(1)}
              aria-label="Next Month"
              className="rounded p-1.5 hover:bg-ink-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="mb-1 grid grid-cols-7 text-center text-xs font-medium text-ink-500">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d}>{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: firstDow }, (_, i) => <div key={`b${i}`} />)}
            {Array.from({ length: days }, (_, i) => {
              const iso = toIso(view.y, view.m, i + 1);
              const blocked = iso < minDate;
              const selected = iso === value;
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={blocked}
                  aria-pressed={selected}
                  onClick={() => { onChange(iso); setOpen(false); }}
                  className={
                    'h-9 rounded-full text-sm transition-colors '
                    + (blocked
                      ? 'cursor-not-allowed text-ink-300 line-through'
                      : selected
                        ? 'bg-success text-white'
                        : 'text-ink-900 hover:bg-ink-50')
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
