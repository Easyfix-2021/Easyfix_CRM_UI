'use client';

/*
 * Issue Queue — the manager-side triage surface for the in-app issue reporter.
 *
 * STRUCTURE COPIED FROM (deliberately, not invented):
 *   src/app/(authed)/settings/service-categories/page.tsx
 *     — the canonical settings list: Card > CardContent p-0 > table.data-table,
 *       loading/empty rendered as a colSpan row inside <tbody>, and
 *       TablePagination in a `border-t` band under the table.
 *   src/app/(authed)/finance/payout-requests/page.tsx
 *     — the fail-closed RBAC preamble (redirect + null fetch key + no flash),
 *       the chip-style status filter bar, and the confirm-with-a-note pattern
 *       (uncontrolled textarea captured through a ref, because the confirm
 *       `description` JSX is snapshotted at call time and a controlled input
 *       would not re-render the provider on keystrokes).
 *
 * BACKEND (routes/admin/issues.js + services/issue.service.js):
 *   GET   /admin/issues?scope=&status=&limit=&offset=
 *           → { items, total, limit, offset }; each item carries
 *             screenshot_count (number) and NEVER a key or a URL.
 *   GET   /admin/issues/:id      → detail + comments + screenshot_urls[]
 *   POST  /admin/issues/:id/comments   { comment_text }
 *   PATCH /admin/issues/:id/close      { close_note? }   → 409 if already closed
 *
 * RBAC — the WHOLE page needs BOTH locks (isIssueManage AND the
 * access.issues.emails allowlist, as canManageIssues), and the gate fails
 * CLOSED on either.
 * `scope=all` and `close` are the two manager-only operations in the service,
 * and this page is nothing but those two, so there is no second flag to check:
 * past the gate, canManage is true by construction. Everyone can FILE an issue
 * and read their own — that is the reporter widget's job, not this queue's.
 *
 * THE SCREENSHOT URL IS SHORT-LIVED (900 s, minted only by the detail
 * endpoint). An expired URL fails as an ordinary image load, which a browser
 * renders as a broken-image glyph that reads like a bug in this page. The
 * <img onError> below swaps in an explicit "Attachment Expired" panel with the
 * one action that actually fixes it — reload the detail, which mints a fresh
 * URL. `key={url}` on the panel resets that error state when a new URL lands,
 * so no effect is needed to clear it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bug, AlertTriangle, Eye, Image as ImageIcon, ImageOff,
  MessageSquare, CheckCircle2, RefreshCw, Send,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SkillImageLightbox, type SkillImageLightboxValue } from '@/components/easyfixer/SkillImageLightbox';
import { TablePagination, type TablePageSize, pageSizeToLimit, PAGE_SIZE_OPTIONS } from '@/components/ui/table-pagination';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast, dismissToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { formatDate } from '@/lib/utils';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';

type IssueRow = {
  id: number;
  title: string;
  page_path: string | null;
  status: string;
  reported_by: number;
  created_on: string | null;
  closed_on: string | null;
  screenshot_count: number;
  comment_count: number;
};
type ListResp = { items: IssueRow[]; total: number; limit: number; offset: number };

type IssueComment = {
  id: number;
  comment_text: string;
  commented_by: number;
  created_on: string | null;
};
type IssueDetail = {
  id: number;
  title: string;
  description: string;
  page_path: string | null;
  status: string;
  reported_by: number;
  created_on: string | null;
  closed_by: number | null;
  closed_on: string | null;
  close_note: string | null;
  screenshot_count: number;
  /* Presigned for 15 minutes each. May be SHORTER than screenshot_count — a key
   * that failed to sign is dropped rather than returned as a null hole, so the
   * two differing is how a partial failure shows up. */
  screenshot_urls: string[];
  comments: IssueComment[];
};

type UserLite = { user_id: number; user_name: string };

/* Joi `limit.max()` on issueListQuery — TablePagination's "All" must not ask
 * for more than the endpoint will accept, or the page 400s at the top size. */
const LIMIT_CAP = 200;

/*
 * Page sizes offered here — deliberately WITHOUT "All", same reasoning as
 * components/call-info/ClickToCallTab.tsx and the same 200 cap.
 *
 * The cap above already stops "All" from 400ing. What it cannot stop is the
 * LIE: <TablePagination> renders 'all' as ONE page with every nav control
 * disabled and a hint reading "Showing 1–<total> of <total>". Past 200 issues
 * that claims every row is on screen when 200 are, and leaves rows 201+
 * unreachable without changing the page size back. 10/20/50 page through the
 * whole queue honestly, so "All" is strictly worse than every other option.
 */
const ISSUE_PAGE_SIZES = PAGE_SIZE_OPTIONS.filter((o) => o.value !== 'all');

/* The lookup that turns reported_by / commented_by (tbl_user ids — the list
 * endpoint returns ids, never names) into something readable. Admin-group only
 * and capped at 500 by the lookup's own validator, so a deactivated or
 * out-of-page reporter falls through to `User #id` rather than blanking. */
const USERS_LOOKUP_KEY = '/shared/lookup/users?roleGroup=admin&limit=500';

const STATUS_META: Record<string, { label: string; tone: StatusChipTone }> = {
  open:   { label: 'Open',   tone: 'urgent' },
  closed: { label: 'Closed', tone: 'success' },
};

const STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '',       label: 'All' },
  { value: 'open',   label: 'Open' },
  { value: 'closed', label: 'Closed' },
];

/* The service's two scopes. 'all' is the queue and needs isIssueManage — which
 * this page already requires — and 'mine' is the same manager's own reports. */
const SCOPE_FILTERS: ReadonlyArray<{ value: 'all' | 'mine'; label: string }> = [
  { value: 'all',  label: 'All Issues' },
  { value: 'mine', label: 'Reported By Me' },
];

function filterChipClass(active: boolean): string {
  return active
    ? 'rounded px-2 py-0.5 text-xs bg-primary text-white'
    : 'rounded px-2 py-0.5 text-xs bg-ink-100 text-ink-700 hover:bg-ink-300';
}

export default function IssueQueuePage() {
  const router = useRouter();
  const { me, loading: meLoading } = useMe();
  /*
   * Two locks, matching services/issue.service.js resolveActor exactly: the
   * RBAC key says the screen exists, the easyfix_properties allowlist says who
   * may reach it. Deduped module-wide with the Navbar icon and the reporter
   * widget, so this page adds no extra round trip.
   */
  const gatedFeatures = useFetchOnce<{ canManageIssues?: boolean }>('/admin/access/features');
  const canManage =
    hasAction(me, 'isIssueManage') && gatedFeatures.data?.canManageIssues === true;

  /* Fail CLOSED — bounce anyone without BOTH locks once we KNOW the answer to
   * both, never while either is still loading. hasAction returns false for a
   * null `me` and the flag is undefined mid-flight, so redirecting before both
   * settle would eject every user, including the ones who do have access. A
   * FAILED flag fetch leaves loading false and data undefined, which redirects
   * — that is the fail-closed direction and is intended. */
  const gateSettled = !meLoading && !gatedFeatures.loading;
  useEffect(() => {
    if (gateSettled && !canManage) router.replace('/dashboard');
  }, [gateSettled, canManage, router]);

  const [status, setStatus] = useState('');
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(50);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // A filter change must not leave us on a page the new result set doesn't have.
  useEffect(() => { setPage(0); }, [status, scope]);

  const limit = pageSizeToLimit(pageSize, LIMIT_CAP);
  const offset = pageSize === 'all' ? 0 : page * Number(pageSize);
  const qs = new URLSearchParams({ scope, limit: String(limit), offset: String(offset) });
  if (status) qs.set('status', status);
  const listKey = canManage ? `/admin/issues?${qs.toString()}` : null;

  const { data, loading, error, refetch } = useFetch<ListResp>(listKey, { enabled: canManage });
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  const users = useFetchOnce<UserLite[]>(USERS_LOOKUP_KEY);
  const userNames = useMemo(() => {
    const m = new Map<number, string>();
    for (const u of users.data ?? []) m.set(u.user_id, u.user_name);
    return m;
  }, [users.data]);
  const nameOf = (id: number | null | undefined): string =>
    (id == null ? '—' : userNames.get(id) ?? `User #${id}`);

  function refreshList() {
    invalidateFetch((k) => k.startsWith('/admin/issues'));
    refetch();
  }

  // Don't flash the queue before the permission check resolves.
  if (meLoading || !canManage) {
    return <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Bug className="size-6" /> Issue Queue
        </h1>
        <p className="text-sm text-muted-foreground">
          Problems reported from inside the CRM. Open one to read the description, the screenshot and the thread, reply, or close it with a note.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 p-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Status:</span>
            {STATUS_FILTERS.map((s) => (
              <button key={s.value || 'all'} onClick={() => setStatus(s.value)} className={filterChipClass(status === s.value)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Scope:</span>
            {SCOPE_FILTERS.map((s) => (
              <button key={s.value} onClick={() => setScope(s.value)} className={filterChipClass(scope === s.value)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="ml-auto">
            <Button variant="outline" onClick={refreshList}>
              <RefreshCw className="size-4 mr-1" /> Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card><CardContent className="flex items-center gap-2 p-3 text-sm text-urgent">
          <AlertTriangle className="size-4" /> {error}
        </CardContent></Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="!text-center">ID</th>
                  <th className="!text-left">Title</th>
                  <th className="!text-left">Reporter</th>
                  <th className="!text-left">Page Path</th>
                  <th className="!text-left">Created</th>
                  <th className="!text-center">Comments</th>
                  <th className="!text-center">Screenshot</th>
                  <th className="!text-center">Status</th>
                  <th className="!text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">Loading…</td></tr>
                )}
                {!loading && rows.length === 0 && (
                  <tr><td colSpan={9} className="!text-center text-muted-foreground py-6">No issues match the current filters.</td></tr>
                )}
                {!loading && rows.map((r) => {
                  const meta = STATUS_META[r.status] ?? { label: r.status, tone: 'neutral' as StatusChipTone };
                  return (
                    <tr key={r.id} className="hover:bg-ink-50">
                      <td className="!text-center font-mono text-xs">{r.id}</td>
                      <td className="!text-left">
                        <button
                          type="button"
                          onClick={() => setSelectedId(r.id)}
                          className="text-left font-medium hover:underline"
                          title={r.title}
                        >
                          {r.title}
                        </button>
                      </td>
                      <td className="!text-left">{nameOf(r.reported_by)}</td>
                      <td className="!text-left max-w-[220px] truncate font-mono text-xs text-muted-foreground" title={r.page_path ?? ''}>
                        {r.page_path || '—'}
                      </td>
                      <td className="!text-left text-xs">{formatDate(r.created_on)}</td>
                      <td className="!text-center font-mono text-xs">{r.comment_count}</td>
                      <td className="!text-center">
                        {r.screenshot_count > 0 ? (
                          <span className="inline-flex items-center gap-1 text-muted-foreground" title={`${r.screenshot_count} Screenshot(s)`}>
                            <ImageIcon className="size-4" aria-label="Has Screenshots" />
                            {r.screenshot_count > 1 ? <span className="font-mono text-xs">{r.screenshot_count}</span> : null}
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="!text-center"><StatusChip tone={meta.tone} size="sm">{meta.label}</StatusChip></td>
                      <td className="!text-right whitespace-nowrap">
                        <IconButton icon={Eye} intent="primary" label="View Issue" onClick={() => setSelectedId(r.id)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t px-3 py-2">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              pageSizeOptions={ISSUE_PAGE_SIZES}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          </div>
        </CardContent>
      </Card>

      {/* key: a fresh mount per issue, so the draft comment and the screenshot
          error state reset without an effect that has to remember to. */}
      <IssueDetailDialog
        key={selectedId ?? 'none'}
        issueId={selectedId}
        nameOf={nameOf}
        onClose={() => setSelectedId(null)}
        onChanged={refreshList}
      />
    </div>
  );
}

/* ── Detail ─────────────────────────────────────────────────────────────── */

function IssueDetailDialog({ issueId, nameOf, onClose, onChanged }: {
  issueId: number | null;
  nameOf: (id: number | null | undefined) => string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const detailKey = issueId != null ? `/admin/issues/${issueId}` : null;
  const { data, loading, error, refetch } = useFetch<IssueDetail>(detailKey);

  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<SkillImageLightboxValue>(null);
  /* Close note lives in a ref, not state: the confirm dialog snapshots its
   * `description` JSX at call time, so a controlled textarea there would never
   * re-render on keystrokes. Same shape as the payout-requests remarks field. */
  const closeNoteRef = useRef('');

  const guardedOpenChange = useFormDirtyGuard(onClose, {
    isDirty: () => comment.trim().length > 0,
    when: () => !busy,
    title: 'Discard This Comment?',
    description: 'Your unsent comment will be lost.',
    confirmLabel: 'Discard',
  });

  async function addComment() {
    const text = comment.trim();
    if (!text || issueId == null) return;
    setBusy(true);
    const toastId = showToast({ variant: 'loading', message: 'Adding Comment…' });
    try {
      await api.post(`/admin/issues/${issueId}/comments`, { comment_text: text });
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Comment Added' });
      setComment('');
      refetch();
      onChanged();
    } catch (e) {
      dismissToast(toastId);
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Comment Failed' });
    } finally {
      setBusy(false);
    }
  }

  async function closeIssue() {
    if (issueId == null) return;
    closeNoteRef.current = '';
    const ok = await confirm({
      title: 'Close This Issue?',
      confirmLabel: 'Close Issue',
      iconAccent: 'emerald',
      icon: <CheckCircle2 className="size-5" />,
      description: (
        <div className="space-y-3">
          <p>The reporter keeps read access and can still comment, but the issue leaves the open queue. It cannot be re-opened.</p>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Close Note (Optional)</label>
            <textarea
              defaultValue=""
              onChange={(e) => { closeNoteRef.current = e.target.value; }}
              rows={3}
              placeholder="What was done, or why this is being closed"
              className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      ),
    });
    if (!ok) return;

    setBusy(true);
    const toastId = showToast({ variant: 'loading', message: 'Closing Issue…' });
    try {
      await api.patch(`/admin/issues/${issueId}/close`, {
        close_note: closeNoteRef.current.trim() || undefined,
      });
      dismissToast(toastId);
      showToast({ variant: 'success', message: 'Issue Closed' });
      refetch();
      onChanged();
    } catch (e) {
      dismissToast(toastId);
      // 409 = someone else closed it first. Refetch so the panel stops
      // offering an action the row no longer supports.
      if (e instanceof ApiError && e.status === 409) refetch();
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Close Failed' });
    } finally {
      setBusy(false);
    }
  }

  const meta = data ? (STATUS_META[data.status] ?? { label: data.status, tone: 'neutral' as StatusChipTone }) : null;

  return (
    <Dialog open={issueId != null} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{data ? data.title : 'Issue'}</DialogTitle>
        </DialogHeader>

        {loading && <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>}
        {error && (
          <div className="flex items-center gap-2 py-4 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {error}
          </div>
        )}

        {!loading && data && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {meta && <StatusChip tone={meta.tone} size="sm">{meta.label}</StatusChip>}
              <span>Issue #{data.id}</span>
              <span>Reported By {nameOf(data.reported_by)}</span>
              <span>{formatDate(data.created_on)}</span>
              {data.page_path && <span className="font-mono">{data.page_path}</span>}
            </div>

            <div>
              <h3 className="mb-1 text-sm font-medium">Description</h3>
              <p className="whitespace-pre-wrap rounded border bg-muted/40 p-3 text-sm">{data.description}</p>
            </div>

            {data.status === 'closed' && (
              <div>
                <h3 className="mb-1 text-sm font-medium">Close Note</h3>
                <p className="whitespace-pre-wrap rounded border bg-muted/40 p-3 text-sm">
                  {data.close_note || <span className="text-muted-foreground">No note was left.</span>}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Closed By {nameOf(data.closed_by)} · {formatDate(data.closed_on)}
                </p>
              </div>
            )}

            {data.screenshot_count > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium">
                  {data.screenshot_count === 1 ? 'Screenshot' : `Screenshots (${data.screenshot_count})`}
                </h3>
                {data.screenshot_urls.length === 0 ? (
                  /* Attached, but none could be signed — the panel's own
                     "Attachment Unavailable" state says so and offers a reload. */
                  <ScreenshotPanel url={null} onReload={refetch} />
                ) : (
                  <>
                    {data.screenshot_urls.length < data.screenshot_count && (
                      <p className="mb-1 text-xs text-muted-foreground">
                        Showing {data.screenshot_urls.length} Of {data.screenshot_count} — The Rest Could Not Be Signed For Viewing.
                      </p>
                    )}
                    <div className={data.screenshot_urls.length > 1 ? 'grid gap-2 sm:grid-cols-2' : ''}>
                      {data.screenshot_urls.map((u, i) => (
                        /* key on the URL: a new presigned URL is a new panel,
                           which clears any prior expiry state without an effect. */
                        <ScreenshotPanel key={u} url={u} onReload={refetch}
                          onOpen={() => setZoom({ url: u, name: `Screenshot ${i + 1} Of ${data.screenshot_urls.length}` })} />
                      ))}
                    </div>
                  </>
                )}
                <SkillImageLightbox wide value={zoom} onClose={() => setZoom(null)} />
              </div>
            )}

            <div>
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                <MessageSquare className="size-4" /> Comments ({data.comments.length})
              </h3>
              {data.comments.length === 0 && (
                <p className="text-sm text-muted-foreground">No comments yet.</p>
              )}
              <ul className="space-y-2">
                {data.comments.map((c) => (
                  <li key={c.id} className="rounded border p-2.5">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{nameOf(c.commented_by)}</span>
                      <span>{formatDate(c.created_on)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{c.comment_text}</p>
                  </li>
                ))}
              </ul>

              <div className="mt-3">
                <label htmlFor="issue-comment" className="mb-1 block text-xs font-medium text-muted-foreground">Add Comment</label>
                <textarea
                  id="issue-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="Reply on this issue"
                  className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
              <Button onClick={addComment} disabled={busy || comment.trim().length === 0}>
                <Send className="size-4 mr-1" /> Add Comment
              </Button>
              {data.status === 'open' && (
                <Button variant="destructive" onClick={closeIssue} disabled={busy}>
                  <CheckCircle2 className="size-4 mr-1" /> Close Issue
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/*
 * The screenshot, and the honest failure state for it.
 *
 * `url` is presigned for 900 seconds by the detail endpoint. Leave the modal
 * open past that (or come back to a cached detail response) and the GET returns
 * a 403 the browser renders as a broken-image glyph — indistinguishable, to the
 * operator, from "this page is broken". The onError below replaces it with what
 * actually happened plus the one action that fixes it: refetch the detail, which
 * mints a fresh URL.
 *
 * A null `url` is NOT an error: the service returns null when S3 is
 * unconfigured or the presign itself failed, and says so explicitly.
 */
function ScreenshotPanel({ url, onReload, onOpen }: { url: string | null; onReload: () => void; onOpen?: () => void }) {
  const [expired, setExpired] = useState(false);

  if (!url || expired) {
    return (
      <div className="flex flex-col items-center gap-2 rounded border border-dashed p-6 text-center">
        <ImageOff className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">{url ? 'Attachment Expired' : 'Attachment Unavailable'}</p>
        <p className="text-xs text-muted-foreground">
          {url
            ? 'The screenshot link is valid for 15 minutes and this one has lapsed.'
            : 'The screenshot could not be signed for viewing.'}
        </p>
        <Button variant="outline" onClick={onReload}>
          <RefreshCw className="size-4 mr-1" /> Reload Screenshot
        </Button>
      </div>
    );
  }

  /*
   * Click to enlarge. The thumbnail is capped at 420px, which leaves a full-page
   * capture unreadable; the operator's only way in used to be right-click → open
   * the presigned URL. An expired or unsigned attachment never reaches here (the
   * panel above renders instead), so the lightbox cannot open on a dead link.
   */
  return (
    <button type="button" onClick={onOpen} title="Click To Enlarge" className="block w-full cursor-zoom-in">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Issue Screenshot"
        onError={() => setExpired(true)}
        className="max-h-[420px] w-full rounded border object-contain"
      />
    </button>
  );
}
