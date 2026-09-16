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
 *
 * `nameScope=false` drops the bucket NAME and states only the limitation
 * (2026-09-16). Manage Jobs' two status dropdowns now state the scope
 * themselves, and they can be changed WITHOUT changing `tab` — a restricted
 * user switching Job Status to another granted stage left this bar reading
 * "Showing Pending for Scheduling Only" over a table of something else. The
 * name belongs to whichever control the operator can actually move; when that
 * is the dropdown, this bar says only why the list is limited.
 */
export function JobScopeBar({ tab, clamped, onClear, noun, nameScope = true }: {
  tab: string;
  clamped: boolean;
  onClear: () => void;
  /** "Jobs" on /jobs, "Orders" on /my-orders — the button names what it shows. */
  noun: string;
  /**
   * False when another control on the page already states the scope and can be
   * changed independently of `tab` (Manage Jobs' Job Status dropdown). Naming
   * the tab there goes stale the moment the operator moves that control.
   */
  nameScope?: boolean;
}) {
  if (tab === 'all') return null;
  // Nothing left to say: the scope is stated elsewhere and nothing limits it.
  if (!nameScope && !clamped) return null;
  const label = TABS.find((t) => t.value === tab)?.label ?? tab;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span>
        {nameScope ? (
          <>
            Showing <span className="font-medium">{label}</span> Only
            {clamped && (
              <span className="text-muted-foreground"> · Limited By Your Job Stage Access</span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">Limited By Your Job Stage Access</span>
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
