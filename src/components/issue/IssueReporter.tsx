'use client';

/*
 * IssueReporter — the in-app bug reporter.
 *
 * One floating button, bottom-right by default and draggable, mounted once at the authed root so an
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
 * screenshot is captured automatically on open (route zero) and would 413 on any ordinary full-page PNG (see the header comment in
 * routes/admin/issues.js). `api.post` already omits Content-Type for a
 * FormData body so the browser can set the multipart boundary.
 *
 * ─── "ALL TICKETS" IS THE CALLER'S OWN TICKETS ─────────────────────────────
 *
 * Open Tickets = mine, open; All Tickets = mine, every status (2026-09-11, per
 * ops). It used to list scope=all for the three issue managers, so their
 * personal widget showed everyone's tickets — the full queue belongs on
 * /admin-actions/issues, which has its own All Issues / Reported By Me scope.
 * Being reporter-scoped, the tab is now shown to everyone: a reporter can find
 * their closed tickets and the close notes on them.
 *
 * Reopen Issue is offered on a closed ticket to its reporter or a manager — the
 * backend's READ rule, so no key is needed to reopen your own.
 *
 * The manager gate survives only on the Close button. It passes BOTH locks the
 * backend applies in services/issue.service.js resolveActor: the `isIssueManage`
 * action key, read through actionFlags() like every other action gate in the
 * CRM, AND the `access.issues.emails` allowlist, read as canManageIssues from
 * GET /admin/access/features. Both halves fail closed — an in-flight or failed
 * fetch is undefined and denies. The server enforces all of this regardless:
 * scope=all is refused to non-managers and scope=mine filters by reporter.
 */

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { ArrowLeft, Bug, Camera, Loader2, Paperclip, Send, X } from 'lucide-react';

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
import {
  useScreenshotAttachments,
  ScreenshotField,
  appendScreenshots,
  MAX_SCREENSHOTS,
  MAX_SCREENSHOT_BYTES,
  ALLOWED_MIME,
} from './screenshotAttachments';

/** The one action key that means "issue manager" — services/issue.service.js. */
const MANAGE_ACTION = 'isIssueManage';

/* The caps, the allow-set and the picker markup all live in
 * ./screenshotAttachments now — three surfaces attach images since
 * 2026-09-16 and they must refuse the same things the same way. */

/*
 * ─── CAPTURE SCREEN (owner, 2026-09-16) ──────────────────────────────────
 *
 * Route three, beside the picker and the paste: grab THIS tab. Native
 * getDisplayMedia rather than a DOM-to-canvas library — no dependency, and it
 * is what the operator actually sees (modals, portals, canvases, the lot),
 * where a DOM renderer approximates. Chrome's picker still shows, but the
 * hints below default it to the current tab so it is one click.
 *
 * JPEG, not PNG: a 1440×900 PNG of a dense table can pass the 5 MB cap this
 * form enforces; the same frame as JPEG at this quality is a few hundred KB
 * and every screenshot this feature has ever needed was legible at it.
 *
 * The frame is grabbed a beat after the stream starts so the picker overlay
 * has cleared; the panel itself is hidden for the whole capture so the shot
 * is the page, not this form over the page.
 */
const CAPTURE_JPEG_QUALITY = 0.85;
const CAPTURE_SETTLE_MS = 250;
/* Chrome-only hints (ignored elsewhere): open the picker on THIS tab, let it
 * be picked, and do not offer whole monitors. Typed loosely — lib.dom has
 * not caught up with them. */
const CAPTURE_PICKER_HINTS: Record<string, unknown> = {
  preferCurrentTab: true,
  selfBrowserSurface: 'include',
  surfaceSwitching: 'exclude',
  monitorTypeSurfaces: 'exclude',
};

/*
 * ─── ROUTE ZERO: THE AUTOMATIC ONE (owner, 2026-09-16) ────────────────────
 *
 * "It still does not auto capture the page screenshot." Route three above is a
 * BUTTON and structurally cannot be anything else: getDisplayMedia requires a
 * user gesture and always shows the browser's picker — a security property of
 * the API, not a setting. So a genuinely automatic capture has to rasterise the
 * DOM instead, which is what modern-screenshot does.
 *
 * The two are not redundant and both stay:
 *   · AUTO (here) — silent, instant, fires the moment the panel opens, so the
 *     operator gets a screenshot without knowing the feature exists. It
 *     APPROXIMATES: it re-renders the DOM into an SVG foreignObject, so
 *     cross-origin images it cannot inline come out blank and live <canvas>
 *     contents do not survive.
 *   · MANUAL (Capture Screen) — pixel-exact, everything the compositor drew,
 *     at the cost of a picker click. The upgrade path when the auto shot missed
 *     the thing being reported.
 *
 * DYNAMICALLY IMPORTED. This component mounts on EVERY authed page; the library
 * is ~180 KB unpacked and is needed only once someone actually opens the
 * reporter. A static import would tax every page load in the CRM for a feature
 * used a few times a week.
 *
 * VIEWPORT, NOT THE FULL PAGE. domToBlob(document.body) would rasterise the
 * whole scroll height — on a 500-row table that is an enormous image against a
 * 5 MB cap, and it is not what was asked for ("Current Screen's Screenshot").
 * The body is shifted by the scroll offset and clipped to innerWidth/Height, so
 * the result is exactly what the operator was looking at.
 *
 * scale: 1 on purpose. The default follows devicePixelRatio, which on a Retina
 * machine quadruples the pixels for no legibility a bug report needs.
 */
const AUTO_CAPTURE_SCALE = 1;
/* Marks this component's own two roots so the rasteriser drops them: the shot
 * must be the PAGE, not the reporter sitting on top of it. An attribute rather
 * than a class because Tailwind classes here are composed by cn() and a filter
 * matching on them would be a string match against a moving target. */
const REPORTER_ROOT_ATTR = 'data-issue-reporter';

/*
 * ─── THE BUTTON MOVES (owner, 2026-09-16) ────────────────────────────────
 *
 * Bottom-right is where every page puts its own last button, so the FAB sat
 * on top of Search on Pending to Start and on the row actions of a long
 * table. It can now be dragged anywhere, and the spot persists in a cookie —
 * per the owner, a cookie, so it survives a new tab and a restart the same
 * way the login does. The value is two integers, so no encoding.
 *
 * Click versus drag: a press that travels less than DRAG_THRESHOLD_PX is a
 * click and toggles the panel; more is a drag, and the click the browser
 * fires on release is swallowed once. Keyboard users never drag, so their
 * Enter/Space still lands on the plain click path.
 */
const FAB_COOKIE = 'crm_issue_fab';
const FAB_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const FAB_SIZE = 48;        // h-12 w-12
const FAB_MARGIN = 16;      // bottom-4 right-4 — also the minimum inset when dragged
const DRAG_THRESHOLD_PX = 4;

type FabPos = { x: number; y: number };

function readFabCookie(): FabPos | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${FAB_COOKIE}=(\\d+),(\\d+)`));
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

function writeFabCookie(p: FabPos) {
  try {
    document.cookie = `${FAB_COOKIE}=${Math.round(p.x)},${Math.round(p.y)}; path=/; max-age=${FAB_COOKIE_MAX_AGE}; SameSite=Lax`;
  } catch {
    /* a browser that refuses cookies still gets a draggable button for the session */
  }
}

/* Keep the whole button on screen — a spot saved on a wide monitor must not
 * park it off the edge of a laptop. */
function clampFab(p: FabPos): FabPos {
  const maxX = window.innerWidth - FAB_SIZE - FAB_MARGIN;
  const maxY = window.innerHeight - FAB_SIZE - FAB_MARGIN;
  return {
    x: Math.min(Math.max(FAB_MARGIN, p.x), Math.max(FAB_MARGIN, maxX)),
    y: Math.min(Math.max(FAB_MARGIN, p.y), Math.max(FAB_MARGIN, maxY)),
  };
}

/** Joi bounds from validators/issue.validator.js — kept in step so a typo is a
 *  field-level stop here rather than a 400 after a round trip. */
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const COMMENT_MAX = 2000;
const CLOSE_NOTE_MAX = 1000;
/* validators/issue.validator.js issueReopen — 600, so the reopen comment can
 * also carry the close it undoes within comment_text's 2000. */
const REOPEN_NOTE_MAX = 600;
const MIN_TEXT = 3;

/** First page. The panel is 26rem wide, so a full table footer does not fit —
 *  the list grows in ONE step to LIST_LIMIT_MAX instead of paginating. */
const LIST_LIMIT = 50;

/** issueListQuery's `limit.max()` in validators/issue.validator.js. Asking for
 *  more is a hard 400, not a silent clamp. A manager whose queue is past this
 *  has /admin-actions/issues, which paginates properly. */
const LIST_LIMIT_MAX = 200;

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
  /* Attachments on a reply (2026-09-16). Presigned server-side in
   * getIssueDetail, same 900s TTL as the report's own. Optional so a CRM that
   * meets an older backend renders the text and no gallery. */
  screenshot_urls?: string[];
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
  onShowMore,
}: {
  state: { data: IssueListResponse | null; loading: boolean; error: string | null };
  emptyLabel: string;
  onOpen: (id: number) => void;
  /* NULL once the list is already asking for LIST_LIMIT_MAX — there is no
   * second step, and a button that cannot change the result is worse than no
   * button. The count line below still renders in that case, so a queue of 312
   * never silently reads as 200 either. */
  onShowMore: (() => void) | null;
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
  /* The server sends `total` on every page (services/issue.service.js
   * listIssues). Falling back to items.length rather than 0 means a response
   * shape that ever loses `total` hides the footer instead of claiming
   * "Showing 50 Of 0". */
  const total = state.data?.total ?? items.length;
  return (
    <div className="flex flex-col gap-2">
      {items.map((it) => <IssueRow key={it.id} issue={it} onOpen={onOpen} />)}
      {total > items.length ? (
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-muted-foreground">
            Showing {items.length} Of {total}
          </span>
          {onShowMore ? (
            <Button type="button" variant="ghost" size="sm" onClick={onShowMore}>
              Show More
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function IssueReporter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  /*
   * PATH AND QUERY (owner, 2026-09-16). `/my-orders?tab=pending-start&
   * action=reassign&jobId=509493` is the reproduction — which tab, which
   * modal, which job — and the path alone sent every triager back to ask.
   * The backend keeps the query too now (validators/issue.validator.js) and
   * still drops any fragment.
   */
  const search = searchParams?.toString();
  const pageUrl = `${pathname ?? ''}${search ? `?${search}` : ''}`;
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

  // Report form.
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  /* The REPORT form's attachments. The same hook the comment box below uses,
   * so both surfaces enforce one set of rules — see ./screenshotAttachments. */
  const reportShots = useScreenshotAttachments();
  const { files, acceptFiles, onPaste, clear: clearScreenshots } = reportShots;
  const [capturing, setCapturing] = React.useState(false);
  /* Route zero runs once per open, and only when nothing is attached yet. */
  const autoCaptureDone = React.useRef(false);

  /* null = the default corner (the CSS bottom-4 right-4). Read from the
   * cookie after mount — never during render, which runs on the server too. */
  const [fabPos, setFabPos] = React.useState<FabPos | null>(null);
  React.useEffect(() => {
    const saved = readFabCookie();
    if (saved) setFabPos(clampFab(saved));
    const onResize = () => setFabPos((p) => (p ? clampFab(p) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const drag = React.useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean; last: FabPos | null } | null>(null);
  const swallowNextClick = React.useRef(false);
  const [submitting, setSubmitting] = React.useState(false);

  // Detail view.
  const [commentText, setCommentText] = React.useState('');
  /* A reply's attachments — its own set, independent of the report form's, so
   * a half-written report with screenshots is not disturbed by commenting on a
   * different ticket in the other tab. */
  const commentShots = useScreenshotAttachments();
  const [posting, setPosting] = React.useState(false);
  const [reopening, setReopening] = React.useState(false);

  /* Close note lives in a ref, not state: confirm() snapshots its `description`
   * JSX at call time (see components/ui/confirm-dialog.tsx), so a controlled
   * textarea there would never re-render on keystrokes. Same shape as
   * admin-actions/issues/page.tsx and finance/payout-requests/page.tsx — the
   * only two of the 75 useConfirm call sites that carry free text. */
  const closeNoteRef = React.useRef('');
  /* The reopen reason — a ref for the same reason as closeNoteRef. */
  const reopenNoteRef = React.useRef('');

  /*
   * Every key is null unless the panel is open AND that pane is the one on
   * screen — see the header. A closed widget issues no requests at all.
   */
  /* One step, 50 -> 200, SHARED by both list tabs. Shared rather than per-tab
   * because the two tabs are never on screen together and a second piece of
   * state would only have to be kept in sync with the first. */
  const [listLimit, setListLimit] = React.useState(LIST_LIMIT);

  // Both list tabs are the caller's own tickets — see "ALL TICKETS" above.
  const listKey = (status?: IssueStatus) =>
    `${LIST_PREFIX}?scope=mine&limit=${listLimit}${status ? `&status=${status}` : ''}`;

  const showingList = open && selectedId === null;
  const openList = useFetch<IssueListResponse>(
    showingList && tab === 'open' ? listKey('open') : null,
  );
  const allList = useFetch<IssueListResponse>(
    showingList && tab === 'all' ? listKey() : null,
  );
  const detail = useFetch<IssueDetail>(
    open && selectedId != null ? `${LIST_PREFIX}/${selectedId}` : null,
  );

  /*
   * Route zero: rasterise the page the moment the panel opens. Silent by
   * design — it is automatic, so a toast on every page whose images will not
   * inline would be noise the operator cannot act on. A failure simply leaves
   * the form with no attachment, exactly as before this existed.
   */
  const autoCapture = React.useCallback(async () => {
    try {
      const { domToBlob } = await import('modern-screenshot');
      const blob = await domToBlob(document.body, {
        type: 'image/jpeg',
        quality: CAPTURE_JPEG_QUALITY,
        scale: AUTO_CAPTURE_SCALE,
        width: window.innerWidth,
        height: window.innerHeight,
        style: {
          // Clip to the viewport by shifting the body under a fixed-size frame.
          transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
          transformOrigin: 'top left',
        },
        // Drop this component's own DOM — the panel and the FAB.
        filter: (node: Node) => !(node instanceof Element && node.hasAttribute(REPORTER_ROOT_ATTR)),
      });
      if (!blob) return;
      acceptFiles([new File([blob], `page-${Date.now()}.jpg`, { type: 'image/jpeg' })]);
    } catch {
      /* Approximation failed (tainted canvas, an un-inlinable font, a browser
       * without foreignObject support). The Capture Screen button still works. */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Fires on the OPEN transition only, and only with an empty attachment set:
   * re-opening a panel the operator already put screenshots in must not shove
   * another one in front of them, and must not spend the rasterise.
   */
  React.useEffect(() => {
    if (!open) { autoCaptureDone.current = false; return; }
    if (autoCaptureDone.current || files.length) return;
    autoCaptureDone.current = true;
    void autoCapture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* Route three: this tab, through the browser's own capture API. Goes
   * through acceptFiles like the other two, so the 5-file and 5 MB rules
   * apply to it unchanged. See CAPTURE_* above for the choices. */
  async function captureScreen() {
    if (capturing || files.length >= MAX_SCREENSHOTS) return;
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.getDisplayMedia) {
      showToast({ variant: 'error', message: 'Screen Capture Is Not Available In This Browser. Paste Or Choose A File Instead.' });
      return;
    }
    setCapturing(true); // hides the panel before the picker even opens
    let stream: MediaStream | null = null;
    try {
      stream = await md.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false,
        ...CAPTURE_PICKER_HINTS,
      } as DisplayMediaStreamOptions);
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      await new Promise((r) => setTimeout(r, CAPTURE_SETTLE_MS));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', CAPTURE_JPEG_QUALITY));
      if (!blob) throw new Error('capture produced no image');
      acceptFiles([new File([blob], `screen-${Date.now()}.jpg`, { type: 'image/jpeg' })]);
    } catch (err) {
      // NotAllowedError is the operator closing the picker — not a failure.
      if (!(err instanceof DOMException && err.name === 'NotAllowedError')) {
        showToast({ variant: 'error', message: 'Could Not Capture The Screen.' });
      }
    } finally {
      // Always. A capture stream left running keeps the tab's "sharing" pill lit.
      stream?.getTracks().forEach((t) => t.stop());
      setCapturing(false);
    }
  }

  /* The FAB's drag. Pointer events cover mouse and touch alike; capture keeps
   * the gesture on the button when the pointer outruns it. */
  function fabPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: rect.left, originY: rect.top, moved: false, last: null };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function fabPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    d.last = clampFab({ x: d.originX + dx, y: d.originY + dy });
    setFabPos(d.last);
  }
  function fabPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (e.currentTarget.hasPointerCapture(d.pointerId)) e.currentTarget.releasePointerCapture(d.pointerId);
    if (d.moved) {
      if (d.last) writeFabCookie(d.last);
      swallowNextClick.current = true; // the click that follows a drag is not a click
    }
  }
  function fabClick() {
    if (swallowNextClick.current) {
      swallowNextClick.current = false;
      return;
    }
    setOpen((v) => !v);
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
        fd.append('page_path', pageUrl);
        // Repeated under ONE field name — multer's .array('screenshot') on the
        // route collects them into req.files in this order, which becomes
        // tbl_crm_issue_image.sort_order.
        for (const f of files) fd.append('screenshot', f);
        await api.post(LIST_PREFIX, fd);
      } else {
        await api.post(LIST_PREFIX, { title: t, description: d, page_path: pageUrl });
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
      if (commentShots.files.length) {
        const fd = new FormData();
        fd.append('comment_text', text);
        appendScreenshots(fd, commentShots.files);
        await api.post(`${LIST_PREFIX}/${selectedId}/comments`, fd);
      } else {
        // Plain JSON when there is nothing to attach — the route accepts both.
        await api.post(`${LIST_PREFIX}/${selectedId}/comments`, { comment_text: text });
      }
      setCommentText('');
      commentShots.clear();
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
    // Reset FIRST: the ref outlives the dialog, so a note typed into a close
    // the operator then cancelled must not ride along on the next one.
    closeNoteRef.current = '';
    const ok = await confirm({
      title: 'Close This Issue?',
      description: (
        <div className="space-y-3">
          <p>The reporter can still comment on it afterwards, but it leaves the open queue.</p>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Close Note (Optional)</label>
            <textarea
              defaultValue=""
              onChange={(e) => { closeNoteRef.current = e.target.value; }}
              rows={3}
              maxLength={CLOSE_NOTE_MAX}
              placeholder="What Was Done, Or Why This Is Being Closed"
              className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      ),
      confirmLabel: 'Close Issue',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      // `|| undefined` drops the key; JSON.stringify then omits it, so a
      // no-note close sends the same `{}` body it sends today.
      await api.patch(`${LIST_PREFIX}/${selectedId}/close`, {
        close_note: closeNoteRef.current.trim() || undefined,
      });
      showToast({ variant: 'success', message: 'Issue Closed.' });
      detail.refetch();
      refreshLists();
    } catch (err) {
      showToast({ variant: 'error', message: errText(err, 'Could Not Close The Issue.') });
    }
  }

  async function reopenIssue() {
    if (selectedId == null) return;
    // Reset FIRST, same as closeNoteRef.
    reopenNoteRef.current = '';
    const ok = await confirm({
      title: 'Reopen This Issue?',
      description: (
        <div className="space-y-3">
          <p>It goes back to the open queue, and your reason is added to the thread.</p>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">What Is Still Wrong?</label>
            <textarea
              defaultValue=""
              onChange={(e) => { reopenNoteRef.current = e.target.value; }}
              rows={3}
              maxLength={REOPEN_NOTE_MAX}
              required
              placeholder="What Still Happens, And Where"
              className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      ),
      confirmLabel: 'Reopen Issue',
    });
    if (!ok) return;
    const reopenNote = reopenNoteRef.current.trim();
    if (!reopenNote) {
      showToast({ variant: 'error', message: 'Tell Us What Is Still Wrong.' });
      return;
    }
    setReopening(true);
    try {
      await api.patch(`${LIST_PREFIX}/${selectedId}/reopen`, { reopen_note: reopenNote });
      showToast({ variant: 'success', message: 'Issue Reopened.' });
      detail.refetch();
      refreshLists();
    } catch (err) {
      // 409 = someone reopened (or re-closed) it first: show the ticket as it is now.
      if (err instanceof ApiError && err.status === 409) { detail.refetch(); refreshLists(); }
      showToast({ variant: 'error', message: errText(err, 'Could Not Reopen The Issue.') });
    } finally {
      setReopening(false);
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
    /* Back to the first page. Without this, switching tabs carries an
     * expansion the operator made on the OTHER list into a 200-row fetch they
     * did not ask for. */
    setListLimit(LIST_LIMIT);
  }

  const issue = detail.data;

  return (
    <>
      {open ? (
        <div
          {...{ [REPORTER_ROOT_ATTR]: '' }}
          className={cn(
            // z-40 — one band below the dialog stack (dialog.tsx is all z-50),
            // so an open job modal covers this rather than the reverse.
            'fixed bottom-20 right-4 z-40 flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg',
            // Out of the shot for the whole capture — visibility, not unmount,
            // so the half-written report underneath survives untouched.
            capturing && 'invisible',
            /*
             * h-, not max-h-. A max-height only CAPS the panel: a flex column
             * still collapses to its content, so switching from the report form
             * to a one-row All Tickets list shrank the panel and moved the
             * header and the tab strip up under the pointer. The frame is now
             * FIXED and the variability lives inside the scroll area below,
             * which is what the min-h-0 flex-1 children are already built for.
             *
             * Still viewport-clamped by the min(): 34rem where there is room,
             * and calc(100vh-7rem) on a short window so the panel never grows
             * past the FAB it is anchored above.
             */
            'w-[min(26rem,calc(100vw-2rem))] h-[min(34rem,calc(100vh-7rem))]',
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
            /* min-h-0: a flex item's min-height is auto, i.e. its content, so
               without this the detail pane pushes the fixed frame instead of
               scrolling inside it. The tabs branch below already had it; this
               branch only got away with it while the panel was free to grow. */
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
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
                          {c.screenshot_urls?.length ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {c.screenshot_urls.map((url, i) => (
                                /* Opens in a tab rather than a lightbox: this panel is
                                   26rem wide, so a full-page capture is unreadable inside
                                   it however it is framed. */
                                <a key={url} href={url} target="_blank" rel="noopener noreferrer" title="Open Full Size">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={url}
                                    alt={`Comment Screenshot ${i + 1}`}
                                    className="h-16 w-16 rounded border border-border object-cover"
                                  />
                                </a>
                              ))}
                            </div>
                          ) : null}
                          <p className="mt-1 text-xs text-muted-foreground">{fmtWhen(c.created_on)}</p>
                        </div>
                      ))
                    )}
                  </div>

                  {/* onPaste on the FORM, matching the report form above: a
                      screenshot on the clipboard attaches wherever the operator
                      happens to have focus. */}
                  <form className="flex flex-col gap-2" onSubmit={postComment} onPaste={commentShots.onPaste}>
                    <textarea
                      rows={2}
                      maxLength={COMMENT_MAX}
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="Add A Comment"
                      className={TEXTAREA_CLASS}
                    />
                    <ScreenshotField attachments={commentShots} compact disabled={posting} />
                    <div className="flex items-center justify-between gap-2">
                      {canManage && issue.status === 'open' ? (
                        <Button type="button" variant="outline" size="sm" onClick={closeIssue}>
                          Close Issue
                        </Button>
                      ) : issue.status === 'closed' && (issue.reported_by === me?.user.user_id || canManage) ? (
                        <Button type="button" variant="outline" size="sm" onClick={reopenIssue} disabled={reopening}>
                          Reopen Issue
                        </Button>
                      ) : <span />}
                      {/* Text stays REQUIRED even with images attached: the
                          backend's Joi minimum is 1 char, and a bare image with
                          no sentence is the comment nobody can triage. */}
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
            <Tabs value={tab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col">
              <div className="px-4 pt-3">
                <TabsList className="w-full">
                  <TabsTrigger value="report" className="flex-1">Report An Issue</TabsTrigger>
                  <TabsTrigger value="open" className="flex-1">Open Tickets</TabsTrigger>
                  <TabsTrigger value="all" className="flex-1">All Tickets</TabsTrigger>
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
                      {/* The picker, the previews and the caps all come from
                          ./screenshotAttachments — shared with the comment box
                          below and the Issue Queue's. Capture Screen is passed
                          in because it is the report form's alone: a reply is
                          about something already on screen, not about the page
                          the reply is typed on. */}
                      <ScreenshotField
                        attachments={reportShots}
                        extraAction={(
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1"
                            disabled={capturing || files.length >= MAX_SCREENSHOTS}
                            onClick={captureScreen}
                            title="Grab This Tab As A Screenshot"
                          >
                            {capturing
                              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                              : <Camera className="h-4 w-4" aria-hidden="true" />}
                            Capture Screen
                          </Button>
                        )}
                      />

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
                  <ListBody
                    state={openList}
                    emptyLabel="You Have No Open Tickets."
                    onOpen={openTicket}
                    onShowMore={listLimit < LIST_LIMIT_MAX ? () => setListLimit(LIST_LIMIT_MAX) : null}
                  />
                </TabsContent>

                <TabsContent value="all">
                  <ListBody
                    state={allList}
                    emptyLabel="You Have Not Reported Any Tickets Yet."
                    onOpen={openTicket}
                    onShowMore={listLimit < LIST_LIMIT_MAX ? () => setListLimit(LIST_LIMIT_MAX) : null}
                  />
                </TabsContent>
              </div>
            </Tabs>
          )}
        </div>
      ) : null}

      <button
        type="button"
        {...{ [REPORTER_ROOT_ATTR]: '' }}
        onClick={fabClick}
        onPointerDown={fabPointerDown}
        onPointerMove={fabPointerMove}
        onPointerUp={fabPointerUp}
        onPointerCancel={fabPointerUp}
        aria-label="Report An Issue"
        aria-expanded={open}
        title="Report An Issue — Drag To Move"
        // A saved spot overrides the corner classes inline; null keeps them.
        style={fabPos ? { left: fabPos.x, top: fabPos.y, right: 'auto', bottom: 'auto' } : undefined}
        className={cn(
          'fixed bottom-4 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full',
          'bg-primary text-primary-foreground shadow-lg transition-colors hover:bg-primary/90',
          // touch-none: a finger drag moves the button, not the page under it.
          'touch-none cursor-grab active:cursor-grabbing select-none',
        )}
      >
        {open
          ? <X className="h-5 w-5" aria-hidden="true" />
          : <Bug className="h-5 w-5" aria-hidden="true" />}
      </button>
    </>
  );
}
