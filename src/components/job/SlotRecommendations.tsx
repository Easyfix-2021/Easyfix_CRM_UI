'use client';

/*
 * Best-time-slot advice for a chosen appointment date.
 *
 * Ops otherwise pick a booking window from a STATIC list with nothing to say
 * whether anyone can actually work it — the cost of which shows up later as
 * failed assignments and reschedules. The backend answers "which windows can be
 * staffed" by running the real candidate-ranking engine for the date, so this is
 * the same notion of "eligible technician" the Schedule & Assign list uses, not
 * a parallel guess.
 *
 * SHAPE: a hook plus a small presentational strip, deliberately NOT a chip row.
 * Every surface already renders its own slot chips (JobModal, the Reschedule
 * dialog, the customer job-completion form), and each renders them differently.
 * Handing back a lookup lets each one badge ITS OWN chips, so this mounts
 * unchanged wherever a slot is picked instead of forcing one chip design on all
 * of them.
 *
 * ADVISORY ONLY. Nothing here disables a chip. Ops routinely hold context the
 * engine cannot see — a customer who can only do mornings, a technician about to
 * be freed up — so a window with zero free technicians must stay selectable.
 */

import * as React from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { useFetch } from '@/lib/hooks';

export type SlotRecommendation = {
  slot: string;             // matches tbl_job.time_slot / the CRM's SLOTS values
  freeCount: number;        // eligible technicians with no clash in this window
  totalCandidates: number;
  topScore: number;
  unavailable: boolean;     // date passed, or window already over today
  reason: string | null;    // why it's poor/unavailable — shown as a tooltip
  recommended: boolean;     // the single best pick
};

type Resp = {
  date: string;
  slots: SlotRecommendation[];
  candidatePool: number;
  /*
   * FALSE for any future date. Attendance rows only exist once a technician has
   * marked in, so tomorrow's advice is eligibility + existing load, NOT a claim
   * about who will turn up. The copy below changes accordingly — overstating
   * this would be worse than staying silent.
   */
  attendanceKnown: boolean;
  note: string | null;
};

/*
 * `date` accepts either 'YYYY-MM-DD' or the datetime-local 'YYYY-MM-DDTHH:mm'
 * the pickers emit — we slice, so callers pass their field value directly.
 * Returns an empty map (not null) so callers can badge unconditionally.
 */
export function useSlotRecommendations(jobId: number | null | undefined, date: string | null | undefined) {
  const day = (date || '').slice(0, 10);
  const valid = !!jobId && /^\d{4}-\d{2}-\d{2}$/.test(day);
  const q = useFetch<Resp>(
    valid ? `/admin/jobs/${jobId}/slot-recommendations?date=${day}` : null,
    { enabled: valid },
  );

  const bySlot = React.useMemo(() => {
    const m = new Map<string, SlotRecommendation>();
    for (const s of q.data?.slots ?? []) m.set(s.slot, s);
    return m;
  }, [q.data]);

  return {
    bySlot,
    best: q.data?.slots?.find((s) => s.recommended) ?? null,
    attendanceKnown: q.data?.attendanceKnown ?? false,
    candidatePool: q.data?.candidatePool ?? 0,
    loading: q.loading,
    // A failed lookup must never block booking — callers just render no badges.
    failed: !!q.error,
  };
}

/* Small count badge for a caller's own chip. Renders nothing until data lands. */
export function SlotBadge({ rec }: { rec?: SlotRecommendation }) {
  if (!rec) return null;
  const tone = rec.unavailable
    ? 'bg-slate-100 text-slate-500'
    : rec.freeCount === 0
      ? 'bg-rose-100 text-rose-700'
      : rec.recommended
        ? 'bg-emerald-100 text-emerald-800'
        : 'bg-slate-100 text-slate-600';
  return (
    <span
      className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${tone}`}
      title={rec.reason || `${rec.freeCount} technician(s) free for this window`}
    >
      {rec.unavailable ? '—' : rec.freeCount}
    </span>
  );
}

/*
 * One-line summary under the chips. Says what the numbers MEAN, because a bare
 * count next to a chip is ambiguous — and states the attendance caveat plainly
 * for future dates rather than letting the badge imply certainty it lacks.
 */
export function SlotAdvisory({
  best, attendanceKnown, candidatePool, loading, failed,
}: {
  best: SlotRecommendation | null;
  attendanceKnown: boolean;
  candidatePool: number;
  loading: boolean;
  failed: boolean;
}) {
  if (failed) return null;
  if (loading) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking which windows can be staffed…
      </p>
    );
  }
  if (!candidatePool) {
    return (
      <p className="mt-1.5 text-xs text-amber-700">
        No eligible technician found for this job&apos;s area on this date — the counts below are all zero.
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-xs text-muted-foreground">
      {best ? (
        <span className="text-emerald-700 font-medium">
          <Sparkles className="inline h-3 w-3 mb-0.5" /> Best: {best.slot} ({best.freeCount} free)
        </span>
      ) : (
        <span className="text-amber-700">No window has a free technician on this date.</span>
      )}
      <span className="ml-1.5">
        Numbers show eligible technicians with no clash in that window
        {attendanceKnown
          ? ', based on today’s attendance.'
          : '. Attendance for a future date isn’t known yet, so this reflects skills, area and existing load.'}
      </span>
    </p>
  );
}
