'use client';

/*
 * Assign Training — LMS (menu slug `lmsAssign`, added 2026-08-13).
 *
 * Two stacked concerns on one page:
 *   1. Assign ONE course to MANY technicians in a single call, with a
 *      completion deadline (POST /admin/lms/assignments).
 *   2. Browse / unassign what is already assigned, including each row's
 *      due date and deadline state (GET + DELETE /admin/lms/assignments).
 *
 * Deadlines (added 2026-08-13): the form posts a `duration_months` /
 * `duration_days` PAIR and the BE derives `due_date` from it. The duration
 * itself is NOT stored — only the date is. The client never sends a date; it
 * only PREVIEWS one, via a verbatim mirror of the server arithmetic in
 * src/lib/due-date.ts. Two API rules are enforced in the form so the operator
 * hits them before the round-trip rather than as an error toast: 0 months +
 * 0 days is a 400, and a course with zero videos is a 409.
 *
 * A deadline is also EXTENDABLE per row (PATCH, added 2026-08-13) — see
 * ExtendDeadlineDialog at the foot of this file for the anchor rule, which
 * the preview there has to reproduce exactly or it under-reports the date
 * the operator is about to commit to.
 *
 * Permission split: writes (assign + unassign) gate on `isLmsManage`; the
 * LIST stays readable without it. A coordinator often needs to answer "is
 * this technician trained on that course?" without holding the training-admin
 * permission, and hiding the table from them would just move the question
 * into a Slack thread.
 */

import * as React from 'react';
import { UserPlus, Search, Trash2, AlertTriangle, X, CalendarPlus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { IconButton } from '@/components/ui/icon-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StatusChip } from '@/components/ui/StatusChip';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { TablePagination, type TablePageSize } from '@/components/ui/table-pagination';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { api, ApiError } from '@/lib/api';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { formatEasyfixerName } from '@/lib/utils';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { istToday, dueDateFrom, extendAnchor, durationLabel } from '@/lib/due-date';

type Course = {
  id: number;
  name: string;
  description: string | null;
  status: number;
  /* Correlated count from the BE. Misnamed on the wire and kept that way: it
   * counts CONTENT ITEMS of all three kinds (video / document / assessment),
   * not videos. A course with 0 of them is unfinishable. */
  video_count: number;
  assigned_count: number;
};
type CoursesResp = { rows: Course[]; total: number };

/* Bare array (NOT {rows,total}) — /shared/lookup/* returns the list directly. */
type EasyfixerLite = {
  efr_id: number;
  efr_name: string;
  efr_no: string;
  city_name: string | null;
  is_technician_verified: boolean;
  efr_status: number;
};

type Assignment = {
  id: number;
  easyfixer_id: number;
  course_id: number;
  /* NULL until the technician is scored — never coerce this to 0. */
  score: number | null;
  assigned_on: string;
  /*
   * The BE LEFT JOINs tbl_easyfixer, so a row whose technician record was
   * purged still lists with NULL name/mobile rather than vanishing.
   */
  technician_name: string | null;
  technician_mobile: string | null;
  course_name: string;
  /*
   * DATE strings ('YYYY-MM-DD'), both nullable. `due_date` is NULL on rows
   * created before deadlines existed; `completion_date` is NULL until the
   * technician finishes every video in the course.
   *
   * There is deliberately NO stored duration beside `due_date` any more
   * (`duration_months` / `duration_days` were dropped from
   * `easyfixer_courses`). The DATE is the fact every query, reminder and
   * restriction reads, and once a deadline has been extended a stored
   * "3 Months" is true of neither the original assignment nor the current
   * deadline — it would only ever be a second, staler answer to a question
   * the date already answers. One column, one truth.
   */
  due_date: string | null;
  completion_date: string | null;
};
type AssignmentsResp = { rows: Assignment[]; total: number; limit: number; offset: number };

type AssignResult = {
  requested: number;
  assigned: number;
  alreadyAssigned: number;
  /* The authoritative deadline the BE computed — echoed back so the toast can
   * confirm what was actually stored rather than repeating our preview. */
  due_date: string | null;
};

type ExtendResult = {
  course_id: number;
  easyfixer_id: number;
  /* What the deadline WAS — NULL when the row had no deadline at all. */
  previous_due_date: string | null;
  /* Non-nullable: an extension always lands on a date. */
  due_date: string;
  /*
   * True when this extension moved an OVERDUE row back into the future,
   * i.e. it lifted the training restriction on the technician. The BE is
   * the only thing that can say this — it knows both the old date and the
   * restriction rule — so we report its answer rather than re-deriving it.
   */
  unblocked: boolean;
};

/*
 * Mirrors the BE Joi cap (`easyfixer_ids` max 500). Enforced here too so a
 * 501-technician selection fails with an explanation in the form instead of
 * a bare 400 toast after the round-trip.
 */
const MAX_PER_ASSIGN = 500;

/*
 * 'All' is deliberately absent. /admin/lms/assignments caps `limit` at 1000,
 * and assignments multiply (technicians x courses), so on a mature board
 * "All" would render one un-navigable page whose range hint claims to show
 * every row while the response was silently truncated.
 */
const ASSIGN_PAGE_SIZES: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
];

/*
 * Mirrors the BE Joi bounds on the duration pair. Both are allowed to be 0
 * individually — it is only the 0/0 COMBINATION the API rejects, because an
 * assignment with no due date is never reminded on and never enforced.
 */
const MAX_DURATION_MONTHS = 60;
const MAX_DURATION_DAYS = 365;

/*
 * Default deadline, shared by the assign form and the extend dialog.
 * Deliberately NOT 0/0: that combination is a hard 400 on both endpoints, so
 * shipping it as the initial state would make either form born invalid and
 * turn the very first click into an error toast.
 */
const DEFAULT_DURATION_MONTHS = '1';
const DEFAULT_DURATION_DAYS = '0';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/*
 * `assigned_on` arrives as a raw MySQL DATETIME string ("2026-08-13 10:30:00")
 * because the BE pool runs `dateStrings: true` — it is already an IST
 * wall-clock reading, NOT an instant. Feeding it through `new Date(...)` +
 * toLocaleString would re-interpret it in the viewer's timezone and shift the
 * displayed time for anyone not on IST, so we format the string's own parts
 * and never construct a Date at all.
 */
function formatAssignedOn(raw: string | null | undefined): string {
  if (!raw) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(raw));
  // Unexpected shape → show it verbatim. "Invalid Date" tells the operator
  // nothing; the raw value at least hints at what the BE actually sent.
  if (!m) return String(raw);
  const [, year, month, day, hh, mi] = m;
  const hour24 = Number(hh);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${day} ${MONTHS[Number(month) - 1] ?? month} ${year}, ${String(hour12).padStart(2, '0')}:${mi} ${hour24 >= 12 ? 'PM' : 'AM'}`;
}

/*
 * Date-only sibling of formatAssignedOn for `due_date` / `completion_date`.
 * Same reasoning: these are MySQL DATE strings under `dateStrings: true`, so
 * they are already IST calendar days. Parsing them into a Date would let the
 * viewer's timezone shift them a day either way — a deadline that silently
 * moves is worse than no deadline at all.
 */
function formatDay(raw: string | null | undefined): string {
  if (!raw) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw));
  if (!m) return String(raw);
  const [, year, month, day] = m;
  return `${day} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

/*
 * Deadline state of one assignment, derived purely from the row — the BE
 * stores no status column, and computing it here keeps the list honest as
 * the day rolls over without needing a re-fetch to re-stamp anything.
 *
 * Order matters: completion WINS over an expired deadline. A technician who
 * finished late is "Completed", not "Overdue" — flagging finished work as
 * overdue forever would make the Overdue filter useless as a worklist.
 *
 * A NULL due_date (legacy rows created before deadlines existed) can never be
 * overdue; it falls through to In Progress rather than being invented into a
 * breach.
 */
function assignmentStatus(a: Assignment, todayIso: string): { label: string; tone: 'emerald' | 'red' | 'amber' } {
  if (a.completion_date) return { label: 'Completed', tone: 'emerald' };
  // Both sides are fixed-width 'YYYY-MM-DD', so a string compare IS a
  // chronological compare — no Date objects, no timezone to get wrong.
  const due = a.due_date ? String(a.due_date).slice(0, 10) : '';
  if (due && due < todayIso) return { label: 'Overdue', tone: 'red' };
  return { label: 'In Progress', tone: 'amber' };
}

/*
 * Report the split the BE deliberately hands back. Saying "5 Technicians
 * Assigned" when 2 of them already held the course would be a lie the
 * operator can't detect — repeat assignment is an idempotent upsert that
 * preserves any existing score, so those 2 were untouched.
 *
 * The due date is quoted from the RESPONSE, not from our preview, and only
 * when something was actually assigned — "Due 13 Nov" next to zero new rows
 * would imply a deadline was set when nothing was written.
 */
function assignSummary(assigned: number, alreadyAssigned: number, dueDate: string | null): string {
  const parts: string[] = [];
  if (assigned > 0) parts.push(`${assigned} ${assigned === 1 ? 'Technician' : 'Technicians'} Assigned`);
  if (assigned > 0 && dueDate) parts.push(`Due ${formatDay(dueDate)}`);
  if (alreadyAssigned > 0) parts.push(`${alreadyAssigned} Already Had This Course`);
  return parts.join(' · ') || 'Nothing To Assign';
}

/*
 * '' / whitespace reads as 0 so a cleared field behaves like "none of this
 * unit" instead of NaN. Anything non-integer or negative returns null, which
 * the caller surfaces as an inline error rather than silently coercing — a
 * duration the operator did not type is a duration they cannot audit.
 */
function parseDurationField(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return 0;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

type DurationCheck = {
  months: number | null;
  days: number | null;
  formatInvalid: boolean;
  overBounds: boolean;
  /* 0 months + 0 days — a hard 400 on BOTH the assign and extend endpoints. */
  empty: boolean;
  valid: boolean;
};

/*
 * One validator for the months/days PAIR, shared by the assign form and the
 * extend dialog. Both post the same pair to the same Joi bounds, so a second
 * copy would drift the moment either bound moved — and a form that disagrees
 * with the API about what is valid fails as a surprise 400 instead of as an
 * inline note.
 */
function validateDuration(monthsRaw: string, daysRaw: string): DurationCheck {
  const months = parseDurationField(monthsRaw);
  const days = parseDurationField(daysRaw);
  const formatInvalid = months === null || days === null;
  const overBounds = (months ?? 0) > MAX_DURATION_MONTHS || (days ?? 0) > MAX_DURATION_DAYS;
  const empty = !formatInvalid && (months ?? 0) <= 0 && (days ?? 0) <= 0;
  return {
    months,
    days,
    formatInvalid,
    overBounds,
    empty,
    valid: !formatInvalid && !overBounds && !empty,
  };
}

/*
 * The months + days input pair. `idPrefix` exists because this renders twice
 * on the page once the extend dialog is open, and two <input id="…-months">
 * in one document would silently point both <label for> targets at the first
 * field.
 */
function DurationFields({
  idPrefix,
  ariaPrefix,
  monthsRaw,
  daysRaw,
  onMonthsChange,
  onDaysChange,
}: {
  idPrefix: string;
  ariaPrefix: string;
  monthsRaw: string;
  daysRaw: string;
  onMonthsChange: (v: string) => void;
  onDaysChange: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="flex items-center gap-1.5">
        <Input
          id={`${idPrefix}-months`}
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_DURATION_MONTHS}
          step={1}
          value={monthsRaw}
          onChange={(e) => onMonthsChange(e.target.value)}
          className="w-full"
          aria-label={`${ariaPrefix} Months`}
        />
        <Label htmlFor={`${idPrefix}-months`} className="text-xs text-muted-foreground">
          Months
        </Label>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          id={`${idPrefix}-days`}
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_DURATION_DAYS}
          step={1}
          value={daysRaw}
          onChange={(e) => onDaysChange(e.target.value)}
          className="w-full"
          aria-label={`${ariaPrefix} Days`}
        />
        <Label htmlFor={`${idPrefix}-days`} className="text-xs text-muted-foreground">
          Days
        </Label>
      </div>
    </div>
  );
}

/*
 * Inline validation note for a duration pair. Only the 0/0 copy differs
 * between the two forms — "no deadline" and "no extension" are different
 * mistakes — so that one string is a prop and the rest are shared.
 */
function DurationErrors({ check, emptyMessage }: { check: DurationCheck; emptyMessage: string }) {
  if (check.formatInvalid) {
    return <p className="mt-1 text-xs text-urgent">Enter whole numbers only.</p>;
  }
  if (check.overBounds) {
    return (
      <p className="mt-1 text-xs text-urgent">
        Maximum {MAX_DURATION_MONTHS} months and {MAX_DURATION_DAYS} days.
      </p>
    );
  }
  if (check.empty) {
    return <p className="mt-1 text-xs text-urgent">{emptyMessage}</p>;
  }
  return null;
}

export default function AssignTrainingPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isLmsManage']);

  /* ── Assign panel state ─────────────────────────────────────────── */
  const [courseId, setCourseId] = React.useState<number | ''>('');
  const [selectedIds, setSelectedIds] = React.useState<number[]>([]);
  const [assigning, setAssigning] = React.useState(false);
  /*
   * Duration is held as STRINGS, not numbers. A numeric state would force a
   * cleared field back to "0" on every keystroke, so the operator could never
   * clear "1" to type "12" — they would fight the input. Parsing happens once,
   * below, and the parsed value is what validates and submits.
   */
  const [monthsRaw, setMonthsRaw] = React.useState(DEFAULT_DURATION_MONTHS);
  const [daysRaw, setDaysRaw] = React.useState(DEFAULT_DURATION_DAYS);

  /*
   * Row whose deadline is being extended. Holding the ROW (not just an id)
   * lets the dialog mount only when it is open, so its inputs reset per row
   * for free instead of needing an "if (open) reset everything" effect.
   */
  const [extending, setExtending] = React.useState<Assignment | null>(null);

  /* ── List state ─────────────────────────────────────────────────── */
  const [search, setSearch] = React.useState('');
  const [courseFilter, setCourseFilter] = React.useState<number | ''>('');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  const dq = useDebouncedValue(search, 300);
  const limit = pageSize === 'all' ? 1000 : pageSize;

  /*
   * Courses feed BOTH the assign picker and the list filter, so they load for
   * everyone — not just `isLmsManage` holders. limit=1000 is the endpoint's
   * Joi max; the course master is a short list by nature.
   */
  const coursesFetch = useFetch<CoursesResp>('/admin/lms/courses?includeInactive=false&limit=1000');

  /*
   * Technician lookup loads only when the assign panel will actually render —
   * it is a multi-thousand-row payload and read-only viewers never use it.
   *
   * Fetched WITHOUT `q`: SearchMultiSelect filters client-side inside its own
   * popover, and server-filtering would drop already-selected technicians out
   * of `options` the moment the query changed, orphaning their chips (the
   * label lookup below would fall back to "Technician #123").
   */
  const techFetch = useFetch<EasyfixerLite[]>(can.isLmsManage ? '/shared/lookup/easyfixers' : null);

  const qs = new URLSearchParams();
  if (dq.trim()) qs.set('q', dq.trim());
  if (courseFilter) qs.set('courseId', String(courseFilter));
  qs.set('limit', String(limit));
  qs.set('offset', String(page * limit));
  const listFetch = useFetch<AssignmentsResp>(`/admin/lms/assignments?${qs.toString()}`);

  /*
   * Any filter change re-queries from row 0. Without this, narrowing a filter
   * while on page 3 asks for an offset the smaller result set no longer has
   * and the table renders empty with no obvious cause.
   */
  React.useEffect(() => { setPage(0); }, [dq, courseFilter]);

  const courses = React.useMemo(() => coursesFetch.data?.rows ?? [], [coursesFetch.data]);
  const selectedCourse = React.useMemo(
    () => (courseId === '' ? null : courses.find((c) => c.id === courseId) ?? null),
    [courses, courseId],
  );

  /*
   * The option label carries the content count so an empty course is visible
   * at PICK time, not only after selection — the operator sees the problem
   * while choosing rather than being corrected afterwards.
   */
  const courseOptions = React.useMemo<SearchOption[]>(
    () => courses.map((c) => ({
      value: c.id,
      label: `${c.name} · ${c.video_count === 0 ? 'No Content' : `${c.video_count} Item${c.video_count === 1 ? '' : 's'}`}`,
    })),
    [courses],
  );

  /*
   * Label embeds mobile + city so the picker's typeahead matches on any of
   * them. `formatEasyfixerName` expands the legacy "(T)" prefix → "Trainee · …"
   * so trainee status is visible while assigning training.
   */
  const technicians = React.useMemo(() => techFetch.data ?? [], [techFetch.data]);
  const techOptions = React.useMemo<SearchOption[]>(
    () => technicians.map((t) => ({
      value: t.efr_id,
      label: `${formatEasyfixerName(t.efr_name)} · ${t.efr_no}${t.city_name ? ` · ${t.city_name}` : ''}`,
    })),
    [technicians],
  );
  const techNameById = React.useMemo(
    () => new Map(technicians.map((t) => [t.efr_id, formatEasyfixerName(t.efr_name)])),
    [technicians],
  );

  /*
   * "Today" in IST, recomputed per render. Drives BOTH the due-date preview
   * and the Overdue classification in the list, so the two can never disagree
   * about where the boundary sits.
   */
  const todayIso = istToday();

  /*
   * The 0/0 case is a hard 400 on the BE. Catching it here means the operator
   * learns it from the disabled button and the inline note, not from a red
   * toast after a round-trip that changed nothing.
   */
  const duration = validateDuration(monthsRaw, daysRaw);
  const { months: monthsNum, days: daysNum, valid: durationValid } = duration;
  /*
   * Preview only — the BE recomputes this from the same inputs and its answer
   * is the one that gets stored. See src/lib/due-date.ts.
   */
  const previewDue = durationValid ? dueDateFrom(todayIso, monthsNum ?? 0, daysNum ?? 0) : null;

  const overCap = selectedIds.length > MAX_PER_ASSIGN;
  /*
   * A course with zero content items is now a HARD block, not a warning: the
   * BE answers 409 because such a course can never be completed, so assigning
   * it would only manufacture permanently-overdue rows.
   */
  const courseHasNoContent = !!selectedCourse && selectedCourse.video_count === 0;
  const canSubmit =
    courseId !== ''
    && selectedIds.length > 0
    && !overCap
    && !courseHasNoContent
    && durationValid
    && !assigning;

  async function handleAssign() {
    // `canSubmit` already asserts a course is picked — TS narrows `courseId`
    // to number through it, so a second `=== ''` guard here is dead code.
    if (!canSubmit) return;
    setAssigning(true);
    const toastId = showToast({ variant: 'loading', message: 'Assigning Course…' });
    try {
      const res = await api.post<AssignResult>('/admin/lms/assignments', {
        course_id: Number(courseId),
        easyfixer_ids: selectedIds,
        duration_months: monthsNum ?? 0,
        duration_days: daysNum ?? 0,
      });
      dismissToast(toastId);
      showToast({
        // Zero new rows is not a failure (the upsert is a safe no-op) but it is
        // not a success either — warn so the operator notices nothing changed.
        variant: res.assigned > 0 ? 'success' : 'warning',
        message: assignSummary(res.assigned, res.alreadyAssigned, res.due_date),
      });
      // Clear the technicians but KEEP the course — assigning the same course
      // to a second batch is the common next action.
      setSelectedIds([]);
      invalidateFetch((k) => k.startsWith('/admin/lms/assignments'));
      // Eviction alone never reaches a MOUNTED useFetch — it clears the module
      // cache but nothing re-requests, so the new rows would not appear until a
      // full page reload. The explicit refetch is what actually refreshes.
      listFetch.refetch();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Assign failed' });
    } finally {
      setAssigning(false);
    }
  }

  async function handleUnassign(a: Assignment) {
    const who = a.technician_name ? formatEasyfixerName(a.technician_name) : `Technician #${a.easyfixer_id}`;
    const ok = await confirm({
      title: 'Unassign This Course?',
      description: `${who} will no longer be required to complete "${a.course_name}". Any videos they have already watched stay recorded — unassigning removes the assignment, not their progress — so re-assigning later picks up where they left off.`,
      confirmLabel: 'Unassign',
      variant: 'destructive',
    });
    if (!ok) return;
    const toastId = showToast({ variant: 'loading', message: 'Unassigning…' });
    try {
      await api.delete(`/admin/lms/assignments/${a.course_id}/${a.easyfixer_id}`);
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Course Unassigned' });
      invalidateFetch((k) => k.startsWith('/admin/lms/assignments'));
      // Same trap as the assign path — the mounted list needs an explicit refetch.
      listFetch.refetch();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Unassign failed' });
    }
  }

  /*
   * Post-extend refresh. Eviction alone never reaches this MOUNTED list —
   * `invalidateFetch` clears the module cache but has no subscriber
   * mechanism, so the row would keep showing the OLD deadline (and an
   * Overdue chip that is no longer true) until a full page reload.
   */
  function handleExtended() {
    setExtending(null);
    invalidateFetch((k) => k.startsWith('/admin/lms/assignments'));
    listFetch.refetch();
  }

  const rows = listFetch.data?.rows ?? [];
  const total = listFetch.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <UserPlus className="size-6" /> Assign Training
        </h1>
        <p className="text-sm text-muted-foreground">
          Assign training courses to technicians and review who already holds what.
        </p>
      </div>

      {/* ── Assign panel — write surface, hidden entirely without isLmsManage ── */}
      {can.isLmsManage && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Label required>Course</Label>
                  {selectedCourse && (
                    // Red, not amber — with the 409 in place an empty course is
                    // a blocker, and an amber "caution" chip would understate it.
                    <StatusChip tone={selectedCourse.video_count === 0 ? 'red' : 'emerald'} size="sm">
                      {selectedCourse.video_count === 0
                        ? 'No Content'
                        : `${selectedCourse.video_count} Item${selectedCourse.video_count === 1 ? '' : 's'}`}
                    </StatusChip>
                  )}
                </div>
                <SearchSelect
                  value={courseId}
                  onChange={(v) => setCourseId(v ? Number(v) : '')}
                  options={courseOptions}
                  placeholder={coursesFetch.loading ? 'Loading Courses…' : 'Select A Course…'}
                  emptyText="No Active Courses"
                />
              </div>

              <div>
                <Label className="block mb-1" required>Technicians</Label>
                <SearchMultiSelect
                  value={selectedIds}
                  onChange={(next) => setSelectedIds(next.map(Number))}
                  options={techOptions}
                  placeholder={techFetch.loading ? 'Loading Technicians…' : 'Select Technicians…'}
                  emptyText="No Technicians Match"
                  // 'plusminus' reads as "add this / drop this", which suits a
                  // picker paired with the removable chip list below.
                  indicator="plusminus"
                  summarize={(n) => (n === 0
                    ? 'Select Technicians…'
                    : `${n} Technician${n === 1 ? '' : 's'} Selected`)}
                />
              </div>

              {/*
                * Completion window. The BE turns this pair into the stored
                * `due_date`; we never send a date. Months and days are split
                * because "1 month" and "30 days" are NOT the same span — the
                * month arm is calendar-clamped (31 Jan + 1 Month = 28 Feb).
                */}
              <div>
                <Label className="block mb-1" required>Completion Window</Label>
                <DurationFields
                  idPrefix="duration"
                  ariaPrefix="Completion Window"
                  monthsRaw={monthsRaw}
                  daysRaw={daysRaw}
                  onMonthsChange={setMonthsRaw}
                  onDaysChange={setDaysRaw}
                />

                {/*
                  * Live preview of the deadline being committed to. Recomputed
                  * from the SAME arithmetic the BE uses (src/lib/due-date.ts);
                  * the stored value still comes from the API response.
                  */}
                {durationValid && previewDue && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Due <span className="font-medium text-foreground">{formatDay(previewDue)}</span>
                    {' '}({durationLabel(monthsNum ?? 0, daysNum ?? 0)})
                  </p>
                )}
                <DurationErrors
                  check={duration}
                  emptyMessage="Set a duration — an assignment with no due date is never reminded or enforced."
                />
              </div>
            </div>

            {/* Selected technicians as removable chips — the picker owns only
                the trigger + popover, so the caller renders the chips. */}
            {selectedIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedIds.map((id) => {
                  const name = techNameById.get(id) ?? `Technician #${id}`;
                  return (
                    <StatusChip key={id} tone="sky" size="sm" className="gap-1">
                      {name}
                      <button
                        type="button"
                        onClick={() => setSelectedIds((prev) => prev.filter((x) => x !== id))}
                        className="rounded-full hover:bg-info/20 p-0.5"
                        aria-label={`Remove ${name}`}
                      >
                        <X className="size-3" />
                      </button>
                    </StatusChip>
                  );
                })}
              </div>
            )}

            <div className="flex items-end justify-between gap-3 flex-wrap">
              <div className="flex-1 min-w-[260px] space-y-2">
                {/*
                 * Empty-course BLOCK (was a soft warning until deadlines
                 * landed). A course with no content can never reach completion,
                 * so with a due date attached every technician assigned to it
                 * would tip into Overdue and stay there. The BE now answers 409
                 * for exactly this, so the button is disabled to match — the
                 * form refuses locally rather than letting the server error be
                 * the first thing the operator hears.
                 */}
                {courseHasNoContent && selectedCourse && (
                  <div className="flex items-start gap-2 rounded-md border border-urgent/30 bg-urgent-tint p-2 text-xs text-urgent-strong">
                    <AlertTriangle className="size-4 shrink-0 mt-px" />
                    <span>
                      <strong>{selectedCourse.name}</strong> has no content yet and cannot be
                      assigned until some is added. A course with no content can never be
                      completed, so everyone assigned it would go overdue and stay there. Add
                      content to the course first, then assign it.
                    </span>
                  </div>
                )}
                {overCap && (
                  <div className="flex items-start gap-2 rounded-md border border-urgent/30 bg-urgent-tint p-2 text-xs text-urgent-strong">
                    <AlertTriangle className="size-4 shrink-0 mt-px" />
                    <span>
                      {selectedIds.length} technicians selected — the maximum per assignment is{' '}
                      {MAX_PER_ASSIGN}. Remove {selectedIds.length - MAX_PER_ASSIGN} and assign the
                      rest in a second batch.
                    </span>
                  </div>
                )}
                {techFetch.error && (
                  <div className="flex items-center gap-2 text-xs text-urgent">
                    <AlertTriangle className="size-4" /> {techFetch.error}
                  </div>
                )}
              </div>
              <Button onClick={handleAssign} disabled={!canSubmit}>
                <UserPlus className="size-4 mr-1" />
                {assigning ? 'Assigning…' : 'Assign Course'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Filters ────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by technician name, mobile, or course…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <SearchSelect
            value={courseFilter}
            onChange={(v) => setCourseFilter(v ? Number(v) : '')}
            options={[{ value: '', label: 'All Courses' }, ...courseOptions]}
            placeholder="All Courses"
            className="w-64"
          />
        </CardContent>
      </Card>

      {listFetch.error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {listFetch.error}
          </CardContent>
        </Card>
      )}

      {/* ── Assignments list ───────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th className="!text-left">Technician</th>
                <th className="!text-left">Mobile</th>
                <th className="!text-left">Course</th>
                <th className="!text-left whitespace-nowrap">Assigned On</th>
                <th className="!text-left whitespace-nowrap">Due Date</th>
                <th className="!text-left whitespace-nowrap">Status</th>
                <th className="!text-center">Score</th>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {listFetch.loading && (
                <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!listFetch.loading && rows.length === 0 && (
                <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">No assignments match the current filters.</td></tr>
              )}
              {!listFetch.loading && rows.map((a) => {
                const st = assignmentStatus(a, todayIso);
                return (
                <tr key={a.id}>
                  <td className="!text-left font-medium">
                    {a.technician_name ? formatEasyfixerName(a.technician_name) : `Technician #${a.easyfixer_id}`}
                  </td>
                  {/*
                   * Mobiles arrive pre-masked ("9876••••••") from the admin
                   * masking middleware. Rendered verbatim — any reformatting
                   * here would mangle the bullets.
                   */}
                  <td className="!text-left font-mono text-xs">{a.technician_mobile || '—'}</td>
                  <td className="!text-left">{a.course_name}</td>
                  <td className="!text-left whitespace-nowrap text-xs">{formatAssignedOn(a.assigned_on)}</td>
                  {/*
                   * The deadline itself, and nothing else. The window it was
                   * originally derived from is no longer stored (see the
                   * Assignment type) — and printing one under a date that may
                   * since have been extended would contradict the date it sits
                   * beneath. Legacy rows predate deadlines and carry NULL — an
                   * em-dash, never the string "null", never a fabricated date.
                   */}
                  <td className="!text-left whitespace-nowrap text-xs">
                    {a.due_date
                      ? (
                        <span className={st.label === 'Overdue' ? 'font-medium text-urgent-strong' : ''}>
                          {formatDay(a.due_date)}
                        </span>
                      )
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-left whitespace-nowrap">
                    <StatusChip tone={st.tone} size="sm">{st.label}</StatusChip>
                    {a.completion_date && (
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        {formatDay(a.completion_date)}
                      </span>
                    )}
                  </td>
                  {/* NULL score = not yet scored. An em-dash, never "0" — a
                      zero would read as a failed test rather than no test. */}
                  <td className="!text-center tabular-nums">
                    {a.score == null ? <span className="text-muted-foreground">—</span> : a.score}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-1">
                      {can.isLmsManage
                        ? (
                          <>
                            {/*
                             * Disabled rather than hidden once the training is
                             * finished: the row still HAS a deadline, so an
                             * absent control reads as "not allowed here" with
                             * no reason given. The tooltip gives the reason.
                             */}
                            <IconButton
                              icon={CalendarPlus}
                              label={a.completion_date
                                ? 'Training Already Complete'
                                : 'Extend Deadline'}
                              intent="primary"
                              disabled={!!a.completion_date}
                              onClick={() => setExtending(a)}
                            />
                            <IconButton
                              icon={Trash2}
                              label="Unassign"
                              intent="danger"
                              onClick={() => handleUnassign(a)}
                            />
                          </>
                        )
                        : <span className="text-xs text-muted-foreground">view-only</span>}
                    </div>
                  </td>
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
        pageSizeOptions={ASSIGN_PAGE_SIZES}
      />

      {/* Mounted only while open, so each row starts the dialog fresh. The
          permission is re-checked here as well as on the trigger — the state
          is only reachable from a gated button today, but a dialog that can
          write is worth gating at the dialog. */}
      {extending && can.isLmsManage && (
        <ExtendDeadlineDialog
          assignment={extending}
          todayIso={todayIso}
          onClose={() => setExtending(null)}
          onSaved={handleExtended}
        />
      )}
    </div>
  );
}

/*
 * Extend Deadline — ONE action covering both "extend to unblock a restricted
 * technician" and "correct a deadline that was set wrong". They are the same
 * write (push the due date forward by a duration), and splitting them into
 * two controls would only force the operator to classify their own intent
 * before they are allowed to act.
 *
 * ── THE ANCHOR RULE ──────────────────────────────────────────────────────
 * The server anchors the new date at `max(today, due_date)`:
 *   - OVERDUE row      → counts from TODAY, so "+7 Days" really is seven days
 *     and the technician is unblocked for that whole window.
 *   - NOT YET DUE row  → counts from the EXISTING due date, so "+1 Month"
 *     genuinely ADDS a month instead of shortening a deadline months out.
 *   - NO deadline      → counts from today.
 *
 * The preview below reproduces that rule via `extendAnchor` and states what
 * it is counting FROM. This is not decoration: previewing from today on a
 * not-yet-due row would show an EARLIER date than the server will store, so
 * the operator would read "+1 Month" as a shortening and either not extend
 * at all or over-correct. A preview that under-reports the result is worse
 * than no preview, because it is believed.
 */
function ExtendDeadlineDialog({
  assignment,
  todayIso,
  onClose,
  onSaved,
}: {
  assignment: Assignment;
  /* Passed in (not recomputed) so the dialog and the list's Overdue chip can
     never disagree about where "today" sits. */
  todayIso: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [monthsRaw, setMonthsRaw] = React.useState(DEFAULT_DURATION_MONTHS);
  const [daysRaw, setDaysRaw] = React.useState(DEFAULT_DURATION_DAYS);
  const [submitting, setSubmitting] = React.useState(false);

  const duration = validateDuration(monthsRaw, daysRaw);

  const currentDue = assignment.due_date ? String(assignment.due_date).slice(0, 10) : null;
  const anchor = extendAnchor(todayIso, currentDue);
  // Fixed-width 'YYYY-MM-DD' on both sides, so a string compare is a
  // chronological one. Matches `assignmentStatus`'s Overdue test exactly.
  const isOverdue = !!currentDue && currentDue < todayIso;
  const preview = duration.valid
    ? dueDateFrom(anchor, duration.months ?? 0, duration.days ?? 0)
    : null;

  /*
   * Dirty = the operator actually changed the pre-filled duration. A real
   * check, not a blanket `true`: prompting "Discard changes?" on an untouched
   * dialog trains people to dismiss the prompt without reading it, which is
   * exactly when it stops protecting anything.
   */
  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: monthsRaw !== DEFAULT_DURATION_MONTHS || daysRaw !== DEFAULT_DURATION_DAYS,
    // A write in flight closes without a prompt — the row is about to be
    // refetched and the dialog unmounted either way.
    when: () => !submitting,
  });

  const who = assignment.technician_name
    ? formatEasyfixerName(assignment.technician_name)
    : `Technician #${assignment.easyfixer_id}`;

  async function handleSubmit() {
    if (!duration.valid || submitting) return;
    setSubmitting(true);
    const toastId = showToast({ variant: 'loading', message: 'Extending Deadline…' });
    try {
      const res = await api.patch<ExtendResult>(
        `/admin/lms/assignments/${assignment.course_id}/${assignment.easyfixer_id}`,
        { duration_months: duration.months ?? 0, duration_days: duration.days ?? 0 },
      );
      dismissToast(toastId);
      showToast({
        variant: 'success',
        /*
         * Quote the date the SERVER computed, not our preview — and say so
         * plainly when the extension lifted a restriction, because for an
         * overdue row that unblocking IS the point of the action. Reporting
         * only "Deadline Extended" would leave the operator to guess whether
         * the technician can work again.
         */
        message: `Deadline Extended To ${formatDay(res.due_date)}${res.unblocked ? ' · Technician Unblocked' : ''}`,
      });
      // Parent closes this dialog and refreshes the list, so `submitting` is
      // deliberately left true — the component unmounts on the next commit.
      onSaved();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Extend failed' });
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Extend Deadline</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-sm">
            <div className="font-medium">{who}</div>
            <div className="text-muted-foreground">{assignment.course_name}</div>
          </div>

          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
            <span className="text-muted-foreground">Current Deadline</span>
            <span className={isOverdue ? 'font-medium text-urgent-strong' : 'font-medium'}>
              {currentDue ? formatDay(currentDue) : 'None Set'}
            </span>
            {isOverdue && <StatusChip tone="red" size="sm">Overdue</StatusChip>}
          </div>

          <div>
            <Label className="block mb-1" required>Extend By</Label>
            <DurationFields
              idPrefix="extend-duration"
              ariaPrefix="Extend By"
              monthsRaw={monthsRaw}
              daysRaw={daysRaw}
              onMonthsChange={setMonthsRaw}
              onDaysChange={setDaysRaw}
            />

            {/* Live preview — states the anchor as well as the result, so the
                operator can see WHICH date is being counted from. */}
            {duration.valid && preview && (
              <p className="mt-1 text-xs text-muted-foreground">
                {isOverdue
                  ? 'Overdue — extending from today'
                  : currentDue
                    ? `From ${formatDay(currentDue)}`
                    : 'No deadline set — extending from today'}
                {' → '}
                <span className="font-medium text-foreground">{formatDay(preview)}</span>
                {' '}({durationLabel(duration.months ?? 0, duration.days ?? 0)})
              </p>
            )}
            {duration.valid && preview && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isOverdue || !currentDue
                  ? 'Counted from today, so the technician gets the full window and is unblocked immediately.'
                  : 'Counted from the existing deadline, so this adds to it rather than shortening it.'}
              </p>
            )}
            <DurationErrors
              check={duration}
              emptyMessage="Set how far to extend the deadline."
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={!duration.valid || submitting}>
              <CalendarPlus className="size-4 mr-1" />
              {submitting ? 'Extending…' : 'Extend Deadline'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
