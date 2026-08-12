'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { useFetch } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { NoticeDetailModal } from './NoticeDetailModal';
import type { Notice } from '@/lib/notice-types';

/*
 * NoticeFlash — pops UNREAD notices at the operator automatically instead of
 * waiting for them to notice the dashboard strip.
 *
 * Mounted once at the authed root, so it runs on login and on every in-app
 * navigation ("when the user changes any tab").
 *
 * Rules:
 *   - Only notices that are still unread FOR THIS USER are flashed.
 *   - They flash ONE AT A TIME: closing the current card reveals the next, so
 *     three new notices produce three cards in sequence rather than a pile.
 *   - A notice is never flashed twice. Opening the modal marks it read
 *     server-side (NoticeDetailModal does this), which removes it from the
 *     next fetch; the session-scoped `seen` set below covers the window before
 *     that write lands — and the case where it fails outright, so a broken
 *     mark-read can't turn into an infinite popup on every route change.
 *
 * Deliberately does NOT own a fetch of its own beyond the shared active-notices
 * key: `useFetch` dedupes and caches module-side, so the dashboard strip and
 * this component share one request.
 */

type Resp = { items: Notice[] };

const SEEN_KEY = 'notice_flash_seen_v1';
/*
 * Re-check for newly published notices at most this often. Without a throttle a
 * click-heavy operator would fire a request per navigation; 60s is well under
 * how quickly anyone needs to see a new broadcast.
 */
const RECHECK_MS = 60_000;

function readSeen(): Set<number> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.sessionStorage.getItem(SEEN_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : []);
  } catch {
    return new Set();
  }
}

function markSeen(id: number) {
  if (typeof window === 'undefined') return;
  try {
    const next = readSeen();
    next.add(id);
    window.sessionStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(next)));
  } catch {
    // sessionStorage can throw in private modes — the server-side read flag is
    // the durable guard, so losing this is not fatal.
  }
}

export function NoticeFlash() {
  const pathname = usePathname();
  const fetched = useFetch<Resp>('/admin/notices/active?surface=crm&limit=20');
  const [queue, setQueue] = React.useState<Notice[]>([]);
  /*
   * How many cards this burst started with, so the deck can read "2 of 3" as
   * the operator steps through. Reset once the last card is dismissed, so a
   * later burst counts from 1 again rather than continuing the old total.
   */
  const [burstTotal, setBurstTotal] = React.useState(0);

  // Re-check on navigation, throttled. `refetch` is stable enough for this use;
  // the ref keeps the last-checked stamp out of the dependency list.
  const lastCheckRef = React.useRef(0);
  const refetchRef = React.useRef(fetched.refetch);
  refetchRef.current = fetched.refetch;
  React.useEffect(() => {
    const now = Date.now();
    if (now - lastCheckRef.current < RECHECK_MS) return;
    lastCheckRef.current = now;
    refetchRef.current();
  }, [pathname]);

  // Fold newly-arrived unread notices into the queue. Pinned first, then the
  // API's own order (newest first), so the most important card leads.
  React.useEffect(() => {
    const items = fetched.data?.items;
    if (!items || items.length === 0) return;
    const seen = readSeen();
    const pending = items
      .filter((n) => !n.is_read && !seen.has(n.notice_id))
      .sort((a, b) => Number(!!b.is_pinned) - Number(!!a.is_pinned));
    if (pending.length === 0) return;
    setQueue((prev) => {
      // Merge without disturbing a card the operator is already reading.
      const known = new Set(prev.map((n) => n.notice_id));
      const additions = pending.filter((n) => !known.has(n.notice_id));
      if (additions.length === 0) return prev;
      setBurstTotal((t) => t + additions.length);
      return [...prev, ...additions];
    });
  }, [fetched.data]);

  const current = queue[0] ?? null;

  function dismissCurrent() {
    if (current) markSeen(current.notice_id);
    setQueue((prev) => {
      const next = prev.slice(1);
      if (next.length === 0) setBurstTotal(0);
      return next;
    });
  }

  if (!current) return null;

  const remaining = queue.length;
  const position = Math.max(1, burstTotal - remaining + 1);
  const isDeck = burstTotal > 1;

  return (
    <NoticeDetailModal
      notice={current}
      open
      onClose={dismissCurrent}
      // The modal marks it read; refresh the shared list so the dashboard
      // strip's unread dot + counter drop without a reload.
      onRead={() => fetched.refetch()}
      // Stacked-paper edges hint that more cards are waiting behind this one.
      stackDepth={Math.min(2, remaining - 1)}
      footer={isDeck
        ? ({ buttonClass }) => (
          <div className="flex items-center justify-between border-t px-6 py-4">
            <div className="flex items-center gap-2.5">
              <div className="flex gap-1.5">
                {/* Capped at 5 dots — beyond that the "N of M" text carries
                    the count and a longer dot row just becomes noise. */}
                {queue.slice(0, 5).map((n, i) => (
                  <span
                    key={n.notice_id}
                    className={`h-2 w-2 rounded-full ${i === 0 ? 'bg-sky-600' : 'bg-slate-300'}`}
                  />
                ))}
              </div>
              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                {position} of {burstTotal}
              </span>
            </div>
            <Button
              type="button"
              onClick={dismissCurrent}
              autoFocus
              className={`h-10 min-w-[8rem] rounded-lg px-6 text-sm font-semibold ${buttonClass}`}
            >
              {remaining > 1 ? 'Next →' : 'Done'}
            </Button>
          </div>
        )
        : undefined}
    />
  );
}
