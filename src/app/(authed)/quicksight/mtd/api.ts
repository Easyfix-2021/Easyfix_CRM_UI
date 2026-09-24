/*
 * QuickSight — MTD: endpoint + fetch-key builders, and the date-window rules
 * the tab shares with the backend.
 *
 * Pure: nothing here fetches. Pass a key straight to useFetch, which treats
 * null as "don't fetch". Gate on canView before calling.
 *
 * WHAT THE TAB IS: the owner's MIS "MTD Client Report", rebuilt natively over
 * live data. Six KPI tiles and eleven sections — the day-wise bars and the
 * open-jobs line, the donut, both days-open splits, the cancel reasons and
 * comment themes, the city table, the status-by-aging matrix and the job list
 * behind any cell of it — plus, as the last section, the per-SPOC
 * book-of-business table this tab was first built for.
 *
 * LIVE: every number is read from the database per request, through the Manage
 * Jobs export, exactly as the Employee tab's job half reads it. The MIS engine
 * reads an uploaded Excel; we do not. There is no upload and no snapshot here,
 * so there is no cache-buster either: the tab's keys are the filters and
 * nothing else.
 *
 *   GET /mtd/report  → MtdReportResponse: the tiles and sections 1-10, with
 *                      the options each picker should offer.
 *   GET /mtd/jobs    → MtdJobsResponse: section 11, one page of one matrix
 *                      cell. Shares the report's cache entry on the server, so
 *                      clicking a cell costs no second read of the export.
 *   GET /mtd         → MtdTableResponse: one page of people PLUS the totals,
 *                      the Unattributed row and `reconciled` over the WHOLE
 *                      filtered set.
 *   GET /mtd/summary → those same totals with no rows, for a tab that paints
 *                      tiles before its table. This one does NOT call it: the
 *                      table response already carries every figure the per-SPOC
 *                      section shows, so a second request would be a second
 *                      round-trip for numbers we hold. It exists, it is
 *                      documented, and this tab has no use for it.
 *
 * TWO FILTER FAMILIES, AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   Vertical Id and Zonal Manager Id are EXPORT PREDICATES: they narrow the
 *   SQL, so they change which rows are read at all. Both are integers with
 *   0 = All, the sentinel every other QuickSight report uses.
 *
 *   Client, Vertical (by NAME) and Primary SPOC are the MIS filter bar's three
 *   MULTI-selects, applied in memory over the rows already read. Absent or
 *   empty means All — an empty pick is never "no jobs", because the pickers
 *   clear themselves by sending nothing.
 *
 *   The per-SPOC table takes only the first family. The three multi-selects
 *   are not in its contract and are deliberately left off its key, so ticking
 *   a client narrows the report above without silently claiming to have
 *   narrowed a table that the server never filtered.
 *
 * SPELLING THE MULTI-SELECTS ON THE WIRE. Numeric ids are comma-joined
 * (?clientId=4,9) because it is shorter and the backend accepts both forms.
 * Vertical names REPEAT THE KEY instead (?vertical=A&vertical=B) and are never
 * comma-joined: a vertical name may contain a comma, and the backend refuses
 * to split that one for exactly this reason.
 */

import { dayCount, monthToDate, shiftYmd, type DateWindow } from '@/lib/report-window';

export const BASE = '/admin/quicksight/mtd';
export const REPORT_BASE = `${BASE}/report`;
export const JOBS_BASE = `${BASE}/jobs`;
export const ACTION_KEY = 'isQuickSightMtdView';

/**
 * sources.service.js MAX_WINDOW_DAYS: the widest window the backend will read,
 * both ends inclusive. A DAY cap, unlike Employee Performance's 3-calendar-
 * month one — the two reports read different loaders and each cap is matched
 * to its own backend rather than shared between them.
 */
export const MAX_WINDOW_DAYS = 366;

/** mtd.service.js MAX_PAGE_SIZE — the server's own ceiling on the per-SPOC table's `size`. */
export const MAX_PAGE_SIZE = 500;

/** mtd-report.service.js MAX_PAGE_SIZE — the job list's own ceiling. */
export const MAX_JOB_PAGE_SIZE = 500;

/*
 * mtd-report.service.js MAX_DAY_BUCKETS: past this many days the day-wise
 * chart rolls up to Monday-start weeks, because ninety bars on one axis is not
 * a chart. The frontend does not decide this — `daily.granularity` on the
 * response says which view was built — but the chart's own subtitle explains
 * the switch, and this is the number it quotes.
 */
export const MAX_DAY_BUCKETS = 62;

/* mtd.service.js SORT_KEYS / DEFAULT_SORT_BY / DEFAULT_SORT_DIR (the per-SPOC table). */
export type MtdSortKey = 'name' | 'ticketCreated' | 'inProgress' | 'open' | 'completed' | 'cancelled';
export const DEFAULT_SORT_BY: MtdSortKey = 'ticketCreated';
export const DEFAULT_SORT_DIR = 'desc' as const;

/* mtd-report.service.js JOB_SORT_KEYS and the /jobs route's own defaults. */
export type MtdJobSortKey = 'jobId' | 'jobStatus' | 'daysOpen';
export const DEFAULT_JOB_SORT_BY: MtdJobSortKey = 'daysOpen';
export const DEFAULT_JOB_SORT_DIR = 'desc' as const;

/**
 * The tab's filter state.
 *
 * `from` / `to` are stored EMPTY while the window is the default one (the
 * current IST month, 1st .. today — which is what MTD means), so "nothing
 * chosen" and "Month To Date" are one canonical fetch key rather than two that
 * fetch the same rows.
 *
 * The three multi-selects are stored as empty arrays for All, matching both
 * the pickers and the backend: an empty selection sends nothing.
 */
export type MtdFilters = {
  from: string;
  to: string;
  /** 0 = All, the sentinel the backend's Joi schema defaults to. */
  verticalId: number;
  zonalManagerId: number;
  /** Empty = All. 0 selects the jobs with no client at all. */
  clientIds: number[];
  /** Empty = All. Verticals are selected BY NAME; '(Blank)' selects the jobs with none. */
  verticals: string[];
  /** Empty = All. 0 is the Unattributed bucket. */
  spocUserIds: number[];
};

export const EMPTY_FILTERS: MtdFilters = {
  from: '', to: '', verticalId: 0, zonalManagerId: 0, clientIds: [], verticals: [], spocUserIds: [],
};

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
  return filters.from !== ''
    || filters.to !== ''
    || filters.verticalId !== 0
    || filters.zonalManagerId !== 0
    || filters.clientIds.length > 0
    || filters.verticals.length > 0
    || filters.spocUserIds.length > 0;
}

/**
 * How many of the three multi-selects are narrowing the report — the count the
 * filter bar shows beside "Reset Filters", and the reason the per-SPOC table
 * at the foot of the tab carries a note saying it does not honour them.
 */
export function pickersInUse(filters: MtdFilters): number {
  return (filters.clientIds.length > 0 ? 1 : 0)
    + (filters.verticals.length > 0 ? 1 : 0)
    + (filters.spocUserIds.length > 0 ? 1 : 0);
}

/* ── keys ─────────────────────────────────────────────────────────────────── */

export type MtdPaging = {
  /** 1-based, as the endpoint counts pages. */
  page: number;
  size: number;
  sortBy: MtdSortKey;
  sortDir: 'asc' | 'desc';
};

/**
 * The two export predicates plus the window. Always explicit: the window is
 * what the report is about, and a key that left it out would serve one month's
 * rows under another month's heading.
 */
function appendWindow(qs: URLSearchParams, f: MtdFilters): void {
  qs.set('startDate', f.from);
  qs.set('endDate', f.to);
  qs.set('verticalId', String(f.verticalId));
  qs.set('zonalManagerId', String(f.zonalManagerId));
}

/**
 * The three in-memory pickers.
 *
 * A selection is SORTED before it is spelled, so ticking A then B and ticking
 * B then A are one fetch key and one cache entry rather than two requests for
 * the same rows. Nothing is sent at all for an empty pick — the backend reads
 * a missing key as All, and an explicitly empty one would be a second spelling
 * of the same thing.
 */
function appendPickers(qs: URLSearchParams, f: MtdFilters): void {
  if (f.clientIds.length > 0) qs.set('clientId', [...f.clientIds].sort((a, b) => a - b).join(','));
  // Never comma-joined: a vertical name may contain a comma, so the key repeats.
  for (const name of [...f.verticals].sort()) qs.append('vertical', name);
  if (f.spocUserIds.length > 0) qs.set('spocUserId', [...f.spocUserIds].sort((a, b) => a - b).join(','));
}

/**
 * The report: the tiles and sections 1-10, plus the picker options.
 *
 * `filters` must be resolved (resolveWindow) so the key carries the effective
 * window. One request paints the whole tab bar the job list.
 */
export function reportKey(filters: MtdFilters): string {
  const qs = new URLSearchParams();
  appendWindow(qs, filters);
  appendPickers(qs, filters);
  return `${REPORT_BASE}?${qs.toString()}`;
}

/** Which cell of the status-by-aging matrix section 11 is listing, and how. */
export type MtdJobsQuery = {
  /** 'all' = every status; otherwise one row of the matrix. */
  status: 'all' | 'completed' | 'cancelled' | 'open';
  /** 'all' = every band; otherwise one statusAging bucket key. */
  bucket: string;
  /** The search box: a Job ID or a job-status substring. Sent only when non-empty. */
  q: string;
  /** 1-based, as the endpoint counts pages. */
  page: number;
  size: number;
  sortBy: MtdJobSortKey;
  sortDir: 'asc' | 'desc';
};

/**
 * One page of one matrix cell. Same filters as the report, so the server
 * answers it from the report's own cache entry rather than reading the export
 * a second time.
 *
 * Status, bucket and sort are always sent, even at their defaults: the table's
 * headers and its scope chips show what they are sorting and scoping by, and a
 * key that dropped a pair would leave them claiming something the request
 * never asked for.
 */
export function jobsKey(filters: MtdFilters, query: MtdJobsQuery): string {
  const qs = new URLSearchParams();
  appendWindow(qs, filters);
  appendPickers(qs, filters);
  qs.set('status', query.status);
  qs.set('bucket', query.bucket);
  const needle = query.q.trim();
  if (needle !== '') qs.set('q', needle);
  qs.set('page', String(query.page));
  qs.set('size', String(query.size));
  qs.set('sortBy', query.sortBy);
  qs.set('sortDir', query.sortDir);
  return `${JOBS_BASE}?${qs.toString()}`;
}

/**
 * The per-SPOC book-of-business table, unchanged.
 *
 * It takes the window and the two export predicates ONLY — the three
 * multi-selects are not in its contract, and appendPickers is deliberately not
 * called here. Sort is always sent, even when it is the server's own default:
 * the column header shows an arrow on whatever it is sorting by, and a key
 * that dropped the pair would leave that arrow claiming an order the request
 * never asked for.
 */
export function tableKey(filters: MtdFilters, paging: MtdPaging): string {
  const qs = new URLSearchParams();
  appendWindow(qs, filters);
  qs.set('page', String(paging.page));
  qs.set('size', String(paging.size));
  qs.set('sortBy', paging.sortBy);
  qs.set('sortDir', paging.sortDir);
  return `${BASE}?${qs.toString()}`;
}
