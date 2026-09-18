/*
 * QuickSight — Employee Performance: endpoint + fetch-key builders, and the
 * date-window rules the tab shares with the backend.
 *
 * Pure: nothing here fetches. Pass a key straight to useFetch, which treats
 * null as "don't fetch". Gate on canView before calling.
 *
 * LIVE (owner decision, final). Open jobs, closed jobs and the CRM counts come
 * from the database on every read; targets, emp detail, TimeChamp and IVR come
 * from the Excel uploads the backend stores. Every number is computed by
 * EasyFix_Backend services/quicksight/employee-performance (live.service.js
 * builds the dashboard object, aggregate.js reads it):
 *
 *   GET  /live/options?v&from&to                     LiveOptionsResponse
 *   GET  /live/summary?v&<filters>                   LiveSummaryResponse
 *   GET  /live/open-jobs?v&<filters>&page&pageSize&sortBy&sortDir    OpenJobsPage
 *   GET  /live/technicians?v&<filters>&page&pageSize&sortBy&sortDir  TechniciansPage
 *   GET  /live/member?v&<filters>&name               MemberDetail (404 unknown name)
 *   GET  /live/template                              the 5-sheet .xlsx (upload key)
 *   POST /live/upload?dryRun=true|false              UploadPreview | UploadCommitResult
 *
 * <filters> are the names aggregate.js normaliseFilters reads, as query params:
 *   vertical  repeated, one per selected vertical   (omitted = Select All)
 *   employee  repeated, one per selected CRM name   (omitted = Select All)
 *   zm        omitted for '' / 'ALL'
 *   month     'YYYY-MM', omitted for '' / 'ALL'
 *   from, to  'YYYY-MM-DD' — the tab ALWAYS sends the effective window
 *             (resolveWindow), so a window change is a new key and refetches.
 * Lists are de-duplicated and sorted, so the same selection in any click order
 * is the same key. A list holding 'ALL' is Select All and is omitted.
 *
 * `v` is the tab's cache-buster (the server ignores it): it changes after an
 * upload is saved, so the 30-second useFetch cache can never serve the
 * pre-upload report.
 *
 * NOTE: Express parses the query with qs, which turns 21+ repeated keys into
 * an index-keyed object instead of an array. The routes accept that object as
 * the list it is, so a large selection still works; an empty list stays the
 * shorter way to say Select All.
 */

import type { Filters, OpenJobSortKey, Paging, TechnicianSortKey } from './types';

const API_BASE = '/admin/quicksight/employee-performance';
/** Every live read, the template and the upload live under here (the invalidateFetch prefix). */
export const LIVE_BASE = `${API_BASE}/live`;
export const ACTION_KEY = 'isQuickSightEmployeePerformanceView';
export const UPLOAD_KEY = 'isQuickSightEmployeePerformanceUpload';

/** The dashboard's sentinel for "Select All" in single selects. */
export const ALL = 'ALL';

/** Server cap on pageSize (aggregate.js MAX_PAGE_SIZE). */
export const MAX_PAGE_SIZE = 200;

/* The Excel template MIS fills (upload key; streamed .xlsx). */
export const TEMPLATE_URL = `${LIVE_BASE}/template`;
export const TEMPLATE_FILENAME = 'employee-performance-upload-template.xlsx';

export const EMPTY_FILTERS: Filters = {
  verticals: [],
  zm: ALL,
  employees: [],
  month: ALL,
  from: '',
  to: '',
};

type Version = string | null | undefined;

/* ── the window (mirrors live.service.js resolveLiveWindow) ───────────────── */

/** live.service.js MAX_RANGE_MONTHS: `to` must be before `from` + 3 calendar months. */
export const MAX_RANGE_MONTHS = 3;

export type DateWindow = { from: string; to: string };

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

/** 'YYYY-MM-DD' shifted by n days. */
function shiftYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The latest `to` a window starting at `from` may have (live.service.js lastAllowedTo). */
export function lastAllowedTo(from: string): string {
  const ym = shiftMonth(from.slice(0, 7), MAX_RANGE_MONTHS);
  const day = Math.min(Number(from.slice(8, 10)), daysInMonth(ym));
  return shiftYmd(`${ym}-${pad2(day)}`, -1);
}

/**
 * The default bounds of a filter state: the chosen month (its last day capped
 * at today), else the current IST month's 1st .. today.
 */
export function windowBounds(month: string, today: string): DateWindow {
  if (month && month !== ALL) {
    const end = `${month}-${pad2(daysInMonth(month))}`;
    return { from: `${month}-01`, to: end > today ? today : end };
  }
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/** The filter state with '' from / to replaced by the default bounds — what every request sends. */
export function resolveWindow(filters: Filters, today: string): Filters {
  const bounds = windowBounds(filters.month, today);
  return { ...filters, from: filters.from || bounds.from, to: filters.to || bounds.to };
}

/** The last `count` IST months, newest first ('YYYY-MM'). */
export function recentMonths(today: string, count: number): string[] {
  const current = today.slice(0, 7);
  return Array.from({ length: count }, (_, i) => shiftMonth(current, -i));
}

/* ── keys ─────────────────────────────────────────────────────────────────── */

function sortedList(values: readonly string[]): string[] {
  const clean = values.filter((x) => typeof x === 'string' && x !== '');
  if (clean.includes(ALL)) return [];
  return Array.from(new Set(clean)).sort();
}

function appendFilters(qs: URLSearchParams, f: Filters): void {
  sortedList(f.verticals).forEach((x) => qs.append('vertical', x));
  if (f.zm && f.zm !== ALL) qs.set('zm', f.zm);
  sortedList(f.employees).forEach((x) => qs.append('employee', x));
  if (f.month && f.month !== ALL) qs.set('month', f.month);
  if (f.from) qs.set('from', f.from);
  if (f.to) qs.set('to', f.to);
}

function appendPaging<K extends string>(qs: URLSearchParams, p: Paging<K>): void {
  qs.set('page', String(p.page));
  qs.set('pageSize', String(p.pageSize));
  if (p.sortBy) {
    qs.set('sortBy', p.sortBy);
    qs.set('sortDir', p.sortDir === 'asc' ? 'asc' : 'desc');
  }
}

/** Filters → query string (no leading '?'); '' when nothing is narrowed. */
export function filtersQuery(filters: Filters): string {
  const qs = new URLSearchParams();
  appendFilters(qs, filters);
  return qs.toString();
}

function versioned(v: string): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set('v', v);
  return qs;
}

/** The filter lists depend on the window only (one live build per window). */
export function optionsKey(v: Version, window: DateWindow): string | null {
  if (!v) return null;
  const qs = versioned(v);
  qs.set('from', window.from);
  qs.set('to', window.to);
  return `${LIVE_BASE}/options?${qs.toString()}`;
}

/** `filters` must be resolved (resolveWindow) so the key carries the window. */
export function summaryKey(v: Version, filters: Filters): string | null {
  if (!v) return null;
  const qs = versioned(v);
  appendFilters(qs, filters);
  return `${LIVE_BASE}/summary?${qs.toString()}`;
}

export function openJobsKey(v: Version, filters: Filters, paging: Paging<OpenJobSortKey>): string | null {
  if (!v) return null;
  const qs = versioned(v);
  appendFilters(qs, filters);
  appendPaging(qs, paging);
  return `${LIVE_BASE}/open-jobs?${qs.toString()}`;
}

export function techniciansKey(v: Version, filters: Filters, paging: Paging<TechnicianSortKey>): string | null {
  if (!v) return null;
  const qs = versioned(v);
  appendFilters(qs, filters);
  appendPaging(qs, paging);
  return `${LIVE_BASE}/technicians?${qs.toString()}`;
}

/** null when no member is open. */
export function memberKey(v: Version, filters: Filters, name: string | null | undefined): string | null {
  if (!v || !name) return null;
  const qs = versioned(v);
  appendFilters(qs, filters);
  qs.set('name', name);
  return `${LIVE_BASE}/member?${qs.toString()}`;
}

/*
 * POST target for the Excel upload (multipart field `file`, .xlsx, max 15 MB).
 * dryRun=true previews and saves nothing; only an explicit false saves — the
 * server defaults a missing flag to a preview too.
 */
export function uploadUrl(dryRun: boolean): string {
  return `${LIVE_BASE}/upload?dryRun=${dryRun ? 'true' : 'false'}`;
}
