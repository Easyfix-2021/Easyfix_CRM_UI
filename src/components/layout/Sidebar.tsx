'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  Home, Briefcase, UserCircle2, Users, Building2,
  BarChart3, Settings, Coins, ShoppingBag, Wallet, User, MapPin,
  ChevronRight, ChevronDown, Circle, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMe } from '@/lib/auth-context';
import { api } from '@/lib/api';

/*
 * Sidebar is now driven by tbl_menu (via /api/shared/lookup/menus). The
 * DB is the source of truth — anything not in the DB does not appear.
 * Local concerns this component still owns:
 *
 *   1. Mapping legacy URL values ('home', 'job', 'deepSkillTable', …) to our
 *      Next.js routes. Unmapped URLs fall through to /coming-soon so operators
 *      still see the item and know it's WIP.
 *   2. Icon mapping — legacy stores Font Awesome class names ("fa-home");
 *      we map the top-level parents to lucide icons. Sub-items use a bullet.
 *   3. Role filter — the DB doesn't encode per-role visibility, so we keep
 *      a hardcoded allowlist here by parent menu_name.
 *   4. Accordion behaviour — only one parent open at a time (the one whose
 *      child matches the current route, or the one the user clicked last).
 */

type MenuRow = {
  menu_id: number;
  menu_name: string;
  parent_menu: number;   // 0 = top-level
  menu_depth: number;
  has_child: number;
  url: string | null;    // 'javascript:;' for parent-only, otherwise a legacy url
  icons: string | null;
  sequence: number | null;
  menu_status: number;   // 1 = active, 0 = hidden. Backend already filters,
                         // but we re-assert client-side for safety.
};

type TreeNode = MenuRow & { children: TreeNode[] };

/*
 * Legacy URL → Next.js route mapping. Anything not listed routes to
 * /coming-soon?title=<menu_name>&legacyPath=<url>.
 *
 * My Orders sub-menus — legacy `dashboardChecking?enumDesc=<value>` URLs.
 * The canonical enumDesc values come from `HomeAction.getJobUIStatus()` in
 * the legacy CRM; each maps to a tab slug in /jobs (and the tab carries the
 * correct status/statuses/assigned filter payload):
 *
 *   UnConfirmed               → /jobs?tab=unconfirmed          (status 9)
 *   PendingForScheduling      → /jobs?tab=pending-scheduling   (status 0, unassigned)
 *   PendingForAcknowledgement → /jobs?tab=pending-app-ack      (status 0, assigned)
 *   NotStarted                → /jobs?tab=pending-start        (status 1)
 *   NotCompleted              → /jobs?tab=pending-close        (statuses 2 OR 20)
 *   PendingFeedback           → /jobs?tab=pending-feedback     (status 3)
 *   PendingForApproval        → /jobs?tab=estimate-pending     (statuses 15 OR 21)
 *   PendingForCheckout        → /jobs?tab=audit-complete       (status 10)
 *
 * Two legacy concepts currently fold onto existing buckets in our status
 * model: (a) "Audit & Complete" has no distinct legacy enumDesc — it's a
 * dashboard-only card that maps to closed-jobs (status 3+5); (b) "Orders in
 * Followup" maps to `PendingForCheckout` in legacy, which is our status 10
 * — same row as Pending for Feedback in our schema today. If a distinct
 * followup flag lands later, split these URL_MAP entries.
 */
const URL_MAP: Record<string, string> = {
  'home':                  '/dashboard',
  'job':                   '/jobs',
  'uploadJobByExcel':      '/jobs/upload',
  'easyfixer':             '/easyfixers',
  // Zone management lives in TWO places (intentional split):
  //   - /settings/zones        — full management surface: CRUD + city
  //                              mapping editor + bulk Excel upload/download.
  //                              `manageZones` (the new sidebar entry under
  //                              Settings) routes here.
  //   - /easyfixers/zones      — read-only "browse zones from EasyFixers
  //                              context" view. The legacy CRM seeded its
  //                              tbl_menu row with url='easyfixerZones' so we
  //                              keep that key for backwards compatibility.
  'manageZones':           '/settings/zones',
  'easyfixerZones':        '/easyfixers/zones',
  'deepSkillTable':        '/settings/deep-skills',
  'manageAutoAllocations': '/settings/auto-allocation',
  // My Orders sub-menus (legacy CRM): each tbl_menu row's `url` is the full
  // `dashboardChecking?enumDesc=<value>` string, so these keys match verbatim.
  // Targets point at the distinct /my-orders route — that page scopes the
  // list automatically (role-aware: admin sees all, others see own) without
  // leaking a scope pill into /jobs.
  'dashboardChecking?enumDesc=UnConfirmed':               '/my-orders?tab=unconfirmed',
  'dashboardChecking?enumDesc=PendingForScheduling':      '/my-orders?tab=pending-scheduling',
  'dashboardChecking?enumDesc=PendingForAcknowledgement': '/my-orders?tab=pending-app-ack',
  'dashboardChecking?enumDesc=NotStarted':                '/my-orders?tab=pending-start',
  'dashboardChecking?enumDesc=NotCompleted':              '/my-orders?tab=pending-close',
  'dashboardChecking?enumDesc=PendingFeedback':           '/my-orders?tab=pending-feedback',
  'dashboardChecking?enumDesc=PendingForApproval':        '/my-orders?tab=estimate-pending',
  'dashboardChecking?enumDesc=PendingForCheckout':        '/my-orders?tab=audit-complete',
};

// Top-level parent → lucide icon + role rules. Keyed by menu_name so DB
// changes don't break us as long as the canonical names stay stable.
const PARENT_META: Record<string, { icon: LucideIcon; allow?: string[]; group?: string[] }> = {
  'Home':              { icon: Home },
  'Jobs':              { icon: Briefcase, group: ['admin'] },
  'My Orders':         { icon: ShoppingBag },
  'Customers':         { icon: Users, group: ['admin'] },
  'Clients':           { icon: Building2, allow: ['Admin', 'Business Development', 'Project Manager', 'Technology team'] },
  'EasyFixers':        { icon: UserCircle2, allow: ['Admin', 'Executive Supply', 'Admin Supply', 'Project Manager', 'Zonal Field Team', 'Solution expert', 'Technology team'] },
  'Finance':           { icon: Coins, allow: ['Admin', 'Finance', 'Technology team'] },
  'User':              { icon: User, allow: ['Admin', 'Technology team'] },
  'Settings':          { icon: Settings, allow: ['Admin', 'Technology team'] },
  'Report':            { icon: BarChart3, group: ['admin'] },
  'Tracking':          { icon: MapPin, group: ['admin'] },
  'Easyfixer Advance': { icon: Wallet, allow: ['Admin', 'Finance', 'Technology team'] },
};

function legacyToRoute(name: string, url: string | null | undefined): string {
  if (!url || url === 'javascript:;' || url === '') return '#';
  if (URL_MAP[url]) return URL_MAP[url];
  const qs = new URLSearchParams({ title: name, legacyPath: url });
  return `/coming-soon?${qs.toString()}`;
}

function buildTree(rows: MenuRow[]): TreeNode[] {
  const byId = new Map<number, TreeNode>();
  rows.forEach((r) => byId.set(r.menu_id, { ...r, children: [] }));
  const roots: TreeNode[] = [];
  byId.forEach((n) => {
    if (!n.parent_menu || n.parent_menu === 0) { roots.push(n); return; }
    // Legacy has a few menu_depth=3 nodes (Call Center → PM Weekly / Tx Open).
    // We flatten any grandchild into its nearest top-level parent's child list
    // so the sidebar stays a simple 2-level tree.
    let ancestor = byId.get(n.parent_menu);
    while (ancestor && ancestor.parent_menu && ancestor.parent_menu !== 0) {
      ancestor = byId.get(ancestor.parent_menu);
    }
    if (ancestor) ancestor.children.push(n);
    // If orphan (parent not in the active rows), silently drop.
  });
  return roots;
}

/*
 * A sidebar link is "active" when the browser's URL matches the link's href:
 *   (a) path matches (current pathname === href pathname OR is a descendant),
 *   (b) every query param present in the href matches the current URL.
 *
 * We only compare the href's params (not the full set) because the current URL
 * may carry extra runtime params (e.g. `?view=385` on the jobs modal) that
 * shouldn't break the sidebar highlight.
 *
 * Previously we only matched on `title` — fine for /coming-soon links (which
 * use title to disambiguate) but broken for /jobs?tab=X links where every
 * My Orders sub-item would read as equally active. Generalising to "match
 * every href param" fixes both: coming-soon links still work (their `title`
 * param is checked along with any others), and tab deep-links differentiate
 * themselves correctly.
 */
function isRouteActive(pathname: string, currentSearch: string, href: string) {
  const [hrefPath, hrefQuery] = href.split('?');
  const onPath = pathname === hrefPath || pathname.startsWith(hrefPath + '/');
  if (!hrefQuery) return onPath;
  if (!onPath) return false;
  const hrefParams = new URLSearchParams(hrefQuery);
  const currentParams = new URLSearchParams(currentSearch);
  for (const [k, v] of hrefParams.entries()) {
    if (currentParams.get(k) !== v) return false;
  }
  return true;
}

type RoleHint = { role_name: string; group: string } | undefined;
function allowedFor(role: RoleHint, rule: { allow?: string[]; group?: string[] }): boolean {
  const hasRule = (rule.allow && rule.allow.length) || (rule.group && rule.group.length);
  if (!role) return !hasRule;
  if (rule.allow && rule.allow.length) return rule.allow.includes(role.role_name);
  if (rule.group && rule.group.length) return rule.group.includes(role.group);
  return true;
}

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentSearch = searchParams.toString();
  const { me } = useMe();

  const [menus, setMenus] = useState<MenuRow[] | null>(null);
  useEffect(() => {
    /*
     * Defence in depth: backend `lookup.service.js::menus()` already
     * filters `WHERE menu_status = 1`, so this `.filter` is normally
     * a no-op. We keep it because:
     *   (a) if a future refactor accidentally drops the WHERE clause,
     *       the sidebar still hides inactive menus instead of leaking
     *       half-built routes to operators;
     *   (b) it documents the intended contract at the call site.
     * Mirrors the legacy CRM behaviour where menus toggled off in
     * `tbl_menu.menu_status` immediately disappear from the sidebar.
     */
    api.get<MenuRow[]>('/shared/lookup/menus')
      .then((rows) => setMenus((rows ?? []).filter((r) => Number(r.menu_status) === 1)))
      .catch(() => setMenus([]));
  }, []);

  // Tree + per-role filter.
  const tree = useMemo(() => {
    if (!menus) return [];
    const roots = buildTree(menus);
    // Filter to only parents we have metadata for (role rules + icon). Unknown
    // top-level names get hidden — protects the UI from DB surprises.
    return roots
      .filter((r) => !!PARENT_META[r.menu_name])
      .filter((r) => allowedFor(me?.role, PARENT_META[r.menu_name] || {}));
  }, [menus, me]);

  /*
   * Accordion: exactly one parent open at a time. On initial render or route
   * change, auto-open the parent whose child matches the current URL. When
   * the user clicks a parent, close all others and toggle this one.
   */
  const autoOpenLabel = useMemo(() => {
    for (const p of tree) {
      if (p.children.some((c) => isRouteActive(pathname, currentSearch, legacyToRoute(c.menu_name, c.url)))) {
        return p.menu_name;
      }
    }
    return null;
  }, [tree, pathname, currentSearch]);

  const [openParent, setOpenParent] = useState<string | null>(autoOpenLabel);
  /*
   * Keep `openParent` in sync with the route. We sync to `autoOpenLabel`
   * unconditionally — INCLUDING null — so that navigating to a top-level
   * leaf (Home, anything without a matching child) collapses whichever
   * submenu was previously expanded. Earlier we guarded `if (autoOpenLabel)`
   * which left stale expansions visible after Home clicks.
   *
   * Manual expansion on a non-matching route still works because this
   * effect only fires when `autoOpenLabel` changes, not when `openParent`
   * changes — so clicking a parent button mid-route doesn't immediately
   * snap closed.
   */
  useEffect(() => { setOpenParent(autoOpenLabel); }, [autoOpenLabel]);

  function togglе(label: string) {
    setOpenParent((prev) => (prev === label ? null : label));
  }

  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="px-5 h-16 border-b border-sidebar-accent flex items-center justify-center">
        <Link href="/dashboard" className="flex items-center justify-center">
          <Image
            src="/logo.png"
            alt="EasyFix"
            width={139} height={34}
            priority
            unoptimized
            className="h-9 w-auto object-contain"
          />
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto py-3">
        {menus === null && <div className="px-5 py-3 text-xs text-sidebar-foreground/60">Loading menus…</div>}
        {menus !== null && tree.length === 0 && (
          <div className="px-5 py-3 text-xs text-sidebar-foreground/60">No menus available</div>
        )}
        <ul className="px-3 space-y-0.5">
          {tree.map((parent) => {
            const meta = PARENT_META[parent.menu_name];
            const Icon = meta.icon;
            const open = openParent === parent.menu_name;
            const Chev = open ? ChevronDown : ChevronRight;

            // Parent with no children → render as leaf link.
            if (!parent.children || parent.children.length === 0) {
              const href = legacyToRoute(parent.menu_name, parent.url);
              const active = isRouteActive(pathname, currentSearch, href);
              return (
                <li key={parent.menu_id}>
                  <Link
                    href={href}
                    className={cn(
                      'flex items-center gap-2 rounded px-3 py-2 text-sm transition-colors',
                      active
                        ? 'bg-sidebar-accent text-white'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white'
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{parent.menu_name}</span>
                  </Link>
                </li>
              );
            }

            // Parent with children → accordion header + list.
            const activeChildHref = parent.children
              .map((c) => legacyToRoute(c.menu_name, c.url))
              .filter((href) => isRouteActive(pathname, currentSearch, href))
              .sort((a, b) => b.length - a.length)[0] ?? null;
            const anyChildActive = activeChildHref !== null;

            return (
              <li key={parent.menu_id}>
                <button
                  type="button"
                  onClick={() => togglе(parent.menu_name)}
                  className={cn(
                    'w-full flex items-center gap-2 rounded px-3 py-2 text-sm transition-colors',
                    anyChildActive
                      ? 'text-white bg-sidebar-accent/40'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white'
                  )}
                  aria-expanded={open}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 text-left">{parent.menu_name}</span>
                  <Chev className="h-3.5 w-3.5 shrink-0 opacity-70" />
                </button>
                {open && (
                  <ul className="mt-0.5 ml-6 pl-2 border-l border-sidebar-accent/40 space-y-0.5">
                    {parent.children.map((c) => {
                      const href = legacyToRoute(c.menu_name, c.url);
                      const active = href === activeChildHref;
                      return (
                        <li key={c.menu_id}>
                          <Link
                            href={href}
                            className={cn(
                              'flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px] transition-colors',
                              active
                                ? 'bg-sidebar-accent text-white'
                                : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-white'
                            )}
                          >
                            <Circle className="h-1.5 w-1.5 shrink-0 fill-current opacity-40" />
                            <span className="truncate">{c.menu_name}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
