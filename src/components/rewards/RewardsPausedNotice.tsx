'use client';

/*
 * "Rewards Programme Is Paused" — shown across all Rewards pages.
 *
 * Pausing (`rewards.earn.enabled = false`) stops FURTHER earning and nothing
 * else. It is not a kill switch, and the copy is careful to say so, because
 * the two most likely wrong readings both cost real trust:
 *
 *   - ops assuming balances were wiped, and telling a technician so;
 *   - ops assuming claims are frozen, and refusing to fulfil one.
 *
 * Neither is true: the ledger is untouched and technicians can still spend
 * what they already earned. Only new rating/SDA/referral awards stop.
 *
 * Renders nothing when the programme is running, so it costs a hook and no
 * layout on the normal path.
 */

import { PauseCircle } from 'lucide-react';
import { useFetch } from '@/lib/hooks';

type RewardsConfig = {
  earningPaused: boolean;
  configurable: boolean;
  rules: { code: string; points: number; label: string; detail: string }[];
};

export function RewardsPausedNotice() {
  const { data } = useFetch<RewardsConfig>('/admin/rewards/config');
  if (!data?.earningPaused) return null;

  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <PauseCircle className="size-4 shrink-0 mt-0.5" />
      <div>
        <span className="font-semibold">Rewards Programme Is Paused For Now. Stay Tuned!</span>{' '}
        <span className="text-amber-800">
          No new points are being earned from ratings, same-day appointments or referrals.
          Existing balances are unchanged and technicians can still claim rewards.
        </span>
      </div>
    </div>
  );
}

/*
 * "How Points Are Earned" — the published rates, read-only.
 *
 * The values are fixed in code, so an operator asked "how many points is a
 * same-day appointment worth?" has nowhere to look them up otherwise. Stating
 * that they are not editable here prevents a hunt for a settings screen that
 * does not exist.
 */
export function RewardsEarnRates() {
  const { data } = useFetch<RewardsConfig>('/admin/rewards/config');
  if (!data?.rules?.length) return null;

  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-xs font-semibold mb-1.5">How Points Are Earned</div>
      {/*
        One rule per ROW, not a wrapping row of inline items. Wrapping packed
        two rules onto the first line and orphaned the third, which read as a
        layout accident rather than a list — and these are three parallel
        terms, so they should scan as three.

        Sorted by value, highest first. An operator asked "what earns the most?"
        should be able to read the answer off the top of the list rather than
        compare three numbers. Sorted HERE rather than trusting the order the
        API happened to send, so a future rate change cannot silently reshuffle
        it into something misleading.
      */}
      <ul className="flex flex-col gap-1">
        {[...data.rules]
          .sort((a, b) => b.points - a.points)
          .map((rule) => (
            <li key={rule.code} className="text-xs flex items-baseline gap-1.5">
              <span className="font-semibold text-amber-600 tabular-nums w-10 shrink-0">
                +{rule.points}
              </span>
              <span className="font-medium shrink-0">{rule.label}</span>
              <span className="text-muted-foreground">— {rule.detail}</span>
            </li>
          ))}
      </ul>
      <div className="mt-1 text-[11px] text-muted-foreground">
        These rates are fixed and cannot be changed from the CRM — they are the terms technicians
        are told, so changing one is a deliberate release.
      </div>
    </div>
  );
}
