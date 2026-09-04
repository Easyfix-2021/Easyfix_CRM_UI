'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GripVertical, ChevronDown, ChevronRight } from 'lucide-react';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { buildJobsKey } from '@/lib/jobs-query';
import { reorder } from '@/lib/reorder';
import { StatusChip } from '@/components/ui/StatusChip';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { UnconfirmedJobsTable, type UnconfirmedJobRow } from './UnconfirmedJobsTable';
import type { ComponentProps } from 'react';

/*
 * My Orders -> Unconfirmed, split into five independently-paged sections.
 *
 * WHAT CHANGED, AND WHY IT HAD TO. The first cut took the page's current page
 * of rows and grouped them in the browser. That is wrong in a way a screenshot
 * makes obvious: with 84 matching orders the headings read 0 / 0 / 2 / 8 / 0 —
 * they summed to TEN, the page size, not to 84. A section was never showing
 * "the Overdue jobs"; it was showing "the Overdue jobs that happened to fall on
 * page 1", and paging the shared footer reshuffled every heading. Counts that
 * look authoritative and are not are worse than no counts.
 *
 * So each section now runs its OWN query against /admin/jobs with `section=`
 * and its own limit/offset, exactly as PendingToStartView's three appointment
 * buckets do. That buys three things the grouped version could not have:
 *   - `total` is the section's real total, so the chip is the whole book;
 *   - a section can page past what is on screen;
 *   - the page's search box reaches every section and every page, because `q`
 *     goes to the server rather than filtering an already-truncated array.
 *
 * MEMBERSHIP IS STILL THE SERVER'S. The predicate lives in
 * client-request.service.js (sectionPredicate) beside the JS classifier it
 * mirrors, and check:sections compares the two over the real book.
 *
 * ORDER AND COLLAPSE ARE THE OPERATOR'S, and live in localStorage: per-viewer
 * display preferences, wanted next visit, never needed by the server. Reads are
 * wrapped because localStorage THROWS in a private window and in browsers with
 * site data blocked — an unguarded read there takes the page down to fix the
 * order of some headings.
 */

// `/admin/jobs` Joi caps limit at 500, so "All" must send 500 and not the
// helper's 1000 default (which 400s). Same value as /my-orders and /jobs.
const JOBS_MAX_LIMIT = 500;

const ORDER_KEY = 'easyfix.crm.unconfirmed.sectionOrder.v1';
/*
 * Collapsed state, stored SEPARATELY from the order. One combined blob would
 * mean a change to either shape invalidates both, and an operator who had
 * carefully arranged their order would lose it to a change in how collapse is
 * remembered.
 *
 * The stored value is the COLLAPSED set, not the expanded one, because
 * everything is expanded by default: an absent key, a corrupt value and a
 * first-ever visit then all mean the same correct thing. Storing "expanded"
 * would make a section added later arrive collapsed and invisible.
 */
const COLLAPSED_KEY = 'easyfix.crm.unconfirmed.sectionCollapsed.v1';

// How long a section takes to slide to its new place after a reorder.
const REORDER_MS = 220;

type Section = { key: string; label: string };
type MetaResp = { meta: Section[] };
type Resp = { items: UnconfirmedJobRow[]; total: number; limit: number; offset: number };
type TableProps = ComponentProps<typeof UnconfirmedJobsTable>;
/*
 * The tab's request shape, built ONCE by the page (status pin, owner scope,
 * search, sort) and extended here with `section` + this section's page window.
 * Passing the whole object rather than named props means a filter the page adds
 * later reaches all five sections without touching this file.
 */
type JobsQuery = Record<string, string | number | undefined>;

/*
 * Reconcile a saved order against the sections that actually exist.
 *
 * Not `stored ?? server` — a saved array is a snapshot of the sections that
 * existed the day it was saved. Trusting it wholesale means a section added
 * later never renders, and one removed later leaves an empty heading forever.
 * Both failures are silent, and the first hides a whole bucket of jobs.
 */
function reconcile(stored: unknown, meta: Section[]): Section[] {
  const known = new Map(meta.map((m) => [m.key, m]));
  const seen = new Set<string>();
  const out: Section[] = [];
  if (Array.isArray(stored)) {
    for (const k of stored) {
      const m = typeof k === 'string' ? known.get(k) : undefined;
      if (m && !seen.has(m.key)) { out.push(m); seen.add(m.key); }
    }
  }
  for (const m of meta) if (!seen.has(m.key)) out.push(m);
  return out;
}

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : []);
  } catch {
    // Private window, blocked site data, corrupt JSON — all expanded, which is
    // the documented default and a correct page.
    return new Set();
  }
}

function loadOrder(meta: Section[]): Section[] {
  try {
    const raw = window.localStorage.getItem(ORDER_KEY);
    return reconcile(raw ? JSON.parse(raw) : null, meta);
  } catch {
    return meta;
  }
}

export function UnconfirmedSections({
  query,
  onMagicLinkSent,
  ...tableProps
}: Omit<TableProps, 'rows' | 'loading'> & { query: JobsQuery }) {
  /*
   * The section LIST comes from the server so a sixth section is a backend
   * change, not a frontend deploy. Sent without `ids`, which the endpoint
   * answers from SECTION_META alone — no query, no rows.
   */
  const metaReq = useFetch<MetaResp>('/admin/jobs/unconfirmed-sections');
  const meta = metaReq.data?.meta;

  const [order, setOrder] = useState<Section[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  /*
   * Post-mutation refresh signal.
   *
   * ⚠ invalidateFetch ALONE DOES NOT REFRESH A MOUNTED SECTION, which is the
   * trap this exists to close. It evicts the module-level cache and notifies
   * `invalidationListeners` — but only useFetchOnce subscribes to those.
   * useFetch re-runs on `[key, enabled, tick]`, and an eviction changes
   * neither: the key is a pure function of the query, so after a magic-link
   * send or a reschedule it is byte-identical and the effect never re-runs.
   * Eviction only helps a LATER mount, and these sections never unmount.
   *
   * Before this component fetched its own rows, the page's own reload was
   * enough — the rows on screen were the page's rows. Now they are not, so
   * without this bump the "Link Sent" pill never appears (inviting a duplicate
   * send) and a rescheduled job keeps its old date and stays in the wrong
   * section until the operator changes page, search, sort or tab.
   *
   * PendingToStartView solves it exactly this way; see its bumpReload().
   */
  const [reloadKey, setReloadKey] = useState(0);
  function handleMutation() {
    invalidateFetch((k) => k.startsWith('/admin/jobs'));
    setReloadKey((k) => k + 1);
    // Still tell the page: its own query feeds the "N matching orders" header,
    // and a mutation can change that count.
    onMagicLinkSent?.();
  }

  // Read once on mount — localStorage exists only in the browser, and reading
  // it during render would differ between the server pass and the client one.
  useEffect(() => { setCollapsed(loadCollapsed()); }, []);

  useEffect(() => {
    if (meta?.length) {
      setOrder((prev) => (prev.length ? reconcile(prev.map((s) => s.key), meta) : loadOrder(meta)));
    }
  }, [meta]);

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch { /* applies for this visit; just will not survive a reload */ }
      return next;
    });
  }

  function persist(next: Section[]) {
    setOrder(next);
    try {
      window.localStorage.setItem(ORDER_KEY, JSON.stringify(next.map((s) => s.key)));
    } catch {
      // Losing a display preference is not worth failing the interaction over.
    }
  }

  /* ── Reordering ──────────────────────────────────────────────────────
   *
   * THE BUG THIS REPLACES. The old handler inserted the dragged section at the
   * index of whatever it was dropped on, with no adjustment:
   *
   *     const at = next.findIndex(s => s.key === targetKey);
   *     next.splice(at, 0, moved);
   *
   * Two things are wrong there, and together they explain "sometimes it lands
   * in the wrong place":
   *
   *   1. It always inserts BEFORE the target. Drag section 1 down onto section
   *      3 and it lands at position 2 — before the thing you dropped it on.
   *      Dragging UP behaves as expected, so the error is asymmetric, which is
   *      exactly what makes it feel random rather than broken.
   *   2. Removing the source first shifts every later index down by one, and
   *      nothing compensated for that. So a downward move was off by one twice.
   *
   * The fix is to stop deriving the destination from "which element got the
   * drop" and derive it from WHERE THE POINTER IS: above a card's midpoint
   * means before it, below means after it. That index is then shown as a live
   * insertion bar, so the landing place is visible during the drag rather than
   * discovered after it.
   */
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  // Live DOM nodes, for measuring the slide (below).
  const nodes = useRef(new Map<string, HTMLElement>());
  const firstTops = useRef<Map<string, number> | null>(null);

  /*
   * FLIP (First, Last, Invert, Play). Reordering an array remounts nothing and
   * animates nothing — the cards simply appear in new places, and with five
   * headings of similar shape it is genuinely hard to see WHICH one moved.
   *
   * So: record every card's y BEFORE the state change, let React lay the new
   * order out, then translate each card back to where it was and release it.
   * The browser animates the transform, so the cards slide past each other and
   * the one that moved is obvious. Done with two style writes rather than a
   * drag-and-drop dependency.
   */
  function measureBefore() {
    const m = new Map<string, number>();
    for (const [k, el] of nodes.current) m.set(k, el.getBoundingClientRect().top);
    firstTops.current = m;
  }

  useLayoutEffect(() => {
    const first = firstTops.current;
    firstTops.current = null;
    if (!first) return;
    // Respect the OS setting: the reorder still happens, it just happens at once.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    // INVERT — put every card back where it was, with no transition, before
    // the browser has painted the new layout.
    const moved: HTMLElement[] = [];
    for (const [k, el] of nodes.current) {
      const was = first.get(k);
      if (was == null) continue;
      const delta = was - el.getBoundingClientRect().top;
      if (!delta) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${delta}px)`;
      moved.push(el);
    }
    if (!moved.length) return;

    // PLAY — next frame, release them.
    const raf = requestAnimationFrame(() => {
      for (const el of moved) {
        el.style.transition = `transform ${REORDER_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
        el.style.transform = '';
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [order]);

  /*
   * `to` is an insertion index in the CURRENT order — the gap the bar is drawn
   * in. The arithmetic itself lives in lib/reorder.ts, where it is unit-tested
   * against the exact case that was broken; see the note there.
   */
  function move(fromKey: string, to: number) {
    const from = order.findIndex((s) => s.key === fromKey);
    const next = reorder(order, from, to);
    // reorder() returns a copy either way; only animate and store a real move.
    if (next.every((s, i) => s.key === order[i].key)) return;
    measureBefore();
    persist(next);
  }

  function endDrag() { setDragKey(null); setDropAt(null); }

  function onDrop() {
    if (dragKey && dropAt != null) move(dragKey, dropAt);
    endDrag();
  }

  /*
   * Keyboard reordering, which the drag handle did not have. It is the
   * accessible path, and it is also the precise one — the complaint that
   * started this was about a drag landing somewhere unintended, and arrow keys
   * cannot miss. Same move(), so the slide animates identically.
   */
  function onGripKey(e: React.KeyboardEvent, idx: number, key: string) {
    const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    // move() takes an insertion index: one step down is "past the next card",
    // which is idx + 2 before the source is removed.
    move(key, dir < 0 ? idx - 1 : idx + 2);
  }

  // A bar drawn where the section would land. Suppressed when the drop would be
  // a no-op (either side of the dragged card), so it never promises a move that
  // will not happen.
  function Indicator({ at }: { at: number }) {
    if (dragKey == null || dropAt !== at) return null;
    const from = order.findIndex((s) => s.key === dragKey);
    if (at === from || at === from + 1) return null;
    return (
      <div className="mx-3 mb-3 h-1 rounded-full bg-primary" aria-hidden />
    );
  }

  if (metaReq.error) {
    return (
      <div className="px-4 py-3 text-xs text-warning-strong bg-warning-tint">
        The section list could not be loaded, so Unconfirmed orders cannot be grouped.
        Reload the page to try again.
      </div>
    );
  }

  return (
    // pt-3 so the first card is not flush against the toolbar above it; each
    // card carries its own mb-3, so the last supplies the bottom gap.
    <div
      className="flex flex-col pt-3"
      onDragOver={(e) => { if (dragKey) e.preventDefault(); }}
      onDrop={onDrop}
    >
      {order.map((s, idx) => (
        <div key={s.key}>
          <Indicator at={idx} />
          <SectionCard
            section={s}
            index={idx}
            query={query}
            collapsed={collapsed.has(s.key)}
            onToggle={() => toggle(s.key)}
            dragging={dragKey === s.key}
            onDragStart={() => { setDragKey(s.key); setDropAt(idx); }}
            onDragEnd={endDrag}
            onDragOverCard={(after) => { if (dragKey) setDropAt(idx + (after ? 1 : 0)); }}
            onGripKey={(e) => onGripKey(e, idx, s.key)}
            registerNode={(el) => {
              if (el) nodes.current.set(s.key, el); else nodes.current.delete(s.key);
            }}
            reloadKey={reloadKey}
            onMagicLinkSent={handleMutation}
            tableProps={tableProps}
          />
        </div>
      ))}
      <Indicator at={order.length} />
    </div>
  );
}

/*
 * One section: its own page window, its own query, its own footer.
 *
 * Split into a component because each section needs independent `page` /
 * `pageSize` state, and hooks cannot be called in a loop inside the parent.
 * Same reason PendingToStartView has a per-bucket component.
 */
function SectionCard({
  section, index, query, collapsed, onToggle, dragging,
  onDragStart, onDragEnd, onDragOverCard, onGripKey, registerNode,
  reloadKey, onMagicLinkSent, tableProps,
}: {
  section: Section;
  index: number;
  query: JobsQuery;
  collapsed: boolean;
  onToggle: () => void;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverCard: (after: boolean) => void;
  onGripKey: (e: React.KeyboardEvent) => void;
  registerNode: (el: HTMLElement | null) => void;
  reloadKey: number;
  onMagicLinkSent?: TableProps['onMagicLinkSent'];
  tableProps: Omit<TableProps, 'rows' | 'loading' | 'onMagicLinkSent'>;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  const limit = pageSizeToLimit(pageSize, JOBS_MAX_LIMIT);

  /*
   * A COLLAPSED section still needs its count — that is most of the point of
   * collapsing one — but not its rows. limit=1 fetches the `total` the chip
   * shows without pulling a page of records nothing will render. Expanding
   * changes the key, so the real page is fetched then.
   */
  const key = buildJobsKey({
    ...query,
    section: section.key,
    limit: collapsed ? 1 : limit,
    offset: collapsed ? 0 : page * limit,
  });
  const { data, loading, refetch } = useFetch<Resp>(key);

  /*
   * A filter or search change makes the current page number meaningless — page
   * 4 of a 60-row section is empty once a search narrows it to 8. Reset to the
   * first page, but NOT on the initial render, which would fight the mount.
   * Keyed on a serialised copy because `query` is a fresh object every render.
   */
  const queryKey = JSON.stringify(query);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setPage(0);
  }, [queryKey]);

  // Refetch when the parent signals a mutation. Skips the initial render,
  // which the key-driven fetch above already covers.
  const firstReload = useRef(true);
  useEffect(() => {
    if (firstReload.current) { firstReload.current = false; return; }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <section
      ref={registerNode}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        // Which HALF the pointer is in decides before-or-after. Deriving it
        // from the pointer rather than from the drop target is what makes a
        // downward drag land where it looks like it will.
        onDragOverCard(e.clientY > r.top + r.height / 2);
      }}
      className={`mx-3 mb-3 rounded-lg border border-ink-100 overflow-hidden bg-surface transition-opacity ${
        dragging ? 'opacity-40' : ''
      }`}
    >
      <header
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="flex items-center gap-2 px-3 py-2 bg-surface-alt select-none"
      >
        {/* The GRIP is the drag handle, and only the grip. Making the whole
            header draggable meant a click that moved a pixel started a drag
            instead of toggling — the two gestures fought for one target.
            It is a real button so it can be tabbed to and moved with arrows. */}
        <button
          type="button"
          onKeyDown={onGripKey}
          aria-label={`Reorder ${section.label}: press the up or down arrow key to move this section`}
          title="Drag, or focus and use the arrow keys, to reorder"
          className="cursor-grab active:cursor-grabbing text-ink-300 hover:text-ink-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
        >
          <GripVertical className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 flex-1 text-left"
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed
            ? <ChevronRight className="w-4 h-4 text-ink-500" aria-hidden />
            : <ChevronDown className="w-4 h-4 text-ink-500" aria-hidden />}
          <span className="text-sm font-semibold text-ink-900">{section.label}</span>
          {/* An em dash while the count is unknown — a 0 that means "not
              loaded yet" is indistinguishable from a 0 that means "empty". */}
          <StatusChip tone="info" size="sm">{data ? String(total) : '—'}</StatusChip>
        </button>
        <span className="text-xs text-ink-400">{index + 1}</span>
      </header>

      {collapsed ? null : (
        <>
          <div className="overflow-x-auto">
            <UnconfirmedJobsTable
              rows={rows}
              loading={loading}
              onMagicLinkSent={onMagicLinkSent}
              {...tableProps}
            />
          </div>
          {/* Its own footer, over its own total — the whole point of the
              change. Rendered only once a response has arrived so it never
              shows "1 / 0" against an unknown total. */}
          {data && total > 0 && (
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            />
          )}
        </>
      )}
    </section>
  );
}
