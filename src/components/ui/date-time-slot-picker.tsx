'use client';

/*
 * TimeSelect + DateTimeSlotPicker — the shared "Requested Date & Time" control
 * used by Book New Call (create), Confirm & Schedule (confirm) and the
 * Schedule & Assign modal.
 *
 * TWO GRANULARITIES, chosen by the caller:
 *
 *   'half-hour'  (DEFAULT) — 30-MINUTE options (12:00, 12:30, 1:00 …) with a
 *                "Custom Time…" row pinned at the BOTTOM that reveals a free
 *                `type="time"` input for any-minute entry (per ops: "30-min
 *                options only + custom input from the bottom"). Used where the
 *                surface only REQUESTS a time that someone else will commit —
 *                today that is the customer's preferred-time field on the public
 *                magic-link form, which POSTs `preferred_datetime` to
 *                /reschedule-request and writes no job column.
 *                ⚠ The CRM's own RescheduleDialog is NOT one of these: it writes
 *                requested_date_time / requested_time / time_slot directly, so
 *                it uses 'hour-frame'.
 *
 *   'hour-frame' — the ten 1-HOUR booking frames from '@/lib/job-slots'
 *                (9-10 … 6-7). Picking one emits the frame's START, which is
 *                exactly what tbl_job.requested_time stores and what the
 *                Booking Time Slot band is derived from. Used on every surface
 *                that COMMITS a booking window (Book New Call, Confirm &
 *                Schedule, Edit). The trailing "After Hours / Custom Time" row
 *                reveals the same free `type="time"` input, which is how an
 *                out-of-hours visit (banding to 'After Hours') is entered.
 *
 * A stored time that is off-grid for the active granularity (legacy 16:30, or a
 * deliberate custom pick) drops the control into custom mode so the real value
 * stays visible and editable — never silently re-rounded.
 *
 * The 30-min list renders through the shared searchable <SearchSelect />
 * (typeahead combobox) so the operator can type "2:30" / "pm" to filter
 * instead of scrolling 48 rows — and its popover portals above the Dialog's
 * scroll container, which is exactly why the old native <select> was here.
 *
 * Values are the raw LOCAL strings — 'HH:mm' for TimeSelect, 'YYYY-MM-DDTHH:mm'
 * for DateTimeSlotPicker. Each caller keeps its OWN serialization (Book New
 * Call / Confirm send `new Date(...).toISOString()` UTC; Schedule & Assign
 * sends an IST wall-clock string). The picker never round-trips through UTC.
 */

import * as React from 'react';
import { Input } from './input';
import { SearchSelect, type SearchOption } from './search-select';
import { cn } from '@/lib/utils';
import { HOUR_FRAMES, isHourFrameStart } from '@/lib/job-slots';

const CUSTOM = '__custom__';

/** Which option grid the time dropdown offers. See the file header. */
export type TimeGranularity = 'half-hour' | 'hour-frame';

function label12h(h: number, m: number): string {
  const suffix = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, '0')} ${suffix}`;
}
function isHalfHour(v: string): boolean {
  return /^\d{2}:(00|30)$/.test(v);
}

export function TimeSelect({
  value, onChange, minTime, disabled, required, placeholder, className,
  granularity = 'half-hour',
}: {
  value: string;               // 'HH:mm' (24h) or ''
  onChange: (v: string) => void;
  minTime?: string;            // 'HH:mm' — options strictly before this are hidden (same-day gate)
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
  granularity?: TimeGranularity;
}) {
  const isFrames = granularity === 'hour-frame';
  // Is this value one of the offered rows, or does it need the free input?
  const onGrid = React.useCallback(
    (v: string) => (isFrames ? isHourFrameStart(v) : isHalfHour(v)),
    [isFrames],
  );
  // A value off the active grid (legacy data, or a deliberate custom pick)
  // drops the control into custom mode so the entered time stays visible.
  const [custom, setCustom] = React.useState<boolean>(!!value && !onGrid(value));
  /*
   * Remember the value WE last emitted, so the sync-effect below can tell an
   * OUTSIDE push apart from our own echo.
   *
   * Outside pushes re-decide custom mode in BOTH directions. That matters for
   * the paired Booking Time Slot control: clicking a band chip pushes the
   * band's start hour down here, and a control still latched in custom mode
   * from the job's off-grid stored time (16:30) would keep showing the free
   * input and "After Hours / Custom Time" while actually holding 09:00 — the
   * band and the time visibly disagreeing right next to each other.
   *
   * Our OWN emissions never re-decide, or typing into the free input would
   * snap the control shut the moment the half-typed value landed on the grid.
   */
  const selfEmitted = React.useRef<string>(value);
  React.useEffect(() => {
    if (value === selfEmitted.current) return;
    selfEmitted.current = value;
    setCustom(!!value && !onGrid(value));
  }, [value, onGrid]);
  const emit = (v: string) => { selfEmitted.current = v; onChange(v); };

  const options = React.useMemo<SearchOption[]>(() => {
    const out: SearchOption[] = [];
    if (isFrames) {
      // The ten booking frames, in order. `keywords` carries the 24-hour start
      // so typing "14" finds "2 PM - 3 PM".
      for (const f of HOUR_FRAMES) {
        if (minTime && f.start < minTime) continue;
        out.push({ value: f.start, label: f.label, keywords: f.start });
      }
      // Out-of-hours / any-minute escape, pinned last. Picking it reveals the
      // free time input; any time outside 9-19 bands to 'After Hours'.
      out.push({ value: CUSTOM, label: 'After Hours / Custom Time' });
      return out;
    }
    // Ordered to START at 08:00 and wrap through midnight to 07:30 — all 48
    // half-hour slots, business-hours-first (per ops). The same-day `minTime`
    // gate still hides past slots.
    for (let i = 0; i < 24; i++) {
      const h = (8 + i) % 24;
      for (const m of [0, 30]) {
        const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        if (minTime && hhmm < minTime) continue;
        // `keywords: hhmm` lets the operator filter by 24-hour form too —
        // typing "13" or "13:00" finds "1:00 PM".
        out.push({ value: hhmm, label: label12h(h, m), keywords: hhmm });
      }
    }
    // "Custom Time…" pinned last — picking it reveals the free time input.
    out.push({ value: CUSTOM, label: 'Custom Time…' });
    return out;
  }, [minTime, isFrames]);

  return (
    <div className={className}>
      <SearchSelect
        value={custom ? CUSTOM : value}
        options={options}
        placeholder={placeholder || '— Pick Time —'}
        disabled={disabled}
        required={required}
        onChange={(v) => {
          if (v === CUSTOM) { setCustom(true); return; } // reveal the free input; keep current value
          setCustom(false);
          emit(v);
        }}
      />
      {custom && (
        <Input
          type="time"
          value={value}
          disabled={disabled}
          required={required}
          onChange={(e) => emit(e.target.value)}
          className="mt-1.5"
        />
      )}
    </div>
  );
}

export function DateTimeSlotPicker({
  value, onChange, min, disabled, required, className, granularity = 'half-hour',
}: {
  value: string;               // 'YYYY-MM-DDTHH:mm' local, or ''
  onChange: (v: string) => void;
  min?: string;                // 'YYYY-MM-DDTHH:mm' local
  disabled?: boolean;
  required?: boolean;
  className?: string;
  /** Forwarded to <TimeSelect>. 'hour-frame' on booking surfaces. */
  granularity?: TimeGranularity;
}) {
  // Internal date/time state, DECOUPLED from the parent value. The parent only
  // ever receives a COMBINED value (or '' when incomplete) so its required-gate
  // fires — but the inputs must show a picked date BEFORE a time is chosen. If
  // the date input were bound straight to the (gated) parent value, picking a
  // date would emit '' and React would snap the controlled input back to empty
  // (the reschedule "can't pick a date" deadlock). Local state holds the date
  // so the time picker unlocks.
  const [date, setDate] = React.useState<string>(value ? value.split('T')[0] : '');
  const [time, setTime] = React.useState<string>(value ? (value.split('T')[1] || '') : '');
  // Remember the value WE last emitted so the sync-effect doesn't clobber local
  // state when the parent echoes back our own push('') (picking a date before a
  // time makes the parent value '', but we must keep the visible date).
  const lastPushed = React.useRef<string>(value);
  React.useEffect(() => {
    if (value === lastPushed.current) return; // our own echo — keep local state
    setDate(value ? value.split('T')[0] : '');
    setTime(value ? (value.split('T')[1] || '') : '');
    lastPushed.current = value;
  }, [value]);

  const minDate = min ? min.split('T')[0] : undefined;
  // Only gate the time list when the picked date IS the min date (today).
  const minTime = (min && date && date === minDate) ? min.split('T')[1] : undefined;

  // Push to the parent only when BOTH parts are present; otherwise '' so the
  // caller's required-gate fires and no half-formed value is submitted.
  const push = (d: string, t: string) => {
    const v = d && t ? `${d}T${t}` : '';
    lastPushed.current = v;
    onChange(v);
  };

  return (
    // Stack full-width on narrow screens (customer mobile magic-link page) and
    // sit side-by-side from `sm` up (desktop CRM Dialog). A half-width native
    // date input on mobile is too cramped to tap/read, which is why the
    // customer couldn't pick a date.
    <div className={cn('grid grid-cols-1 sm:grid-cols-2 gap-2', className)}>
      <Input
        type="date"
        min={minDate}
        value={date}
        disabled={disabled}
        required={required}
        onChange={(e) => {
          const d = e.target.value;
          // Switching to today can make the existing time past — drop it so the
          // operator re-picks a valid slot rather than submitting a past time.
          const newMinTime = (min && d === minDate) ? min!.split('T')[1] : undefined;
          const keptTime = (newMinTime && time && time < newMinTime) ? '' : time;
          setDate(d);
          setTime(keptTime);
          push(d, keptTime);
        }}
      />
      <TimeSelect
        value={time}
        minTime={minTime}
        granularity={granularity}
        disabled={disabled || !date}
        required={required}
        placeholder={date ? '— Pick Time —' : 'Pick A Date First'}
        onChange={(t) => { setTime(t); push(date, t); }}
      />
    </div>
  );
}
