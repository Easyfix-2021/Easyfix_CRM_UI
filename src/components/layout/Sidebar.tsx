'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home, Briefcase, UserCircle2, Users, Building2,
  BarChart3, Bell, Settings, Coins, Webhook,
  ChevronRight, ChevronDown, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMe } from '@/lib/auth-context';

/*
 * Role-aware navigation — mirrors legacy EasyFix_CRM's tbl_role access model.
 *
 * Backend classifies tbl_role.role_id into a "group" (admin | client | mobile |
 * default | unknown) via services/role.service.js::ROLE_ID_TO_GROUP. On top of
 * the group, a specific role_name grants or denies individual screens. This map
 * is the CRM-side equivalent — each leaf/parent can declare `allow` (role_names)
 * or `group` (broader class) and we hide items the user can't access.
 *
 * Rules:
 *   - No `allow` and no `group` → everyone sees it (Dashboard, Notifications).
 *   - `group: ['admin']`       → any admin-group role_name sees it.
 *   - `allow: ['Finance']`     → only that exact role_name.
 *   - If a parent has children, children inherit the parent's rules unless they
 *     override. Parent is hidden if ALL its children are hidden.
 *
 * The specific role→screen map below is based on legacy responsibilities
 * (Finance sees Finance/Invoices; Zonal Field / Project Manager see Jobs/
 * Easyfixers; Business Development sees Clients; etc.). Refine as needed —
 * the classification is data, not code.
 */

type NavChild  = { href: string; label: string; allow?: string[]; group?: string[] };
type NavItem   = {
  label: string; icon: LucideIcon;
  href?: string; children?: NavChild[];
  allow?: string[]; group?: string[];
};
type NavGroup  = { section: string; items: NavItem[] };

const ADMIN_ALL = ['admin']; // shortcut

const NAV: NavGroup[] = [
  {
    section: 'MAIN',
    items: [
      { label: 'Dashboard', icon: Home, href: '/dashboard' }, // everyone
      {
        label: 'Jobs', icon: Briefcase, group: ADMIN_ALL,
        children: [
          { href: '/jobs',         label: 'Manage Jobs' },
          { href: '/jobs/upload',  label: 'Upload Jobs' },
          { href: '/auto-assign',  label: 'Auto Assignment' },
        ],
      },
    ],
  },
  {
    section: 'MANAGE',
    items: [
      // Easyfixers — supply-side roles only.
      {
        label: 'Easyfixers', icon: UserCircle2,
        allow: ['Admin', 'Executive Supply', 'Admin Supply', 'Project Manager', 'Zonal Field Team', 'Solution expert', 'Technology team'],
        children: [
          { href: '/easyfixers',       label: 'Manage Easyfixers' },
          { href: '/easyfixers/zones', label: 'Easyfixer Zones' },
        ],
      },
      {
        label: 'Clients', icon: Building2, group: ADMIN_ALL,
        children: [
          { href: '/clients', label: 'Manage Clients',
            allow: ['Admin', 'Business Development', 'Project Manager', 'Technology team'] },
          { href: '/users',   label: 'Users',
            allow: ['Admin', 'Technology team'] },
        ],
      },
    ],
  },
  {
    section: 'OPS',
    items: [
      // Finance — Finance role or Admin.
      {
        label: 'Finance', icon: Coins, allow: ['Admin', 'Finance', 'Technology team'],
        children: [
          { href: '/finance',  label: 'Overview' },
          { href: '/invoices', label: 'Invoices' },
        ],
      },
      { label: 'Reports',       icon: BarChart3, href: '/reports',       group: ADMIN_ALL },
      { label: 'Notifications', icon: Bell,      href: '/notifications' }, // everyone who logs in
      { label: 'Webhooks',      icon: Webhook,   href: '/webhooks',
        allow: ['Admin', 'Technology team'] },
    ],
  },
  {
    section: 'SETTINGS',
    items: [
      {
        label: 'Settings', icon: Settings,
        allow: ['Admin', 'Technology team'],
        children: [
          { href: '/settings', label: 'Masters' },
          { href: '/legacy',   label: 'Legacy Integration' },
        ],
      },
    ],
  },
];

function isRouteActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + '/');
}

type RoleHint = { role_name: string; group: string } | undefined;

function allowedFor(role: RoleHint, rule: { allow?: string[]; group?: string[] }): boolean {
  // Fail-closed while role is loading: items with explicit allow/group rules
  // stay hidden until /auth/me returns. Items without rules (Dashboard,
  // Notifications) are visible from the first paint. This prevents the
  // "flash of privileged menus" that restricted users saw before filtering
  // kicked in — observed after the first role-based filtering landed.
  const hasRule = (rule.allow && rule.allow.length) || (rule.group && rule.group.length);
  if (!role) return !hasRule;
  if (rule.allow && rule.allow.length) return rule.allow.includes(role.role_name);
  if (rule.group && rule.group.length) return rule.group.includes(role.group);
  return true;
}

export function Sidebar() {
  const pathname = usePathname();
  // Reads from shared AuthProvider — no extra /auth/me call.
  const { me } = useMe();

  // Apply role rules to produce the visible nav tree.
  const visible = useMemo(() => {
    return NAV.map((group) => ({
      section: group.section,
      items: group.items
        .map((item): NavItem | null => {
          if (!allowedFor(me?.role, item)) return null;
          if (item.children) {
            const kids = item.children.filter((c) => allowedFor(me?.role, c));
            if (kids.length === 0) return null;
            return { ...item, children: kids };
          }
          return item;
        })
        .filter((x): x is NavItem => x !== null),
    })).filter((g) => g.items.length > 0);
  }, [me]);

  const autoOpen = useMemo(() => {
    const set = new Set<string>();
    for (const group of visible) {
      for (const item of group.items) {
        if (item.children?.some((c) => isRouteActive(pathname, c.href))) set.add(item.label);
      }
    }
    return set;
  }, [pathname, visible]);

  const [expanded, setExpanded] = useState<Set<string>>(autoOpen);
  function toggle(label: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      {/* Sidebar header — 64px tall, logo centred horizontally + vertically. */}
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
        {visible.map((group) => (
          <div key={group.section} className="px-3 py-2">
            <div className="px-2 pb-1 text-[10px] tracking-wider uppercase text-sidebar-foreground/60">{group.section}</div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;

                if (item.children) {
                  const open = expanded.has(item.label) || autoOpen.has(item.label);
                  /*
                   * Among siblings, only the longest matching href wins the
                   * active style. Without this, `/jobs/upload` makes BOTH
                   * `/jobs` (Manage Jobs) and `/jobs/upload` (Upload Jobs) light
                   * up, because `/jobs` is a prefix of `/jobs/upload`. Sorting
                   * matches by href length and picking the first resolves the
                   * ambiguity the "specific beats general" way users expect.
                   */
                  const activeChildHref =
                    item.children
                      .filter((c) => isRouteActive(pathname, c.href))
                      .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
                  const anyChildActive = activeChildHref !== null;
                  const Chev = open ? ChevronDown : ChevronRight;
                  return (
                    <li key={item.label}>
                      <button
                        type="button"
                        onClick={() => toggle(item.label)}
                        className={cn(
                          'w-full flex items-center gap-2 rounded px-3 py-2 text-sm transition-colors',
                          anyChildActive
                            ? 'text-white bg-sidebar-accent/40'
                            : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white'
                        )}
                        aria-expanded={open}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="flex-1 text-left">{item.label}</span>
                        <Chev className="h-3.5 w-3.5 shrink-0 opacity-70" />
                      </button>
                      {open && (
                        <ul className="mt-0.5 ml-6 pl-2 border-l border-sidebar-accent/40 space-y-0.5">
                          {item.children.map((c) => {
                            const active = c.href === activeChildHref;
                            return (
                              <li key={c.href}>
                                <Link
                                  href={c.href}
                                  className={cn(
                                    'block rounded px-3 py-1.5 text-[13px] transition-colors',
                                    active
                                      ? 'bg-sidebar-accent text-white'
                                      : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-white'
                                  )}
                                >
                                  {c.label}
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                }

                const active = isRouteActive(pathname, item.href!);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href!}
                      className={cn(
                        'flex items-center gap-2 rounded px-3 py-2 text-sm transition-colors',
                        active
                          ? 'bg-sidebar-accent text-white'
                          : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white'
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
