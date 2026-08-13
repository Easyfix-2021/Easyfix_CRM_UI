'use client';

/*
 * Assign Training — LMS (menu slug `lmsAssign`, added 2026-08-13).
 *
 * Two stacked concerns on one page:
 *   1. Assign ONE course to MANY technicians in a single call
 *      (POST /admin/lms/assignments).
 *   2. Browse / unassign what is already assigned
 *      (GET + DELETE /admin/lms/assignments).
 *
 * Permission split: writes (assign + unassign) gate on `isLmsManage`; the
 * LIST stays readable without it. A coordinator often needs to answer "is
 * this technician trained on that course?" without holding the training-admin
 * permission, and hiding the table from them would just move the question
 * into a Slack thread.
 */

import * as React from 'react';
import { UserPlus, Search, Trash2, AlertTriangle, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
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

type Course = {
  id: number;
  name: string;
  description: string | null;
  status: number;
  /* Correlated count from the BE — a course with 0 videos is unfinishable. */
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
};
type AssignmentsResp = { rows: Assignment[]; total: number; limit: number; offset: number };

type AssignResult = { requested: number; assigned: number; alreadyAssigned: number };

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
 * Report the split the BE deliberately hands back. Saying "5 Technicians
 * Assigned" when 2 of them already held the course would be a lie the
 * operator can't detect — repeat assignment is an idempotent upsert that
 * preserves any existing score, so those 2 were untouched.
 */
function assignSummary(assigned: number, alreadyAssigned: number): string {
  const parts: string[] = [];
  if (assigned > 0) parts.push(`${assigned} ${assigned === 1 ? 'Technician' : 'Technicians'} Assigned`);
  if (alreadyAssigned > 0) parts.push(`${alreadyAssigned} Already Had This Course`);
  return parts.join(' · ') || 'Nothing To Assign';
}

export default function AssignTrainingPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isLmsManage']);

  /* ── Assign panel state ─────────────────────────────────────────── */
  const [courseId, setCourseId] = React.useState<number | ''>('');
  const [selectedIds, setSelectedIds] = React.useState<number[]>([]);
  const [assigning, setAssigning] = React.useState(false);

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
   * The option label carries the video count so an empty course is visible at
   * PICK time, not only after selection — the operator sees the problem while
   * choosing rather than being corrected afterwards.
   */
  const courseOptions = React.useMemo<SearchOption[]>(
    () => courses.map((c) => ({
      value: c.id,
      label: `${c.name} · ${c.video_count === 0 ? 'No Videos' : `${c.video_count} Video${c.video_count === 1 ? '' : 's'}`}`,
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

  const overCap = selectedIds.length > MAX_PER_ASSIGN;
  const canSubmit = courseId !== '' && selectedIds.length > 0 && !overCap && !assigning;

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
      });
      dismissToast(toastId);
      showToast({
        // Zero new rows is not a failure (the upsert is a safe no-op) but it is
        // not a success either — warn so the operator notices nothing changed.
        variant: res.assigned > 0 ? 'success' : 'warning',
        message: assignSummary(res.assigned, res.alreadyAssigned),
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

  const rows = listFetch.data?.rows ?? [];
  const total = listFetch.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
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
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Label required>Course</Label>
                  {selectedCourse && (
                    <StatusChip tone={selectedCourse.video_count === 0 ? 'amber' : 'emerald'} size="sm">
                      {selectedCourse.video_count === 0
                        ? 'No Videos'
                        : `${selectedCourse.video_count} Video${selectedCourse.video_count === 1 ? '' : 's'}`}
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
                        className="rounded-full hover:bg-sky-200 p-0.5"
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
                 * Empty-course warning. A course with no videos can never reach
                 * completion, so everyone assigned it sits permanently
                 * incomplete in the training report. We still allow the assign —
                 * staging a course before its content is loaded is legitimate —
                 * but the consequence is stated plainly rather than discovered
                 * later from a report full of stuck technicians.
                 */}
                {selectedCourse && selectedCourse.video_count === 0 && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                    <AlertTriangle className="size-4 shrink-0 mt-px" />
                    <span>
                      <strong>{selectedCourse.name}</strong> has no videos yet. A course with no
                      content can never be completed, so anyone assigned it will stay permanently
                      incomplete in the training report. Add videos first, or assign now if you are
                      staging the course ahead of its content.
                    </span>
                  </div>
                )}
                {overCap && (
                  <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700">
                    <AlertTriangle className="size-4 shrink-0 mt-px" />
                    <span>
                      {selectedIds.length} technicians selected — the maximum per assignment is{' '}
                      {MAX_PER_ASSIGN}. Remove {selectedIds.length - MAX_PER_ASSIGN} and assign the
                      rest in a second batch.
                    </span>
                  </div>
                )}
                {techFetch.error && (
                  <div className="flex items-center gap-2 text-xs text-red-600">
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
          <CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
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
                <th className="!text-center">Score</th>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {listFetch.loading && (
                <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!listFetch.loading && rows.length === 0 && (
                <tr><td colSpan={6} className="!text-center text-muted-foreground py-6">No assignments match the current filters.</td></tr>
              )}
              {!listFetch.loading && rows.map((a) => (
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
                  {/* NULL score = not yet scored. An em-dash, never "0" — a
                      zero would read as a failed test rather than no test. */}
                  <td className="!text-center tabular-nums">
                    {a.score == null ? <span className="text-muted-foreground">—</span> : a.score}
                  </td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-1">
                      {can.isLmsManage
                        ? (
                          <IconButton
                            icon={Trash2}
                            label="Unassign"
                            intent="danger"
                            onClick={() => handleUnassign(a)}
                          />
                        )
                        : <span className="text-[10px] text-muted-foreground">view-only</span>}
                    </div>
                  </td>
                </tr>
              ))}
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
    </div>
  );
}
