'use client';

/*
 * Manage Courses — LMS.
 *
 * A course is a named, ordered list of CONTENT ITEMS that gets assigned to
 * technicians. Two surfaces live here:
 *
 *   1. the course master (search / add / edit / retire / reactivate), and
 *   2. the CONTENT editor — the ordered item list behind a course.
 *
 * ─── Content is three kinds now, not one (2026-08-26) ───────────────────
 *
 * Until the lms_content migration a course WAS a video playlist: course_videos
 * held (course_id, video_id, sequence) and the editor below sent `video_ids`.
 * An item can now be a video, a document (PPT/PDF) or an assessment (MCQ), and
 * `lms_content` owns the ordering for all three — one list, one sequence.
 * Completion is derived per kind and never stored twice:
 *
 *   video      — easyfixer_watched_video.watched_percentage = 100
 *   document   — a row in lms_document_ack for that CONTENT id
 *   assessment — a passing row in lms_assessment_attempt
 *
 * The catalogues the picker reads from are the three tabs of LMS ▸ Content.
 *
 * The content editor matters more than it looks. A course with zero items is
 * assignable but *uncompletable*: the technician opens it, finds nothing to
 * do, and their progress can never reach 100%. The editor's empty state says
 * so explicitly rather than rendering a polite blank panel.
 *
 * Retire is a SOFT delete (DELETE sets status 0). Existing assignments and
 * progress rows survive it, which is why the confirm copy says "retire" and
 * offers reactivation instead of warning about data loss.
 *
 * Backend: /admin/lms/courses (+ /:id/content), /admin/lms/documents,
 * /admin/lms/assessments and /admin/aux/training-videos.
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
import { Select } from '@/components/ui/select';
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
  /* Misnamed on the wire and kept that way: it counts CONTENT ITEMS of all
   * three kinds, not videos. See the "Content" header below. */
  video_count: number;
  assigned_count: number;
};
type CourseListResp = { rows: Course[]; total: number; limit: number; offset: number };

/*
 * The three kinds an item can be. Matches the lms_content.kind ENUM exactly —
 * the PUT sends these strings verbatim, so a typo here is a 400 rather than a
 * silently wrong row.
 */
type ContentKind = 'video' | 'document' | 'assessment';

/* A row of the course's content list as GET /courses/:id/content returns it. */
type CourseContentItem = {
  id: number;               // lms_content row id — NOT what the PUT wants
  kind: ContentKind;
  ref_id: number;           // training_videos.id / lms_document.id / lms_assessment.id
  sequence: number;
  title: string;
  /* Kind-specific extras. Optional because each is present for exactly one
   * kind, and the editor must render a row it does not recognise rather than
   * crash on a missing field. */
  sub_title?: string | null;
  /* video only — playable link, already repaired by the backend. Null when the
   * catalogue entry has no video attached, which is worth seeing HERE: such a
   * video can never be completed and so caps the whole course. */
  video_url?: string | null;
};

/*
 * One loose row type for all three catalogue endpoints. Every field beyond
 * id/title is optional and belongs to exactly one endpoint:
 *   /admin/aux/training-videos → sub_title, video_url
 *   /admin/lms/documents       → (title is enough for the picker)
 *   /admin/lms/assessments     → question_count
 * Written as one type rather than three because the picker consumes them
 * identically — it needs a label and an id.
 */
type CatalogueRow = {
  id: number;
  title: string;
  sub_title?: string | null;
  video_url?: string | null;
  question_count?: number;
};
type CatalogueResp = { rows: CatalogueRow[]; total: number; limit: number; offset: number };

/*
 * The editor's working copy. Deliberately keyed on (kind, ref_id) and NOT on
 * the lms_content row `id`: a freshly-added item has no content row yet, and
 * `sequence` is derived from array position at save time, so carrying either
 * would just be a second source of truth waiting to disagree with the array.
 * (kind, ref_id) is also the DB's own uniqueness rule — uq_lms_content_item.
 */
type DraftItem = {
  kind: ContentKind;
  ref_id: number;
  title: string;
  sub_title?: string | null;
  /* Carried so a video row can be previewed before the course is saved — a
   * video added from the catalogue is playable immediately, without a round
   * trip to re-read the content list. */
  video_url?: string | null;
};

/* Stable identity for a draft row: the DB's own uniqueness key. A video and a
 * document can share a numeric id, so ref_id alone would collide. */
const itemKey = (i: { kind: ContentKind; ref_id: number }) => `${i.kind}:${i.ref_id}`;

const KIND_LABEL: Record<ContentKind, string> = {
  video: 'Video',
  document: 'Document',
  assessment: 'Assessment',
};

/* Which catalogue the picker reads for each kind. */
const KIND_ENDPOINT: Record<ContentKind, string> = {
  video: '/admin/aux/training-videos',
  document: '/admin/lms/documents',
  assessment: '/admin/lms/assessments',
};

const KIND_TONE: Record<ContentKind, 'info' | 'gold' | 'success'> = {
  video: 'info',
  document: 'gold',
  assessment: 'success',
};

/*
 * How a catalogue row reads in the picker. Each kind gets the one extra fact
 * that distinguishes two similarly-named entries:
 *   video      — its sub-title, which is what the app shows under the title
 *   assessment — how many questions it has, because a 0-question assessment
 *                is unpassable and would quietly cap the whole course
 *   document   — nothing; the title is the document
 */
function catalogueLabel(kind: ContentKind, row: CatalogueRow): string {
  if (kind === 'video' && row.sub_title) return `${row.title} — ${row.sub_title}`;
  if (kind === 'assessment' && typeof row.question_count === 'number') {
    return `${row.title} — ${row.question_count} question${row.question_count === 1 ? '' : 's'}`;
  }
  return row.title;
}

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
  /*
   * Server-side, not a client filter over the fetched page: this list is
   * paginated, so filtering locally would only narrow the rows that happen to
   * be on screen and report a total for a different set.
   */
  const [mandatoryOnly, setMandatoryOnly] = React.useState(false);

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
  if (mandatoryOnly) qs.set('mandatoryOnly', 'true');
  qs.set('limit', String(limit));
  qs.set('offset', String(page * limit));
  if (sortBy) { qs.set('sortBy', sortBy); qs.set('sortDir', sortDir); }

  const listFetch = useFetch<CourseListResp>(`/admin/lms/courses?${qs.toString()}`);

  /*
   * Any filter/sort change re-queries from row 0. Without this, narrowing the
   * search while sitting on page 3 asks for an offset the smaller result set
   * doesn't have, and the table goes empty with no visible cause.
   */
  React.useEffect(() => { setPage(0); }, [dq, includeRetired, mandatoryOnly, sortBy, sortDir]);

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
      const r = await api.post<{
        requested: number;
        assigned: number;
        alreadyAssigned: number;
        alreadyComplete: number;
      }>(`/admin/lms/courses/${c.id}/assign-all`, {});
      dismissToast(t);
      const n = (v: number) => v.toLocaleString('en-IN');
      /*
       * assigned = 0 has two very different meanings and the endpoint used to
       * return only that number, so this had to guess. With alreadyAssigned we
       * can say which it was: everyone already held the course, or there was
       * nobody active to give it to — the second is a real problem worth
       * seeing, and it used to read as success.
       *
       * alreadyComplete is called out separately because it is the reassuring
       * half: those technicians are not newly blocked from work, they had
       * already watched this content and were stamped complete on the spot.
       */
      let message: string;
      if (r.assigned === 0 && r.requested === 0) {
        message = 'No Active Technicians To Assign';
      } else if (r.assigned === 0) {
        message = 'Every Active Technician Already Had This Course';
      } else {
        message = `Assigned To ${n(r.assigned)} Technician${r.assigned === 1 ? '' : 's'}`;
        if (r.alreadyAssigned > 0) message += ` · ${n(r.alreadyAssigned)} Already Had It`;
        if (r.alreadyComplete > 0) message += ` · ${n(r.alreadyComplete)} Already Complete`;
      }
      showToast({
        variant: r.assigned === 0 && r.requested === 0 ? 'error' : 'success',
        message,
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
          {/*
            Answers "what is every technician held to?" directly. Without it
            that question needs a page-by-page scan for chips, and getting it
            wrong is expensive in both directions — a course nobody realised
            was mandatory, or one everybody assumed was.
          */}
          <label className="flex items-center gap-1.5 text-xs whitespace-nowrap">
            <input
              type="checkbox"
              checked={mandatoryOnly}
              onChange={(e) => setMandatoryOnly(e.target.checked)}
            />
            Mandatory Only
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
                {/*
                  Labelled "Content", sorted by `video_count`. The alias is a
                  fossil: the backend subquery behind it counts EVERY row of
                  lms_content — video, document and assessment alike — and the
                  backend keeps the old name because it is also the sort key on
                  the wire. The header says what the number is; the sort key
                  says what the API calls it. Renaming the key is a
                  backend-and-client change for a cosmetic gain.
                */}
                <SortHeader col="video_count" align="right" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>
                  Content
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
                  {/* Counts all three kinds, so a 0 still means exactly what
                      it always did: the course is assignable and can never be
                      completed. Called out in-row so it is caught before
                      someone assigns it. A PPT-only course counts its PPTs and
                      is not flagged. */}
                  <td className="!text-right tabular-nums">
                    {c.video_count === 0 ? (
                      <span
                        className="text-warning-strong font-semibold"
                        title="No content — technicians cannot complete this course"
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
        /* Close refreshes too, not just save: a half-failed save leaves the
           modal open on purpose (see CourseModal), and the course it already
           created has to appear in the list when the operator gives up and
           closes it. */
        onClose={() => { setFormCourse(null); refreshCourses(); }}
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

  const confirm = useConfirm();

  /* Content editing state. `addKind` drives which catalogue the picker below
   * reads, so it is part of the fetch key rather than a filter applied after. */
  const [draft, setDraft] = React.useState<DraftItem[]>([]);
  const [addKind, setAddKind] = React.useState<ContentKind>('video');
  const [vq, setVq] = React.useState('');
  const [previewing, setPreviewing] = React.useState<DraftItem | null>(null);

  /*
   * Survives a partial save: set once the POST succeeds so a retry PATCHes the
   * course that now exists rather than creating a second one. Cleared when the
   * modal closes, since the next open is a different course.
   */
  const createdIdRef = React.useRef<number | null>(null);

  /* Existing content — only an edit has any. All three kinds arrive in one
   * ordered list; /videos still exists for compatibility but returns only part
   * of the course, so this screen must not use it. */
  const contentFetch = useFetch<CourseContentItem[]>(
    editing ? `/admin/lms/courses/${editing.id}/content` : null,
  );

  /* Catalogue for the picker, server-filtered by the typed query. The KIND is
   * part of the key, so flipping it re-fires the fetch on its own — no manual
   * orchestration effect. */
  const dvq = useDebouncedValue(vq, 300);
  const catQs = new URLSearchParams();
  if (dvq.trim()) catQs.set('q', dvq.trim());
  catQs.set('limit', '50');
  catQs.set('offset', '0');
  const catFetch = useFetch<CatalogueResp>(
    open && canManage ? `${KIND_ENDPOINT[addKind]}?${catQs.toString()}` : null,
  );

  /*
   * Form fields seed on OPEN only, keyed on the course id — deliberately NOT
   * on `contentFetch.data`. Reseeding when the content list arrives would wipe
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
      setAddKind('video');
      setVq('');
      setPreviewing(null);
      return;
    }
    /* Add: nothing to load, start empty. `0` stands in for "the new course". */
    if (!editing) {
      if (seededFor.current !== 0) { seededFor.current = 0; setDraft([]); }
      return;
    }
    if (contentFetch.data && seededFor.current !== editing.id) {
      seededFor.current = editing.id;
      setDraft(contentFetch.data.map((c) => ({
        kind: c.kind,
        ref_id: c.ref_id,
        title: c.title,
        sub_title: c.sub_title ?? null,
        video_url: c.video_url ?? null,
      })));
    }
  }, [open, editing, contentFetch.data]);

  // Skip the discard prompt while a save is in flight — the modal is closing
  // on its own at that point and the prompt would fire over a completed action.
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  /* Keyed on kind+ref_id, not ref_id: a video and a document can share a
   * numeric id, and dropping the kind would hide one behind the other. */
  const draftKeys = new Set(draft.map(itemKey));

  /*
   * Already-added items are filtered OUT of the picker rather than shown
   * disabled: SearchSelect's `pick()` doesn't honour an option's `disabled`
   * flag (only SearchMultiSelect does), so a disabled row would still be
   * selectable and would silently add a duplicate.
   */
  const pickerOptions = (catFetch.data?.rows ?? [])
    .filter((v) => !draftKeys.has(itemKey({ kind: addKind, ref_id: v.id })))
    .map((v) => ({
      value: v.id,
      label: catalogueLabel(addKind, v),
    }));

  /*
   * Whether the content PUT is worth making. Compared as a joined kind:id
   * string because ORDER is part of the content — reordering the same items is
   * a real change the technician sees as a different syllabus, so a set
   * comparison would miss it. The kind is in the key for the same reason it is
   * in the uniqueness rule: swapping video 7 for document 7 is a real edit.
   */
  const serverKeys = new Set((contentFetch.data ?? []).map(itemKey));
  const serverOrder = (contentFetch.data ?? []).map(itemKey).join(',');
  const draftOrder = draft.map(itemKey).join(',');
  const contentDirty = editing ? draftOrder !== serverOrder : draft.length > 0;

  /*
   * Non-video items this save would ADD. Items already on the course are
   * excluded on purpose: prompting on every reorder of a course that has long
   * had a PPT is how a warning becomes something operators click through
   * without reading, and this is the one prompt on the screen that must not
   * become that.
   */
  const addedNonVideo = draft.filter((d) => d.kind !== 'video' && !serverKeys.has(itemKey(d)));

  function addItem(rawId: string) {
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) return;
    const v = catFetch.data?.rows.find((r) => r.id === id);
    if (!v) return;
    const item: DraftItem = {
      kind: addKind,
      ref_id: v.id,
      title: v.title,
      sub_title: v.sub_title ?? null,
      video_url: v.video_url ?? null,
    };
    if (draftKeys.has(itemKey(item))) return;
    // Appended, not inserted: new content belongs at the end of the syllabus
    // by default, and the operator can move it with the reorder buttons.
    setDraft((d) => [...d, item]);
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

    /*
     * The last stop before non-video content reaches an assigned course.
     * The banner above states the problem; this states it at the moment it
     * becomes true and makes the operator say yes to it. Asked BEFORE the
     * POST/PATCH so backing out leaves nothing half-written.
     */
    if (addedNonVideo.length > 0) {
      const what = addedNonVideo.length === 1
        ? `"${addedNonVideo[0].title}" (${KIND_LABEL[addedNonVideo[0].kind].toLowerCase()})`
        : `${addedNonVideo.length} items that are not videos`;
      const ok = await confirm({
        title: 'Field Technicians Cannot Open This Yet',
        description:
          `You are adding ${what} to "${trimmedName}". Every technician in the field is still on `
          + 'the old app, which plays videos and has no screen for documents or assessments. They '
          + 'will not see this item — and because a course is complete only when every item is, '
          + 'this course becomes impossible to finish for everyone it is assigned to. '
          + 'Safe on a course nobody holds yet; not safe on one already assigned.',
        confirmLabel: 'Add Anyway',
        cancelLabel: 'Go Back',
        variant: 'destructive',
      });
      if (!ok) return;
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
        // The PUT REPLACES the whole content list — ALL kinds, not just one —
        // so array order here is the sequence the technician sees. An empty
        // array is a valid payload (it clears the course), which is why
        // there's no "must have >= 1" guard.
        //
        // /videos is deliberately NOT used even for a video-only course: it
        // replaces only the video items and leaves documents and assessments
        // in place, so a course whose last document the operator just removed
        // would keep it.
        await api.put(`/admin/lms/courses/${courseId}/content`, {
          items: draft.map((d) => ({ kind: d.kind, ref_id: d.ref_id })),
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
        /* NOT onSaved(): that closes the modal, and closing it takes the
         * message above — and the content draft the retry needs — with it.
         * The list still learns about the new course, because the parent
         * refreshes on close as well as on save. */
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
                <Label className="block mb-1">Add Content</Label>
                {/*
                  Kind first, then the catalogue for that kind. Two controls
                  rather than one merged list of everything: the three
                  catalogues are separately paginated and separately searched
                  server-side, so a single list could only ever show the first
                  50 of each and would make "find that PPT" a scroll.
                */}
                <div className="flex items-center gap-2">
                  <Select
                    className="w-40 shrink-0"
                    value={addKind}
                    onChange={(e) => { setAddKind(e.target.value as ContentKind); setVq(''); }}
                    options={(Object.keys(KIND_LABEL) as ContentKind[]).map((k) => ({
                      value: k,
                      label: KIND_LABEL[k],
                    }))}
                  />
                  {/*
                    `value` is pinned to '' so the control behaves as an "add"
                    action rather than a selection: pick an item, it lands in
                    the list below, and the picker resets for the next one.
                  */}
                  <div className="flex-1 min-w-0">
                    <SearchSelect
                      value=""
                      onChange={addItem}
                      onQueryChange={setVq}
                      options={pickerOptions}
                      placeholder={`Search The ${KIND_LABEL[addKind]} Catalogue…`}
                      emptyText={catFetch.loading ? 'Loading…' : `No Matching ${KIND_LABEL[addKind]}s`}
                    />
                  </div>
                </div>
              </div>
            )}

            {/*
              THE LEGACY-FLEET WARNING. Not decoration, and not gated on
              canManage — a reviewer needs to see it too.

              Every technician in the field is on the old Flutter app, which
              calls the video endpoints only: it has no screen for a document
              and none for an assessment. An item of either kind is therefore
              invisible to the whole live fleet, and since completion needs
              EVERY item, one PPT on an assigned course pins it below 100% for
              everyone holding it — which, with mandatory courses gating work,
              eventually takes them off jobs.

              Shown whenever the danger is present (the draft already holds a
              non-video item) OR is about to be (the picker is pointed at a
              non-video catalogue), so it is on screen before the pick, not
              only after. The save also confirms — see handleSubmit.
            */}
            {(addKind !== 'video' || draft.some((d) => d.kind !== 'video')) && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-urgent/30 bg-urgent-tint p-2 text-xs text-urgent-strong">
                <AlertTriangle className="size-4 shrink-0 mt-px" />
                <span>
                  <strong>Technicians in the field cannot open documents or assessments yet.</strong>{' '}
                  They are all still on the old app, which plays videos and nothing else. A document
                  or an assessment on this course is invisible to them, and because a course is only
                  complete when every item is, adding one makes this course impossible to finish for
                  every technician it is assigned to. Add non-video content only to courses that are
                  not assigned yet.
                </span>
              </div>
            )}

            <Label className="block mb-1">Course Content ({draft.length})</Label>
            <div className="rounded-md border divide-y max-h-[32vh] overflow-y-auto">
              {editing && contentFetch.loading && (
                <div className="p-4 text-sm text-muted-foreground">Loading…</div>
              )}
              {!(editing && contentFetch.loading) && draft.length === 0 && (
                /*
                 * Not a neutral blank slate on purpose. An empty course is
                 * assignable but uncompletable — a technician who opens it has
                 * nothing to do and can never reach 100% — so the empty state
                 * states the consequence rather than just the fact.
                 */
                <div className="p-6 text-center">
                  <div className="text-sm font-semibold">No Content Added Yet</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    A course with no content can never be completed by a technician —
                    it will show up as assigned and stay stuck at 0% forever.
                    Add at least one video, document or assessment before assigning this course.
                  </div>
                </div>
              )}
              {!(editing && contentFetch.loading) && draft.map((v, idx) => (
                <div key={itemKey(v)} className="flex items-center gap-2 px-3 py-2">
                  {/* Position is derived from array order, so it renumbers
                      itself on every move/remove — no stale sequence values. */}
                  <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {idx + 1}.
                  </span>
                  {/* The kind is the first thing to read on the row: the three
                      complete in completely different ways (watched / read /
                      passed), so "what is this item" governs everything an
                      operator infers from the rest of the line. */}
                  <StatusChip tone={KIND_TONE[v.kind]} size="sm" className="shrink-0">
                    {KIND_LABEL[v.kind]}
                  </StatusChip>
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
                      needs to see what is in it. Rendered only for videos:
                      documents open from the Documents tab, and an assessment
                      has nothing to play. Disabled with the reason in the label
                      when the catalogue entry has no video attached, which is
                      worth noticing here: an unplayable entry can never be
                      completed, so it caps the whole course at incomplete for
                      every technician assigned to it.
                    */}
                    {v.kind === 'video' && (
                      <IconButton
                        icon={Play}
                        label={v.video_url ? 'Play Video' : 'No Video Linked'}
                        disabled={!v.video_url}
                        onClick={() => setPreviewing(v)}
                      />
                    )}
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
                          label={`Remove ${KIND_LABEL[v.kind]}`}
                          onClick={() => removeAt(idx)}
                        />
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {(error || contentFetch.error) && (
            <div className="text-sm text-urgent flex items-start gap-1">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" /> {error ?? contentFetch.error}
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
          /* `?? null` because video_url is optional on DraftItem — only the
             video kind carries one, and the dialog's contract is "a url or
             explicitly none", not "possibly absent". */
          url={previewing.video_url ?? null}
        />
      )}
    </Dialog>
  );
}
