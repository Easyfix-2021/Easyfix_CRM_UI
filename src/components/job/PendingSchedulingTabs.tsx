'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFetch } from '@/lib/hooks';
import type { PsFilters } from './PendingSchedulingFilters';

/*
 * PendingSchedulingTabs — the four buckets of the scheduling queue, promoted
 * from a dropdown to a tab strip.
 *
 * WHY A STRIP AND NOT THE OLD SELECT (2026-09-16): the scheduling queue is
 * triaged by bucket, not filtered by it. "How big is my No takers pile" was
 * three clicks into a Scheduling Status dropdown that showed no counts, so
 * nobody looked — jobs nobody accepted sat in the same undifferentiated list as
 * jobs nobody had offered yet. The strip states all four totals at once.
 *
 * The values are EXACTLY the pre-existing `offerState` API contract
 * ('' | pending | offered | expired) — this is a new presentation of the filter
 * the BE already supports, not a new filter. PendingSchedulingFilters hides its
 * own Scheduling Status select on this surface (`hideOfferState`) so one state
 * has one control.
 *
 * Counts come from /admin/jobs/pending-scheduling/counts, which applies the
 * SAME predicates as the list for every param except offerState, so tab totals
 * and the table below can never disagree. A failed counts call is silent: the
 * tabs still switch, they just carry no numbers. Counting is a convenience;
 * triage must not break because one endpoint blipped.
 */

export type PsOfferState = PsFilters['offerState'];

type Counts = { all: number; pending: number; offered: number; expired: number };

/*
 * The vocabulary, fixed 2026-09-16 and shared with the Schedule & Assign
 * console so the tab an operator clicked and the state the console reports are
 * the same words. `title` is what "No takers" MEANS — the two offer outcomes it
 * gathers — kept as a tooltip rather than a longer label, so the strip stays
 * one line on a laptop.
 */
const TABS: { value: PsOfferState; label: string; key: keyof Counts; title: string }[] = [
  { value: '',        label: 'All',             key: 'all',     title: 'Every job waiting to be scheduled' },
  { value: 'pending', label: 'Unallocated',     key: 'pending', title: 'Not offered to anyone yet' },
  { value: 'offered', label: 'Offered-waiting', key: 'offered', title: 'An offer is open and unanswered' },
  { value: 'expired', label: 'No takers',       key: 'expired', title: 'Expired and rejected — offered, and no offer is still open' },
];

export function PendingSchedulingTabs({
  value, onChange, params, reloadKey, clamped,
}: {
  value: PsOfferState;
  onChange: (next: PsOfferState) => void;
  /*
   * Everything the list sends EXCEPT offerState (the tabs are the offer state)
   * and except paging/sort, which cannot change a count. The caller builds it
   * so this component never has to know the page's query shape.
   */
  params: Record<string, string | number | undefined>;
  /** Bump to recount after an action that can move a job between buckets. */
  reloadKey?: number;
  /** Job Stage Access keeps this user inside the bucket — hide the way out. */
  clamped: boolean;
}) {
  /*
   * The filters ARE the cache key: useFetch dedupes and caches module-side, so
   * flipping between tabs re-uses the counts already fetched for this filter
   * set instead of re-asking on every click (the tabs change `offerState`,
   * which this request deliberately does not carry).
   */
  const key = useMemo(() => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    return `/admin/jobs/pending-scheduling/counts${s ? `?${s}` : ''}`;
  }, [params]);

  // A failed counts call leaves `data` null — the tabs then render without
  // numbers rather than blocking triage on a blipped endpoint.
  const { data: counts, refetch } = useFetch<Counts>(key);

  // Recount after an action moved a job between buckets (see `reloadKey`).
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted px-2 py-2">
      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Scheduling buckets">
        {TABS.map((t) => {
          const active = t.value === value;
          const n = counts?.[t.key];
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              title={t.title}
              onClick={() => onChange(t.value)}
              className={[
                /* Bigger and bold, the active bucket on the theme's dark
                   surface (ops, 2026-09-17) — the strip is the first thing
                   read on the page, so it should look like the page's tabs,
                   not a row of filters. */
                'rounded-md px-4 py-2 text-base font-semibold transition-colors',
                active
                  ? 'bg-sidebar text-sidebar-foreground shadow-sm'
                  /* hover:bg-card, not bg-background: in dark mode --background
                     IS --sidebar, so hovering an idle tab painted it exactly
                     like the selected one. */
                  : 'text-foreground/75 hover:bg-card hover:text-foreground',
              ].join(' ')}
            >
              {t.label}
              {n !== undefined && (
                <span className={`ml-2 text-sm tabular-nums ${active ? 'text-sidebar-foreground/75' : 'text-muted-foreground'}`}>
                  {n.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* No "Show All Orders" here any more (ops, 2026-09-17) — the page's
          own bucket menu is the way out. The clamp note stays: it explains
          why the numbers are smaller than expected. */}
      {clamped && (
        <span className="px-2 text-xs text-muted-foreground">Limited By Your Job Stage Access</span>
      )}
    </div>
  );
}
