/*
 * QuickSight — MTD: endpoint + fetch-key builders, and the date-window rules
 * the tab shares with the backend.
 *
 * Pure: nothing here fetches. Pass a key straight to useFetch, which treats
 * null as "don't fetch". Gate on canView before calling.
 *
 * WHAT THE REPORT IS: one row per PERSON with five job counts — Ticket
 * Created, In Progress, Open, Completed, Cancelled — where the person is the
 * CLIENT'S PRIMARY SPOC, the same attribution the Employee tab uses. It
 * answers "whose book of business is this", NOT "who did the work"; Employee
 * Productivity answers the second question and the two WILL disagree on the
 * same window, on purpose (EasyFix_Backend services/quicksight/mtd.service.js
 * carries the owner's decision in full).
 *
 * LIVE: every count is read from the database per request — jobs through the
 * Manage Jobs export, exactly as the Employee tab's job half reads them. There
 * is no upload and no snapshot here, so there is no cache-buster either: the
 * tab's keys are the filters and nothing else.
 *
 *   GET /mtd?startDate&endDate&verticalId&zonalManagerId&page&size&sortBy&sortDir
 *       → MtdTableResponse: one page of people PLUS the totals, the
 *         Unattributed row and `reconciled` over the WHOLE filtered set.
 *
 * The sibling GET /mtd/summary returns those same totals with no rows, for a
 * tab that paints tiles before its table. This one does NOT call it: the
 * table response already carries every figure the tiles show, so a second
 * request would be a second round-trip for numbers we hold. It exists, it is
 * documented, and this tab has no use for it.
 *
 * FILTERS map to the sentinels every other QuickSight report uses: verticalId
 * / zonalManagerId are integers with 0 = All, and the window is always sent
 * explicitly (resolveWindow) so a window change is a new key and refetches.
 */

import { dayCount, monthToDate, shiftYmd, type DateWindow } from '@/lib/report-window';

export const BASE = '/admin/quicksight/mtd';
export const ACTION_KEY = 'isQuickSightMtdView';

/**
 * sources.service.js MAX_WINDOW_DAYS: the widest window the backend will read,
 * both ends inclusive. A DAY cap, unlike Employee Performance's 3-calendar-
 * month one — the two reports read different loaders and each cap is matched
 * to its own backend rather than shared between them.
 */
export const MAX_WINDOW_DAYS = 366;

/** mtd.service.js MAX_PAGE_SIZE — the server's own ceiling on `size`. */
export const MAX_PAGE_SIZE = 500;

/* mtd.service.js SORT_KEYS / DEFAULT_SORT_BY / DEFAULT_SORT_DIR. */
export type MtdSortKey = 'name' | 'ticketCreated' | 'inProgress' | 'open' | 'completed' | 'cancelled';
export const DEFAULT_SORT_BY: MtdSortKey = 'ticketCreated';
export const DEFAULT_SORT_DIR = 'desc' as const;

/**
 * The tab's filter state. `from` / `to` are stored EMPTY while the window is
 * the default one (the current IST month, 1st .. today — which is what MTD
 * means), so "nothing chosen" and "Month To Date" are one canonical fetch key
 * rather than two that fetch the same rows.
 */
export type MtdFilters = {
  from: string;
  to: string;
  /** 0 = All, the sentinel the backend's Joi schema defaults to. */
  verticalId: number;
  zonalManagerId: number;
};

export const EMPTY_FILTERS: MtdFilters = { from: '', to: '', verticalId: 0, zonalManagerId: 0 };

/* ── the window (mirrors sources.service.js defaultWindow / checkWindow) ──── */

/** The current IST month, 1st .. today — the backend's default window, and the tab's. */
export function defaultWindow(today: string): DateWindow {
  return monthToDate(today);
}

/**
 * The widest window this report allows ending today — the Date Range picker's
 * All Dates. The cap is a plain day count, so this is simple subtraction: 366
 * days INCLUSIVE of both ends is today − 365.
 */
export function widestWindow(today: string): DateWindow {
  return { from: shiftYmd(today, -(MAX_WINDOW_DAYS - 1)), to: today };
}

/** Days in a window, both ends inclusive — what the cap is measured in. */
export function windowDays(w: DateWindow): number {
  return dayCount(w.from, w.to);
}

/** The filter state with '' from / to replaced by the default window — what every request sends. */
export function resolveWindow(filters: MtdFilters, today: string): MtdFilters {
  const def = defaultWindow(today);
  return { ...filters, from: filters.from || def.from, to: filters.to || def.to };
}

/** True when anything is narrowed away from the defaults — drives Reset Filters. */
export function narrowed(filters: MtdFilters): boolean {
  return filters.from !== '' || filters.to !== '' || filters.verticalId !== 0 || filters.zonalManagerId !== 0;
}

/* ── keys ─────────────────────────────────────────────────────────────────── */

export type MtdPaging = {
  /** 1-based, as the endpoint counts pages. */
  page: number;
  size: number;
  sortBy: MtdSortKey;
  sortDir: 'asc' | 'desc';
};

function appendFilters(qs: URLSearchParams, f: MtdFilters): void {
  // Always explicit: the window is what the report is about, and a key that
  // left it out would serve one month's rows under another month's heading.
  qs.set('startDate', f.from);
  qs.set('endDate', f.to);
  qs.set('verticalId', String(f.verticalId));
  qs.set('zonalManagerId', String(f.zonalManagerId));
}

/**
 * The per-person table. `filters` must be resolved (resolveWindow) so the key
 * carries the effective window.
 *
 * Sort is always sent, even when it is the server's own default: the column
 * header shows an arrow on whatever it is sorting by, and a key that dropped
 * the pair would leave that arrow claiming an order the request never asked
 * for.
 */
export function tableKey(filters: MtdFilters, paging: MtdPaging): string {
  const qs = new URLSearchParams();
  appendFilters(qs, filters);
  qs.set('page', String(paging.page));
  qs.set('size', String(paging.size));
  qs.set('sortBy', paging.sortBy);
  qs.set('sortDir', paging.sortDir);
  return `${BASE}?${qs.toString()}`;
}
