'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { Bell, LogOut, Menu, Info, AlertTriangle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useFetchOnce } from '@/lib/hooks';
import { useMe, clearMeCache } from '@/lib/auth-context';
import { hasAction } from '@/lib/permissions';
import { EscalatedJobsModal } from '@/components/job/EscalatedJobsModal';
import { CallInfoModal } from '@/components/call-info/CallInfoModal';

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
         * Identity-as-trigger. Clicking the name/role block used to open a
         * small Effective Access dropdown; it now opens /profile, which shows
         * that same scope table plus the rest of the operator's own record —
         * employee code, contact numbers, reporting reach and the three feature
         * grants that live outside the menu/role pipeline and previously had no
         * surface anywhere in the CRM.
         *
         * A <Link>, not router.push: middle-click and open-in-new-tab work for
         * free, and there is no state to carry.
         *
         * `hidden sm:block` is inherited, not introduced — the identity block
         * has always been desktop-only, and mobile users reach nothing new here.
         */}
        <Link
          href="/profile"
          className="hidden sm:block text-right text-xs px-2 py-1 -mx-2 -my-1 rounded hover:bg-muted/60 transition-colors"
          title="My Profile"
        >
          <div className="font-medium">{me?.user?.user_name ?? '…'}</div>
          <div className="text-muted-foreground">{me?.role?.role_name ?? me?.user?.official_email ?? ''}</div>
        </Link>
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
