'use client';

/*
 * IssueReporter — the in-app bug reporter.
 *
 * One floating button, bottom-right, mounted once at the authed root so an
 * operator can report what they are looking at without leaving the page.
 *
 * ─── IT FETCHES NOTHING UNTIL IT IS OPENED ─────────────────────────────────
 *
 * Every `useFetch` key below is null while `open` is false, and null again for
 * whichever tab is not showing. That is the whole design constraint, not a
 * detail: this component renders on EVERY authed page for EVERY operator, so a
 * request fired on mount is multiplied by headcount and by navigation.
 * components/notice/NoticeFlash.tsx documents that bill being paid once
 * already — its recheck went 60s → 5 min for exactly this reason. So there is
 * no poll, no unread badge, and no list request until someone clicks.
 *
 * ─── Z-INDEX: BELOW THE MODAL LAYER, ON PURPOSE ────────────────────────────
 *
 * components/ui/dialog.tsx puts the overlay, the click-blocker and the content
 * all at `z-50` and lets DOM order decide among them. This widget sits at
 * `z-40`, one band under that whole stack, so an open job modal covers the
 * button instead of the button floating over the modal it is meant to be
 * subordinate to. Toasts (z-[9999]) stay above everything, as they must.
 *
 * ─── THE SCREENSHOT HAS TWO ROUTES AND ONE ENCODING ────────────────────────
 *
 * A file picker AND a clipboard paste, because the way an operator actually
 * captures a screen is Win+Shift+S / Cmd+Ctrl+Shift+4 — which puts a PNG on
 * the clipboard and never touches the disk. Forcing a save-then-browse round
 * trip is the difference between a bug being reported and not.
 *
 * When a file is attached the create goes as multipart/form-data; with no file
 * it goes as plain JSON. That is the backend's contract, not a preference:
 * server.js caps `application/json` on /api/admin at 2 MB, so a base64
 * screenshot would 413 on any ordinary full-page PNG (see the header comment in
 * routes/admin/issues.js). `api.post` already omits Content-Type for a
 * FormData body so the browser can set the multipart boundary.
 *
 * ─── THE "ALL TICKETS" TAB FAILS CLOSED ────────────────────────────────────
 *
 * It is rendered only when the caller passes BOTH locks the backend applies in
 * services/issue.service.js resolveActor: the `isIssueManage` action key, read
 * through actionFlags() like every other action gate in the CRM, AND the
 * `access.issues.emails` allowlist, read as canManageIssues from
 * GET /admin/access/features.
 *
 * Both halves fail closed. actionFlags returns false for a missing `me`, a
 * missing permissions block and a missing key alike; the feature flag is
 * compared `=== true`, so an in-flight or failed fetch is undefined and denies.
 * A still-loading session therefore shows two tabs, not three. The server
 * refuses scope=all anyway; this only keeps the UI from offering a control
 * that would 403.
 */

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { ArrowLeft, Bug, Loader2, Paperclip, Send, X } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, invalidateFetch } from '@/lib/hooks';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { parseIstDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';

/** The one action key that means "issue manager" — services/issue.service.js. */
const MANAGE_ACTION = 'isIssueManage';

/*
 * Mirrors multer's cap and the route's allow-set in routes/admin/issues.js.
 * Checked here so an oversized paste is refused instantly rather than after a
 * 5 MB upload that the server then rejects.
 */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Mirrors MAX_SCREENSHOTS in routes/admin/issues.js. Enforced here so the
 *  sixth attachment is refused with a sentence rather than a 400. */
const MAX_SCREENSHOTS = 5;

/** Joi bounds from validators/issue.validator.js — kept in step so a typo is a
 *  field-level stop here rather than a 400 after a round trip. */
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const COMMENT_MAX = 2000;
const MIN_TEXT = 3;

/** One page is the whole list here; the queue is not a reporting surface. */
const LIST_LIMIT = 50;

const LIST_PREFIX = '/admin/issues';

type TabKey = 'report' | 'open' | 'all';

type IssueStatus = 'open' | 'closed';

type IssueListItem = {
  id: number;
  title: string;
  page_path: string | null;
  status: IssueStatus;
  reported_by: number;
  created_on: string;
  closed_on: string | null;
  screenshot_count: number;
  comment_count: number;
};

type IssueListResponse = {
  items: IssueListItem[];
  total: number;
  limit: number;
  offset: number;
};

type IssueComment = {
  id: number;
  comment_text: string;
  commented_by: number;
  created_on: string;
};

type IssueDetail = {
  id: number;
  title: string;
  description: string;
  page_path: string | null;
  status: IssueStatus;
  reported_by: number;
  created_on: string;
  closed_by: number | null;
  closed_on: string | null;
  close_note: string | null;
  screenshot_count: number;
  /** Presigned, 15 minutes each, minted by GET /admin/issues/:id only. An EMPTY
   *  array means "nothing to show" — no screenshots, no S3, or every signature
   *  failed alike. It can be SHORTER than screenshot_count: a key that fails to
   *  sign is dropped rather than returned as a null hole, so length is always
   *  the number the reader can actually open. */
  screenshot_urls: string[];
  comments: IssueComment[];
};

/** Server datetimes are IST wall clocks with no zone; parseIstDateTime stamps
 *  the offset before we format, so a browser outside IST is not off by 5:30. */
function fmtWhen(value: string | null): string {
  if (!value) return '';
  const d = parseIstDateTime(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function errText(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

/* The shared textarea look — Input's classes, minus the fixed height. There is
 * no <Textarea> primitive in components/ui and one field type does not earn a
 * new file; if a third caller wants it, promote it then. */
const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm transition-colors '
  + 'placeholder:text-muted-foreground focus:outline-none focus-visible:outline-none '
  + 'focus-visible:border-foreground/40';

function StatusPill({ status }: { status: IssueStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        status === 'closed' ? 'bg-muted text-muted-foreground' : 'bg-warning/20 text-warning-strong',
      )}
    >
      {status === 'closed' ? 'Closed' : 'Open'}
    </span>
  );
}

function IssueRow({ issue, onOpen }: { issue: IssueListItem; onOpen: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(issue.id)}
      className="w-full rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-muted"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{issue.title}</span>
        <StatusPill status={issue.status} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>#{issue.id}</span>
        <span>{fmtWhen(issue.created_on)}</span>
        {issue.comment_count > 0 ? <span>{issue.comment_count} Comments</span> : null}
        {issue.screenshot_count > 0 ? (
          <span>{issue.screenshot_count === 1 ? 'Screenshot' : `${issue.screenshot_count} Screenshots`}</span>
        ) : null}
      </div>
      {issue.page_path ? (
        <div className="mt-1 truncate text-xs text-muted-foreground">{issue.page_path}</div>
      ) : null}
    </button>
  );
}

function ListBody({
  state,
  emptyLabel,
  onOpen,
}: {
  state: { data: IssueListResponse | null; loading: boolean; error: string | null };
  emptyLabel: string;
  onOpen: (id: number) => void;
}) {
  if (state.loading) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>;
  }
  if (state.error) {
    return <p className="py-6 text-center text-sm text-destructive">{state.error}</p>;
  }
  const items = state.data?.items ?? [];
  if (items.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map((it) => <IssueRow key={it.id} issue={it} onOpen={onOpen} />)}
    </div>
  );
}

export function IssueReporter() {
  const pathname = usePathname();
  const { me } = useMe();
  const confirm = useConfirm();

  /*
   * Shares one round trip with the Navbar's Reported Issues icon and the Admin
   * Actions page — useFetchOnce dedupes module-wide for 30s.
   */
  const gatedFeatures = useFetchOnce<{ canManageIssues?: boolean }>('/admin/access/features');
  const canManage =
    actionFlags(me, [MANAGE_ACTION])[MANAGE_ACTION] === true
    && gatedFeatures.data?.canManageIssues === true;

  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<TabKey>('report');
  const [selectedId, setSelectedId] = React.useState<number | null>(null);

  /* A tab the caller may not hold must not stay selected if the grant is
   * resolved late (or revoked on a /auth/me refresh) — otherwise the panel
   * shows an empty body under a trigger that is no longer rendered. */
  const activeTab: TabKey = tab === 'all' && !canManage ? 'report' : tab;

  // Report form.
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [files, setFiles] = React.useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = React.useState<string[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Detail view.
  const [commentText, setCommentText] = React.useState('');
  const [posting, setPosting] = React.useState(false);

  /*
   * Every key is null unless the panel is open AND that pane is the one on
   * screen — see the header. A closed widget issues no requests at all.
   */
  const listKey = (scope: 'mine' | 'all', status?: IssueStatus) =>
    `${LIST_PREFIX}?scope=${scope}&limit=${LIST_LIMIT}${status ? `&status=${status}` : ''}`;

  const showingList = open && selectedId === null;
  const openList = useFetch<IssueListResponse>(
    showingList && activeTab === 'open' ? listKey('mine', 'open') : null,
  );
  const allList = useFetch<IssueListResponse>(
    showingList && activeTab === 'all' && canManage ? listKey('all') : null,
  );
  const detail = useFetch<IssueDetail>(
    open && selectedId != null ? `${LIST_PREFIX}/${selectedId}` : null,
  );

  /* Local previews only — every URL is revoked when the set changes, so a long
   * session that pastes a dozen screenshots does not pin a dozen blobs in
   * memory. The whole list is rebuilt rather than diffed: createObjectURL is
   * free next to the render it triggers, and a diff here would be a cache with
   * an invalidation bug waiting in it. */
  React.useEffect(() => {
    if (!files.length) {
      setPreviewUrls([]);
      return;
    }
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviewUrls(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  /*
   * APPENDS. Picking files twice, or pasting twice, adds to the set rather
   * than replacing it — the two capture routes below are used together (paste
   * the screen, then browse for the log), and a picker that silently discarded
   * the first attachment was the whole complaint.
   *
   * Each rejection reason is reported separately and the acceptable files in
   * the same batch are still kept: dropping four good screenshots because the
   * fifth was a PDF is not a helpful reading of "one of these is wrong".
   */
  function acceptFiles(candidates: ArrayLike<File> | null | undefined) {
    const incoming = Array.from(candidates ?? []);
    if (!incoming.length) return;

    const wrongType = incoming.filter((f) => !ALLOWED_MIME.has(f.type));
    const tooBig = incoming.filter((f) => ALLOWED_MIME.has(f.type) && f.size > MAX_SCREENSHOT_BYTES);
    const ok = incoming.filter((f) => ALLOWED_MIME.has(f.type) && f.size <= MAX_SCREENSHOT_BYTES);

    if (wrongType.length) {
      showToast({ variant: 'error', message: 'Only PNG, JPEG, WEBP Or GIF Screenshots Are Accepted.' });
    }
    if (tooBig.length) {
      showToast({ variant: 'error', message: 'Each Screenshot Must Be Under 5 MB.' });
    }
    if (!ok.length) return;

    setFiles((prev) => {
      const room = MAX_SCREENSHOTS - prev.length;
      if (room <= 0) {
        showToast({ variant: 'error', message: `You Can Attach Up To ${MAX_SCREENSHOTS} Screenshots.` });
        return prev;
      }
      if (ok.length > room) {
        showToast({ variant: 'error', message: `Only ${room} More Screenshot${room === 1 ? '' : 's'} Can Be Attached.` });
      }
      return [...prev, ...ok.slice(0, room)];
    });
  }

  /* Route two: the clipboard. Win+Shift+S / Cmd+Ctrl+Shift+4 put the capture
   * here and nowhere else, so a paste anywhere in the form attaches it. */
  function onPaste(e: React.ClipboardEvent<HTMLFormElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    // EVERY image on the clipboard, not just the first — a multi-image paste is
    // one gesture and should not silently lose all but one of them.
    const images = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null);
    if (!images.length) return;
    e.preventDefault();
    acceptFiles(images);
  }

  function clearScreenshots() {
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  /*
   * Removing ONE keeps the rest. The input's value is cleared too: without it
   * the browser treats re-picking the same file as "no change" and fires no
   * change event, so a screenshot removed by mistake could not be re-added
   * without picking something else first.
   */
  function removeScreenshotAt(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function resetForm() {
    setTitle('');
    setDescription('');
    clearScreenshots();
  }

  /* A create changes both queues. useFetch's cache is module-level and lives
   * 30s, so evicting the prefix is what makes the NEXT tab switch a real
   * request; refetch() on the mounted hook is what refreshes the one already on
   * screen. Eviction alone does not reach a mounted useFetch. */
  function refreshLists() {
    invalidateFetch((k) => k.startsWith(LIST_PREFIX));
    openList.refetch();
    allList.refetch();
  }

  async function submitIssue(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    const d = description.trim();
    if (t.length < MIN_TEXT || d.length < MIN_TEXT) {
      showToast({ variant: 'error', message: 'Title And Description Are Both Required.' });
      return;
    }
    setSubmitting(true);
    try {
      if (files.length) {
        const fd = new FormData();
        fd.append('title', t);
        fd.append('description', d);
        fd.append('page_path', pathname ?? '');
        // Repeated under ONE field name — multer's .array('screenshot') on the
        // route collects them into req.files in this order, which becomes
        // tbl_crm_issue_image.sort_order.
        for (const f of files) fd.append('screenshot', f);
        await api.post(LIST_PREFIX, fd);
      } else {
        await api.post(LIST_PREFIX, { title: t, description: d, page_path: pathname ?? '' });
      }
      resetForm();
      showToast({ variant: 'success', message: 'Issue Reported.' });
      refreshLists();
      setTab('open');
    } catch (err) {
      showToast({ variant: 'error', message: errText(err, 'Could Not Report The Issue.') });
    } finally {
      setSubmitting(false);
    }
  }

  async function postComment(e: React.FormEvent) {
    e.preventDefault();
    const text = commentText.trim();
    if (!text || selectedId == null) return;
    setPosting(true);
    try {
      await api.post(`${LIST_PREFIX}/${selectedId}/comments`, { comment_text: text });
      setCommentText('');
      detail.refetch();
      refreshLists();
    } catch (err) {
      showToast({ variant: 'error', message: errText(err, 'Could Not Add The Comment.') });
    } finally {
      setPosting(false);
    }
  }

  async function closeIssue() {
    if (selectedId == null) return;
    const ok = await confirm({
      title: 'Close This Issue?',
      description: 'The reporter can still comment on it afterwards, but it leaves the open queue.',
      confirmLabel: 'Close Issue',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.patch(`${LIST_PREFIX}/${selectedId}/close`, {});
      showToast({ variant: 'success', message: 'Issue Closed.' });
      detail.refetch();
      refreshLists();
    } catch (err) {
      showToast({ variant: 'error', message: errText(err, 'Could Not Close The Issue.') });
    }
  }

  function openTicket(id: number) {
    setSelectedId(id);
    setCommentText('');
  }

  function backToList() {
    setSelectedId(null);
    setCommentText('');
  }

  function onTabChange(next: string) {
    setSelectedId(null);
    setTab(next as TabKey);
  }

  const issue = detail.data;

  return (
    <>
      {open ? (
        <div
          className={cn(
            // z-40 — one band below the dialog stack (dialog.tsx is all z-50),
            // so an open job modal covers this rather than the reverse.
            'fixed bottom-20 right-4 z-40 flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg',
            'w-[min(26rem,calc(100vw-2rem))] max-h-[min(34rem,calc(100vh-7rem))]',
          )}
        >
          <div className="flex items-center justify-between gap-2 bg-sidebar px-4 py-3 text-sidebar-foreground">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Bug className="h-4 w-4" aria-hidden="true" />
              Report An Issue
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close Issue Reporter"
              className="rounded-md p-1 transition-colors hover:bg-sidebar-accent"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          {selectedId != null ? (
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <Button variant="ghost" size="sm" className="mb-2 -ml-2 gap-1" onClick={backToList}>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </Button>

              {detail.loading ? <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p> : null}
              {detail.error ? <p className="py-6 text-center text-sm text-destructive">{detail.error}</p> : null}

              {issue ? (
                <div className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{issue.title}</h3>
                    <StatusPill status={issue.status} />
                  </div>
                  <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    <span>#{issue.id}</span>
                    <span>{fmtWhen(issue.created_on)}</span>
                    {issue.page_path ? <span className="truncate">{issue.page_path}</span> : null}
                  </div>

                  <p className="whitespace-pre-wrap text-sm text-foreground">{issue.description}</p>

                  {issue.screenshot_urls.length ? (
                    <div className={cn(
                      'grid gap-2',
                      issue.screenshot_urls.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
                    )}>
                      {issue.screenshot_urls.map((url, i) => (
                        <a key={url} href={url} target="_blank" rel="noreferrer" title={`Screenshot ${i + 1}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived
                              presigned S3 URL; next/image would need the bucket host in
                              next.config.mjs remotePatterns and buys nothing for a
                              one-off screenshot. */}
                          <img
                            src={url}
                            alt={`Issue Screenshot ${i + 1}`}
                            className="max-h-48 w-full rounded-md border border-border object-contain"
                          />
                        </a>
                      ))}
                    </div>
                  ) : null}

                  {issue.status === 'closed' && issue.close_note ? (
                    <div className="rounded-md border border-border bg-muted px-3 py-2">
                      <p className="text-xs font-medium text-muted-foreground">Closing Note</p>
                      <p className="text-sm text-foreground">{issue.close_note}</p>
                    </div>
                  ) : null}

                  <div className="flex flex-col gap-2">
                    <p className="text-xs font-medium text-muted-foreground">Comments</p>
                    {issue.comments.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No Comments Yet.</p>
                    ) : (
                      issue.comments.map((c) => (
                        <div key={c.id} className="rounded-md border border-border px-3 py-2">
                          <p className="whitespace-pre-wrap text-sm text-foreground">{c.comment_text}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{fmtWhen(c.created_on)}</p>
                        </div>
                      ))
                    )}
                  </div>

                  <form className="flex flex-col gap-2" onSubmit={postComment}>
                    <textarea
                      rows={2}
                      maxLength={COMMENT_MAX}
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="Add A Comment"
                      className={TEXTAREA_CLASS}
                    />
                    <div className="flex items-center justify-between gap-2">
                      {canManage && issue.status === 'open' ? (
                        <Button type="button" variant="outline" size="sm" onClick={closeIssue}>
                          Close Issue
                        </Button>
                      ) : <span />}
                      <Button type="submit" size="sm" className="gap-1" disabled={posting || !commentText.trim()}>
                        {posting
                          ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          : <Send className="h-4 w-4" aria-hidden="true" />}
                        Add Comment
                      </Button>
                    </div>
                  </form>
                </div>
              ) : null}
            </div>
          ) : (
            <Tabs value={activeTab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col">
              <div className="px-4 pt-3">
                <TabsList className="w-full">
                  <TabsTrigger value="report" className="flex-1">Report An Issue</TabsTrigger>
                  <TabsTrigger value="open" className="flex-1">Open Tickets</TabsTrigger>
                  {canManage ? <TabsTrigger value="all" className="flex-1">All Tickets</TabsTrigger> : null}
                </TabsList>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                <TabsContent value="report">
                  <form className="flex flex-col gap-3" onSubmit={submitIssue} onPaste={onPaste}>
                    <div className="flex flex-col gap-1">
                      <label htmlFor="ef-issue-title" className="text-xs font-medium text-muted-foreground">Title</label>
                      <Input
                        id="ef-issue-title"
                        value={title}
                        maxLength={TITLE_MAX}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="What Went Wrong?"
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label htmlFor="ef-issue-desc" className="text-xs font-medium text-muted-foreground">Description</label>
                      <textarea
                        id="ef-issue-desc"
                        rows={4}
                        value={description}
                        maxLength={DESCRIPTION_MAX}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="What Were You Doing, And What Did You Expect To Happen?"
                        className={TEXTAREA_CLASS}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Screenshots (Optional) {files.length ? `— ${files.length} Of ${MAX_SCREENSHOTS}` : ''}
                      </span>
                      <input
                        ref={fileInputRef}
                        type="file"
                        // multiple: the picker is one of the two capture routes, and the
                        // other (paste) already handles a batch. Selecting three files
                        // in one pass should not mean three trips through the dialog.
                        multiple
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        className="hidden"
                        onChange={(e) => acceptFiles(e.target.files)}
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1 self-start"
                          disabled={files.length >= MAX_SCREENSHOTS}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Paperclip className="h-4 w-4" aria-hidden="true" />
                          {files.length ? 'Add More' : 'Choose Files'}
                        </Button>
                        {files.length > 1 ? (
                          <Button type="button" variant="ghost" size="sm" onClick={clearScreenshots}>
                            Remove All
                          </Button>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Or Paste Screenshots Anywhere In This Form. Up To {MAX_SCREENSHOTS}, 5 MB Each.
                      </p>

                      {previewUrls.length ? (
                        <div className="grid grid-cols-2 gap-2">
                          {previewUrls.map((url, i) => (
                            <div key={url} className="relative">
                              {/* eslint-disable-next-line @next/next/no-img-element -- local
                                  blob: preview of a file that never leaves the browser until
                                  submit; next/image cannot take an object URL. */}
                              <img
                                src={url}
                                alt={`Screenshot Preview ${i + 1}`}
                                className="max-h-40 w-full rounded-md border border-border object-contain"
                              />
                              <button
                                type="button"
                                onClick={() => removeScreenshotAt(i)}
                                aria-label={`Remove Screenshot ${i + 1}`}
                                className="absolute right-1 top-1 rounded-full bg-card p-1 text-foreground shadow-sm transition-colors hover:bg-muted"
                              >
                                <X className="h-4 w-4" aria-hidden="true" />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <p className="text-xs text-muted-foreground">
                        Screenshots May Contain Customer Data. Remove Anything Sensitive Before Submitting.
                      </p>
                    </div>

                    <Button type="submit" className="gap-1" disabled={submitting}>
                      {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                      Submit Issue
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="open">
                  <ListBody state={openList} emptyLabel="You Have No Open Tickets." onOpen={openTicket} />
                </TabsContent>

                {canManage ? (
                  <TabsContent value="all">
                    <ListBody state={allList} emptyLabel="No Tickets Yet." onOpen={openTicket} />
                  </TabsContent>
                ) : null}
              </div>
            </Tabs>
          )}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Report An Issue"
        aria-expanded={open}
        className={cn(
          'fixed bottom-4 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full',
          'bg-primary text-primary-foreground shadow-lg transition-colors hover:bg-primary/90',
        )}
      >
        {open
          ? <X className="h-5 w-5" aria-hidden="true" />
          : <Bug className="h-5 w-5" aria-hidden="true" />}
      </button>
    </>
  );
}
