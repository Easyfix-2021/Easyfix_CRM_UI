'use client';

import { SearchSelect, type SearchOption } from '@/components/ui/search-select';

/*
 * Shift start picker — 30-minute slots only (00:00, 00:30 … 23:30), shown as
 * "10:00 AM", on the shared searchable dropdown (SearchSelect) like every other
 * picker in the CRM. The backend accepts only :00 / :30 too
 * (attendance-preference.service toShift), so a value this picker can't
 * produce is also rejected server-side.
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

// keywords: the 24-hour forms, so typing "14", "1430" or "14:30" finds 02:30 PM.
export const SHIFT_OPTIONS: SearchOption[] = Array.from({ length: 48 }, (_, i) => {
  const v = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
  return { value: v, label: label(v), keywords: `${v} ${v.replace(':', '')}` };
});

export function ShiftSelect({
  value, onChange, disabled, className, placeholder, title,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
  /**
   * Set ONLY where "no shift" is a real choice (Fill From Pattern: empty =
   * each member's own default). It makes the picker clearable; without it the
   * picker is `required` — a Default Shift or a grid row always has a shift.
   */
  placeholder?: string;
  title?: string;
}) {
  return (
    <div title={title} className={className}>
      <SearchSelect
        value={value}
        onChange={onChange}
        options={SHIFT_OPTIONS}
        placeholder={placeholder ?? 'Select Shift'}
        required={!placeholder}
        disabled={disabled}
        emptyText="No Matching Time"
      />
    </div>
  );
}
