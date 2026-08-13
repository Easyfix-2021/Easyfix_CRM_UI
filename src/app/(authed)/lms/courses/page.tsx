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
  ChevronUp, ChevronDown, X, AlertTriangle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
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

/* ── Types ──────────────────────────────────────────────────────────────── */

type Course = {
  id: number;
  name: string;
  description: string | null;
  status: number;            // 1 = Active, 0 = Retired
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
};

/* A row of the training-video catalogue (`id` here IS the video_id). */
type CatalogueVideo = {
  id: number;
  title: string;
  sub_title: string | null;
  description: string | null;
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

  /* `'new'` opens a blank add form; a Course opens it pre-filled for edit. */
  const [formCourse, setFormCourse] = React.useState<Course | 'new' | null>(null);
  const [contentCourse, setContentCourse] = React.useState<Course | null>(null);

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

  const rows = listFetch.data?.rows ?? [];
  const total = listFetch.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
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
          <CardContent className="p-3 flex items-center gap-2 text-sm text-red-600">
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
                    <div className="font-medium truncate" title={c.name}>{c.name}</div>
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
                        className="text-amber-700 font-semibold"
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
                      {canManage && (
                        <IconButton
                          icon={Pencil}
                          intent="primary"
                          label="Edit Course"
                          onClick={() => setFormCourse(c)}
                        />
                      )}
                      {canManage && (
                        <IconButton
                          icon={ListVideo}
                          intent="default"
                          label="Manage Content"
                          onClick={() => setContentCourse(c)}
                        />
                      )}
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
                        <span className="text-[10px] text-muted-foreground">View Only</span>
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

      {/* Both dialogs are rendered unconditionally with `open` derived from
          state so their open-transition reset effects actually fire. */}
      <CourseFormDialog
        course={formCourse}
        onClose={() => setFormCourse(null)}
        onSaved={() => { setFormCourse(null); refreshCourses(); }}
      />
      <ManageContentDialog
        course={contentCourse}
        canManage={canManage}
        onClose={() => setContentCourse(null)}
        onSaved={() => { setContentCourse(null); refreshCourses(); }}
      />
    </div>
  );
}

/* ── Add / Edit dialog ──────────────────────────────────────────────────── */

function CourseFormDialog({ course, onClose, onSaved }: {
  course: Course | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const open = course !== null;
  const editing = course !== null && course !== 'new' ? course : null;

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Skip the discard prompt while a save is in flight — the modal is closing
  // on its own at that point and the prompt would fire over a completed action.
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  React.useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setDescription(editing?.description ?? '');
    setError(null);
    // `editing?.id` rather than the object: the row identity changes on every
    // list refetch, and reseeding mid-edit would wipe what the operator typed.
  }, [open, editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const t = showToast({ variant: 'loading', message: editing ? 'Saving course…' : 'Creating course…' });
    try {
      if (editing) {
        await api.patch(`/admin/lms/courses/${editing.id}`, {
          name: trimmedName,
          description: trimmedDesc,
        });
      } else {
        await api.post('/admin/lms/courses', {
          name: trimmedName,
          description: trimmedDesc,
        });
      }
      dismissToast(t);
      showToast({ variant: 'success', message: editing ? 'Course Updated' : 'Course Created' });
      onSaved();
    } catch (e) {
      dismissToast(t);
      const msg = errText(e, 'Save failed');
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit Course' : 'Add Course'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="block mb-1" required>Course Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX}
              placeholder='e.g. "Treadmill Servicing Basics"'
            />
          </div>
          <div>
            <Label className="block mb-1">Description</Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={DESC_MAX}
              rows={4}
              placeholder="What this course covers and who should take it (optional)"
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus-visible:border-foreground/40"
            />
            <div className="mt-1 text-[11px] text-muted-foreground text-right tabular-nums">
              {description.length} / {DESC_MAX}
            </div>
          </div>
          {error && (
            <div className="text-sm text-red-600 flex items-start gap-1">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" /> {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : editing ? 'Save Changes' : 'Add Course'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Manage Content dialog ──────────────────────────────────────────────── */

function ManageContentDialog({ course, canManage, onClose, onSaved }: {
  course: Course | null;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const open = course !== null;

  const videosFetch = useFetch<CourseVideo[]>(
    course ? `/admin/lms/courses/${course.id}/videos` : null,
  );

  /* Catalogue for the picker, server-filtered by the typed query. */
  const [vq, setVq] = React.useState('');
  const dvq = useDebouncedValue(vq, 300);
  const catQs = new URLSearchParams();
  if (dvq.trim()) catQs.set('q', dvq.trim());
  catQs.set('limit', '50');
  catQs.set('offset', '0');
  const catFetch = useFetch<CatalogueResp>(
    open ? `/admin/aux/training-videos?${catQs.toString()}` : null,
  );

  const [draft, setDraft] = React.useState<DraftVideo[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /*
   * Seed the working copy from the server list ONCE per course-open. Guarded
   * by a ref rather than by `draft.length === 0`, because "the operator removed
   * every video" is a legitimate state that must survive — a length-based guard
   * would immediately re-seed the list they just cleared.
   */
  const seededFor = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!open) {
      seededFor.current = null;
      setDraft([]);
      setError(null);
      setVq('');
      return;
    }
    if (course && videosFetch.data && seededFor.current !== course.id) {
      seededFor.current = course.id;
      setDraft(videosFetch.data.map((v) => ({
        video_id: v.video_id,
        title: v.title,
        sub_title: v.sub_title,
      })));
    }
  }, [open, course, videosFetch.data]);

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !saving });

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

  function addVideo(rawId: string) {
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) return;
    const v = catFetch.data?.rows.find((r) => r.id === id);
    if (!v) return;
    if (draftIds.has(id)) return;
    // Appended, not inserted: new content belongs at the end of the syllabus
    // by default, and the operator can move it with the reorder buttons.
    setDraft((d) => [...d, { video_id: v.id, title: v.title, sub_title: v.sub_title }]);
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

  async function handleSave() {
    if (!course) return;
    setError(null);
    setSaving(true);
    const t = showToast({ variant: 'loading', message: 'Saving course content…' });
    try {
      // The PUT REPLACES the whole content list, so array order here is the
      // sequence the technician sees. An empty array is a valid payload — it
      // clears the course — which is why there's no "must have ≥1" guard.
      await api.put(`/admin/lms/courses/${course.id}/videos`, {
        video_ids: draft.map((d) => d.video_id),
      });
      dismissToast(t);
      showToast({ variant: 'success', message: 'Course Content Saved' });
      // The videos key lives under the same prefix, so this eviction covers
      // both the list row counts and this dialog's own content fetch.
      invalidateFetch((k) => k.startsWith('/admin/lms/courses'));
      videosFetch.refetch();
      onSaved();
    } catch (e) {
      dismissToast(t);
      const msg = errText(e, 'Save failed');
      setError(msg);
      showToast({ variant: 'error', message: msg });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Manage Content{course ? ` — ${course.name}` : ''}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {canManage && (
            <div>
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

          <div>
            <Label className="block mb-1">Course Content ({draft.length})</Label>
            <div className="rounded-md border divide-y max-h-[45vh] overflow-y-auto">
              {videosFetch.loading && (
                <div className="p-4 text-sm text-muted-foreground">Loading…</div>
              )}
              {!videosFetch.loading && draft.length === 0 && (
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
              {!videosFetch.loading && draft.map((v, idx) => (
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
                  {canManage && (
                    <div className="flex items-center gap-1 shrink-0">
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
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {(error || videosFetch.error) && (
            <div className="text-sm text-red-600 flex items-start gap-1">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" /> {error ?? videosFetch.error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={saving} />
            {canManage && (
              <Button onClick={handleSave} disabled={saving || videosFetch.loading}>
                {saving ? 'Saving…' : 'Save Content'}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
