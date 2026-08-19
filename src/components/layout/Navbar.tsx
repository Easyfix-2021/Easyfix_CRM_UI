'use client';
import { useState, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Bell, LogOut, Menu, Info, AlertTriangle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
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
/*
 * EffectiveAccessPopover — popover CONTENTS only.
 *
 * Refactor (2026-06-05): the trigger used to be a standalone "Access"
 * pill button. Operators found that visually noisy next to the
 * identity (name / role) cluster, and the natural mental model is
 * "click on who I am to see what I can see." So the trigger is now
 * the identity div itself (see the Navbar render at the call-site)
 * and this component renders only the floating panel body — the
 * call-site owns the open/close state, the click-target, and the
 * positioning wrapper.
 *
 * Background fix (2026-06-05, root-caused 2026-08-18): `bg-popover` used to
 * compile to no CSS rule at all — the `--popover` variables existed but the
 * matching Tailwind colour alias was never added to the config — so the panel
 * rendered transparent, and the workaround was a hardcoded `bg-white`. That
 * workaround does not flip in dark mode: it would stay a white card with dark
 * text on an otherwise dark page. The alias is now mapped in
 * tailwind.config.ts, so the token works and the panel follows the theme.
 */
function EffectiveAccessPopover({
  scope,
  hierarchy,
}: {
  scope: Me['scope'];
  hierarchy: Me['hierarchy'];
}) {
  return (
    <div
      className="absolute right-0 top-full mt-1 z-50 w-56 rounded-md border border-ink-100 bg-popover text-popover-foreground shadow-lg p-2"
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
    valueClass = 'text-warning-strong font-medium';
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
  // Effective Access popover open/close — driven by clicks on the
  // identity (name / role) block in the right-side cluster. See the
  // render below for the wiring + click-outside dismiss strategy.
  const [accessOpen, setAccessOpen] = useState(false);

  // Permission gates — mirror the legacy CRM, which only showed each header
  // button if the operator had the matching action permission. Keys
  // (`ef-QuickSight`, `isCallInfo`, `isEscalatedJob`, `isBookNewCall`) are
  // seeded against the Home menu in `menu_action`.
  const can = {
    // QuickSight moved to the sidebar (bottom-pinned, gated on ef-QuickSight
    // there) — it's no longer a header button.
    callInfo:     hasAction(me, 'isCallInfo'),
    escalatedJob: hasAction(me, 'isEscalatedJob'),
    bookNewCall:  hasAction(me, 'isBookNewCall'),
  };

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
        {can.callInfo && (
          <button
            type="button"
            onClick={() => setCallInfoOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 h-9 rounded-md bg-success text-white text-xs font-semibold shadow-sm hover:bg-success-strong hover:shadow-md hover:scale-[1.02] transition-all"
          >
            <Info className="h-4 w-4" />
            Call Info
          </button>
        )}
        {can.escalatedJob && (
          <button
            type="button"
            onClick={() => setEscalatedOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 h-9 rounded-md bg-primary text-white text-xs font-semibold shadow-sm hover:bg-brand-600 hover:shadow-md hover:scale-[1.02] transition-all"
          >
            <AlertTriangle className="h-4 w-4" />
            Escalated Jobs
            {escalatedCount !== null && escalatedCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-urgent-tint text-urgent-strong text-xs font-semibold">
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
          <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-destructive text-xs text-destructive-foreground grid place-items-center font-semibold">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      <div className="flex items-center gap-3 border-l pl-3">
        {/*
         * Identity-as-trigger (2026-06-05). Clicking the name/role
         * block toggles the Effective Access popover. Matches the
         * operator's intuition ("click on who I am to see what I can
         * see") and removes the visual clutter of a standalone
         * "Access" pill. Wrapper is `relative` so the popover
         * positions against THIS div, not the whole right-side
         * cluster.
         *
         * Trigger is a real <button> for keyboard + a11y (Space/Enter
         * toggle, focus ring), styled to look identical to the
         * previous inline div — only adds a subtle hover background +
         * a pointer cursor so operators discover it's clickable.
         *
         * Behavior: tracks `accessOpen` locally. Click-outside dismiss
         * is handled by the same onBlur subtree-check pattern used
         * elsewhere in this navbar (works because the popover sits
         * inside the wrapper, so focus landing on it doesn't trigger
         * a close).
         */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setAccessOpen((v) => !v)}
            onBlur={(e) => {
              if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) {
                setAccessOpen(false);
              }
            }}
            className="hidden sm:block text-right text-xs px-2 py-1 -mx-2 -my-1 rounded hover:bg-muted/60 transition-colors cursor-pointer"
            title="Show effective row-level access scope"
            aria-haspopup="dialog"
            aria-expanded={accessOpen}
          >
            <div className="font-medium">{me?.user?.user_name ?? '…'}</div>
            <div className="text-muted-foreground">{me?.role?.role_name ?? me?.user?.official_email ?? ''}</div>
          </button>
          {accessOpen && (
            <EffectiveAccessPopover
              scope={me?.scope}
              hierarchy={me?.hierarchy}
            />
          )}
        </div>
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
