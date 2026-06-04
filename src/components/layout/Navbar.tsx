'use client';
import { useState, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Bell, LogOut, Menu, BarChart3, Info, AlertTriangle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { useFetchOnce } from '@/lib/hooks';
import { useMe, clearMeCache, type ScopeDimension, type Me } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { EscalatedJobsModal } from '@/components/job/EscalatedJobsModal';
import { CallInfoModal } from '@/components/call-info/CallInfoModal';

/*
 * EffectiveAccessPanel — small dropdown surfaced from the user-identity
 * cluster in the navbar. Renders a 4-row table (clients / cities / states /
 * verticals) with the resolved scope counts so operators can self-diagnose
 * RBAC scope mismatches without filing a ticket. See the call-site comment
 * in Navbar for the broader rationale.
 *
 * Rendering rules per dimension:
 *   mode='all'   → "All"
 *   mode='allow' → ids.length (e.g. "2")
 *   mode='none'  → "None" in amber, since the user has zero access on that
 *                   dimension and queries will return zero rows.
 *
 * For Admin/Finance (scope === undefined) we collapse the table into a
 * single "Effective access: All (bypass role)" line — there's nothing
 * useful to show per-dimension.
 */
function EffectiveAccessPanel({
  scope,
  hierarchy,
}: {
  scope: Me['scope'];
  hierarchy: Me['hierarchy'];
}) {
  const [open, setOpen] = useState(false);
  // No `me` yet — render nothing rather than a placeholder; AuthProvider
  // hydrates from cache near-instantly so this gap is invisible.
  if (!scope && !hierarchy) {
    // Bypass role (Admin/Finance) — scope intentionally omitted by BE.
    // Still expose a tiny indicator so operators know they're unscoped.
    return (
      <div className="hidden md:block text-[10px] text-muted-foreground italic pr-1" title="Bypass role: no row-level scope filter applies">
        All access
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={(e) => {
          // Close when focus leaves the entire popover subtree (button + panel)
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) {
            setOpen(false);
          }
        }}
        className="hidden md:inline-flex items-center px-2 h-7 rounded-md border border-input bg-background text-[11px] font-medium text-muted-foreground hover:bg-muted"
        title="Show effective row-level access scope"
        aria-haspopup="true"
        aria-expanded={open}
      >
        Access
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-56 rounded-md border bg-popover text-popover-foreground shadow-md p-2"
          role="dialog"
          aria-label="Effective Access"
        >
          {!scope ? (
            <div className="text-xs">
              <div className="font-semibold mb-1">Effective Access</div>
              <div className="text-muted-foreground">All (bypass role)</div>
            </div>
          ) : (
            <>
              <div className="text-xs font-semibold mb-1">Effective Access</div>
              <div className="border-t" />
              <table className="w-full text-xs mt-1">
                <tbody>
                  <ScopeRow label="Clients"   dim={scope.clients} />
                  <ScopeRow label="Cities"    dim={scope.cities} />
                  <ScopeRow label="States"    dim={scope.states} />
                  <ScopeRow label="Verticals" dim={scope.verticals} />
                </tbody>
              </table>
              {hierarchy && hierarchy.descendantsCount > 0 && (
                <>
                  <div className="border-t mt-1" />
                  <div className="text-xs text-muted-foreground italic mt-1">
                    Including {hierarchy.descendantsCount} downstream report{hierarchy.descendantsCount === 1 ? '' : 's'}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Renders one row of the Effective Access table. `mode='none'` highlights
// in amber because zero access usually means the operator's manage_*
// column is mis-seeded — exactly the class of bug this panel exists to
// surface.
function ScopeRow({ label, dim }: { label: string; dim: ScopeDimension }) {
  let value: ReactNode;
  let valueClass = '';
  if (dim.mode === 'all') {
    value = 'All';
  } else if (dim.mode === 'allow') {
    value = dim.ids.length;
  } else {
    value = 'None';
    valueClass = 'text-amber-600 font-medium';
  }
  return (
    <tr>
      <td className="text-left text-muted-foreground py-0.5">{label}</td>
      <td className={`text-right py-0.5 ${valueClass}`}>{value}</td>
    </tr>
  );
}

export function Navbar({ onToggleSidebar }: { onToggleSidebar?: () => void }) {
  const router = useRouter();
  const pathname = usePathname() || '';
  // Legacy CRM rendered the 4 header buttons (QuickSight, Call Info,
  // Escalated Jobs, Book New Call) on the Home/dashboard view and the
  // Manage Jobs page (plus every job sub-page like /jobs/upload). Other
  // sections (Customers, Clients, EasyFixers, Finance, Settings, …)
  // didn't show them. We mirror that here by gating on the pathname.
  // Note: /my-orders is intentionally NOT included — legacy CRM kept the
  // operator-personal "My Orders" surface distinct from the org-wide
  // Manage Jobs surface, and only the latter carried the header buttons.
  const showHeaderActions =
    pathname === '/dashboard' ||
    pathname === '/jobs' ||
    pathname.startsWith('/jobs/');
  // Shared auth state — AuthProvider in (authed)/layout fetches /auth/me once
  // and both Navbar + Sidebar consume from context. Saves one duplicate HTTP
  // request + DB lookup per page load.
  const { me } = useMe();
  /*
   * Notification + escalation badges use `useFetchOnce` — the
   * module-level dedupe + 30s cache in lib/hooks.ts collapses the
   * Strict-Mode double-invoke into one round-trip AND shares the
   * cached response with any other Navbar instance / re-mount that
   * happens within the TTL (e.g. routing between authed pages).
   * Without dedupe each /jobs route load fired this twice in dev.
   */
  const inbox = useFetchOnce<{ unread: number }>('/admin/notifications/inbox/count');
  const counts = useFetchOnce<{ escalated?: number }>('/admin/jobs/counts');
  const unread = inbox.data?.unread ?? 0;
  const escalatedCount = counts.data ? (counts.data.escalated ?? 0) : null;
  // Escalated Jobs modal — opens from the navbar button. Replaces the
  // previous "navigate to /jobs?focus=escalated" behaviour with the
  // dedicated escalation table that matches the legacy column shape.
  const [escalatedOpen, setEscalatedOpen] = useState(false);
  // Call Info modal — opens from the navbar button. Replaces the
  // previous "navigate to /admin-actions/call-info" page so ops stay
  // on Dashboard / Manage Jobs while picking a date range and reading
  // the resulting call history table.
  const [callInfoOpen, setCallInfoOpen] = useState(false);

  // Permission gates — mirror the legacy CRM, which only showed each header
  // button if the operator had the matching action permission. Keys
  // (`ef-QuickSight`, `isCallInfo`, `isEscalatedJob`, `isBookNewCall`) are
  // seeded against the Home menu in `menu_action`.
  const can = {
    quickSight:   hasAction(me, 'ef-QuickSight'),
    callInfo:     hasAction(me, 'isCallInfo'),
    escalatedJob: hasAction(me, 'isEscalatedJob'),
    bookNewCall:  hasAction(me, 'isBookNewCall'),
  };

  async function openQuickSight() {
    // QuickSight migration — preserves the legacy CRM flow:
    //   1. Mint a short-lived session-bridge JWT on the backend
    //      (`/admin/quicksight/token`). The JWT carries session_proof +
    //      user_id and is signed HS256 with QUICKSIGHT_JWT_SECRET. This
    //      is the cookies-equivalent "logged-in session only" check the
    //      user asked about — pasting the resulting URL into a different
    //      browser fails verification because the session_proof was
    //      minted for the originating session.
    //   2. Concatenate the JWT to the env-specific QuickSight base URL
    //      at the path `/EF-QuickSight/openOrders/`.
    //   3. Open in a new tab so the operator doesn't lose their CRM
    //      page state.
    //
    // Env detection: NEXT_PUBLIC_QA_QUICKSIGHT_URL on UAT/QA;
    // NEXT_PUBLIC_PROD_QUICKSIGHT_URL on production. We pick based on
    // build-time NODE_ENV — Next.js sets this to 'production' for
    // `next build` (Vercel/server bundle) and 'development' locally.
    // Operators on a UAT deployment built with NODE_ENV=production but
    // pointing at the UAT host should override by setting
    // NEXT_PUBLIC_QA_QUICKSIGHT_URL only and leaving the PROD one unset
    // — the fallback below picks whichever is defined.
    const base = (process.env.NODE_ENV === 'production'
      ? process.env.NEXT_PUBLIC_PROD_QUICKSIGHT_URL
      : process.env.NEXT_PUBLIC_QA_QUICKSIGHT_URL)
      || process.env.NEXT_PUBLIC_PROD_QUICKSIGHT_URL
      || process.env.NEXT_PUBLIC_QA_QUICKSIGHT_URL;
    if (!base) {
      router.push('/coming-soon?title=QuickSight');
      return;
    }
    try {
      const r = await api.get<{ token: string }>('/admin/quicksight/token');
      const url = `${base.replace(/\/+$/, '')}/EF-QuickSight/openOrders/${r.token}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      // Surface the backend's message (e.g. "QuickSight is not
      // configured" or "You do not have QuickSight access") so the
      // operator gets a meaningful failure, not a silent no-op.
      const msg = e instanceof ApiError ? e.message : 'Could not open QuickSight';
      // Falling back to coming-soon with the failure message so the
      // user always lands somewhere informative rather than the button
      // dead-ending. Coming-soon page reads `?title=` for context.
      router.push(`/coming-soon?title=${encodeURIComponent(`QuickSight unavailable: ${msg}`)}`);
    }
  }

  async function logout() {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    localStorage.removeItem('crm_auth_token');
    // Drop the cached `me` so a different user logging in on the same
    // browser tab doesn't see ghost permissions for a few seconds.
    clearMeCache();
    router.push('/login');
  }

  return (
    <header className="h-14 border-b bg-card px-4 flex items-center gap-3">
      <Button variant="ghost" size="icon" onClick={onToggleSidebar} className="md:hidden">
        <Menu className="h-5 w-5" />
      </Button>
      {/*
       * Center cluster — ported from the legacy CRM page header.
       * 4 buttons, in this exact order so muscle memory carries over:
       *   QuickSight · Call Info · Escalated Jobs (count) · + Book New Call
       *
       * Layout: flex-1 on the left + right ghosts makes the center
       * cluster sit exactly mid-header regardless of right-side content
       * (notification bell + user info take variable width as the
       * user's name length changes). The hidden-on-mobile class on the
       * cluster means small screens get the bell + user only — the
       * action buttons require enough room to keep their labels
       * readable.
       */}
      <div className="flex-1" />
      {showHeaderActions && (
      <nav className="hidden md:flex items-center gap-2" aria-label="Header actions">
        {can.quickSight && (
          <button
            type="button"
            onClick={openQuickSight}
            className="inline-flex items-center gap-1.5 px-3 h-9 rounded-md bg-gradient-to-br from-indigo-500 to-blue-600 text-white text-xs font-semibold shadow-sm hover:shadow-md hover:scale-[1.02] transition-all"
          >
            <BarChart3 className="h-4 w-4" />
            QuickSight
          </button>
        )}
        {can.callInfo && (
          <button
            type="button"
            onClick={() => setCallInfoOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 h-9 rounded-md bg-teal-600 text-white text-xs font-semibold shadow-sm hover:bg-teal-700 hover:shadow-md hover:scale-[1.02] transition-all"
          >
            <Info className="h-4 w-4" />
            Call Info
          </button>
        )}
        {can.escalatedJob && (
          <button
            type="button"
            onClick={() => setEscalatedOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 h-9 rounded-md bg-sky-600 text-white text-xs font-semibold shadow-sm hover:bg-sky-700 hover:shadow-md hover:scale-[1.02] transition-all"
          >
            <AlertTriangle className="h-4 w-4" />
            Escalated Jobs
            {escalatedCount !== null && escalatedCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-rose-100 text-rose-700 text-[11px] font-bold">
                {escalatedCount > 999 ? '999+' : escalatedCount}
              </span>
            )}
          </button>
        )}
        {can.bookNewCall && (
          <button
            type="button"
            /*
             * Per ops 2026-05-14: Book New Call must open the modal on
             * the CURRENT page rather than yanking the operator off to
             * another route. Both /dashboard and /jobs have a ?new=1
             * handler that mounts JobModal in create mode; we pick the
             * destination by the operator's current pathname so the
             * page context (filtered queue, selected tab, etc.) stays
             * intact. Anywhere else (settings, reports), default to
             * /dashboard — that's where ops naturally land for a fresh
             * booking flow.
             */
            onClick={() => {
              const dest = pathname.startsWith('/jobs')
                ? '/jobs?new=1'
                : '/dashboard?new=1';
              router.push(dest);
            }}
            className="inline-flex items-center gap-1.5 px-3 h-9 rounded-md border border-input bg-background text-foreground text-xs font-semibold shadow-sm hover:bg-muted hover:shadow-md hover:scale-[1.02] transition-all"
          >
            <Plus className="h-4 w-4" />
            Book New Call
          </button>
        )}
      </nav>
      )}
      <div className="flex-1" />
      <button
        onClick={() => router.push('/notifications')}
        className="relative rounded p-2 hover:bg-muted"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-destructive text-[10px] text-destructive-foreground grid place-items-center font-semibold">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      <div className="flex items-center gap-3 border-l pl-3">
        <div className="hidden sm:block text-right text-xs">
          <div className="font-medium">{me?.user?.user_name ?? '…'}</div>
          <div className="text-muted-foreground">{me?.role?.role_name ?? me?.user?.official_email ?? ''}</div>
        </div>
        {/*
         * Effective Access panel — surfaces the operator's resolved row-level
         * RBAC scope (clients / cities / states / verticals) so ops can spot
         * "I'm scoped to 2 clients but seeing data for 50" issues at a glance
         * instead of filing a ticket. Driven entirely from the /auth/me
         * response already cached in AuthContext; no extra request.
         *
         * Skipped for bypass roles (Admin / Finance) where scope is absent
         * server-side — those get a single "All (bypass role)" line.
         */}
        <EffectiveAccessPanel
          scope={me?.scope}
          hierarchy={me?.hierarchy}
        />
        <Button variant="ghost" size="icon" onClick={logout} title="Log out">
          <LogOut className="h-5 w-5" />
        </Button>
      </div>
      {/* Escalated Jobs modal — mounted at the navbar level so it can be
          opened from any page that has the header buttons visible.
          State lifts up to the Navbar so a single instance handles all
          opens (avoids multiple modal portals stacking). */}
      <EscalatedJobsModal
        open={escalatedOpen}
        onClose={() => setEscalatedOpen(false)}
      />
      {/* Call Info modal — date-range picker + result table. Shares the
          same lift-state-to-navbar pattern as EscalatedJobsModal so we
          don't stack multiple portal instances per page. */}
      <CallInfoModal
        open={callInfoOpen}
        onClose={() => setCallInfoOpen(false)}
      />
    </header>
  );
}
