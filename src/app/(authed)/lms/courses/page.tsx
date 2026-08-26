'use client';

/*
 * Manage Courses — LMS.
 *
 * A course is a named, ordered playlist of training videos that gets assigned
 * to technicians. Two surfaces live here:
 *
 *   1. the course master (search / add / edit / retire / reactivate), and
 *   2. the CONTENT editor — the ordered video list behind a course.
 *
 * The content editor matters more than it looks. A course with zero videos is
 * assignable but *uncompletable*: the technician opens it, finds nothing to
 * watch, and their progress can never reach 100%. So the video count is called
 * out on the row when it's 0, and the editor's empty state says so explicitly
 * rather than rendering a polite blank panel.
 *
 * Retire is a SOFT delete (DELETE sets status 0). Existing assignments and
 * progress rows survive it, which is why the confirm copy says "retire" and
 * offers reactivation instead of warning about data loss.
 *
 * Backend: /admin/lms/courses (+ /:id/videos) and /admin/aux/training-videos.
 */

import * as React from 'react';
import {
  GraduationCap, Plus, Search, Pencil, ListVideo, Trash2, RotateCcw,
  ChevronUp, ChevronDown, X, AlertTriangle, Play, Users,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { SearchSelect } from '@/components/ui/search-select';
import { StatusChip } from '@/components/ui/StatusChip';
import {
  TablePagination, pageSizeToLimit, type TablePageSize,
} from '@/components/ui/table-pagination';
import { SortHeader, cycleSort, type SortDir } from '@/lib/use-sort';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { api, ApiError } from '@/lib/api';
import { VideoPreviewDialog } from '@/components/lms/VideoPreviewDialog';

/* ── Types ──────────────────────────────────────────────────────────────── */

type Course = {
  id: number;
  name: string;
  description: string | null;
  status: number;            // 1 = Active, 0 = Retired
  /*
   * 1 = auto-assign this course to every technician who completes registration
   * from now on. It is an ASSIGNMENT rule, not a gate: what a technician must
   * complete is what they actually hold, so the flag on its own holds nobody.
   * The backend's mandatory-video query also requires `status = 1`, so a
   * retired course gates nobody even while flagged. Technicians who registered
   * earlier are back-filled only by POST /courses/:id/assign-all.
   * TINYINT on the wire, so compare against 1, not true.
   */
  is_mandatory: number;
  created_at: string | null;
  updated_at: string | null;
  video_count: number;
  assigned_count: number;
};
type CourseListResp = { rows: Course[]; total: number; limit: number; offset: number };

/* A row of the course's content list as the API returns it. */
type CourseVideo = {
  id: number;               // link-row id — NOT what the PUT wants
  video_id: number;         // the training video itself
  sequence: number;
  title: string;
  sub_title: string | null;
  description: string | null;
  /* Playable link, already repaired by the backend. Null when the catalogue
   * entry has no video attached — which is worth seeing HERE, because such a
   * video can never be completed and so caps the whole course. */
  video_url: string | null;
};

/* A row of the training-video catalogue (`id` here IS the video_id). */
type CatalogueVideo = {
  id: number;
  title: string;
  sub_title: string | null;
  description: string | null;
  video_url: string | null;
  progress_count: number;
  course_count: number;
};
type CatalogueResp = { rows: CatalogueVideo[]; total: number; limit: number; offset: number };

/*
 * The editor's working copy. Deliberately keyed on `video_id` and NOT on the
 * link-row `id`: a freshly-added video has no link row yet, and `sequence` is
 * derived from array position at save time, so carrying either would just be a
 * second source of truth waiting to disagree with the array.
 */
type DraftVideo = {
  video_id: number;
  title: string;
  sub_title: string | null;
  /* Carried so the draft row can be previewed before the course is saved —
   * a video added from the catalogue is playable immediately, without a
   * round trip to re-read the content list. */
  video_url: string | null;
};

/*
 * Server-side sort whitelist — must stay in step with SORTABLE_COLUMNS in
 * EasyFix_Backend/services/lms.service.js. A key that is not on the backend's
 * list fails Joi validation and 400s the whole list, so this is one of the few
 * places where a silent drift blanks the page rather than degrading it.
 */
type SortKey = 'id' | 'name' | 'status' | 'video_count' | 'assigned_count' | 'created_at';

/*
 * 'All' is withheld. The list endpoint's own `limit` ceiling isn't something
 * this page can see, and TablePagination's 'All' claims "Showing 1–N of N"
 * whether or not the server actually returned N — a silent lie on any endpoint
 * that caps lower. Course catalogues run to tens of rows, so 50/page is never
 * the thing standing between an operator and the course they want.
 */
const COURSE_PAGE_SIZES: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
];

const NAME_MIN = 2;
const NAME_MAX = 150;
const DESC_MAX = 2000;

/*
 * Joi rejections arrive as ApiError with a generic top-level message
 * ("Validation failed") and the per-field reasons buried in `details`. Showing
 * only `.message` tells the operator something broke but not which field, so
 * flatten `details` onto the toast when it carries anything readable.
 */
function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const d = e.details;
    if (Array.isArray(d) && d.length > 0) {
      const parts = d
        .map((x) => (typeof x === 'string' ? x : (x as { message?: string })?.message))
        .filter((x): x is string => Boolean(x));
      if (parts.length > 0) return `${e.message}: ${parts.join('; ')}`;
    }
    return e.message || fallback;
  }
  return e instanceof Error ? e.message : fallback;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function ManageCoursesPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isLmsManage']);
  const canManage = can.isLmsManage;

  const [search, setSearch] = React.useState('');
  const dq = useDebouncedValue(search, 300);
  const [includeRetired, setIncludeRetired] = React.useState(false);

  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  const limit = pageSizeToLimit(pageSize, 50);

  /*
   * `sortBy` is nullable because cycleSort's third click clears the sort — we
   * then simply omit both params and let the backend fall back to its own
   * default ordering, rather than inventing a client-side "natural" order.
   */
  const [sortBy, setSortBy] = React.useState<SortKey | null>('name');
  const [sortDir, setSortDir] = React.useState<SortDir>('asc');

  const qs = new URLSearchParams();
  if (dq.trim()) qs.set('q', dq.trim());
  if (includeRetired) qs.set('includeInactive', 'true');
  qs.set('limit', String(limit));
  qs.set('offset', String(page * limit));
  if (sortBy) { qs.set('sortBy', sortBy); qs.set('sortDir', sortDir); }

  const listFetch = useFetch<CourseListResp>(`/admin/lms/courses?${qs.toString()}`);

  /*
   * Any filter/sort change re-queries from row 0. Without this, narrowing the
   * search while sitting on page 3 asks for an offset the smaller result set
   * doesn't have, and the table goes empty with no visible cause.
   */
  React.useEffect(() => { setPage(0); }, [dq, includeRetired, sortBy, sortDir]);

  function onSort(col: SortKey) {
    const next = cycleSort<SortKey>(col, { sortBy, sortDir });
    setSortBy(next.sortBy);
    setSortDir(next.sortDir);
  }

  /* `'new'` opens a blank add form; a Course opens it pre-filled for edit.
   * One piece of state for one modal — content used to have its own. */
  const [formCourse, setFormCourse] = React.useState<Course | 'new' | null>(null);

  /*
   * Every mutation path ends here. invalidateFetch only EVICTS the module
   * cache — it has no subscriber mechanism, so a mounted useFetch keeps
   * showing its last render until something re-requests. The explicit
   * refetch() is that something; dropping it is the bug this codebase has
   * shipped repeatedly (stale row survives until a full page reload).
   */
  function refreshCourses() {
    invalidateFetch((k) => k.startsWith('/admin/lms/courses'));
    listFetch.refetch();
  }

  async function handleRetire(c: Course) {
    const ok = await confirm({
      title: 'Retire This Course?',
      description: `"${c.name}" will be hidden from the default list and can no longer be assigned. `
        + `This is a soft retire, not a delete — existing assignments and technician progress are `
        + `preserved, and you can reactivate the course at any time.`,
      confirmLabel: 'Retire',
      variant: 'destructive',
    });
    if (!ok) return;
    const t = showToast({ variant: 'loading', message: 'Retiring course…' });
    try {
      await api.delete(`/admin/lms/courses/${c.id}`);
      dismissToast(t);
      showToast({ variant: 'success', message: 'Course Retired' });
      refreshCourses();
    } catch (e) {
      dismissToast(t);
      showToast({ variant: 'error', message: errText(e, 'Retire failed') });
    }
  }

  async function handleReactivate(c: Course) {
    const t = showToast({ variant: 'loading', message: 'Reactivating course…' });
    try {
      // PATCH takes `status` as a BOOLEAN here (the list read model exposes it
      // as 1/0) — passing 1 would fail the endpoint's Joi boolean().
      await api.patch(`/admin/lms/courses/${c.id}`, { status: true });
      dismissToast(t);
      showToast({ variant: 'success', message: 'Course Reactivated' });
      refreshCourses();
    } catch (e) {
      dismissToast(t);
      showToast({ variant: 'error', message: errText(e, 'Reactivate failed') });
    }
  }

  /*
   * Asked AFTER the save, and only when the flag has just been turned ON.
   *
   * The flag and the back-fill are two decisions with two different blast
   * radii, and the backend keeps them as two calls for exactly that reason:
   * `is_mandatory` only makes assignMandatoryCourses() hand the course to
   * technicians who finish registration from here on, while assignCourseToAll
   * is what reaches the ~2,600 who registered already. So the flag is saved by
   * the time this runs, and declining does not undo it — it declines the
   * back-fill, which is the only part that touches anyone today.
   *
   * Every clause below is anchored in SQL, so do not soften or embellish them:
   *   - "given automatically at registration" — assignMandatoryCourses(),
   *     is_mandatory = 1 AND status = 1, run at Gate 1 finalization.
   *   - "app shows jobs locked" — jobsUnlocked in mobile-registration.service
   *     ANDs trainingComplete, which counts the mandatory video set
   *     (MANDATORY_VIDEO_IDS_SQL), and that set is per-technician: a course's
   *     videos join it only once THAT technician holds the course.
   *     Deliberately not "stops receiving work": the server-side withdrawal of
   *     receiveNewJobs is the OVERDUE overlay, and this back-fill sends no
   *     due_date, so nobody is made overdue by answering yes.
   *   - "active technician" — assignCourseToAll filters efr_status = 1.
   *   - "keeps their existing assignment" — its NOT EXISTS guard skips anyone
   *     who already holds the course, due date and progress untouched.
   *
   * Lives on the PAGE, not in the modal, so the course dialog is closed while
   * the question is on screen — a confirm stacked over the form it came from
   * reads as part of the form, and this is a separate action.
   */
  async function promptAssignAll(c: { id: number; name: string }) {
    const ok = await confirm({
      title: 'Assign To Existing Technicians?',
      description: (
        <span className="space-y-2 block">
          <span className="block">
            <span className="font-medium">&ldquo;{c.name}&rdquo;</span> is now mandatory. That saves one
            thing only: every technician who completes registration from now on is given this course
            automatically, and their app shows jobs locked until they have watched its videos.
            Technicians already registered are not given it and are not held to it.
          </span>
          <span className="block">
            <span className="font-medium">Only Future Registrations</span> — nothing changes for anyone
            already registered. They are not assigned this course, so nothing on their app changes.
          </span>
          <span className="block">
            <span className="font-medium">Assign To All Active Technicians</span> — every active
            technician is given this course now, and each of them then has to watch its videos before
            their app unlocks jobs again. Anyone who already has it keeps their existing assignment, due
            date and progress.
          </span>
        </span>
      ),
      confirmLabel: 'Assign To All Active Technicians',
      cancelLabel: 'Only Future Registrations',
      icon: <Users className="size-5" />,
      iconAccent: 'sky',
    });
    if (!ok) return;
    const t = showToast({ variant: 'loading', message: 'Assigning to active technicians…' });
    try {
      /* No due_date sent — the endpoint accepts an optional one and stores NULL
       * otherwise, which is what a blanket back-fill should be. Per-technician
       * deadlines are set from Assign Training, which owns that decision. */
      const r = await api.post<{ assigned: number }>(`/admin/lms/courses/${c.id}/assign-all`, {});
      dismissToast(t);
      showToast({
        variant: 'success',
        /* 0 is a legitimate answer (idempotent re-run, or everyone already had
         * it) and must not read as a failure. */
        message: r.assigned === 0
          ? 'Every Active Technician Already Had This Course'
          : `Assigned To ${r.assigned.toLocaleString('en-IN')} Technician${r.assigned === 1 ? '' : 's'}`,
      });
      refreshCourses();
    } catch (e) {
      dismissToast(t);
      showToast({ variant: 'error', message: errText(e, 'Assign to all failed') });
    }
  }

  const rows = listFetch.data?.rows ?? [];
  const total = listFetch.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <GraduationCap className="size-6" /> Manage Courses
          </h1>
          <p className="text-sm text-muted-foreground">
            Training courses assigned to technicians — each is an ordered playlist of training videos.
          </p>
        </div>
        {/* Hidden rather than disabled for read-only operators: a permanently
            dead "Add" button just invites clicks that do nothing. */}
        {canManage && (
          <Button onClick={() => setFormCourse('new')}>
            <Plus className="size-4 mr-1" /> Add Course
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by course name or description…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs whitespace-nowrap">
            <input
              type="checkbox"
              checked={includeRetired}
              onChange={(e) => setIncludeRetired(e.target.checked)}
            />
            Include Retired
          </label>
        </CardContent>
      </Card>

      {listFetch.error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {listFetch.error}
          </CardContent>
        </Card>
      )}

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full">
            <thead>
              <tr>
                <SortHeader col="name" align="left" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>
                  Name
                </SortHeader>
                <SortHeader col="video_count" align="right" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>
                  Videos
                </SortHeader>
                <SortHeader col="assigned_count" align="right" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>
                  Assigned
                </SortHeader>
                <SortHeader col="status" align="center" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>
                  Status
                </SortHeader>
                <SortHeader col="created_at" align="left" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>
                  Created
                </SortHeader>
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {listFetch.loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: 6 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-24 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!listFetch.loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="!text-center text-muted-foreground py-8">
                    No courses match the current filters.
                  </td>
                </tr>
              )}
              {!listFetch.loading && rows.map((c) => (
                <tr key={c.id}>
                  <td className="!text-left max-w-[360px]">
                    {/* Mandatory rides on the Name cell rather than taking a
                        column of its own: it is not sortable (SORTABLE_COLUMNS
                        in lms.service.js has no key for it, and an unsupported
                        sortBy 400s the whole list), and the flag only ever
                        reads as a property OF the course.

                        Retired is called out ON the chip, not left to the
                        Status column two cells away. The backend's mandatory
                        set requires status = 1, so a retired course is handed
                        to nobody and holds nobody — a bare "Mandatory" chip
                        here would tell an operator the opposite of what the
                        query does. */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-medium truncate" title={c.name}>{c.name}</span>
                      {c.is_mandatory === 1 && (
                        c.status === 1 ? (
                          <StatusChip
                            tone="warning"
                            size="sm"
                            title="Mandatory — assigned automatically to every technician who completes registration from now on"
                          >
                            Mandatory
                          </StatusChip>
                        ) : (
                          <StatusChip
                            tone="neutral"
                            size="sm"
                            title="Flagged mandatory, but retired — it is assigned to nobody new and holds nobody. Reactivate it to make the flag take effect."
                          >
                            Mandatory · Inactive
                          </StatusChip>
                        )
                      )}
                    </div>
                    {c.description && (
                      <div className="text-xs text-muted-foreground truncate" title={c.description}>
                        {c.description}
                      </div>
                    )}
                  </td>
                  {/* A 0 here is a real defect, not just a small number: the
                      course is assignable but can never be completed. Call it
                      out in-row so it's caught before someone assigns it. */}
                  <td className="!text-right tabular-nums">
                    {c.video_count === 0 ? (
                      <span
                        className="text-warning-strong font-semibold"
                        title="No videos — technicians cannot complete this course"
                      >
                        0
                      </span>
                    ) : c.video_count}
                  </td>
                  <td className="!text-right tabular-nums">{c.assigned_count}</td>
                  <td className="!text-center">
                    <StatusChip tone={c.status === 1 ? 'emerald' : 'slate'}>
                      {c.status === 1 ? 'Active' : 'Retired'}
                    </StatusChip>
                  </td>
                  <td className="!text-left whitespace-nowrap">{formatDate(c.created_at)}</td>
                  <td className="!text-right">
                    <div className="inline-flex items-center justify-end gap-1">
                      {/*
                        One action, not two. Course details and course content
                        used to live in separate dialogs, so this row carried an
                        Edit button and a Manage Content button that opened
                        overlapping views of the same course. They are now one
                        modal, so there is one way in.

                        Shown to viewers as well, read-only. The modal contains
                        the content list with an ungated Play button — a viewer
                        who cannot reach the modal could never use it, and
                        "what is actually in this course" is a fair question for
                        someone reviewing training without editing rights.
                      */}
                      <IconButton
                        icon={canManage ? Pencil : ListVideo}
                        intent={canManage ? 'primary' : 'default'}
                        label={canManage ? 'Edit Course' : 'View Course Content'}
                        onClick={() => setFormCourse(c)}
                      />
                      {/* Retire and Reactivate are mutually exclusive — the
                          row shows whichever transition is actually available
                          rather than a greyed-out pair. */}
                      {canManage && c.status === 1 && (
                        <IconButton
                          icon={Trash2}
                          intent="danger"
                          label="Retire Course"
                          onClick={() => handleRetire(c)}
                        />
                      )}
                      {canManage && c.status !== 1 && (
                        <IconButton
                          icon={RotateCcw}
                          intent="success"
                          label="Reactivate Course"
                          onClick={() => handleReactivate(c)}
                        />
                      )}
                      {!canManage && (
                        <span className="text-xs text-muted-foreground">View Only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="border-t px-3 py-2">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
              pageSizeOptions={COURSE_PAGE_SIZES}
            />
          </div>
        </CardContent>
      </Card>

      {/* Rendered unconditionally with `open` derived from state so its
          open-transition reset effects actually fire. */}
      <CourseModal
        course={formCourse}
        canManage={canManage}
        onClose={() => setFormCourse(null)}
        onSaved={(mandated) => {
          setFormCourse(null);
          refreshCourses();
          // Only present when the save turned the flag ON; the modal passes
          // nothing on a partial save, so a half-written course never prompts.
          if (mandated) void promptAssignAll(mandated);
        }}
      />
    </div>
  );
}

/* ── Course modal (Add / Edit, details + content in one) ────────────────── */

/*
 * ONE modal for a course, not two.
 *
 * Details and content used to be separate dialogs reached by separate row
 * actions, which made "create a usable course" a two-step ritual: add it, find
 * it in the list, open a different dialog, add the videos. A course with no
 * content is assignable but uncompletable, so that second step was the one
 * that actually mattered and the one easiest to forget.
 *
 * ─── Why the save is ordered, and what happens when half of it fails ─────
 *
 * Content is saved through PUT /courses/:id/videos, which needs an id — and on
 * the Add path there is no id until the POST returns. So the save is
 * necessarily two calls, and the interesting case is the POST succeeding and
 * the PUT failing: the course now EXISTS. Reporting that as "create failed"
 * would be a lie that costs the operator real money — they would retry, hit
 * the backend's name-uniqueness check, and get a 409 blaming them for a
 * duplicate they cannot see.
 *
 * `createdIdRef` is what makes the retry honest. Once a create has succeeded
 * in this modal session the id is remembered, so a second Save PATCHes that
 * course instead of POSTing a new one. The modal stays open, the error names
 * exactly which half failed, and pressing Save again resumes rather than
 * duplicates.
 */
function CourseModal({ course, canManage, onClose, onSaved }: {
  course: Course | 'new' | null;
  canManage: boolean;
  onClose: () => void;
  /* Carries the course back ONLY when this save turned `is_mandatory` on, so
   * the page knows to ask about back-filling existing technicians. Absent on
   * every other save, including one that turns the flag off. */
  onSaved: (mandated?: { id: number; name: string }) => void;
}) {
  const open = course !== null;
  const editing = course !== null && course !== 'new' ? course : null;

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [mandatory, setMandatory] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* Content editing state. */
  const [draft, setDraft] = React.useState<DraftVideo[]>([]);
  const [vq, setVq] = React.useState('');
  const [previewing, setPreviewing] = React.useState<DraftVideo | null>(null);

  /*
   * Survives a partial save: set once the POST succeeds so a retry PATCHes the
   * course that now exists rather than creating a second one. Cleared when the
   * modal closes, since the next open is a different course.
   */
  const createdIdRef = React.useRef<number | null>(null);

  /* Existing content — only an edit has any. */
  const videosFetch = useFetch<CourseVideo[]>(
    editing ? `/admin/lms/courses/${editing.id}/videos` : null,
  );

  /* Catalogue for the picker, server-filtered by the typed query. */
  const dvq = useDebouncedValue(vq, 300);
  const catQs = new URLSearchParams();
  if (dvq.trim()) catQs.set('q', dvq.trim());
  catQs.set('limit', '50');
  catQs.set('offset', '0');
  const catFetch = useFetch<CatalogueResp>(
    open && canManage ? `/admin/aux/training-videos?${catQs.toString()}` : null,
  );

  /*
   * Form fields seed on OPEN only, keyed on the course id — deliberately NOT
   * on `videosFetch.data`. Reseeding when the content list arrives would wipe
   * whatever the operator had already typed into Name or Description.
   */
  React.useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setDescription(editing?.description ?? '');
    setMandatory(editing?.is_mandatory === 1);
    setError(null);
  }, [open, editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * Content seeds ONCE per course-open, guarded by a ref rather than by
   * `draft.length === 0` — "the operator removed every video" is a legitimate
   * state, and a length-based guard would immediately re-seed the list they
   * just cleared.
   */
  const seededFor = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!open) {
      seededFor.current = null;
      createdIdRef.current = null;
      setDraft([]);
      setVq('');
      setPreviewing(null);
      return;
    }
    /* Add: nothing to load, start empty. `0` stands in for "the new course". */
    if (!editing) {
      if (seededFor.current !== 0) { seededFor.current = 0; setDraft([]); }
      return;
    }
    if (videosFetch.data && seededFor.current !== editing.id) {
      seededFor.current = editing.id;
      setDraft(videosFetch.data.map((v) => ({
        video_id: v.video_id,
        title: v.title,
        sub_title: v.sub_title,
        video_url: v.video_url,
      })));
    }
  }, [open, editing, videosFetch.data]);

  // Skip the discard prompt while a save is in flight — the modal is closing
  // on its own at that point and the prompt would fire over a completed action.
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  const draftIds = new Set(draft.map((d) => d.video_id));

  /*
   * Already-added videos are filtered OUT of the picker rather than shown
   * disabled: SearchSelect's `pick()` doesn't honour an option's `disabled`
   * flag (only SearchMultiSelect does), so a disabled row would still be
   * selectable and would silently add a duplicate.
   */
  const pickerOptions = (catFetch.data?.rows ?? [])
    .filter((v) => !draftIds.has(v.id))
    .map((v) => ({
      value: v.id,
      label: v.sub_title ? `${v.title} — ${v.sub_title}` : v.title,
    }));

  /*
   * Whether the content PUT is worth making. Compared as a joined id string
   * because ORDER is part of the content — reordering the same videos is a
   * real change the technician sees as a different syllabus, so a set
   * comparison would miss it.
   */
  const serverOrder = (videosFetch.data ?? []).map((v) => v.video_id).join(',');
  const draftOrder = draft.map((d) => d.video_id).join(',');
  const contentDirty = editing ? draftOrder !== serverOrder : draft.length > 0;

  function addVideo(rawId: string) {
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) return;
    const v = catFetch.data?.rows.find((r) => r.id === id);
    if (!v) return;
    if (draftIds.has(id)) return;
    // Appended, not inserted: new content belongs at the end of the syllabus
    // by default, and the operator can move it with the reorder buttons.
    setDraft((d) => [...d, {
      video_id: v.id,
      title: v.title,
      sub_title: v.sub_title,
      video_url: v.video_url,
    }]);
  }

  function removeAt(idx: number) {
    setDraft((d) => d.filter((_, i) => i !== idx));
  }

  function moveAt(idx: number, delta: number) {
    setDraft((d) => {
      const next = idx + delta;
      if (next < 0 || next >= d.length) return d;
      const copy = d.slice();
      [copy[idx], copy[next]] = [copy[next], copy[idx]];
      return copy;
    });
  }

  async function handleSubmit() {
    const trimmedName = name.trim();
    const trimmedDesc = description.trim();
    // Validate client-side first so the common mistakes never cost a round trip
    // — the backend enforces the same bounds and stays the real authority.
    if (trimmedName.length < NAME_MIN || trimmedName.length > NAME_MAX) {
      setError(`Course name must be between ${NAME_MIN} and ${NAME_MAX} characters.`);
      return;
    }
    if (trimmedDesc.length > DESC_MAX) {
      setError(`Description must be ${DESC_MAX} characters or fewer.`);
      return;
    }
    setError(null);
    setSubmitting(true);

    const existingId = editing?.id ?? createdIdRef.current;
    const t = showToast({
      variant: 'loading',
      message: existingId ? 'Saving course…' : 'Creating course…',
    });

    let courseId: number;
    try {
      if (existingId) {
        await api.patch(`/admin/lms/courses/${existingId}`, {
          name: trimmedName,
          description: trimmedDesc,
          // Joi wants a boolean here; the read model hands it back as 1/0.
          is_mandatory: mandatory,
        });
        courseId = existingId;
      } else {
        const created = await api.post<{ id: number }>('/admin/lms/courses', {
          name: trimmedName,
          description: trimmedDesc,
          is_mandatory: mandatory,
        });
        courseId = created.id;
        // Remember it BEFORE the content call, so a failure there leaves a
        // retry that patches rather than duplicates.
        createdIdRef.current = created.id;
      }
    } catch (e) {
      dismissToast(t);
      const msg = errText(e, 'Save failed');
      setError(msg);
      showToast({ variant: 'error', message: msg });
      setSubmitting(false);
      return;
    }

    /*
     * Content is a SECOND call and can fail on its own. The course is already
     * saved by this point, so the failure path says so explicitly, refreshes
     * the list (the course is really there), and leaves the modal open so
     * pressing Save again resumes from the content step.
     */
    if (contentDirty) {
      try {
        // The PUT REPLACES the whole content list, so array order here is the
        // sequence the technician sees. An empty array is a valid payload — it
        // clears the course — which is why there's no "must have >= 1" guard.
        await api.put(`/admin/lms/courses/${courseId}/videos`, {
          video_ids: draft.map((d) => d.video_id),
        });
      } catch (e) {
        dismissToast(t);
        const msg = errText(e, 'Content could not be saved');
        setError(
          `The course was ${editing ? 'updated' : 'created'}, but its content could not be saved: `
          + `${msg} Press Save again to retry — this will not create a duplicate.`,
        );
        showToast({ variant: 'error', message: `Course Saved, Content Failed — ${msg}` });
        invalidateFetch((k) => k.startsWith('/admin/lms/courses'));
        onSaved();
        setSubmitting(false);
        return;
      }
    }

    dismissToast(t);
    showToast({
      variant: 'success',
      message: editing || createdIdRef.current ? 'Course Saved' : 'Course Created',
    });
    // The videos key lives under the same prefix, so this eviction covers both
    // the list row counts and this modal's own content fetch.
    invalidateFetch((k) => k.startsWith('/admin/lms/courses'));
    /*
     * Only a transition OFF→ON asks about existing technicians. Re-saving a
     * course that was already mandatory is not a new decision, and asking
     * again would train operators to dismiss the prompt without reading it.
     * A create counts as a transition — there was no previous state.
     */
    onSaved(mandatory && editing?.is_mandatory !== 1 ? { id: courseId, name: trimmedName } : undefined);
    setSubmitting(false);
  }

  const title = !editing
    ? 'Add Course'
    : canManage
      ? `Edit Course — ${editing.name}`
      : `Course — ${editing.name}`;

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 max-h-[75vh] overflow-y-auto pr-1">
          <div>
            <Label className="block mb-1" required>Course Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX}
              disabled={!canManage}
              placeholder='e.g. "Treadmill Servicing Basics"'
            />
          </div>

          <div>
            <Label className="block mb-1">Description</Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={DESC_MAX}
              rows={3}
              disabled={!canManage}
              placeholder="What this course covers and who should take it (optional)"
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus-visible:border-foreground/40 disabled:opacity-60"
            />
            <div className="mt-1 text-xs text-muted-foreground text-right tabular-nums">
              {description.length} / {DESC_MAX}
            </div>
          </div>

          {/*
            Mandatory is not a second status, and it is not retroactive. It
            decides one thing: that a technician finishing registration from
            now on is AUTO-ASSIGNED this course, and is then held to it (their
            videos join the set the app's jobs-unlocked check counts). Nobody
            already registered is touched by ticking it — that is a separate
            back-fill, which is why saving it on raises the "assign to existing
            technicians too?" prompt instead of implying either answer.

            No `label` prop on the Checkbox: that renders aria-label, which
            REPLACES the accessible name, so the wrapping <label> below —
            including the sentence explaining what the flag does — would be
            dropped from what a screen reader announces. The primitive asks for
            it only when there is no visible label beside it.
          */}
          <label className="flex items-start gap-2">
            <Checkbox
              checked={mandatory}
              disabled={!canManage}
              onChange={setMandatory}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Mandatory Course</span>
              <span className="block text-xs text-muted-foreground">
                Technicians who complete registration from now on are given this course automatically and
                must watch its videos before their app unlocks jobs. Technicians already registered are
                not affected unless you assign it to them.
              </span>
            </span>
          </label>

          {/*
            Content sits directly under Description, in the same modal and the
            same save. Adding a course and giving it a syllabus is one intent;
            splitting it across two dialogs is what let empty courses ship.
          */}
          <div className="border-t pt-3">
            {canManage && (
              <div className="mb-2">
                <Label className="block mb-1">Add Video</Label>
                {/*
                  `value` is pinned to '' so the control behaves as an "add"
                  action rather than a selection: pick a video, it lands in the
                  list below, and the picker resets for the next one.
                */}
                <SearchSelect
                  value=""
                  onChange={addVideo}
                  onQueryChange={setVq}
                  options={pickerOptions}
                  placeholder="Search The Training Video Catalogue…"
                  emptyText={catFetch.loading ? 'Loading…' : 'No Matching Videos'}
                />
              </div>
            )}

            <Label className="block mb-1">Course Content ({draft.length})</Label>
            <div className="rounded-md border divide-y max-h-[32vh] overflow-y-auto">
              {editing && videosFetch.loading && (
                <div className="p-4 text-sm text-muted-foreground">Loading…</div>
              )}
              {!(editing && videosFetch.loading) && draft.length === 0 && (
                /*
                 * Not a neutral blank slate on purpose. An empty course is
                 * assignable but uncompletable — a technician who opens it has
                 * nothing to watch and can never reach 100% — so the empty
                 * state states the consequence rather than just the fact.
                 */
                <div className="p-6 text-center">
                  <div className="text-sm font-semibold">No Videos Added Yet</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    A course with no content can never be completed by a technician —
                    it will show up as assigned and stay stuck at 0% forever.
                    Add at least one video before assigning this course.
                  </div>
                </div>
              )}
              {!(editing && videosFetch.loading) && draft.map((v, idx) => (
                <div key={v.video_id} className="flex items-center gap-2 px-3 py-2">
                  {/* Position is derived from array order, so it renumbers
                      itself on every move/remove — no stale sequence values. */}
                  <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {idx + 1}.
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate" title={v.title}>{v.title}</div>
                    {v.sub_title && (
                      <div className="text-xs text-muted-foreground truncate" title={v.sub_title}>
                        {v.sub_title}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {/*
                      Play sits OUTSIDE the canManage gate — watching is a read,
                      and someone reviewing a syllabus they cannot edit still
                      needs to see what is in it. Disabled with the reason in the
                      label when the catalogue entry has no video attached, which
                      is worth noticing here: an unplayable entry can never be
                      completed, so it caps the whole course at incomplete for
                      every technician assigned to it.
                    */}
                    <IconButton
                      icon={Play}
                      label={v.video_url ? 'Play Video' : 'No Video Linked'}
                      disabled={!v.video_url}
                      onClick={() => setPreviewing(v)}
                    />
                    {canManage && (
                      <>
                        <IconButton
                          icon={ChevronUp}
                          label="Move Up"
                          disabled={idx === 0}
                          onClick={() => moveAt(idx, -1)}
                        />
                        <IconButton
                          icon={ChevronDown}
                          label="Move Down"
                          disabled={idx === draft.length - 1}
                          onClick={() => moveAt(idx, 1)}
                        />
                        <IconButton
                          icon={X}
                          intent="danger"
                          label="Remove Video"
                          onClick={() => removeAt(idx)}
                        />
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {(error || videosFetch.error) && (
            <div className="text-sm text-urgent flex items-start gap-1">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" /> {error ?? videosFetch.error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            {canManage && (
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saving…' : editing ? 'Save Changes' : 'Add Course'}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>

      {/*
        Rendered as a SIBLING of DialogContent, not inside it. Nested, the
        player would be a descendant of the course modal — closing the outer
        one would tear it down mid-playback, and the two would contend over
        focus restoration on close. As a sibling it layers cleanly on top and
        owns its own lifecycle.

        Mounted only while a row is selected: unmounting is what actually stops
        playback, since a hidden-but-mounted iframe keeps playing audio.
      */}
      {previewing && (
        <VideoPreviewDialog
          open
          onClose={() => setPreviewing(null)}
          title={previewing.title}
          url={previewing.video_url}
        />
      )}
    </Dialog>
  );
}
