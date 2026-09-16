'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { CallableMobile } from '@/components/calls/CallButton';
import { relativeTime } from '@/lib/utils';
import type { JobOffer, JobOffersResponse } from '@/lib/api';

/*
 * OfferHoverCard — hovering a job's status chip reveals WHO the job was offered
 * to and where each offer stands.
 *
 * The list row only carries offer COUNTS ("Offered to 3 Tx"), never a roster,
 * so the names have to be fetched. That is done LAZILY on hover and cached per
 * job for the life of the page, so a list of 50 rows costs nothing until an
 * operator actually asks about one.
 *
 * ⚠ The fetch passes `sweep=0`. GET /admin/jobs/:id/offers normally runs a lazy
 * expiry sweep of stale offers as a side effect — harmless when you clicked
 * into a job, but unacceptable on hover: pointing at a row would mutate offer
 * state and flip that row's own chip from "Offered to Tx" to "Expired/Rejected"
 * under the cursor. `sweep=0` makes the read pure.
 *
 * Renders NOTHING extra when the job has no offers — the caller passes
 * `enabled={false}` and the children render bare.
 */

const cache = new Map<number, JobOffer[]>();

/* Keep the card this far from the viewport edges. */
const VIEWPORT_EDGE = 8;

type CardPos = { top: number; left: number; placement: 'below' | 'above'; maxHeight: number | null };

export function OfferHoverCard({
  jobId,
  enabled,
  children,
}: {
  jobId: number;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<JobOffer[] | null>(() => cache.get(jobId) ?? null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);
  /*
   * Guards a late response from painting into an unmounted row.
   *
   * The `aliveRef.current = true` on the way IN is load-bearing, not belt-and-
   * braces: React StrictMode mounts, cleans up, then re-mounts in dev. Without
   * re-arming here the cleanup from that first throwaway mount left the ref
   * false forever, so every response was discarded and the card sat on
   * "Loading…" permanently.
   */
  const aliveRef = React.useRef(true);
  React.useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  /*
   * PORTALED into <body> and positioned `fixed` against the VIEWPORT — the same
   * posture as the pincodes InfoTooltip and the SearchSelect popover.
   *
   * The card used to be `absolute` under the chip, inside the list table's
   * `overflow-x-auto` wrapper — and overflow-x other than visible clips the Y
   * axis too. On the last rows it was cut off by the table's bottom edge, and
   * flipping it upwards inside that same box still cut it when the box had no
   * room either way: a one-row result (Manage Jobs, job 482502) left only the
   * header above the chip, so the card's top was sliced off. z-index does not
   * defeat overflow clipping; leaving the box does.
   *
   * Below when the screen has room; above when it doesn't and above has more;
   * clamped on screen horizontally; if neither side fits, capped to the larger
   * side and scrolls. Measured before paint (hidden on the measuring frame), and
   * again when the content resizes (Loading… → the roster).
   *
   * Hovering the card keeps it open: React synthesises mouseenter/leave along
   * the COMPONENT tree, and a portal is a child of the chip's span there. The 4px
   * gap is padding INSIDE the card's box (pt-1 / pb-1), so moving the pointer
   * from the chip onto the card never crosses dead space.
   */
  const anchorRef = React.useRef<HTMLSpanElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState<CardPos | null>(null);
  const place = React.useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    // scrollHeight is the panel's NATURAL height even while a previous
    // maxHeight is capping it; + borders + the 4px gap.
    const h = panel.scrollHeight + (panel.offsetHeight - panel.clientHeight) + 4;
    const w = panel.offsetWidth;
    const spaceBelow = window.innerHeight - a.bottom - VIEWPORT_EDGE;
    const spaceAbove = a.top - VIEWPORT_EDGE;
    const below = h <= spaceBelow || spaceBelow >= spaceAbove;
    const room = Math.max(0, below ? spaceBelow : spaceAbove);
    setPos({
      placement: below ? 'below' : 'above',
      top: below ? a.bottom : a.top - Math.min(h, room),
      left: Math.max(VIEWPORT_EDGE, Math.min(a.left, window.innerWidth - w - VIEWPORT_EDGE)),
      maxHeight: h > room ? Math.max(0, room - 4) : null,
    });
  }, []);
  React.useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
  }, [open, loading, error, items, place]);

  /*
   * A fixed card does not travel with its row, so close it when anything that
   * CONTAINS the chip scrolls (the page, the table) rather than leave it floating
   * over the wrong job. Other scrolls — the card's own roster list, a call dialog
   * opened from it — are not about this chip and must not close it. A resize
   * just re-places it.
   */
  React.useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t === document || (t instanceof Node && anchorRef.current && t.contains(anchorRef.current))) {
        setOpen(false);
      }
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  async function load() {
    if (items || loading) return;
    const cached = cache.get(jobId);
    if (cached) { setItems(cached); return; }
    setLoading(true);
    setError(false);
    try {
      const r = await api.get<JobOffersResponse>(`/admin/jobs/${jobId}/offers?sweep=0`);
      const list = r?.items ?? [];
      cache.set(jobId, list);
      if (aliveRef.current) setItems(list);
    } catch {
      if (aliveRef.current) setError(true);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }

  if (!enabled) return <>{children}</>;

  return (
    <span
      ref={anchorRef}
      className="relative inline-block"
      onMouseEnter={() => { setOpen(true); void load(); }}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && typeof document !== 'undefined' && createPortal(
        /*
         * whitespace-normal stays explicit: the card used to inherit nowrap from
         * `.data-table td`, and keeping it pins the wrapping whatever it is
         * rendered under. z-[60] clears the table's sticky columns/header and
         * the app chrome.
         */
        /*
         * `w-max` shrinks the card to its widest row instead of always painting
         * a fixed 18rem panel — a job offered to one technician was mostly empty
         * space. min-w keeps a one-word name from collapsing into a sliver, and
         * max-w stops a long name stretching it across the table.
         */
        <div
          className={`fixed z-[60] ${pos?.placement === 'above' ? 'pb-1' : 'pt-1'}`}
          style={pos
            ? { top: pos.top, left: pos.left }
            // Measuring frame: laid out off-screen and invisible, placed before paint.
            : { top: 0, left: 0, visibility: 'hidden' }}
        >
        <div
          ref={panelRef}
          className="w-max min-w-[13rem] max-w-[20rem] whitespace-normal rounded-md border border-ink-100 bg-popover p-2.5 text-left text-xs font-normal leading-relaxed text-ink-700 shadow-xl"
          style={pos?.maxHeight != null ? { maxHeight: pos.maxHeight, overflowY: 'auto' } : undefined}
        >
          <div className="mb-1.5 font-semibold text-ink-900">Offered To</div>

          {loading && <div className="py-1 text-muted-foreground">Loading…</div>}
          {error && <div className="py-1 text-urgent-strong">Could not load offers</div>}
          {!loading && !error && items && items.length === 0 && (
            <div className="py-1 text-muted-foreground">No offers on this job.</div>
          )}

          {!loading && !error && items && items.length > 0 && (
            <ul className="max-h-56 space-y-1.5 overflow-y-auto">
              {items.map((o) => (
                /* items-center (not items-start) so the leading call button sits
                   on the vertical midpoint of the two-line name + status block. */
                <li key={o.efr_id} className="flex items-center gap-2">
                  {/* Call button FIRST: calling a technician is the action ops
                      take straight off this card, so it leads the row rather
                      than trailing it. iconOnly keeps the panel narrow; the real
                      number resolves server-side from efr_id. */}
                  {o.mobile && (
                    <span className="shrink-0">
                      <CallableMobile
                        efrId={o.efr_id}
                        jobContextId={jobId}
                        mobile={o.mobile}
                        iconOnly
                      />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-ink-900">{o.efr_name}</div>
                    <div className="flex items-center gap-1.5 text-xs">
                      {o.offer_status_label && (
                        <span
                          className={
                            'font-medium '
                            + (o.offer_status === 2 ? 'text-urgent-strong'
                              : o.offer_status === 3 ? 'text-ink-500'
                                : 'text-warning-strong')
                          }
                        >
                          {o.offer_status_label}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Clock className="h-2.5 w-2.5" />
                        {relativeTime(o.offered_at)}
                        {(o.offer_count ?? 1) > 1 && <span>· ×{o.offer_count}</span>}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
