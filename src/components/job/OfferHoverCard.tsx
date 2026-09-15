'use client';

import * as React from 'react';
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
      className="relative inline-block"
      onMouseEnter={() => { setOpen(true); void load(); }}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && (
        /*
         * whitespace-normal is REQUIRED: `.data-table td` sets nowrap and the
         * panel inherits it, which would run every line off the edge. z-50 to
         * clear the table's sticky columns/header.
         */
        /*
         * `w-max` shrinks the card to its widest row instead of always painting
         * a fixed 18rem panel — a job offered to one technician was mostly empty
         * space. min-w keeps a one-word name from collapsing into a sliver, and
         * max-w stops a long name stretching it across the table.
         */
        <div className="absolute left-0 top-full z-50 mt-1 w-max min-w-[13rem] max-w-[20rem] whitespace-normal rounded-md border border-ink-100 bg-popover p-2.5 text-left text-xs font-normal leading-relaxed text-ink-700 shadow-xl">
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
      )}
    </span>
  );
}
