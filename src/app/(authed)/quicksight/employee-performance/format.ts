/*
 * QuickSight — Employee Performance: display formatters for the native tab.
 *
 * Numbers follow the MIS dashboard's own helpers
 * (dashboard_automation/dashboard.html) so a figure reads the same in both:
 *
 *   money   "₹" + toLocaleString('en-IN', { maximumFractionDigits: 0 })
 *   pct1    toFixed(1) + '%'           (not locale-grouped, like the page)
 *   hours2  toFixed(2)                 (Working / Productive / Away Hrs)
 *   dec1    toFixed(1)                 (Avg Age)
 *   days1   toFixed(1) + ' days'       (City Avg Aging, TX Avg Open Aging)
 *
 * null / undefined / NaN render as 0, as `Number(n || 0)` does on the page.
 *
 * Dates differ on purpose: fmtDay prints 'Sep' where the page's en-GB
 * toLocaleDateString prints 'Sept', and it never builds a Date, so no browser
 * timezone can move a 'YYYY-MM-DD' to the previous day.
 */

import { formatDate } from '@/lib/utils';
import type { ProductivityTone } from './types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Built once: an Intl.NumberFormat is far cheaper to reuse than toLocaleString per cell.
const INR_WHOLE = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const EN_IN = new Intl.NumberFormat('en-IN');

type Num = number | null | undefined;

const n0 = (n: Num): number => Number(n || 0);

/** ₹1,23,456 — whole rupees, Indian grouping. */
export function money(n: Num): string {
  return `₹${INR_WHOLE.format(n0(n))}`;
}

/** 89.1% — one decimal. */
export function pct1(n: Num): string {
  return `${n0(n).toFixed(1)}%`;
}

/** 1,23,456 — counts, Indian grouping. */
export function num(n: Num): string {
  return EN_IN.format(n0(n));
}

/** 7.50 — hours to two decimals. */
export function hours2(n: Num): string {
  return n0(n).toFixed(2);
}

/** 4.8 — one decimal (Client Avg Age). */
export function dec1(n: Num): string {
  return n0(n).toFixed(1);
}

/** 4.8 days — one decimal plus unit (City Avg Aging, TX Avg Open Aging). */
export function days1(n: Num): string {
  return `${dec1(n)} days`;
}

/** 'YYYY-MM-DD' → '01 Aug 2026'. '—' when empty. */
export function fmtDay(ymd: string | null | undefined): string {
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-');
  return `${d} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** 'YYYY-MM' (or a full 'YYYY-MM-DD') → 'Aug 2026'. '—' when empty. */
export function fmtMonth(ym: string | null | undefined): string {
  if (!ym) return '—';
  const [y, m] = ym.split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** An ISO instant (meta.uploadedAt) → '16 Sept 2026, 03:30 pm' in IST. */
export function fmtStamp(iso: string | null | undefined): string {
  return formatDate(iso);
}

/*
 * The dashboard's productivity colour (prodRowStyle, and build_data.py's
 * `status`): it reads PRODUCTIVE hours only — the legend's "Working ≥ 9 hrs"
 * / "Working < 8 hrs" wording is not in the code.
 *   ≥ 7.5 → good (green)   < 7 → bad (red)   otherwise → warn (orange)
 * A missing value compares false both ways on the page, so it is 'warn' here too.
 * On summed rows (several SPOCs) the hours are a sum; the threshold is per person.
 */
export const PRODUCTIVE_GOOD_HOURS = 7.5;
export const PRODUCTIVE_BAD_HOURS = 7;

export function productivityTone(productiveHours: Num): ProductivityTone {
  if (typeof productiveHours !== 'number' || Number.isNaN(productiveHours)) return 'warn';
  if (productiveHours >= PRODUCTIVE_GOOD_HOURS) return 'good';
  if (productiveHours < PRODUCTIVE_BAD_HOURS) return 'bad';
  return 'warn';
}
