'use client';

import * as React from 'react';
import Link from 'next/link';
import { Megaphone, Pin, ChevronDown, Image as ImageIcon, Radio, List } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useFetch } from '@/lib/hooks';
import { parseIstDateTime } from '@/lib/format';
import { useMe } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { NoticeCategoryTag } from './NoticeChip';
import { NoticeDetailModal } from './NoticeDetailModal';
import type { Notice } from '@/lib/notice-types';

/*
 * Notice Board — dashboard banner list.
 *
 * Design changed 2026-05-22 from the older "collapsed chip strip" to
 * a vertical list of full-width banners. Each banner is the notice
 * TITLE (the operator's most-readable identifier) plus the category
 * tag + an unread dot. Clicking a banner opens the detail modal
 * which shows the full body + image gallery.
 *
 * Why banners (not chips):
 *   - Operators kept missing notices behind the collapsed strip.
 *   - The spec wireframe shows the consuming-surface UX as a stack
 *     of banner-style rows; matching that here keeps CRM ops aligned
 *     with what app users see.
 *   - Title text is more scannable than a coloured chip when the
 *     operator is busy.
 *
 * Visible-row cap: top 3 banners always render; if there are more,
 * a "Show More" toggle expands the rest. Pinned notices always sort
 * to the top of the list (BE-side via is_pinned DESC).
 */

type Resp = { items: Notice[] };
const VISIBLE_DEFAULT = 3;

/* Format the publish_at moment to a short "DD MMM" / "Today" / "Yesterday".
 * Anything older than 7 days falls back to "DD MMM" so the line stays compact. */
/*
 * "Today" means today IN IST, on both sides of the comparison.
 *
 * This compared LOCAL calendar fields of a value that is an IST wall clock
 * against the browser's own local today, so the label slipped by a day around
 * midnight for anyone outside IST. Converting only the parse would not have
 * fixed it — a correct instant compared with local getters is still the wrong
 * calendar. Both operands have to be reduced to the same IST day.
 *
 * 'en-CA' because it formats as YYYY-MM-DD, which compares as a string.
 */
const IST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
const istDay = (d: Date) => IST_DAY.format(d);

function compactDate(value: string | null): string {
  if (!value) return '';
  const d = parseIstDateTime(value);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const day = istDay(d);
  if (day === istDay(now)) return 'Today';
  if (day === istDay(new Date(now.getTime() - 86_400_000))) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
}

/* A single banner row. Category colour drives the left-border stripe
 * so the operator picks up severity at a glance even with peripheral
 * vision. Title truncates with ellipsis on narrow viewports. */
function NoticeBanner({
  notice,
  onClick,
}: {
  notice: Notice;
  onClick: () => void;
}) {
  const color = /^#[0-9a-fA-F]{6}$/.test(notice.category_color)
    ? notice.category_color
    : 'hsl(var(--neutral))';
  const hasImages = Array.isArray(notice.images) && notice.images.length > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-2.5 text-left bg-card hover:bg-muted/40 transition-colors border-l-4"
      style={{ borderLeftColor: color }}
    >
      {notice.is_pinned ? (
        <Pin className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="Pinned" />
      ) : null}

      <NoticeCategoryTag name={notice.category_name} color={notice.category_color} />

      <span className="text-sm font-medium flex-1 min-w-0 truncate">
        {notice.title}
      </span>

      {hasImages && (
        <span
          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground shrink-0"
          title={`${notice.images.length} image${notice.images.length === 1 ? '' : 's'} attached`}
        >
          <ImageIcon className="h-3 w-3" />
          {notice.images.length}
        </span>
      )}

      {!notice.is_read && (
        <span
          aria-label="Unread"
          className="inline-block h-2 w-2 rounded-full bg-info shrink-0"
        />
      )}

      <span className="text-xs text-muted-foreground tabular-nums shrink-0 min-w-[3.5rem] text-right">
        {compactDate(notice.publish_at)}
      </span>
    </button>
  );
}

const VIEW_KEY = 'notice_strip_view_v1';

export function NoticeStrip() {
  const { me } = useMe();
  const canManage = hasAction(me, 'isNoticeManage');

  const fetched = useFetch<Resp>('/admin/notices/active?surface=crm&limit=20');
  const items = fetched.data?.items ?? [];
  const unreadCount = items.filter((n) => !n.is_read).length;

  const [showAll, setShowAll] = React.useState(false);
  const [openNotice, setOpenNotice] = React.useState<Notice | null>(null);
  /*
   * List ⇄ ticker view. Persisted per browser so an operator's choice survives
   * navigation. Initialised in an effect rather than useState's initialiser
   * because localStorage is unavailable during SSR — reading it inline would
   * hydrate-mismatch the server's 'list' render.
   */
  const [mode, setMode] = React.useState<'list' | 'ticker'>('list');
  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
      if (saved === 'ticker' || saved === 'list') setMode(saved);
    } catch { /* private mode — keep the default */ }
  }, []);
  function toggleMode() {
    setMode((m) => {
      const next = m === 'list' ? 'ticker' : 'list';
      try { window.localStorage.setItem(VIEW_KEY, next); } catch { /* non-fatal */ }
      return next;
    });
  }

  const visibleCount = showAll ? items.length : VISIBLE_DEFAULT;
  const visible = items.slice(0, visibleCount);
  const hiddenCount = Math.max(0, items.length - VISIBLE_DEFAULT);

  return (
    <Card className="overflow-hidden">
      {/* Card header — purely informational. No expand/collapse toggle
          on the header anymore (banners are rendered inline directly).
          The View All link routes to the management page for users with
          isNoticeManage; everyone else just sees the header. */}
      <div className="flex items-center gap-3 px-4 py-2 border-b bg-muted/20">
        <Megaphone className="h-4 w-4 text-info shrink-0" />
        <span className="text-sm font-semibold flex-1 min-w-0 truncate">
          Notice Board
          {items.length > 0 && (
            <span className="font-normal text-muted-foreground">
              {' '}· {items.length} active
              {unreadCount > 0 && (
                <>
                  {' '}·{' '}
                  <span className="text-urgent-strong font-medium">{unreadCount} unread</span>
                </>
              )}
            </span>
          )}
        </span>
        {items.length > 0 && (
          <button
            type="button"
            onClick={toggleMode}
            title={mode === 'list' ? 'Switch to ticker view' : 'Switch to list view'}
            aria-label={mode === 'list' ? 'Switch to ticker view' : 'Switch to list view'}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            {mode === 'list' ? <Radio className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
          </button>
        )}
        {canManage && items.length > 0 && (
          <Link
            href="/notice-board"
            className="text-xs font-medium text-primary hover:text-brand-700 shrink-0"
          >
            View All →
          </Link>
        )}
      </div>

      {/* Loading skeleton — 3 banner placeholders. */}
      {fetched.loading && (
        <div className="divide-y">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-l-4 border-muted">
              <div className="h-4 w-16 rounded bg-muted animate-pulse" />
              <div className="h-4 flex-1 rounded bg-muted animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {/* Empty state — single quiet line. CTA intentionally NOT here per
          UI ops 2026-05-22; creation lives only in /notice-board. */}
      {!fetched.loading && items.length === 0 && (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          No Active Notices
        </div>
      )}

      {/* Ticker view — one continuous line instead of stacked banners. Ambient:
          it surfaces every active notice in the height of a single row, which
          is what ops wanted on a dashboard already dense with cards. The track
          is rendered TWICE so the -50% translate loops seamlessly; hovering
          pauses it (see .nb-ticker-wrap in globals.css) so a passing headline
          can actually be read and clicked. */}
      {!fetched.loading && items.length > 0 && mode === 'ticker' && (
        <div className="nb-ticker-wrap overflow-hidden py-2.5">
          <div className="nb-ticker gap-8 px-4">
            {[0, 1].map((copy) => (
              <React.Fragment key={copy}>
                {items.map((n) => (
                  <button
                    key={`${copy}-${n.notice_id}`}
                    type="button"
                    onClick={() => setOpenNotice(n)}
                    // aria-hidden on the duplicate track: it exists purely to
                    // make the loop seamless, so screen readers should not
                    // announce every notice twice.
                    aria-hidden={copy === 1}
                    tabIndex={copy === 1 ? -1 : 0}
                    className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm hover:underline"
                  >
                    {!n.is_read && <span className="h-2 w-2 shrink-0 rounded-full bg-info" />}
                    <span className="font-medium">{n.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {compactDate(n.publish_at)}
                    </span>
                  </button>
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {/* Banner list. Each row is its own click target → detail modal. */}
      {!fetched.loading && items.length > 0 && mode === 'list' && (
        <div className="divide-y">
          {visible.map((n) => (
            <NoticeBanner
              key={n.notice_id}
              notice={n}
              onClick={() => setOpenNotice(n)}
            />
          ))}
        </div>
      )}

      {/* Show more — collapsed by default when > VISIBLE_DEFAULT.

          The hover tint is (c) a HOVER-ONLY fix: resting, the row is bare on the
          card and `text-primary` is a stable brand red (45.49% in both themes),
          so only the hover moved. `bg-muted/40` inverts — 90.59% under :root,
          39.02% under .dark — and at 40% over the card that dragged the label
          from 5.29:1 to 1.53:1 in dark, i.e. red on a plate that had climbed to
          meet it. There is no stable near-white neutral to swap in (the stable
          set tops out at --sidebar-foreground, 63.33%), so the hover instead
          uses the label's OWN stable token as a 10% wash: it reads as a tint of
          the affordance in either theme and leaves the label essentially at its
          resting contrast (light 5.77 -> 4.91, dark 1.96 -> 1.91) rather than
          collapsing it. Light theme does change — a faint brand tint where a
          neutral grey used to be — which (c) permits; only (a) swaps must be
          pixel-identical, and no (a) swap exists here. */}
      {!fetched.loading && mode === 'list' && hiddenCount > 0 && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full px-4 py-2 text-xs font-medium text-primary dark:text-brand-700 hover:bg-muted/40 flex items-center justify-center gap-1 border-t"
        >
          Show {hiddenCount} More <ChevronDown className="h-3 w-3" />
        </button>
      )}

      {/* onRead re-requests the active list the moment the BE records the
          read, so the blue unread dot and the "N unread" counter in the header
          clear immediately. Without it the modal's cache eviction never reached
          this mounted useFetch and the count only updated on a page reload. */}
      <NoticeDetailModal
        notice={openNotice}
        open={openNotice !== null}
        onClose={() => setOpenNotice(null)}
        onRead={() => fetched.refetch()}
      />
    </Card>
  );
}
