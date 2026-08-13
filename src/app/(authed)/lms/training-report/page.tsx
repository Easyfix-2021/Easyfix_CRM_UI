'use client';

/*
 * LMS → Training Report.
 *
 * One row per (technician, assigned course) from GET /admin/lms/report — how
 * far through a course's videos a technician has actually got. Read-only by
 * design: assignment happens on the Assign screen and course content on the
 * Courses screen, so there is nothing to create or edit here and no action
 * column at all.
 *
 * EVERY filter is server-side. The `status` (complete / incomplete) filter in
 * particular MUST NOT be re-applied in JS: the backend evaluates it inside the
 * same derived table that produces `total`, so filtering the returned page
 * again here would drop rows the SQL LIMIT had already selected — the page
 * would render short while the pagination footer still counted them.
 */

import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Search, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { TablePagination, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';
import { SortHeader, cycleSort, type SortDir } from '@/lib/use-sort';
import { useFetch, useDebouncedValue } from '@/lib/hooks';
import { showToast } from '@/components/ui/toast';
import { formatDate } from '@/lib/utils';

type ReportRow = {
  id: number;
  easyfixer_id: number;
  course_id: number;
  /* Legacy free-form column — may be null (never assessed) and may arrive as a
   * string. 0 is a REAL score, so every null-check below has to be `== null`
   * rather than falsy, or a genuine zero would render as an em-dash. */
  score: number | string | null;
  assigned_on: string | null;
  technician_name: string | null;
  /* Masked upstream by the admin router's maskMobile middleware (first 4 digits
   * + bullets). Rendered verbatim — there is no unmasked value on the wire to
   * reformat, and re-formatting a masked string would only corrupt it. */
  technician_mobile: string | null;
  course_name: string | null;
  videos_total: number | string;
  videos_done: number | string;
  completion_pct: number | string;
};

type ReportResponse = {
  rows: ReportRow[];
  total: number;
  limit: number;
  offset: number;
  /* The watched-percentage threshold at which ONE video counts as done
   * (currently 100). Surfaced in the UI because "2/5" is meaningless without
   * knowing what "done" meant — and the backend owns this constant, so hard-
   * coding "100%" in the copy here would silently lie the day it changes. */
  completionPercent: number;
};

type CourseRow = { id: number; name: string };
type CourseListResponse = { rows: CourseRow[]; total: number };

/* BE Joi cap on this endpoint's `limit` is 1000 (routes/admin/lms.js).
 * Pass it explicitly so the shared "All" page size maps to the endpoint's real
 * ceiling instead of the generic default. */
const REPORT_LIMIT_CAP = 1000;

/* Server-side sort keys, exactly the set REPORT_SORTABLE_COLUMNS accepts.
 * Anything outside it 400s at the Joi layer, so this union is the contract. */
type SortKey = 'technician' | 'course' | 'completion_pct' | 'score' | 'assigned_on';

/* Module scope so the array identity is stable across renders — SearchSelect
 * memoises its option processing on it. */
const STATUS_OPTIONS: SearchOption[] = [
  { value: '', label: 'All' },
  { value: 'complete', label: 'Complete' },
  { value: 'incomplete', label: 'Incomplete' },
];

/*
 * mysql2 returns DECIMAL columns as STRINGS unless the pool opts into
 * `decimalNumbers` (ours does not — server/db.js only type-casts TINYINT/BIT).
 * `completion_pct` is a ROUND(…, 1) DECIMAL, so it lands here as "66.7", and
 * the COUNT(*) columns can widen to BIGINT strings too. Coerce once at the
 * edge: `"66.7" >= 100` is a lexicographic comparison in disguise, which would
 * quietly mis-classify rows as complete.
 */
function toNum(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/*
 * Progress presentation for one row.
 *
 * The case that matters is `videos_total === 0`. The backend deliberately
 * reports 0% for a course with no content rather than dividing by zero, and
 * classifies it as *incomplete* — honest, but a red-looking 0% would blame the
 * technician for an empty course an operator is still building. So a
 * contentless course gets its own muted "No Content" state with no bar and no
 * percentage: there is nothing to watch, so there is no progress to show.
 */
type ProgressView = {
  kind: 'empty' | 'none' | 'partial' | 'done';
  tone: StatusChipTone;
  barClass: string;
  label: string;
};

function progressView(done: number, total: number, pct: number): ProgressView {
  if (total === 0) {
    return { kind: 'empty', tone: 'slate', barClass: 'bg-slate-300', label: 'Course Has No Videos Yet' };
  }
  // Mirror the server's own completeness test (videos_done >= videos_total)
  // rather than testing pct >= 100 — the rounded percentage is a display value
  // and could disagree with the count at the boundary.
  if (done >= total) {
    return { kind: 'done', tone: 'emerald', barClass: 'bg-emerald-500', label: 'Complete' };
  }
  if (done <= 0) {
    return { kind: 'none', tone: 'slate', barClass: 'bg-slate-300', label: 'Not Started' };
  }
  return { kind: 'partial', tone: 'amber', barClass: 'bg-amber-500', label: `In Progress — ${pct}%` };
}

export default function TrainingReportPage() {
  const [search, setSearch] = useState('');
  const [courseId, setCourseId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);
  /* `null` is the third state of the shared sort cycle (asc → desc → unsorted);
   * when null we simply omit sortBy/sortDir and let the backend default. */
  const [sortBy, setSortBy] = useState<SortKey | null>('technician');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const debouncedSearch = useDebouncedValue(search, 300);
  const q = debouncedSearch.trim();

  /* Any filter change invalidates the current page number — page 5 of an
   * unfiltered report is usually past the end of a filtered one. */
  useEffect(() => { setPage(0); }, [q, courseId, status]);

  function onSort(col: SortKey) {
    const next = cycleSort<SortKey>(col, { sortBy, sortDir });
    setSortBy(next.sortBy);
    setSortDir(next.sortDir);
    setPage(0);
  }

  /* Filters shared by the table query AND the two summary counts below, so the
   * cards always describe the same population the table is drawn from. */
  const sharedFilters = new URLSearchParams();
  if (q) sharedFilters.set('q', q);
  if (courseId) sharedFilters.set('courseId', courseId);
  const sharedQs = sharedFilters.toString();
  const countPrefix = sharedQs ? `${sharedQs}&` : '';

  const limit = pageSizeToLimit(pageSize, REPORT_LIMIT_CAP);
  const offset = page * (pageSize === 'all' ? limit : Number(pageSize));

  const listParams = new URLSearchParams(sharedQs);
  if (status) listParams.set('status', status);
  listParams.set('limit', String(limit));
  listParams.set('offset', String(offset));
  if (sortBy) {
    listParams.set('sortBy', sortBy);
    listParams.set('sortDir', sortDir);
  }
  /* Every input that changes the result set is inside the key, so useFetch
   * re-fires on its own — no orchestration effect, which is the whole point of
   * the shared-hooks rule. */
  const { data, loading, error: listError } = useFetch<ReportResponse>(
    `/admin/lms/report?${listParams.toString()}`,
  );
  const rows: ReportRow[] = data?.rows ?? [];
  const total = data?.total ?? 0;
  const completionPercent = data?.completionPercent ?? null;

  /*
   * Summary counts.
   *
   * These CANNOT come from the current page — `rows` is one LIMITed slice, so
   * counting it would produce numbers that change as the operator pages
   * through. They also cannot come from the table's own `total`, because that
   * total is itself narrowed by the status filter (pick "Complete" and it stops
   * being a grand total). So each count is its own `limit=1` request whose only
   * useful field is `total`, carrying the same q/courseId scope but pinning
   * `status` — the server does the counting in SQL.
   *
   * complete and incomplete are exhaustive and mutually exclusive server-side
   * (`incomplete` is literally NOT(complete), and contentless courses fall in
   * incomplete), so their sum IS the grand total — no third request needed.
   */
  const { data: completeCount } = useFetch<ReportResponse>(
    `/admin/lms/report?${countPrefix}status=complete&limit=1&offset=0`,
  );
  const { data: incompleteCount } = useFetch<ReportResponse>(
    `/admin/lms/report?${countPrefix}status=incomplete&limit=1&offset=0`,
  );
  const completeTotal = completeCount?.total ?? null;
  const incompleteTotal = incompleteCount?.total ?? null;
  const grandTotal =
    completeTotal != null && incompleteTotal != null ? completeTotal + incompleteTotal : null;

  /* Course filter options. includeInactive=true on purpose: a retired course
   * still has historical assignments in this report, and hiding it from the
   * filter would make those rows unreachable. */
  const { data: coursesData, error: coursesError } = useFetch<CourseListResponse>(
    '/admin/lms/courses?includeInactive=true&limit=1000',
  );

  /* A silently-empty Course dropdown reads as "there are no courses" rather
   * than "the lookup failed", so the failure gets surfaced explicitly. Toast,
   * never a native dialog. */
  useEffect(() => {
    if (coursesError) {
      showToast({ variant: 'error', message: `Course Filter Unavailable — ${coursesError}` });
    }
  }, [coursesError]);

  const courseOptions: SearchOption[] = useMemo(
    () => [
      { value: '', label: 'All Courses' },
      ...(coursesData?.rows ?? []).map((c) => ({ value: String(c.id), label: c.name })),
    ],
    [coursesData],
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="size-6" /> Training Report
        </h1>
        <p className="text-sm text-muted-foreground">
          Course completion per technician — how far through each assigned course they have got.
        </p>
      </div>

      {/* Filters — all three are server-side query params. */}
      <Card>
        <CardContent className="p-3 flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[240px]">
            <Label className="block mb-1">Search</Label>
            <div className="relative">
              <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by technician name, mobile, or course…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>
          <div className="w-64">
            <Label className="block mb-1">Course</Label>
            {/* `required` suppresses the inline clear "×" — "All Courses" is
                already the reachable no-filter option, and two ways to clear
                one control is one too many. */}
            <SearchSelect
              value={courseId}
              onChange={setCourseId}
              options={courseOptions}
              required
              placeholder="All Courses"
            />
          </div>
          <div className="w-44">
            <Label className="block mb-1">Status</Label>
            <SearchSelect
              value={status}
              onChange={setStatus}
              options={STATUS_OPTIONS}
              required
              placeholder="All"
            />
          </div>
        </CardContent>
      </Card>

      {/* Summary — scoped by Search + Course, deliberately NOT by Status (see
          the counts above). Values stay em-dashed until both counts land, so
          the cards never show a half-computed total. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Total Assignments" value={grandTotal} />
        <StatCard label="Complete" value={completeTotal} valueClass="text-emerald-700" />
        <StatCard label="Incomplete" value={incompleteTotal} valueClass="text-amber-700" />
      </div>

      {listError && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle className="size-4" /> {listError}
          </CardContent>
        </Card>
      )}

      {/* The threshold comes from the response, not a literal — see
          `completionPercent` on ReportResponse. */}
      {completionPercent != null && (
        <p className="text-xs text-muted-foreground">
          A Video Counts As Done At {completionPercent}% Watched.
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          {/* Fixed layout + colgroup so a long course name on one page doesn't
              reflow the columns relative to another page. */}
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {/*
                Comments sit on their own lines, never trailing a <col /> after
                a space. JSX strips whitespace that contains a newline but KEEPS
                a same-line space between two expressions, so `<col /> {/* x *\/}`
                emits a " " text node — and a text node is illegal inside
                <colgroup>, which React reports as a hydration error.
              */}
              {/* Technician */}
              <col style={{ width: '22%' }} />
              {/* Mobile */}
              <col style={{ width: '13%' }} />
              {/* Course */}
              <col style={{ width: '22%' }} />
              {/* Progress */}
              <col style={{ width: '22%' }} />
              {/* Score */}
              <col style={{ width: '8%' }} />
              {/* Assigned On */}
              <col style={{ width: '13%' }} />
            </colgroup>
            <thead>
              <tr>
                <SortHeader col="technician"     align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Technician</SortHeader>
                <th className="!text-left whitespace-nowrap">Mobile</th>
                <SortHeader col="course"         align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Course</SortHeader>
                <SortHeader col="completion_pct" align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Progress</SortHeader>
                <SortHeader col="score"          align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Score</SortHeader>
                <SortHeader col="assigned_on"    align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Assigned On</SortHeader>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">No assignments match the current filters.</td></tr>
              )}
              {!loading && rows.map((r) => {
                const done = toNum(r.videos_done);
                const totalVideos = toNum(r.videos_total);
                const pct = toNum(r.completion_pct);
                const view = progressView(done, totalVideos, pct);
                return (
                  <tr key={r.id}>
                    <td className="!text-left font-medium truncate" title={r.technician_name ?? ''}>
                      {r.technician_name || <span className="text-muted-foreground">—</span>}
                    </td>
                    {/* Masked upstream — printed exactly as received. */}
                    <td className="!text-left font-mono text-xs truncate">
                      {r.technician_mobile || <span className="text-muted-foreground font-sans">—</span>}
                    </td>
                    <td className="!text-left truncate" title={r.course_name ?? ''}>
                      {r.course_name || <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="!text-left">
                      {view.kind === 'empty' ? (
                        /* No bar, no percentage: an empty course has no
                           progress to report, and showing "0%" here would
                           read as a technician who has watched nothing. */
                        <StatusChip
                          tone={view.tone}
                          size="sm"
                          title="This course has no videos yet, so there is nothing for the technician to watch."
                        >
                          No Content
                        </StatusChip>
                      ) : (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-2 whitespace-nowrap">
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {done.toLocaleString('en-IN')} / {totalVideos.toLocaleString('en-IN')} Videos
                            </span>
                            <StatusChip tone={view.tone} size="sm" title={view.label}>
                              {pct}%
                            </StatusChip>
                          </div>
                          {/* Deliberately a plain div, not a chart library —
                              one bar per row, no axes, no interaction. */}
                          <div
                            className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
                            role="progressbar"
                            aria-valuenow={pct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`${r.course_name ?? 'Course'} progress`}
                          >
                            <div
                              className={`h-full rounded-full ${view.barClass}`}
                              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </td>
                    {/* `== null` not falsy — a scored-zero is a real result. */}
                    <td className="!text-center whitespace-nowrap tabular-nums">
                      {r.score == null || r.score === ''
                        ? <span className="text-muted-foreground">—</span>
                        : String(r.score)}
                    </td>
                    {/* formatDate already renders a null date as an em-dash. */}
                    <td className="!text-left whitespace-nowrap text-xs">{formatDate(r.assigned_on)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <TablePagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
      />
    </div>
  );
}

/*
 * Summary tile. `null` renders an em-dash rather than 0 — "0 assignments" and
 * "the count has not arrived yet" are different facts and must not look alike.
 */
function StatCard({ label, value, valueClass }: {
  label: string;
  value: number | null;
  valueClass?: string;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className={`text-2xl font-semibold tabular-nums ${valueClass ?? ''}`}>
          {value == null ? '—' : value.toLocaleString('en-IN')}
        </div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}
