'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  Home, Briefcase, UserCircle2, Users, Building2,
  BarChart3, Settings, Coins, ShoppingBag, Wallet, User, MapPin,
  Megaphone,
  ChevronRight, ChevronDown, Circle, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMe } from '@/lib/auth-context';
import { useFetchOnce } from '@/lib/hooks';
// URL_MAP lives in a shared module so middleware.ts (server-side route
// guard) can reverse-map hidden legacy URLs → Next.js paths without
// duplicating the table. See src/lib/legacy-url-map.ts for the full mapping
// + the My Orders enumDesc rationale.
import { URL_MAP } from '@/lib/legacy-url-map';

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
 *   3. Permission filter — driven by `me.permissions.menuIds` (resolved
 *      server-side from `tbl_role.menu_ids`, matching the legacy CRM
 *      LoginAction.java session map). A menu (parent OR child) is visible
 *      iff its `menu_id` appears in the allowlist. Parents with no visible
 *      children but whose own id IS in menuIds still render (legacy
 *      parity — the legacy `Navigation.vm` iterates the menuList without
 *      pruning empty parents).
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


// Top-level parent → lucide icon. Keyed by menu_name so DB changes don't
// break us as long as the canonical names stay stable.
//
// No code-level menu-name suppression: tbl_menu is the single source of
// truth for which menus exist and which parent each one sits under. To
// move a menu (e.g. "Manage User") between parents, edit the row's
// parent_menu in tbl_menu; to hide it entirely, set menu_status = 0 or
// remove its menu_id from the role's menu_ids CSV.
//
// Role-based visibility used to live here as `allow` / `group` arrays. That
// hardcoded model has been retired — visibility is now driven entirely by
// `me.permissions.menuIds` (resolved from `tbl_role.menu_ids` server-side),
// matching the legacy CRM's session-map semantics. This map keeps ONLY the
// icon assignment; a parent name missing from this map still renders but
// without a custom icon (falls back to a circle bullet).
const PARENT_META: Record<string, { icon: LucideIcon }> = {
  'Home':              { icon: Home },
  'Notice Board':      { icon: Megaphone },
  'Jobs':              { icon: Briefcase },
  'My Orders':         { icon: ShoppingBag },
  'Customers':         { icon: Users },
  'Clients':           { icon: Building2 },
  'EasyFixers':        { icon: UserCircle2 },
  'Finance':           { icon: Coins },
  'User':              { icon: User },
  'Settings':          { icon: Settings },
  'Report':            { icon: BarChart3 },
  'Tracking':          { icon: MapPin },
  'Easyfixer Advance': { icon: Wallet },
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

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentSearch = searchParams.toString();
  const { me } = useMe();

  /*
   * Menus go through `useFetchOnce` for module-level Strict-Mode
   * dedupe + 30s cache. Without this, Sidebar's mount effect fired
   * twice on every authed-page load in dev. The defence-in-depth
   * `menu_status === 1` filter runs in a useMemo over the hook
   * output so we don't re-derive on every render.
   *
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
  const menusFetch = useFetchOnce<MenuRow[]>('/shared/lookup/menus');
  const menus: MenuRow[] | null = menusFetch.loading
    ? null
    : (menusFetch.data ?? []).filter((r) => Number(r.menu_status) === 1);

  // Tree + per-user permission filter.
  //
  // The allowlist is `me.permissions.menuIds` (server-resolved from the
  // user's role.menu_ids CSV, exactly as legacy LoginAction did).
  //
  // Visibility rules:
  //   - empty menuIds  → empty sidebar (no fallthrough to "show everything")
  //   - parent in list → parent renders (legacy Navigation.vm doesn't
  //     prune empty parents)
  //   - parent NOT in list but at least one child IS → render the parent
  //     so the child is actually reachable. This handles the data shape
  //     produced by the Manage Roles editor when the operator checks
  //     "Manage Jobs" without explicitly also checking the "Jobs"
  //     parent. Without this fallthrough, granting a child-only role
  //     (e.g. Executive Supply with `Manage Jobs` but no `Jobs` parent
  //     id) produced a sidebar that only showed Home even though the
  //     role had several menus.
  const allowedMenuIds = useMemo(
    () => new Set(me?.permissions?.menuIds ?? []),
    [me?.permissions?.menuIds],
  );

  const tree = useMemo(() => {
    if (!menus) return [];
    const roots = buildTree(menus);
    return roots
      .map((r) => ({
        ...r,
        children: r.children.filter((c) => allowedMenuIds.has(c.menu_id)),
      }))
      // Keep a parent if EITHER it's directly granted OR it has at least
      // one allowed child after pruning. Roots with no children at all
      // (legacy top-level pages like Home) still need their own id in
      // the allowlist to render — they have no implicit "via a child"
      // path.
      .filter((r) => allowedMenuIds.has(r.menu_id) || r.children.length > 0);
  }, [menus, allowedMenuIds]);

  /*
   * Single globally-active href across the entire sidebar.
   *
   * Bug this prevents: when two menu rows in DIFFERENT parents share a
   * pathname (e.g. "App Job" → /my-orders and a Manage-Orders submenu
   * → /my-orders?focus=X), both used to highlight simultaneously
   * because each parent picked its own most-specific match in
   * isolation. Per-parent scoring is correct within a parent but
   * doesn't reconcile across parents.
   *
   * Fix: collect every renderable href once (leaves + children),
   * filter to those that match the current URL via isRouteActive,
   * and pick the LONGEST one — the most-specific URL that still
   * matches is the actual destination the operator clicked.
   * Everything else stays inactive. Mirrors the legacy CRM's
   * "exact match wins" behaviour.
   */
  const globalActiveHref = useMemo(() => {
    const all: string[] = [];
    for (const parent of tree) {
      if (!parent.children || parent.children.length === 0) {
        all.push(legacyToRoute(parent.menu_name, parent.url));
      } else {
        for (const c of parent.children) {
          all.push(legacyToRoute(c.menu_name, c.url));
        }
      }
    }
    const matches = all
      .filter((h) => h !== '#' && isRouteActive(pathname, currentSearch, h))
      .sort((a, b) => b.length - a.length);
    return matches[0] ?? null;
  }, [tree, pathname, currentSearch]);

  /*
   * Accordion: exactly one parent open at a time. On initial render or route
   * change, auto-open the parent whose child OWNS the globally-active href.
   * Using the global match (not per-parent isRouteActive) ensures the opened
   * parent is the same one whose row visually highlights — otherwise an
   * earlier-in-tree parent that incidentally matched the same pathname could
   * auto-open instead of the right one.
   */
  const autoOpenLabel = useMemo(() => {
    if (!globalActiveHref) return null;
    for (const p of tree) {
      if (p.children?.some((c) => legacyToRoute(c.menu_name, c.url) === globalActiveHref)) {
        return p.menu_name;
      }
    }
    return null;
  }, [tree, globalActiveHref]);

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
            // Fallback to Circle for any parent whose name isn't in PARENT_META.
            // We removed the hard-filter so DB-driven parents can render even
            // without curated icon metadata — visibility is decided by
            // permissions, not by what we've hand-mapped here.
            const meta = PARENT_META[parent.menu_name] ?? { icon: Circle };
            const Icon = meta.icon;
            const open = openParent === parent.menu_name;
            const Chev = open ? ChevronDown : ChevronRight;

            // Parent with no children → render as leaf link.
            if (!parent.children || parent.children.length === 0) {
              const href = legacyToRoute(parent.menu_name, parent.url);
              // Compare against the globally-resolved active href so
              // siblings with overlapping URLs don't all light up.
              const active = href === globalActiveHref;
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

            // Parent with children → accordion header + list. The
            // single globally-active href (computed above) decides
            // which child lights up; this parent is "active" only if
            // ITS list contains that href. Previously each parent
            // computed its own most-specific match in isolation, which
            // caused multiple parents to light up at once when two of
            // their children shared a pathname (App Job vs Manage Orders).
            const anyChildActive = globalActiveHref !== null && parent.children
              .some((c) => legacyToRoute(c.menu_name, c.url) === globalActiveHref);
            const activeChildHref = anyChildActive ? globalActiveHref : null;

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
                    {parent.children
                      // Legacy `url='javascript:;'` rows were sidebar
                      // category folders in the old 3-level tree. Our new
                      // sidebar flattens to 2 levels, so those folders are
                      // dead-link siblings of their own grandchildren. They
                      // render as `href='#'` after `legacyToRoute()` — hide
                      // them entirely to avoid "nothing happens on click".
                      .filter((c) => legacyToRoute(c.menu_name, c.url) !== '#')
                      .map((c) => {
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
