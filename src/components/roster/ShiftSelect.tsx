'use client';

import { Select, type SelectOption } from '@/components/ui/select';

/*
 * Shift start picker — 30-minute slots only (00:00, 00:30 … 23:30), shown as
 * "10:00 AM". Replaces <input type="time">, which offers every minute. The
 * backend accepts only :00 / :30 too (attendance-preference.service toHhMm),
 * so a value this picker can't produce is also rejected server-side.
 *
 * Used by Add/Edit User (Default Shift), the roster grid rows and Fill From
 * Pattern — one list, so the three can never disagree on the granularity.
 */

export const DEFAULT_SHIFT = '10:00';

function label(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export const SHIFT_OPTIONS: SelectOption[] = Array.from({ length: 48 }, (_, i) => {
  const v = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
  return { value: v, label: label(v) };
});

export function ShiftSelect({
  value, onChange, disabled, className, placeholder, title,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
  /** When set, adds an empty first option (e.g. "Keep Default"). */
  placeholder?: string;
  title?: string;
}) {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      options={SHIFT_OPTIONS}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      title={title}
      aria-label={title ?? 'Shift Start'}
    />
  );
}
