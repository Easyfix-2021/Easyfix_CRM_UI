'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFetch } from '@/lib/hooks';

/*
 * PendingStartTabs — the Pending to Start queue as a tab strip, one tab per
 * state ops triage it by, with a count beside each.
 *
 * Modelled on PendingSchedulingTabs and deliberately identical to it in markup,
 * counting and failure behaviour, so the two queues an operator works through
 * back to back read as one product. It is a sibling rather than a
 * parameterisation of that component because the vocabulary, the counts
 * endpoint and the state type all differ, and that component is not ours to
 * widen.
 *
 * WHY TABS (2026-09-16): the view used to stack four independently-paged
 * sections — Technician Requests / Over Due / Action Today / Future. Reaching
 * the fourth meant scrolling past three tables, and the sections OVERLAPPED: a
 * job with an open request was listed under Technician Requests AND under its
 * appointment bucket, so the totals never added up to the queue. The tabs are a
 * partition — every job is under exactly one of them (plus All).
 *
 * The values ARE the `ptsState` contract on GET /admin/jobs; '' is All and
 * sends no ptsState at all. The SERVER owns the partition (mutually exclusive
 * by priority cancel → reschedule → missed → today → future, "today" in IST),
 * so nothing here computes a date boundary a browser timezone could move.
 *
 * Counts come from /admin/jobs/pending-start/counts, which takes the list's
 * filters minus ptsState and paging. A failed counts call is silent: the tabs
 * still switch, they just carry no numbers. Counting is a convenience; triage
 * must not break because one endpoint blipped (or has not shipped yet).
 */

export type PtsState = '' | 'missed' | 'reschedule' | 'cancel' | 'today' | 'future';

type Counts = { all: number; cancel: number; reschedule: number; missed: number; today: number; future: number };

/*
 * The strip, in the order ops asked for. Missed slots lead because they are
 * already late; the two request kinds follow because they are waiting on an
 * operator rather than on a clock; Today and Future are the queue that is
 * merely scheduled. `title` states the server's predicate as a tooltip so the
 * labels can stay short enough for one line on a laptop.
 */
const TABS: { value: PtsState; label: string; key: keyof Counts; title: string }[] = [
  { value: '',           label: 'All',                key: 'all',        title: 'Every job waiting to start' },
  { value: 'missed',     label: 'Slots missed',       key: 'missed',     title: 'Appointment was before today, and no request is open' },
  { value: 'reschedule', label: 'Reschedule request', key: 'reschedule', title: 'The technician asked from the app to move the appointment' },
  { value: 'cancel',     label: 'Cancel request',     key: 'cancel',     title: 'The technician asked from the app to cancel the order' },
  { value: 'today',      label: 'Today',              key: 'today',      title: 'Appointment is today, and no request is open' },
  { value: 'future',     label: 'Future',             key: 'future',     title: 'Appointment is tomorrow or later, and no request is open' },
];

/*
 * URL → tab. Anything that is not one of the five states resolves to All: a
 * mistyped or retired `?ptsTab=` must never silently narrow the queue to
 * nothing, which is what sending an unknown ptsState would look like.
 */
export function toPtsState(raw: string | null): PtsState {
  const hit = TABS.find((t) => t.value !== '' && t.value === raw);
  return hit ? hit.value : '';
}

export function PendingStartTabs({
  value, onChange, params, reloadKey, clamped,
}: {
  value: PtsState;
  onChange: (next: PtsState) => void;
  /*
   * Everything the list sends EXCEPT ptsState (the tabs are the state) and
   * except paging/sort, which cannot change a count. The caller builds it so
   * this component never has to know the page's query shape.
   */
  params: Record<string, string | number | undefined>;
  /** Bump to recount after an action that can move a job between tabs. */
  reloadKey?: number;
  /** Job Stage Access keeps this user inside the bucket — hide the way out. */
  clamped: boolean;
}) {
  /*
   * The filters ARE the cache key: useFetch dedupes and caches module-side, so
   * flipping between tabs re-uses the counts already fetched for this filter
   * set instead of re-asking on every click.
   */
  const key = useMemo(() => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    return `/admin/jobs/pending-start/counts${s ? `?${s}` : ''}`;
  }, [params]);

  const { data, error, refetch } = useFetch<Counts>(key);
  /*
   * No numbers on error, even when older ones are in hand. useFetch keeps the
   * previous key's data through a failed request, so after a filter change a
   * blipped call would otherwise leave the LAST filter set's totals beside tabs
   * that now list something else. No count is honest; a wrong one is not.
   */
  const counts = error ? null : data;

  // Recount after an action moved a job between tabs (see `reloadKey`).
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted px-2 py-2">
      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Pending to start states">
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
              {n != null && (
                <span className={`ml-2 text-sm tabular-nums ${active ? 'text-sidebar-foreground/75' : 'text-muted-foreground'}`}>
                  {n.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* No "Show All Orders" (ops, 2026-09-17) — same strip as Pending for
          Scheduling. The clamp note stays. */}
      {clamped && (
        <span className="px-2 text-xs text-muted-foreground">Limited By Your Job Stage Access</span>
      )}
    </div>
  );
}
