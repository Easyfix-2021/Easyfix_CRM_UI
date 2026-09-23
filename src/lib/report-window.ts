/*
 * Report date windows — the 'YYYY-MM-DD' arithmetic and display that the
 * QuickSight report tabs share.
 *
 * Pure and side-effect-free: no React, no fetching, no clock. "Today" is
 * always passed in (the tabs read it once from lib/due-date istToday), so a
 * whole tab shares ONE idea of the current IST day and no helper here can
 * disagree with it halfway down a render.
 *
 * Every function treats a date as a CALENDAR date, never an instant: the
 * arithmetic goes through Date.UTC / toISOString, so no browser timezone can
 * move a 'YYYY-MM-DD' to the previous day. Nothing here builds a local Date.
 *
 * WHERE IT CAME FROM: these were private helpers of
 * quicksight/employee-performance/api.ts (plus fmtDay / fmtDayRange from that
 * tab's format.ts). They moved here when the Date Range picker became shared
 * (components/quicksight/DateRangeFilter) — a component under components/ must
 * not import a tab's api.ts, and the second tab to want the picker (MTD) must
 * not get a second copy of the date rules. That tab's api.ts still exports the
 * same names, as thin wrappers that supply its own cap, so nothing in it
 * changed shape.
 *
 * THE CAP IS NOT HERE, DELIBERATELY. How wide a window a report allows is that
 * report's own rule, matched to its backend: Employee Performance allows 3
 * calendar months (live.service.js MAX_RANGE_MONTHS), MTD allows 366 days
 * (sources.service.js MAX_WINDOW_DAYS). So the cap-shaped helpers take the
 * limit as an argument and the tab owns the number, rather than this module
 * holding a constant that is right for one report and wrong for the next.
 */

export type DateWindow = { from: string; to: string };

/*
 * The three helpers below (pad2, shiftMonth, daysInMonth, shiftYmdMonths) are
 * deliberately NOT exported: they are the arithmetic the exported rules are
 * built from, and a caller reaching for one of them is a caller about to write
 * a second window rule by hand.
 */
const pad2 = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM' shifted by n calendar months. */
function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

/** Days in 'YYYY-MM'. UTC arithmetic: calendar dates, never instants. */
function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' shifted by n days. The Date Range presets count their days with this. */
export function shiftYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' shifted by n calendar months, the day capped at the target month's length. */
function shiftYmdMonths(ymd: string, n: number): string {
  const ym = shiftMonth(ymd.slice(0, 7), n);
  return `${ym}-${pad2(Math.min(Number(ymd.slice(8, 10)), daysInMonth(ym)))}`;
}

/** Days in the window, both ends inclusive — the shape of a DAY-capped limit (MTD's 366). */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

/**
 * The latest `to` a window starting at `from` may have under a MONTH-shaped
 * cap (Employee Performance's live.service.js lastAllowedTo, with its
 * MAX_RANGE_MONTHS passed in as `months`).
 */
export function lastAllowedTo(from: string, months: number): string {
  return shiftYmd(shiftYmdMonths(from, months), -1);
}

/**
 * The widest window a month-shaped cap of `months` allows ending on `to` —
 * what a picker's "All Dates" means for such a report.
 *
 * It is NOT simply `to` less `months` plus a day. lastAllowedTo caps the day at
 * the target month's length, so a short month swallows that day: a window
 * ending 28 Feb has to start 1 Dec, not 29 Nov, or the cap rejects it. Walking
 * forward from the naive candidate asks lastAllowedTo itself where the edge is,
 * so the cap stays one rule with one implementation. The walk is three days at
 * worst — lastAllowedTo never decreases as `from` advances, and `from` = `to`
 * is always inside the cap.
 */
export function widestWindow(to: string, months: number): DateWindow {
  let from = shiftYmd(shiftYmdMonths(to, -months), 1);
  while (from < to && lastAllowedTo(from, months) < to) from = shiftYmd(from, 1);
  return { from, to };
}

/** A concrete month's bounds ('YYYY-MM'), its last day capped at today — the Last Month preset. */
export function monthWindow(month: string, today: string): DateWindow {
  const end = `${month}-${pad2(daysInMonth(month))}`;
  return { from: `${month}-01`, to: end > today ? today : end };
}

/** The current month's 1st .. today — Month To Date, and every tab's default window. */
export function monthToDate(today: string): DateWindow {
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/** The last `count` months ending on today's, newest first ('YYYY-MM'). */
export function recentMonths(today: string, count: number): string[] {
  const current = today.slice(0, 7);
  return Array.from({ length: count }, (_, i) => shiftMonth(current, -i));
}

/* ── display ──────────────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * 'YYYY-MM-DD' → '01 Aug 2026'. '—' when empty.
 *
 * Deliberately not toLocaleDateString: 'Sep' rather than en-GB's 'Sept', and
 * no Date is built at all, so the browser's timezone cannot move the day.
 */
export function fmtDay(ymd: string | null | undefined): string {
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-');
  return `${d} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** 'YYYY-MM-DD' pair → '01 Aug 2026 – 13 Sep 2026' (one date when equal). 'none' when either is empty. */
export function fmtDayRange(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return 'none';
  return from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`;
}
