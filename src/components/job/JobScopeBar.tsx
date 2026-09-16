'use client';

import { TABS, filterTabsForStages } from '@/lib/job-tabs';

/*
 * JobScopeBar — the one statement of "this list is narrowed to a bucket", plus
 * the way out. Shared by /jobs and /my-orders because NEITHER has a visible tab
 * bar (grep TabsTrigger in either page: 0 hits): both take their tab from the
 * URL or a sidebar click, so without this the scope is invisible state.
 *
 * Reported 2026-09-16: an Admin opened Manage Jobs on a bookmarked
 * ?tab=pending-scheduling, saw a "Pending For Scheduling Filters" panel no
 * colleague had, and read it as the UI differing per user. It did not — the URL
 * did.
 *
 * ONE statement per page, deliberately. /my-orders used to carry the bucket in
 * its H1 ("My Orders · Pending for Scheduling"); that suffix is gone in favour
 * of this bar, so the two surfaces say the same thing in the same place instead
 * of one page saying it twice.
 *
 * `clamped` suppresses the exit rather than the whole bar. Both pages run a Job
 * Stage Access clamp that snaps a restricted user back to their first allowed
 * tab, so a "Show All" they are not permitted to sit on would fire and appear
 * to do nothing. They get the reason instead.
 */
export function JobScopeBar({ tab, clamped, onClear, noun }: {
  tab: string;
  clamped: boolean;
  onClear: () => void;
  /** "Jobs" on /jobs, "Orders" on /my-orders — the button names what it shows. */
  noun: string;
}) {
  if (tab === 'all') return null;
  const label = TABS.find((t) => t.value === tab)?.label ?? tab;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span>
        Showing <span className="font-medium">{label}</span> Only
        {clamped && (
          <span className="text-muted-foreground"> · Limited By Your Job Stage Access</span>
        )}
      </span>
      {!clamped && (
        <button type="button" onClick={onClear} className="whitespace-nowrap text-xs hover:underline">
          Show All {noun}
        </button>
      )}
    </div>
  );
}

/*
 * Is this user barred from the neutral 'all' view? Exported so both pages
 * compute it identically — the clamp and this predicate have to agree, and
 * they used to be able to drift because each page carried its own copy.
 */
export type AllowedStages = { mode: 'all' | 'list'; stages: string[] };

export function scopeIsClampedFor(allowedStages: AllowedStages | undefined): boolean {
  if (!allowedStages || allowedStages.mode === 'all') return false;
  return !filterTabsForStages(TABS, allowedStages).some((t) => t.value === 'all');
}
