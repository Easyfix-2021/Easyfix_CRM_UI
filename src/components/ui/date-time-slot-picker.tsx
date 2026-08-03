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
 *   'hour-frame' — WHOLE HOURS, all 24 of them (12:00 AM … 11:00 PM). The
 *                chosen hour IS the start of the 1-hour booking frame, which is
 *                exactly what tbl_job.requested_time stores and what the
 *                Booking Time Slot band is derived from. Used on every surface
 *                that COMMITS a booking window (Book New Call, Confirm &
 *                Schedule, Edit).
 *                NO minute selector and NO "Custom Time" escape row: the list
 *                already spans midnight to 11 PM, so an out-of-hours visit is
 *                just another hour in it (and bands to 'After Hours' on its
 *                own). It previously offered only the ten 9-7 frames plus an
 *                "After Hours / Custom Time" row that revealed a free
 *                `type="time"` input — two controls stacked under the date, and
 *                the frame rows duplicated the Booking Time Slot chips sitting
 *                immediately to their left. One hourly dropdown replaces both.
 *
 * OFF-GRID STORED TIMES (legacy 16:30, 05:30) are never blanked and never
 * silently re-rounded — but the two granularities keep them visible in
 * DIFFERENT ways, and mixing the two is what produced the double-control bug:
 *
 *   'half-hour'  → the control drops into CUSTOM mode, revealing the free
 *                  `type="time"` input already on offer there.
 *   'hour-frame' → NO custom mode. The stored time is appended to the dropdown
 *                  as a "(stored)" row, so there is exactly ONE control on
 *                  screen and no minute selector anywhere. Custom mode on this
 *                  granularity would select a CUSTOM row that does not exist,
 *                  leaving the dropdown showing its placeholder while a second
 *                  time input rendered underneath it.
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

/* Half-hour mode only — 'hour-frame' offers all 24 hours and needs no escape row. */
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

/* 'hour-frame' grid = anything on the hour. */
function isWholeHour(v: string): boolean {
  return /^\d{2}:00$/.test(v);
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
    (v: string) => (isFrames ? isWholeHour(v) : isHalfHour(v)),
    [isFrames],
  );
  /*
   * Does this value need the free `type="time"` input?
   *
   * HALF-HOUR ONLY — `!isFrames` is the load-bearing clause. 'hour-frame' has
   * no custom mode at all: an off-grid value there is appended as a "(stored)"
   * ROW in the same dropdown (see the options memo below), which is precisely
   * why that grid offers all 24 hours.
   *
   * Without the `!isFrames` guard, a booking surface opened on a job holding an
   * off-grid time (legacy 05:30 / 16:30) latched into custom mode — and since
   * 'hour-frame' offers no CUSTOM row, `value={CUSTOM}` matched no option and
   * SearchSelect fell back to its placeholder. That is the bug ops reported on
   * job #482491: the dropdown read "— Pick Time —" as though nothing were
   * picked, while a SECOND control (a native time input, minute wheel and all)
   * sat underneath holding the real 05:30. Two time controls where the design
   * has one — and the minute selector this granularity exists to remove.
   */
  const wantsCustom = React.useCallback(
    (v: string) => !isFrames && !!v && !onGrid(v),
    [isFrames, onGrid],
  );
  const [custom, setCustom] = React.useState<boolean>(() => wantsCustom(value));
  /*
   * Remember the value WE last emitted, so the sync-effect below can tell an
   * OUTSIDE push apart from our own echo.
   *
   * Outside pushes re-decide custom mode in BOTH directions, so a control
   * latched open by an off-grid stored time closes again the moment a caller
   * pushes an on-grid one (rather than showing the free input while actually
   * holding the pushed value — the two visibly disagreeing).
   *
   * Our OWN emissions never re-decide, or typing into the free input would
   * snap the control shut the moment the half-typed value landed on the grid.
   */
  const selfEmitted = React.useRef<string>(value);
  React.useEffect(() => {
    if (value === selfEmitted.current) return;
    selfEmitted.current = value;
    setCustom(wantsCustom(value));
  }, [value, wantsCustom]);
  const emit = (v: string) => { selfEmitted.current = v; onChange(v); };

  const options = React.useMemo<SearchOption[]>(() => {
    const out: SearchOption[] = [];
    if (isFrames) {
      /*
       * Every hour of the day, business-hours-first: 08:00 → 23:00 → 00:00 →
       * 07:00. Same ordering as the half-hour list below, so the two controls
       * feel identical; the wrap is what puts the hours ops actually books at
       * the top without hiding the after-hours ones.
       *
       * No "Custom Time" row and no minute input: the list already covers all
       * 24 hours, so an out-of-hours visit is simply one of them. Minutes are
       * deliberately not offered — a booking frame starts on the hour.
       */
      for (let i = 0; i < 24; i++) {
        const h = (8 + i) % 24;
        const hhmm = `${String(h).padStart(2, '0')}:00`;
        if (minTime && hhmm < minTime) continue;
        // `keywords` carries the 24-hour form so typing "14" finds "2:00 PM".
        out.push({ value: hhmm, label: label12h(h, 0), keywords: hhmm });
      }
      /*
       * A stored OFF-GRID time (legacy 16:30, or one typed before this control
       * offered whole hours only) is appended so it still renders as the
       * selection instead of the field reading blank — and so opening and
       * saving an untouched job cannot silently re-round it. Same
       * keep-what-is-stored rule the Booking Time Slot chips follow.
       */
      if (value && !isWholeHour(value)) {
        const [hh, mm] = value.split(':').map(Number);
        if (Number.isFinite(hh) && Number.isFinite(mm)) {
          out.push({ value, label: `${label12h(hh, mm)} (stored)`, keywords: value });
        }
      }
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
    lastPushed.current = value;
    if (!value) {
      /*
       * '' means INCOMPLETE, not "empty this control". That is the meaning WE
       * give it in push() — picking a date before a time emits '' while the date
       * stays on screen — so an incoming '' has to mean the same thing, or a
       * parent-initiated clear behaves differently from our own and takes the
       * operator's DATE away as collateral. Clear the time; keep the date.
       *
       * Booking Time Slot's "After Hours" chip depends on this: it clears the
       * time (that band has no start hour to nudge to, and guessing one commits
       * the customer to an hour nobody picked) and relies on the date surviving
       * so the operator only has to re-pick the hour.
       *
       * With no date held there is nothing to keep and this IS a full clear.
       */
      setTime('');
      return;
    }
    setDate(value.split('T')[0]);
    setTime(value.split('T')[1] || '');
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
