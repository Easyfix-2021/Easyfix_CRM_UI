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
import { publicFetch } from '@/lib/public-fetch';

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

// Slim, leak-free shape the token-gated /public endpoint returns — only the
// best slot LABEL plus the two flags SlotAdvisory's copy needs. The per-slot
// counts and the raw candidatePool are deliberately NOT sent to the
// unauthenticated client (see routes/public/job-completion.js).
type PublicResp = {
  date: string;
  best: { slot: string } | null;
  hasCandidatePool: boolean;
  attendanceKnown: boolean;
};

// Stable empty lookup for the public branch. The customer form badges no
// individual chips (`bySlot` exists only for JobModal's per-chip badging), so
// an empty map is the correct, allocation-free value to hand back there.
const EMPTY_SLOT_MAP = new Map<string, SlotRecommendation>();

/*
 * `date` accepts either 'YYYY-MM-DD' or the datetime-local 'YYYY-MM-DDTHH:mm'
 * the pickers emit — we slice, so callers pass their field value directly.
 * Returns an empty map (not null) so callers can badge unconditionally.
 *
 * `opts.publicToken` switches the hook to the customer magic-link surface: it
 * fetches the token-gated /public/job-completion/:token/slot-recommendations
 * endpoint via the bare `publicFetch` (no CRM bearer / cookies) instead of the
 * JWT-only /admin route, which the public page cannot call. SlotAdvisory only
 * reads best/attendanceKnown/candidatePool/loading/failed, so the slim public
 * payload is sufficient there.
 */
export function useSlotRecommendations(
  jobId: number | null | undefined,
  date: string | null | undefined,
  opts?: { publicToken?: string },
) {
  const day = (date || '').slice(0, 10);
  const valid = !!jobId && /^\d{4}-\d{2}-\d{2}$/.test(day);
  const publicToken = opts?.publicToken;
  const isPublic = !!publicToken;

  // Admin (JWT) branch — the CRM JobModal / Schedule & Assign path. Gated OFF
  // in public mode so it never routes through @/lib/api (which attaches the
  // staff bearer + credentials:'include').
  const adminQ = useFetch<Resp>(
    valid && !isPublic ? `/admin/jobs/${jobId}/slot-recommendations?date=${day}` : null,
    { enabled: valid && !isPublic },
  );

  // Public (magic-link) branch. Hooks below are called UNCONDITIONALLY every
  // render so hook order stays stable regardless of `isPublic`.
  const [pub, setPub] = React.useState<{
    best: SlotRecommendation | null;
    attendanceKnown: boolean;
    candidatePool: number;
    loading: boolean;
    failed: boolean;
  }>({ best: null, attendanceKnown: false, candidatePool: 0, loading: false, failed: false });

  React.useEffect(() => {
    if (!isPublic || !valid) {
      setPub({ best: null, attendanceKnown: false, candidatePool: 0, loading: false, failed: false });
      return;
    }
    let cancelled = false;
    setPub((p) => ({ ...p, loading: true, failed: false }));
    publicFetch<PublicResp>(
      `/public/job-completion/${encodeURIComponent(publicToken!)}/slot-recommendations?date=${day}`,
    )
      .then((r) => {
        if (cancelled) return;
        setPub({
          // Reconstruct a minimal SlotRecommendation from the slim label so the
          // shared SlotAdvisory (which reads only `best.slot`) renders as on the
          // admin surface. The count fields are zeroed — they are never rendered.
          best: r.best
            ? { slot: r.best.slot, recommended: true, freeCount: 0, totalCandidates: 0, topScore: 0, unavailable: false, reason: null }
            : null,
          attendanceKnown: !!r.attendanceKnown,
          // SlotAdvisory uses candidatePool purely as a truthy check, so 1/0 is
          // enough to keep its "No eligible technician" vs "No free window"
          // messaging correct without exposing the real supply count.
          candidatePool: r.hasCandidatePool ? 1 : 0,
          loading: false,
          failed: false,
        });
      })
      .catch(() => {
        // A failed lookup must never block the reschedule — SlotAdvisory returns
        // null on `failed`, so the customer just sees no advice.
        if (!cancelled) setPub({ best: null, attendanceKnown: false, candidatePool: 0, loading: false, failed: true });
      });
    return () => { cancelled = true; };
  }, [isPublic, valid, day, publicToken]);

  const bySlot = React.useMemo(() => {
    const m = new Map<string, SlotRecommendation>();
    for (const s of adminQ.data?.slots ?? []) m.set(s.slot, s);
    return m;
  }, [adminQ.data]);

  if (isPublic) {
    return {
      bySlot: EMPTY_SLOT_MAP,
      best: pub.best,
      attendanceKnown: pub.attendanceKnown,
      candidatePool: pub.candidatePool,
      loading: pub.loading,
      failed: pub.failed,
    };
  }

  return {
    bySlot,
    best: adminQ.data?.slots?.find((s) => s.recommended) ?? null,
    attendanceKnown: adminQ.data?.attendanceKnown ?? false,
    candidatePool: adminQ.data?.candidatePool ?? 0,
    loading: adminQ.loading,
    // A failed lookup must never block booking — callers just render no badges.
    failed: !!adminQ.error,
  };
}

/*
 * One-line advisory under the chips.
 *
 * We deliberately show ONLY the best window and NOT the per-slot counts. On a
 * future date every window shows the same free-count (nobody has a booking yet),
 * so a row of identical numbers reads as noise and — worse — implies a precision
 * the future-date estimate doesn't have. The single "Best" recommendation is the
 * one piece of signal worth surfacing; the full explanation (what the numbers
 * mean, and the future-date attendance caveat) moves to a hover tooltip on that
 * line rather than cluttering the row.
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
        No eligible technician found for this job&apos;s area on this date.
      </p>
    );
  }
  if (!best) {
    return <p className="mt-1.5 text-xs text-amber-700">No window has a free technician on this date.</p>;
  }
  const hint = attendanceKnown
    ? 'Shows the window with the most eligible technicians who have no clash there, based on today’s attendance.'
    : 'Shows the window with the most eligible technicians who have no clash there. Attendance for a future date isn’t known yet, so this reflects skills, area and existing load.';
  return (
    <p className="mt-1.5 text-xs">
      {/* Native title = the "on hover" info text the row no longer prints. The
          dotted underline is the affordance that there's more on hover. */}
      <span
        className="text-emerald-700 font-medium cursor-help underline decoration-dotted underline-offset-2"
        title={hint}
      >
        <Sparkles className="inline h-3 w-3 mb-0.5" /> Best: {best.slot}
      </span>
    </p>
  );
}
