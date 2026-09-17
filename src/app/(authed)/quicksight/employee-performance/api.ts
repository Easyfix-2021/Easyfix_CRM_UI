/*
 * QuickSight — Employee Performance: endpoint + fetch-key builders.
 *
 * Pure string builders for useFetch keys; nothing here fetches. Every data key
 * carries `v` = meta.uploadedAt, so a new upload yields new keys and the
 * 30-second useFetch cache can never serve the previous snapshot. A builder
 * returns null when there is no snapshot (v empty) — pass the result straight
 * to useFetch, which treats null as "don't fetch". Gate on canView before
 * calling (the body's /meta key is already null without it).
 *
 *   GET  /meta                                       SnapshotMeta | null
 *   POST /upload                                     SnapshotMeta
 *   GET  /options?v                                  FilterOptions
 *   GET  /summary?v&<filters>                        SummaryResponse
 *   GET  /open-jobs?v&<filters>&page&pageSize&sortBy&sortDir    OpenJobsPage
 *   GET  /technicians?v&<filters>&page&pageSize&sortBy&sortDir  TechniciansPage
 *   GET  /member?v&<filters>&name                    MemberDetail (404 unknown name)
 *
 * <filters> are the names aggregate.js normaliseFilters reads, as query params:
 *   vertical  repeated, one per selected vertical   (omitted = Select All)
 *   employee  repeated, one per selected CRM name   (omitted = Select All)
 *   zm        omitted for '' / 'ALL'
 *   month     'YYYY-MM', omitted for '' / 'ALL'
 *   from, to  'YYYY-MM-DD', omitted when empty
 * Lists are de-duplicated and sorted, so the same selection in any click order
 * is the same key. A list holding 'ALL' is Select All and is omitted.
 *
 * NOTE: Express parses the query with qs, which turns 21+ repeated keys into
 * an index-keyed object instead of an array. The routes accept that object as
 * the list it is, so a large selection still works; an empty list stays the
 * shorter way to say Select All.
 */

import type { Filters, OpenJobSortKey, Paging, TechnicianSortKey } from './types';

export const API_BASE = '/admin/quicksight/employee-performance';
export const ACTION_KEY = 'isQuickSightEmployeePerformanceView';
export const UPLOAD_KEY = 'isQuickSightEmployeePerformanceUpload';

/** The dashboard's sentinel for "Select All" in single selects. */
export const ALL = 'ALL';

/** Server cap on pageSize (aggregate.js MAX_PAGE_SIZE). */
export const MAX_PAGE_SIZE = 200;

export const META_KEY = `${API_BASE}/meta`;
export const UPLOAD_URL = `${API_BASE}/upload`;
/* The Excel template for update_dashboard.bat (upload key; streamed .xlsx). */
export const TEMPLATE_URL = `${API_BASE}/template`;

export const EMPTY_FILTERS: Filters = {
  verticals: [],
  zm: ALL,
  employees: [],
  month: ALL,
  from: '',
  to: '',
};

type Version = string | null | undefined;

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

export function optionsKey(v: Version): string | null {
  if (!v) return null;
  return `${API_BASE}/options?${versioned(v).toString()}`;
}

export function summaryKey(v: Version, filters: Filters): string | null {
  if (!v) return null;
  const qs = versioned(v);
  appendFilters(qs, filters);
  return `${API_BASE}/summary?${qs.toString()}`;
}

export function openJobsKey(v: Version, filters: Filters, paging: Paging<OpenJobSortKey>): string | null {
  if (!v) return null;
  const qs = versioned(v);
  appendFilters(qs, filters);
  appendPaging(qs, paging);
  return `${API_BASE}/open-jobs?${qs.toString()}`;
}

export function techniciansKey(v: Version, filters: Filters, paging: Paging<TechnicianSortKey>): string | null {
  if (!v) return null;
  const qs = versioned(v);
  appendFilters(qs, filters);
  appendPaging(qs, paging);
  return `${API_BASE}/technicians?${qs.toString()}`;
}

/** null when there is no snapshot or no member is open. */
export function memberKey(v: Version, filters: Filters, name: string | null | undefined): string | null {
  if (!v || !name) return null;
  const qs = versioned(v);
  appendFilters(qs, filters);
  qs.set('name', name);
  return `${API_BASE}/member?${qs.toString()}`;
}
