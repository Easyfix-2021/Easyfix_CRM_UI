'use client';

/*
 * Training Videos — LMS catalogue page.
 *
 * Reads/writes the legacy `training_videos` table through
 * /api/admin/aux/training-videos. The table has existed for years and the
 * technician app has been playing these videos the whole time (it reads the
 * same rows via /api/mobile/training-videos) — but until this page there was
 * no CRM surface for it at all, so the catalogue could only be edited by hand
 * in the database. 2,439 technicians hold watched-progress against these rows.
 *
 * Scope note: this page manages the CATALOGUE ENTRY (title / description),
 * not the media. The playable file is not stored on this table — it resolves
 * through the legacy document store by `training_video_id`, which is why
 * there is no upload control here.
 */

import { useEffect, useState } from 'react';
import { Video, Search, Plus, Pencil, Trash2, AlertTriangle, Play, Youtube, FileVideo } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { IconButton } from '@/components/ui/icon-button';
import { StatusChip } from '@/components/ui/StatusChip';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { api, ApiError } from '@/lib/api';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { VideoPreviewDialog } from '@/components/lms/VideoPreviewDialog';
import { isYouTubeUrl } from '@/lib/video-url';

type TrainingVideo = {
  id: number;
  title: string;
  description: string | null;
  sub_title: string | null;
  sub_description: string | null;
  /* Foreign key into the legacy `document` store, which is where the playable
   * link actually lives — training_videos has never had a url column. Edited
   * indirectly through `video_url` below, never set by hand. */
  training_video_id: number | null;
  /* document.url for the linked row. YouTube-only on write; historic rows hold
   * legacy .mp4 files served from core.easyfix.in. */
  video_url: string | null;
  /* Delete blockers, computed by the backend on every list read — see
   * `deleteBlockReason` below for why they are on the list response at all.
   *
   * progress_count has NO column of its own, deliberately. It is
   * COUNT(*) FROM easyfixer_watched_video WHERE video_id = <id> — WATCH
   * PROGRESS, counted however the video was reached, course videos included.
   * As a number it is right; as a column headed "Technicians" it was not: a
   * video assigned to hundreds of people who have not opened it yet reads 0,
   * so the table said "nobody" about a video that is squarely in front of
   * everyone. It still governs the delete guard, where 0 is not a claim about
   * who is being trained but the exact question the guard asks — is any
   * progress row pointing at this id. */
  progress_count: number;
  course_count: number;
};

/*
 * The YouTube check lives in @/lib/video-url, shared with VideoPreviewDialog —
 * the same function that decides a link is valid must be the one that decides
 * which player renders it, or a link can pass validation and then play in
 * nothing.
 */

type ListResponse = { rows: TrainingVideo[]; total: number; limit: number; offset: number };

/* BE Joi cap on this endpoint's `limit` is 1000 (routes/admin/auxiliary.js).
 * Pass it explicitly so the shared "All" page-size maps to the endpoint's real
 * ceiling instead of silently 400ing on the generic default. */
const VIDEOS_LIMIT_CAP = 1000;

/* Field limits mirror the backend Joi schema exactly. Enforcing them here is
 * a courtesy (instant feedback, no round-trip) — the server remains the real
 * validator, so these must not drift from routes/admin/auxiliary.js. */
const MAX_TITLE = 255;
const MAX_SUB_TITLE = 255;
const MAX_DESCRIPTION = 2000;

/*
 * Why a client-side delete guard exists at all.
 *
 * `training_videos` and `easyfixer_watched_video` are both MyISAM. MySQL
 * PARSES foreign-key clauses on MyISAM tables and then silently ignores them —
 * the constraints that appear on easyfixer_watched_video read like a guarantee
 * and enforce nothing. The database will NOT stop a delete that orphans
 * technician progress, and it already hasn't: 5 progress rows across 3 deleted
 * video ids were stranded this way before the backend guard was added.
 *
 * So the refusal is enforced in the API (409), and mirrored here as a DISABLED
 * button. Disabling is the point: a 409 after the click tells the operator they
 * were wrong; a disabled button with the reason in its tooltip tells them
 * before they try. Returns null when the video is safe to delete.
 */
function deleteBlockReason(v: TrainingVideo): string | null {
  if (v.progress_count > 0) {
    return `Cannot Delete — ${v.progress_count.toLocaleString('en-IN')} Technician${v.progress_count === 1 ? '' : 's'} Have Progress`;
  }
  if (v.course_count > 0) {
    return `Cannot Delete — Used In ${v.course_count.toLocaleString('en-IN')} Course${v.course_count === 1 ? '' : 's'}`;
  }
  return null;
}

export default function TrainingVideosPage() {
  const confirm = useConfirm();
  const { me } = useMe();
  /* One flag gates every write across all four LMS screens (courses, videos,
   * assign, report). The LIST stays readable without it — an operator who can
   * see the training report needs to see which video a row refers to. */
  const can = actionFlags(me, ['isLmsManage']);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);
  const [editing, setEditing] = useState<TrainingVideo | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  /* The row being previewed, or null. Holds the whole row rather than just the
   * url so the dialog header can name the video. */
  const [previewing, setPreviewing] = useState<TrainingVideo | null>(null);
  /* Tracks the row whose delete is in flight so only that IconButton spins. */
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const debouncedSearch = useDebouncedValue(search, 300);
  /* Any filter change invalidates the current page number — page 4 of an
   * unfiltered list is usually past the end of a filtered one. */
  useEffect(() => { setPage(0); }, [debouncedSearch]);

  /* Every input that affects the result set is part of the key, so useFetch
   * re-fires on its own when search/page/size change — no manual orchestration
   * effect, which is exactly what the shared-hooks rule buys us. */
  const limit = pageSizeToLimit(pageSize, VIDEOS_LIMIT_CAP);
  const offset = page * (pageSize === 'all' ? limit : Number(pageSize));
  const params = new URLSearchParams();
  if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const listUrl = `/admin/aux/training-videos?${params.toString()}`;

  const { data, loading, error: fetchError, refetch } = useFetch<ListResponse>(listUrl);
  const rows: TrainingVideo[] = data?.rows ?? [];
  const total = data?.total ?? 0;

  /*
   * Post-mutation refresh. BOTH calls are required and neither is redundant:
   * `invalidateFetch` only evicts the module-level cache — it has no subscriber
   * mechanism, so a mounted `useFetch` keeps rendering its existing state until
   * something re-runs the effect. `refetch()` is that something. Dropping
   * either one leaves the operator staring at pre-mutation rows.
   */
  function refreshList() {
    invalidateFetch((k) => k.startsWith('/admin/aux/training-videos'));
    refetch();
  }

  async function handleDelete(v: TrainingVideo) {
    const ok = await confirm({
      title: 'Delete Training Video?',
      description:
        `"${v.title}" will be permanently removed from the catalogue. This cannot be undone. ` +
        'The technician app stops listing it immediately. The underlying media file is not ' +
        'touched — it lives in the document store and is removed separately.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    setDeletingId(v.id);
    try {
      await api.delete(`/admin/aux/training-videos/${v.id}`);
      showToast({ variant: 'success', message: `"${v.title}" Deleted.` });
      refreshList();
    } catch (e) {
      /*
       * Defensive 409 handling. The button is already disabled when the counts
       * block a delete, but those counts are a snapshot from list-load time —
       * a technician can start watching, or someone can add the video to a
       * course, in the seconds between the render and the click. The server is
       * the authority; surface its message verbatim rather than guessing.
       */
      if (e instanceof ApiError) showToast({ variant: 'error', message: e.message });
      else showToast({ variant: 'error', message: 'Delete Failed.' });
      /* Counts are demonstrably stale if we got here — pull fresh ones so the
       * button reflects reality on the next render. */
      refreshList();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Video className="size-6" /> Training Videos
          </h1>
          <p className="text-sm text-muted-foreground">
            Catalogue of training videos the technician app plays. Courses are built from these entries.
          </p>
          {/* Sets expectations before an operator hunts for an upload button
              that does not exist on this screen. */}
          <p className="text-xs text-muted-foreground mt-1 max-w-3xl">
            The playable video file itself is managed outside the CRM — it resolves through the
            legacy document store via <span className="font-mono">training_video_id</span>. This page
            manages the catalogue entry (title and description), not the media upload.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.isLmsManage && (
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="size-4 mr-1" /> Add Training Video
            </Button>
          )}
        </div>
      </div>

      {/* Filters — server-side search across title / sub-title / description. */}
      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by title, sub title, or description…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
        </CardContent>
      </Card>

      {fetchError && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {fetchError}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {/* `table-fixed` + colgroup locks column widths so a long title on
              one page doesn't reflow the headers relative to another page. */}
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {/*
                Comments go on their own lines, never trailing a <col /> after a
                space. JSX strips whitespace containing a newline but KEEPS a
                same-line space between expressions, so a trailing comment emits
                a " " text node — illegal inside <colgroup> and reported by
                React as a hydration error.
              */}
              {/* Title */}
              <col style={{ width: '36%' }} />
              {/* Sub Title */}
              <col style={{ width: '28%' }} />
              {/* Video */}
              <col style={{ width: '12%' }} />
              {/* Courses */}
              <col style={{ width: '12%' }} />
              {/* Actions */}
              <col style={{ width: '12%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="!text-left whitespace-nowrap">Title</th>
                <th className="!text-left whitespace-nowrap">Sub Title</th>
                {/* A catalogue entry with no link is invisible to technicians —
                    it lists in the app and plays nothing. Surfacing it as a
                    column means an operator spots the gap while scanning,
                    instead of opening each row to find out. */}
                <th className="!text-center whitespace-nowrap">Video</th>
                {/* Surfaces the delete guard before the click. Its sibling
                    count — progress_count — is fetched and still enforced by
                    the guard, but NOT shown: it counts watch progress while
                    the header said "Technicians", so a video assigned to
                    people who have not started it yet read 0 and the column
                    claimed nobody was on a video everybody had. */}
                <th className="!text-center whitespace-nowrap">Courses</th>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={5} className="!text-center text-muted-foreground py-6">No training videos match the current search.</td></tr>
              )}
              {!loading && rows.map((v) => {
                const blocked = deleteBlockReason(v);
                return (
                  <tr key={v.id}>
                    <td className="!text-left font-medium truncate" title={v.description || v.title}>
                      {v.title}
                    </td>
                    <td className="!text-left truncate" title={v.sub_title ?? ''}>
                      {v.sub_title || <span className="text-muted-foreground">—</span>}
                    </td>
                    {/*
                      Link indicator. The icon distinguishes the two kinds that
                      exist — a YouTube embed from a legacy direct file — because
                      they behave differently in the app and an operator
                      debugging "it won't play" needs to know which they have.
                      "Not Linked" is styled as a warning, not a neutral dash:
                      it means technicians see the entry and get nothing.
                    */}
                    <td className="!text-center whitespace-nowrap">
                      {v.video_url ? (
                        <StatusChip
                          tone={isYouTubeUrl(v.video_url) ? 'rose' : 'slate'}
                          size="sm"
                          title={v.video_url}
                        >
                          <span className="inline-flex items-center gap-1">
                            {isYouTubeUrl(v.video_url)
                              ? <Youtube className="size-3" />
                              : <FileVideo className="size-3" />}
                            {isYouTubeUrl(v.video_url) ? 'YouTube' : 'File'}
                          </span>
                        </StatusChip>
                      ) : (
                        <StatusChip tone="amber" size="sm" title="No video is attached — technicians will see this entry but nothing will play">
                          Not Linked
                        </StatusChip>
                      )}
                    </td>
                    {/* A non-zero count is a delete blocker, so it gets a chip;
                        zero is inert and stays muted so the blockers are what
                        the eye finds. */}
                    <td className="!text-center whitespace-nowrap">
                      {v.course_count > 0 ? (
                        <StatusChip tone="sky" size="sm" title={`Included in ${v.course_count.toLocaleString('en-IN')} course(s)`}>
                          {v.course_count.toLocaleString('en-IN')}
                        </StatusChip>
                      ) : (
                        <span className="text-xs text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className="!text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-0.5">
                        {/*
                          Play is NOT gated on isLmsManage. Watching a training
                          video is a read, and someone reviewing what technicians
                          are being taught needs it whether or not they can edit
                          the catalogue.
                        */}
                        <IconButton
                          icon={Play}
                          label={v.video_url ? 'Play Training Video' : 'No Video Linked'}
                          disabled={!v.video_url}
                          onClick={() => setPreviewing(v)}
                        />
                        {can.isLmsManage && (
                          <IconButton
                            icon={Pencil}
                            label="Edit Training Video"
                            intent="primary"
                            onClick={() => { setEditing(v); setModalOpen(true); }}
                          />
                        )}
                        {can.isLmsManage && (
                          <IconButton
                            icon={Trash2}
                            /* `label` drives BOTH the tooltip and the aria-label,
                             * so the refusal reason reaches sighted hover AND a
                             * screen reader from this one prop. */
                            label={blocked ?? 'Delete Training Video'}
                            intent="danger"
                            disabled={blocked !== null}
                            busy={deletingId === v.id}
                            onClick={() => handleDelete(v)}
                          />
                        )}
                        {!can.isLmsManage && (
                          <span className="text-xs text-muted-foreground">view-only</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-3 py-2 border-t">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </div>
        </CardContent>
      </Card>

      {can.isLmsManage && (
        <TrainingVideoFormModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          editing={editing}
          onSaved={() => { setModalOpen(false); refreshList(); }}
        />
      )}

      {/*
        Mounted only while a row is selected, so closing the dialog UNMOUNTS the
        player. That is what actually stops playback: a hidden-but-mounted
        <iframe> or <video> keeps playing audio behind the dialog, which is the
        classic "why is this page talking to me" bug.
      */}
      {previewing && (
        <VideoPreviewDialog
          open
          onClose={() => setPreviewing(null)}
          title={previewing.title}
          url={previewing.video_url}
        />
      )}
    </div>
  );
}

/* ─── Add / Edit modal ───────────────────────────────────────────────── */
function TrainingVideoFormModal({
  open, onClose, editing, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: TrainingVideo | null;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [title, setTitle] = useState('');
  const [subTitle, setSubTitle] = useState('');
  const [description, setDescription] = useState('');
  const [subDescription, setSubDescription] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Reset on OPEN rather than on close — the dialog animates out, and clearing
   * during that window makes the fields visibly blank as it fades. */
  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? '');
    setSubTitle(editing?.sub_title ?? '');
    setDescription(editing?.description ?? '');
    setSubDescription(editing?.sub_description ?? '');
    setVideoUrl(editing?.video_url ?? '');
    setError(null);
  }, [open, editing]);

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  async function handleSubmit() {
    setError(null);
    if (!title.trim()) { setError('Title is required'); return; }
    /*
     * Mirror the backend's YouTube-only rule client-side so a typo is caught
     * in the form rather than as a bare 400. The backend re-validates with the
     * same accepted forms and is the authority — this is only about where the
     * operator sees the message.
     */
    if (videoUrl.trim() && !isYouTubeUrl(videoUrl.trim())) {
      setError('Video Link must be a YouTube URL (watch, youtu.be, embed or shorts).');
      return;
    }
    setSubmitting(true);
    try {
      if (isEdit) {
        /*
         * Empty strings are sent deliberately, not stripped. The backend maps
         * '' to NULL per field, which is how an operator CLEARS a sub-title.
         * Omitting the key instead would mean "leave unchanged" and make
         * clearing a field impossible from this form.
         */
        await api.patch(`/admin/aux/training-videos/${editing!.id}`, {
          title: title.trim(),
          sub_title: subTitle.trim(),
          description: description.trim(),
          sub_description: subDescription.trim(),
          // Always sent, including empty — '' clears the link, matching how
          // the text fields clear. The backend writes it to the joined
          // `document` row, not to a column on training_videos.
          video_url: videoUrl.trim(),
        });
        showToast({ variant: 'success', message: 'Training Video Updated.' });
      } else {
        await api.post('/admin/aux/training-videos', {
          title: title.trim(),
          sub_title: subTitle.trim(),
          description: description.trim(),
          sub_description: subDescription.trim(),
          // Always sent, including empty — '' clears the link, matching how
          // the text fields clear. The backend writes it to the joined
          // `document` row, not to a column on training_videos.
          video_url: videoUrl.trim(),
        });
        showToast({ variant: 'success', message: 'Training Video Added.' });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit "${editing!.title}"` : 'Add Training Video'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/*
            Video Id is shown read-only on edit. It is the value the technician
            app posts watched-progress against, so when a row looks wrong in the
            Training Report it is the first thing anyone needs — and it is easy
            to confuse with the separate legacy document id that also lives on
            this table.
          */}
          {isEdit && (
            <div className="text-xs text-muted-foreground">
              Video Id <span className="font-mono text-foreground">{editing!.id}</span>
            </div>
          )}

          <div>
            <Label className="block mb-1" required>Title</Label>
            <Input
              value={title}
              maxLength={MAX_TITLE}
              onChange={(e) => setTitle(e.target.value)}
              placeholder='e.g. "Safe Handling Of Refrigerant"'
            />
          </div>

          <div>
            <Label className="block mb-1">Video Link (YouTube)</Label>
            <Input
              value={videoUrl}
              maxLength={500}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=…"
            />
            {/*
              There is no url COLUMN on training_videos. The link is stored on
              the joined legacy `document` row (document_type_id = 2) and
              training_video_id is the foreign key to it — which is why this
              field saves through its own backend path rather than with the
              text columns beside it.
            */}
            <p className="text-xs text-muted-foreground mt-0.5">
              YouTube links only. Leave blank to remove the current link.
            </p>
            {videoUrl.trim() && isYouTubeUrl(videoUrl.trim()) && (
              <a
                href={videoUrl.trim()}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline mt-1 inline-block"
              >
                Open Link In New Tab
              </a>
            )}
          </div>

          <div>
            <Label className="block mb-1">Sub Title</Label>
            <Input
              value={subTitle}
              maxLength={MAX_SUB_TITLE}
              onChange={(e) => setSubTitle(e.target.value)}
              placeholder="Optional — short line shown under the title in the app"
            />
          </div>

          <div>
            <Label className="block mb-1">Description</Label>
            <textarea
              value={description}
              maxLength={MAX_DESCRIPTION}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional — what the technician will learn"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:border-foreground/40"
            />
            <div className="text-xs text-muted-foreground mt-0.5 text-right">
              {description.length} / {MAX_DESCRIPTION}
            </div>
          </div>

          <div>
            <Label className="block mb-1">Sub Description</Label>
            <textarea
              value={subDescription}
              maxLength={MAX_DESCRIPTION}
              onChange={(e) => setSubDescription(e.target.value)}
              rows={3}
              placeholder="Optional — secondary detail"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:border-foreground/40"
            />
            <div className="text-xs text-muted-foreground mt-0.5 text-right">
              {subDescription.length} / {MAX_DESCRIPTION}
            </div>
          </div>

          {error && (
            <div className="text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Training Video'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
