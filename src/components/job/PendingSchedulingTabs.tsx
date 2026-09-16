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

const TABS: { value: PsOfferState; label: string; key: keyof Counts }[] = [
  { value: '',        label: 'All',             key: 'all' },
  { value: 'pending', label: 'Not offered',     key: 'pending' },
  { value: 'offered', label: 'Offered-waiting', key: 'offered' },
  { value: 'expired', label: 'No takers',       key: 'expired' },
];

export function PendingSchedulingTabs({
  value, onChange, params, reloadKey, clamped, onShowAll,
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
  onShowAll: () => void;
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
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
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
              onClick={() => onChange(t.value)}
              className={[
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                active
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
              ].join(' ')}
            >
              {t.label}
              {n !== undefined && (
                <span className={`ml-1.5 text-xs tabular-nums ${active ? 'text-muted-foreground' : 'text-muted-foreground/80'}`}>
                  {n.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {clamped ? (
        <span className="px-2 text-xs text-muted-foreground">Limited By Your Job Stage Access</span>
      ) : (
        <button type="button" onClick={onShowAll} className="px-2 text-xs hover:underline">
          Show All Orders
        </button>
      )}
    </div>
  );
}
