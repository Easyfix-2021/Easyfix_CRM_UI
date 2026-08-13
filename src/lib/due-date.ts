/*
 * Training-deadline arithmetic — PREVIEW ONLY.
 *
 * ⚠ THE BACKEND IS AUTHORITATIVE. `POST /admin/lms/assignments` derives and
 * stores the real `due_date` server-side from `duration_months` /
 * `duration_days`; nothing here is ever sent to the API. This module exists
 * so the assign form can show the operator the date they are about to commit
 * to BEFORE they submit. It is a verbatim mirror of
 * `EasyFix_Backend/services/lms.service.js :: dueDateFrom` — if that function
 * ever changes, this one must change with it or the preview silently lies.
 *
 * The order of operations matters and is NOT interchangeable:
 *   1. months first, CLAMPED to the last day of the target month, then
 *   2. days added on top.
 * That clamp is what makes "31 Jan + 1 Month" land on 28 Feb rather than
 * overflowing to 3 Mar the way `Date.setMonth` would.
 */

/*
 * Today's date in Asia/Kolkata as 'YYYY-MM-DD'.
 *
 * Built from Intl (not `new Date().toISOString()`) because the browser's
 * local timezone is irrelevant — deadlines are counted from the IST business
 * day, which is also the clock the backend counts from. 'en-CA' formats
 * date-only as ISO, so no part-stitching is needed.
 */
export function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/*
 * dueDateFrom('2026-08-13', 3, 0) -> '2026-11-13'
 *
 * Returns null when both durations are zero/negative — "no duration" means
 * "no deadline", and the BE rejects that combination outright, so the caller
 * uses the null to block submission rather than rendering a fake date.
 *
 * All arithmetic runs in UTC (`Date.UTC` + `getUTC*` + `setUTCDate`) purely to
 * keep it timezone-neutral: the input and output are calendar dates, never
 * instants, so no DST or offset can shift the result by a day.
 */
export function dueDateFrom(
  fromIsoDate: string,
  months: number,
  days: number,
): string | null {
  if (months <= 0 && days <= 0) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fromIsoDate));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);

  // Months first. `monthIndex` can run past 11 (or below 0 if a caller ever
  // passes a negative month), so year carry and month wrap are computed
  // explicitly — the double-modulo keeps the month non-negative.
  const monthIndex = (mo - 1) + months;
  const year = y + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;

  // Day 0 of the NEXT month is the last day of the target month.
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDayOfTargetMonth);

  // Then days, on top of the clamped month result.
  const result = new Date(Date.UTC(year, month, day));
  result.setUTCDate(result.getUTCDate() + days);

  return result.toISOString().slice(0, 10);
}

/*
 * Anchor date an EXTENSION counts from — `max(today, due_date)`, a verbatim
 * mirror of what the server does in `PATCH /admin/lms/assignments/:c/:e`.
 *
 * The three cases this collapses into one expression:
 *   - OVERDUE row (due < today)  -> today, so "+7 Days" really is seven days
 *     from now and the technician is unblocked for that whole window.
 *   - NOT YET DUE (due >= today) -> the existing due date, so "+1 Month"
 *     ADDS a month rather than shortening a deadline that was months out.
 *   - NO deadline (NULL)         -> today.
 *
 * Anchoring an extension at today unconditionally would silently SHORTEN
 * every future deadline it touched, which is the opposite of "extend".
 */
export function extendAnchor(todayIso: string, dueDate: string | null | undefined): string {
  const due = dueDate ? String(dueDate).slice(0, 10) : '';
  // Both sides are fixed-width 'YYYY-MM-DD', so a string compare IS a
  // chronological compare — no Date objects, no timezone to get wrong.
  return due && due > todayIso ? due : todayIso;
}

/*
 * Human duration label — "3 Months", "10 Days", "1 Month 15 Days".
 * Title Case per house convention. Empty string when there is no duration,
 * so callers can decide what "no deadline" should read as.
 */
export function durationLabel(months: number, days: number): string {
  const parts: string[] = [];
  if (months > 0) parts.push(`${months} ${months === 1 ? 'Month' : 'Months'}`);
  if (days > 0) parts.push(`${days} ${days === 1 ? 'Day' : 'Days'}`);
  return parts.join(' ');
}
