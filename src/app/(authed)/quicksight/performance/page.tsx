'use client';

/*
 * QuickSight — Performance Report.
 *
 * One page, FIVE gliding tabs over the performance scorecards:
 *   Client · State · City · User · Technician (see TAB_ORDER for why this order)
 *   Client · City · Technician — the EXISTING reports, rendered from the very
 *     same body components their standalone routes use. Not re-implementations:
 *     a fix to either surface lands on both. Those routes stay live, so existing
 *     links, bookmarks and RBAC keep working.
 *   State · User — new, built on the Manage Regions (state) scope. Same metrics
 *     as City Performance (the backend imports them from that service).
 *
 * PERMISSIONS: each tab keeps its OWN per-report action key — the same key that
 * gates its standalone route. So this page grants nothing new: a user sees only
 * the tabs they already had access to, and the tab strip renders just those.
 * When a user has none of the five, we hand the first tab's body the job of
 * rendering the standard access-denied panel rather than inventing another one.
 *
 * WHICH TAB OPENS FIRST — resolved in three tiers, no DB / no backend:
 *   1. `?tab=<value>` in the URL — always wins when it names a visible tab.
 *      Makes every tab a shareable, bookmarkable deep link.
 *   2. A per-user pin in localStorage (`crm.qsPerf.defaultTab.<user_id>`) — the
 *      landing tab the user chose via the pin button. PER-USER because CRM
 *      workstations are shared; an unkeyed key would leak one person's default
 *      to whoever logs in next on that browser.
 *   3. First tab the user can access.
 * The pin is a HINT, never an authority: if it names a tab the user can't see
 * (grant revoked, or the State/User seed not yet run) it's ignored and cleared.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Pin, PinOff } from 'lucide-react';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { GlidingTabs } from '@/components/ui/gliding-tabs';

import { ClientPerformanceBody } from '../client-performance/ClientPerformanceBody';
import { CityPerformanceBody } from '../city-performance/CityPerformanceBody';
import { TechnicianPerformanceBody } from '../technician-performance/TechnicianPerformanceBody';
import { RegionPerformanceBody } from '@/components/quicksight/reports/RegionPerformanceBody';

type PerfTab = 'client' | 'city' | 'technician' | 'state' | 'user';

// tab → the per-report action key that already gates its standalone route.
const TAB_ACTION: Record<PerfTab, string> = {
  client: 'isQuickSightClientPerformanceView',
  city: 'isQuickSightCityPerformanceView',
  technician: 'isQuickSightTechnicianPerformanceView',
  state: 'isQuickSightStatePerformanceView',
  user: 'isQuickSightUserPerformanceView',
};
const TAB_LABEL: Record<PerfTab, string> = {
  client: 'Client', city: 'City', technician: 'Technician', state: 'State', user: 'User',
};
/*
 * Tab order is deliberately GEOGRAPHIC-then-PEOPLE, widest scope first:
 *   Client → State → City → User → Technician
 * i.e. who the work is for, then where it happened (coarse → fine), then who
 * owns it (desk → field). Not the order the tabs were built in.
 */
const TAB_ORDER: PerfTab[] = ['client', 'state', 'city', 'user', 'technician'];

const isPerfTab = (v: string | null | undefined): v is PerfTab =>
  !!v && (TAB_ORDER as string[]).includes(v);

// Per-user localStorage key for the pinned landing tab (see header).
const pinKey = (userId: number) => `crm.qsPerf.defaultTab.${userId}`;

export default function PerformanceReportPage() {
  const { me } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const flags = actionFlags(me, Object.values(TAB_ACTION));
  const userId = me?.user.user_id ?? null;

  /*
   * Only the tabs this user can actually open.
   *
   * The `!me` branch is specifically the STILL-LOADING case — show everything
   * and let each body's own access-denied panel decide, since the server is the
   * authority regardless. Once `me` has resolved, a user with zero grants gets
   * zero tabs: keying the fallback off "granted.length === 0" instead would have
   * shown all five to someone entitled to none.
   *
   * ⚠ A tab is also hidden when its key does not EXIST yet (an unseeded
   * migration is indistinguishable from a revoked grant). That is the intended
   * fail-closed behaviour — see the seed migration for State/User.
   */
  const visible = useMemo(
    () => (me ? TAB_ORDER.filter((t) => flags[TAB_ACTION[t]]) : TAB_ORDER),
    [flags, me],
  );

  // Selection state. `null` = "not chosen yet" — `active` (below) resolves it to
  // a concrete tab. Seed ONLY from the URL here: localStorage is client-only, so
  // reading it during render would risk a hydration mismatch. The pin is applied
  // in the mount effect below instead.
  const [tab, setTab] = useState<PerfTab | null>(() => {
    const t = searchParams.get('tab');
    return isPerfTab(t) ? t : null;
  });

  // The user's pinned landing tab (button state), and a gate that holds the
  // report body back until we've read the pin — so we never mount (and fire the
  // queries of) the fallback tab for a frame before swapping to the pinned one.
  const [pinned, setPinned] = useState<PerfTab | null>(null);
  const [pinChecked, setPinChecked] = useState(false);
  const pinAppliedRef = useRef(false);

  useEffect(() => {
    if (userId == null || pinAppliedRef.current) return;
    pinAppliedRef.current = true;

    let stored: PerfTab | null = null;
    try {
      const raw = localStorage.getItem(pinKey(userId));
      if (isPerfTab(raw)) stored = raw;
    } catch { /* storage disabled (private mode) — treat as no pin */ }

    // Stale pin — names a tab this user can't see. Forget it rather than
    // stranding them on a tab that will never render.
    if (stored && !visible.includes(stored)) {
      try { localStorage.removeItem(pinKey(userId)); } catch { /* ignore */ }
      stored = null;
    }

    setPinned(stored);
    // Apply the pin only when the URL didn't already choose a tab (URL wins).
    if (stored && tab == null) setTab(stored);
    setPinChecked(true);
    // Run once per user; `tab`/`visible` are read at that moment by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Keep the selection reachable: if the resolved permissions drop the current
  // tab, snap to the first one that survived.
  const active = tab && visible.includes(tab) ? tab : visible[0];

  // Explicit tab click: record the choice, reflect it in the URL (shareable +
  // survives the remount a modal action can cause), and stop any pending pin
  // apply from overriding it.
  const selectTab = useCallback((v: PerfTab) => {
    pinAppliedRef.current = true;
    setTab(v);
    const p = new URLSearchParams(searchParams);
    p.set('tab', v);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  }, [searchParams, pathname, router]);

  // Pin / unpin the ACTIVE tab as this user's default landing tab.
  const isActivePinned = !!active && pinned === active;
  const togglePin = useCallback(() => {
    if (userId == null || !active) return;
    try {
      if (pinned === active) {
        localStorage.removeItem(pinKey(userId));
        setPinned(null);
      } else {
        localStorage.setItem(pinKey(userId), active);
        setPinned(active);
      }
    } catch { /* storage disabled — pin silently unavailable */ }
  }, [userId, active, pinned]);

  if (visible.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        You do not have access to any performance report.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <GlidingTabs
          ariaLabel="Performance dimension"
          value={active}
          onChange={(v) => selectTab(v as PerfTab)}
          tabs={visible.map((t) => ({ value: t, label: TAB_LABEL[t] }))}
        />

        {/* Pin the current tab as the default one to open — per user, this browser. */}
        {me && active && (
          <button
            type="button"
            onClick={togglePin}
            aria-pressed={isActivePinned}
            title={
              isActivePinned
                ? `Stop opening ${TAB_LABEL[active]} by default`
                : `Open ${TAB_LABEL[active]} by default next time`
            }
            className={
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors '
              + (isActivePinned
                ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
                : 'border-border text-muted-foreground hover:bg-muted')
            }
          >
            {isActivePinned ? <PinOff size={14} /> : <Pin size={14} />}
            {isActivePinned ? `Default: ${TAB_LABEL[active]}` : 'Set as default'}
          </button>
        )}
      </div>

      {/*
        * Only the ACTIVE body is mounted. Each one owns its filters, lookups and
        * fetches, so rendering all five would fire five reports' worth of
        * queries on load — the tab switch is meant to be the thing that costs.
        * Held back until `pinChecked` so a pinned tab doesn't briefly mount the
        * fallback tab's body (and fire its queries) before swapping.
        */}
      {!pinChecked ? (
        <div className="h-64 animate-pulse rounded-md border border-border bg-muted/30" />
      ) : (
        <>
          {active === 'client' && <ClientPerformanceBody />}
          {active === 'city' && <CityPerformanceBody />}
          {active === 'technician' && <TechnicianPerformanceBody />}
          {active === 'state' && <RegionPerformanceBody dimension="state" />}
          {active === 'user' && <RegionPerformanceBody dimension="user" />}
        </>
      )}
    </div>
  );
}
