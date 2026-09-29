/*
 * Pure 'YYYY-MM-DD' string helpers for the roster grid.
 *
 * All arithmetic runs through Date.UTC / getUTC* — never `new Date(ymd)` +
 * local getters, which reads a date-only string as browser-local midnight
 * and can shift the calendar day by the timezone offset. Mirrors the same
 * pattern already used in src/lib/due-date.ts (dueDateFrom).
 */

const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type RosterView = 'week' | 'month';

function toUtcDate(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}
function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDaysYmd(ymd: string, n: number): string {
  const d = toUtcDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return toYmd(d);
}
export function addMonthsYmd(ymd: string, n: number): string {
  const d = toUtcDate(ymd);
  d.setUTCMonth(d.getUTCMonth() + n);
  return toYmd(d);
}
/** Monday=0 .. Sunday=6 — the contract's own weekday index. */
export function weekdayIndexMonday0(ymd: string): number {
  return (toUtcDate(ymd).getUTCDay() + 6) % 7;
}
export function weekdayShort(ymd: string): string {
  return WEEKDAY_SHORT[weekdayIndexMonday0(ymd)];
}
export function dayOfMonth(ymd: string): number {
  return toUtcDate(ymd).getUTCDate();
}
export function startOfWeekMonday(ymd: string): string {
  return addDaysYmd(ymd, -weekdayIndexMonday0(ymd));
}
export function startOfMonth(ymd: string): string {
  const d = toUtcDate(ymd);
  return toYmd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
}
export function endOfMonth(ymd: string): string {
  const d = toUtcDate(ymd);
  return toYmd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}
/** 'YYYY-MM' — the calendar month a date falls in. */
export function monthKey(ymd: string): string {
  return ymd.slice(0, 7);
}
export function formatYmdLabel(ymd: string): string {
  const d = toUtcDate(ymd);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** "28 Sep – 04 Oct 2026" */
export function formatRangeLabel(from: string, to: string): string {
  const a = toUtcDate(from);
  const left = `${String(a.getUTCDate()).padStart(2, '0')} ${MONTH_SHORT[a.getUTCMonth()]}`;
  return `${left} – ${formatYmdLabel(to)}`;
}
export function daysBetweenInclusive(from: string, to: string): number {
  const a = toUtcDate(from).getTime();
  const b = toUtcDate(to).getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000) + 1);
}
/*
 * IST 'today' as YYYY-MM-DD — used only to seed the INITIAL view before the
 * first server response lands. `window.today` from GET /admin/roster is
 * authoritative for every "is this cell past?" decision once it arrives;
 * this is never used for that. Mirrors lib/due-date.ts::istToday.
 */
export function istTodayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/** The visible [from, to] range for a view anchored on a given date. */
export function rangeFor(view: RosterView, anchor: string): { from: string; to: string } {
  if (view === 'week') {
    const from = startOfWeekMonday(anchor);
    return { from, to: addDaysYmd(from, 6) };
  }
  const from = startOfMonth(anchor);
  return { from, to: endOfMonth(anchor) };
}
/** Where prev/next should move the anchor for a given view. */
export function nextAnchor(view: RosterView, anchor: string, dir: 1 | -1): string {
  return view === 'week' ? addDaysYmd(anchor, 7 * dir) : addMonthsYmd(anchor, dir);
}

/*
 * Every CONTIGUOUS Monday..Sunday 7-day block fully contained in `dates`
 * (assumed sorted ascending, one entry per calendar day — true of the
 * `dates` array GET /admin/roster returns). Used to decide "does this
 * member have a week with no WO" without counting a partial edge week as
 * evidence either way.
 */
export function fullWeeksIn(dates: string[]): string[][] {
  const weeks: string[][] = [];
  for (let i = 0; i + 6 < dates.length; i++) {
    if (weekdayIndexMonday0(dates[i]) !== 0) continue;
    if (dates[i + 6] !== addDaysYmd(dates[i], 6)) continue; // non-contiguous — skip
    weeks.push(dates.slice(i, i + 7));
  }
  return weeks;
}
