'use client';

/*
 * TimeSelect + DateTimeSlotPicker — the shared "Requested Date & Time" control
 * used by Book New Call (create), Confirm & Schedule (confirm) and the
 * Schedule & Assign modal.
 *
 * TIME is offered in 30-MINUTE options (12:00, 12:30, 1:00 …) instead of the
 * old minute-granular native `datetime-local` / whole-hour dropdown, with a
 * "Custom Time…" row pinned at the BOTTOM of the list that reveals a free
 * `type="time"` input for any-minute entry (per ops: "30-min options only +
 * custom input from the bottom").
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

const CUSTOM = '__custom__';

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
}: {
  value: string;               // 'HH:mm' (24h) or ''
  onChange: (v: string) => void;
  minTime?: string;            // 'HH:mm' — 30-min options strictly before this are hidden (same-day gate)
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
}) {
  // A value that isn't on a 30-min boundary (legacy data, or a custom pick)
  // drops the control into custom mode so the entered time stays visible.
  const [custom, setCustom] = React.useState<boolean>(!!value && !isHalfHour(value));
  React.useEffect(() => {
    if (value && !isHalfHour(value)) setCustom(true);
  }, [value]);

  const options = React.useMemo<SearchOption[]>(() => {
    const out: SearchOption[] = [];
    for (let h = 0; h < 24; h++) {
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
  }, [minTime]);

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
          onChange(v);
        }}
      />
      {custom && (
        <Input
          type="time"
          value={value}
          disabled={disabled}
          required={required}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1.5"
        />
      )}
    </div>
  );
}

export function DateTimeSlotPicker({
  value, onChange, min, disabled, required, className,
}: {
  value: string;               // 'YYYY-MM-DDTHH:mm' local, or ''
  onChange: (v: string) => void;
  min?: string;                // 'YYYY-MM-DDTHH:mm' local
  disabled?: boolean;
  required?: boolean;
  className?: string;
}) {
  const [date, time] = value ? value.split('T') : ['', ''];
  const minDate = min ? min.split('T')[0] : undefined;
  // Only gate the time list when the picked date IS the min date (today).
  const minTime = (min && date && date === minDate) ? min.split('T')[1] : undefined;

  // Emit the combined local string only when BOTH parts are present; otherwise
  // '' so callers' required-gates fire and no half-formed value is submitted.
  const emit = (d: string, t: string) => onChange(d && t ? `${d}T${t}` : '');

  return (
    <div className={cn('grid grid-cols-2 gap-2', className)}>
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
          emit(d, keptTime);
        }}
      />
      <TimeSelect
        value={time}
        minTime={minTime}
        disabled={disabled || !date}
        required={required}
        placeholder={date ? '— Pick Time —' : 'Pick A Date First'}
        onChange={(t) => emit(date, t)}
      />
    </div>
  );
}
