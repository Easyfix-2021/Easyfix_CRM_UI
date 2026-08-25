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
 *
 * DEADLINES AND THE OVERDUE FILTER.
 *
 * Rows carry a `due_date`, and an assignment past it restricts the technician's
 * app (Training, Claim Amount and skipping jobs only). `status=overdue` is a
 * real server-side filter, evaluated in the SAME derived table as
 * complete/incomplete, so it obeys the rule above like the others — the page
 * and `total` describe one set. It was added to the backend precisely so this
 * page would not have to fake it in JS.
 *
 * THE INVARIANT: the red highlight below and the server's `status=overdue`
 * MUST agree, or the filter would hide rows the table paints red (and vice
 * versa). The server's predicate is
 *
 *     t.completion_date IS NULL AND t.due_date IS NOT NULL AND t.due_date < <IST today>
 *
 * and `dueView()` mirrors it clause for clause — including judging the STAMPED
 * completion_date rather than the video maths, which can legitimately disagree
 * for a moment (last video watched, completion not yet stamped). Change one
 * side and you must change the other.
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
  /* Deadline the course was assigned with, denormalised onto the row.
   *
   * The DURATION the operator picked ("3 months") is deliberately not stored
   * or sent: once a deadline is extended it would be true of neither the
   * original assignment nor the current date. The date is the only fact. */
  /* DATE, 'YYYY-MM-DD'. Null when the course carries no deadline. */
  due_date: string | null;
  /* DATETIME, 'YYYY-MM-DD HH:mm:ss'. Null until the course is finished — and
   * null is the ONLY completion test used below, because it is the fact the
   * deadline is judged against (videos_done >= videos_total is the progress
   * bar's separate concern). */
  completion_date: string | null;
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
type SortKey =
  | 'technician'
  | 'course'
  | 'completion_pct'
  | 'score'
  | 'assigned_on'
  | 'due_date'
  | 'completion_date';

/* Module scope so the array identity is stable across renders — SearchSelect
 * memoises its option processing on it. */
const STATUS_OPTIONS: SearchOption[] = [
  { value: '', label: 'All' },
  { value: 'complete', label: 'Complete' },
  { value: 'incomplete', label: 'Incomplete' },
  /* Not a fourth slice of a partition — 'overdue' is a SUBSET of 'incomplete'
   * (unfinished, past a deadline it actually had). Picking it narrows the same
   * population the other two split. */
  { value: 'overdue', label: 'Overdue' },
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

/* ── Deadline dates ──────────────────────────────────────────────────────
 *
 * `due_date` and `completion_date` arrive as MySQL date/datetime STRINGS (the
 * pool runs `dateStrings: true`) and are already IST wall-clock. They are
 * therefore read CHARACTER-WISE and never fed to `new Date(...)`:
 *
 *   new Date('2026-08-13')            → parsed as UTC midnight
 *   new Date('2026-08-13 09:00:00')   → parsed as the BROWSER's local midnight
 *
 * …so a Date round-trip re-derives a timezone the value never had, and shifts
 * the calendar day by one for anyone whose browser is not on IST. The shared
 * `formatDate` does exactly that round-trip (and appends a time), which is why
 * these two columns get their own formatter while `assigned_on` keeps using it.
 */
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* The leading 'YYYY-MM-DD' of a date or datetime string, or null if it is not
 * a real calendar day. Guards MySQL's zero-date ('0000-00-00'), which must
 * never surface as "0" or "null" — it means "no date", so it reads as one. */
function toYmd(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/* 'YYYY-MM-DD' → '13 Aug 2026', built from the string's own parts. */
function formatYmd(v: string | null | undefined): string | null {
  const ymd = toYmd(v);
  if (!ymd) return null;
  return `${ymd.slice(8, 10)} ${MONTH_ABBR[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
}

/* Today in IST as 'YYYY-MM-DD'. Fixed-width, so `a < b` on two of these is a
 * calendar comparison — no Date objects, no offset arithmetic. */
function istTodayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/* Whole days from one 'YYYY-MM-DD' to another. Both sides are pinned to the
 * SAME fictional UTC frame purely to do calendar subtraction — no timezone is
 * being inferred for either value, and DST/offsets cannot leak in because UTC
 * has none. */
function daysBetweenYmd(fromYmd: string, toYmdStr: string): number {
  const utc = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((utc(toYmdStr) - utc(fromYmd)) / 86_400_000);
}

/* Consequence spelled out on hover — red alone does not tell an operator what
 * actually happens to the technician. */
const OVERDUE_TITLE =
  'Training is overdue. This technician’s app is restricted to Training, Claim Amount and skipping jobs until the course is finished.';

/*
 * Deadline state for one row.
 *
 * Overdue is the exact rule the backend restricts the app on, and the exact
 * rule `status=overdue` filters by: not finished (`completion_date` is null)
 * AND a deadline exists AND that deadline is already behind today's IST date.
 *
 * `daysLeft` is a hint, not a status: it exists only for rows that are still
 * open and still in time, and is deliberately absent once a row is finished
 * (the deadline stopped mattering) or overdue (the chip says it louder).
 */
type DueView = {
  dueLabel: string | null;
  overdue: boolean;
  daysLeft: number | null;
};

function dueView(row: ReportRow, todayYmd: string): DueView {
  const due = toYmd(row.due_date);
  /* Mirrors the SQL's `completion_date IS NULL` — PRESENCE, not parseability.
   * Using `toYmd(...) != null` here instead would classify a present-but-
   * unparseable stamp as unfinished and paint a row red that `status=overdue`
   * would never return, breaking the invariant in the file header. Display
   * still goes through formatYmd, so such a value shows an em-dash rather than
   * a "0" — the row is simply not called overdue on the strength of it. */
  const finished = row.completion_date != null && String(row.completion_date).trim() !== '';
  if (!due) return { dueLabel: null, overdue: false, daysLeft: null };
  const overdue = !finished && due < todayYmd;
  return {
    dueLabel: formatYmd(due),
    overdue,
    daysLeft: finished || overdue ? null : daysBetweenYmd(todayYmd, due),
  };
}

/* "Due Today" / "In 1 Day" / "In 12 Days" — Title Case like every other label. */
function daysLeftLabel(days: number): string {
  if (days <= 0) return 'Due Today';
  return days === 1 ? 'In 1 Day' : `In ${days.toLocaleString('en-IN')} Days`;
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
    return { kind: 'empty', tone: 'slate', barClass: 'bg-ink-300', label: 'Course Has No Videos Yet' };
  }
  // Mirror the server's own completeness test (videos_done >= videos_total)
  // rather than testing pct >= 100 — the rounded percentage is a display value
  // and could disagree with the count at the boundary.
  if (done >= total) {
    return { kind: 'done', tone: 'emerald', barClass: 'bg-success', label: 'Complete' };
  }
  if (done <= 0) {
    return { kind: 'none', tone: 'slate', barClass: 'bg-ink-300', label: 'Not Started' };
  }
  return { kind: 'partial', tone: 'amber', barClass: 'bg-warning', label: `In Progress — ${pct}%` };
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

  /* One formatter per render rather than one per row. Not memoised on []: the
   * report is left open all day and a pinned "today" would stop marking rows
   * overdue after the first midnight. Safe against hydration mismatch because
   * `rows` is empty on the first paint, so no comparison is emitted then. */
  const todayYmd = istTodayYmd();

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
   * incomplete), so their sum IS the grand total.
   *
   * OVERDUE IS NOT PART OF THAT PARTITION. It is a SUBSET of incomplete — an
   * overdue row is by definition unfinished — so it is counted separately and
   * deliberately left OUT of the total, which stays complete + incomplete.
   * Adding it in would double-count every overdue row and inflate the total
   * past the real number of assignments. The card is labelled to say so out
   * loud, because four tiles in a row otherwise read as four slices of a pie.
   */
  const { data: completeCount } = useFetch<ReportResponse>(
    `/admin/lms/report?${countPrefix}status=complete&limit=1&offset=0`,
  );
  const { data: incompleteCount } = useFetch<ReportResponse>(
    `/admin/lms/report?${countPrefix}status=incomplete&limit=1&offset=0`,
  );
  const { data: overdueCount } = useFetch<ReportResponse>(
    `/admin/lms/report?${countPrefix}status=overdue&limit=1&offset=0`,
  );
  const completeTotal = completeCount?.total ?? null;
  const incompleteTotal = incompleteCount?.total ?? null;
  const overdueTotal = overdueCount?.total ?? null;
  /* complete + incomplete ONLY — see the note above on why overdue is excluded. */
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
        <h1 className="text-2xl font-semibold flex items-center gap-2">
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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Assignments"
          value={grandTotal}
          hint="Complete + Incomplete"
        />
        <StatCard label="Complete" value={completeTotal} valueClass="text-success-strong" />
        <StatCard label="Incomplete" value={incompleteTotal} valueClass="text-warning-strong" />
        {/* Explicitly marked as contained by Incomplete rather than sitting
            beside it — the four tiles must not read as a partition. */}
        <StatCard
          label="Overdue"
          value={overdueTotal}
          valueClass="text-urgent-strong"
          hint="Included In Incomplete"
          title={OVERDUE_TITLE}
        />
      </div>

      {listError && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {listError}
          </CardContent>
        </Card>
      )}

      {/* The threshold comes from the response, not a literal — see
          `completionPercent` on ReportResponse. */}
      <div className="space-y-1">
        {completionPercent != null && (
          <p className="text-xs text-muted-foreground">
            A Video Counts As Done At {completionPercent}% Watched.
          </p>
        )}
        {/* Legend for the red chip. Without it the colour is a warning with no
            stated consequence, and the consequence is the whole point of the
            deadline. */}
        <p className="text-xs text-muted-foreground">
          A Red Due Date Is Overdue — That Technician’s App Is Restricted To Training, Claim Amount
          And Skipping Jobs Until The Course Is Finished.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {/*
            * Auto layout inside a horizontal scroller — the pattern every other
            * data table here uses (customers/[id], settings/zones, …).
            *
            * This replaced `table-fixed` + a percentage colgroup. That gave
            * stable column widths from page to page, but the percentages were a
            * guess about content: "Assigned On" had 10%, which is narrower than
            * "25 Aug 2026, 06:49 pm", so the timestamp ran under the Due Date
            * column and the two read as one smeared cell.
            *
            * Auto layout sizes each column to its widest cell instead, and the
            * scroller absorbs the overflow rather than the page squeezing the
            * columns. The cost is honest: column widths can now shift slightly
            * between pages as content changes. That is a smaller problem than
            * two columns overlapping, and it is what the rest of the CRM does.
            *
            * whitespace-nowrap lives on the cells that must never wrap (dates,
            * mobile) rather than on the table, so a long technician or course
            * name can still wrap instead of forcing a very wide scroll.
            */}
          <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <SortHeader col="technician"     align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Technician</SortHeader>
                <th className="!text-left whitespace-nowrap">Mobile</th>
                <SortHeader col="course"         align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Course</SortHeader>
                <SortHeader col="completion_pct" align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Progress</SortHeader>
                <SortHeader col="score"          align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Score</SortHeader>
                <SortHeader col="assigned_on"    align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Assigned On</SortHeader>
                {/* Both keys exist in REPORT_SORTABLE_COLUMNS (t.due_date /
                    t.completion_date), so these sort server-side like the rest.
                    Anything outside that map 400s at Joi, which is why SortKey
                    is pinned to exactly its key set. */}
                <SortHeader col="due_date"        align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Due Date</SortHeader>
                <SortHeader col="completion_date" align="left"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Completed On</SortHeader>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">No assignments match the current filters.</td></tr>
              )}
              {!loading && rows.map((r) => {
                const done = toNum(r.videos_done);
                const totalVideos = toNum(r.videos_total);
                const pct = toNum(r.completion_pct);
                const view = progressView(done, totalVideos, pct);
                const due = dueView(r, todayYmd);
                const completedOn = formatYmd(r.completion_date);
                return (
                  <tr key={r.id}>
                    {/* max-w + truncate, not truncate alone: in an auto-layout
                        table an unconstrained cell just grows, so `truncate`
                        never ellipsizes. The cap lets short names size to
                        content and only clips genuinely long ones. */}
                    <td className="!text-left font-medium truncate max-w-[22ch]" title={r.technician_name ?? ''}>
                      {r.technician_name || <span className="text-muted-foreground">—</span>}
                    </td>
                    {/* Masked upstream — printed exactly as received. */}
                    <td className="!text-left font-mono text-xs whitespace-nowrap">
                      {r.technician_mobile || <span className="text-muted-foreground font-sans">—</span>}
                    </td>
                    <td className="!text-left truncate max-w-[28ch]" title={r.course_name ?? ''}>
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
                    {/* Due Date. Both states keep the same two-line shape — date
                        on top, status/hint beneath — so the column scans as one
                        vertical rhythm and the red chip is the only thing that
                        jumps out. */}
                    <td className="!text-left whitespace-nowrap text-xs">
                      {due.dueLabel == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : due.overdue ? (
                        <div className="space-y-0.5">
                          <StatusChip tone="red" size="sm" title={OVERDUE_TITLE}>
                            {due.dueLabel}
                          </StatusChip>
                          <div className="text-xs font-semibold text-urgent-strong" title={OVERDUE_TITLE}>
                            Overdue
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-0.5">
                          <div>{due.dueLabel}</div>
                          {/* Subordinate to the date itself: the deadline is the
                              fact, the countdown is only a convenience. */}
                          {due.daysLeft != null && (
                            <div className="text-xs text-muted-foreground">
                              {daysLeftLabel(due.daysLeft)}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    {/* Completed On — em-dash while still in progress. */}
                    <td className="!text-left whitespace-nowrap text-xs">
                      {completedOn ?? <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
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
function StatCard({ label, value, valueClass, hint, title }: {
  label: string;
  value: number | null;
  valueClass?: string;
  /* Set-relationship note. Exists because these tiles are NOT all disjoint:
   * without it "Overdue" beside "Incomplete" implies the two are separate
   * populations, and an operator would add them up. */
  hint?: string;
  title?: string;
}) {
  return (
    <Card>
      <CardContent className="p-3" title={title}>
        <div className={`text-2xl font-semibold tabular-nums ${valueClass ?? ''}`}>
          {value == null ? '—' : value.toLocaleString('en-IN')}
        </div>
        <div className="text-xs text-muted-foreground">{label}</div>
        {hint && <div className="text-xs text-muted-foreground/80">{hint}</div>}
      </CardContent>
    </Card>
  );
}
