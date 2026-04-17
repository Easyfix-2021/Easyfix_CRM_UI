'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home, Wrench, Briefcase, Upload, UserCircle2, Users, Building2,
  BarChart3, Bell, Settings, Coins, FileText, Webhook, Archive,
  ChevronRight, ChevronDown, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/*
 * Two-level navigation, matching legacy EasyFix_CRM's parent/child pattern.
 *
 * - Items with `href` only are leaf links (click = navigate).
 * - Items with `children[]` are parents (click = toggle expand).
 * - A parent is auto-expanded when the current route lives under any of its
 *   children — so a user landing on /jobs/upload sees the Jobs group already
 *   open. Manual expand/collapse state layers on top of that via `expanded`.
 */

type NavChild  = { href: string; label: string };
type NavItem   = { label: string; icon: LucideIcon; href?: string; children?: NavChild[] };
type NavGroup  = { section: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    section: 'MAIN',
    items: [
      { label: 'Dashboard', icon: Home, href: '/dashboard' },
      {
        label: 'Jobs', icon: Briefcase,
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
      {
        label: 'Easyfixers', icon: UserCircle2,
        children: [
          { href: '/easyfixers',     label: 'Manage Easyfixers' },
          { href: '/easyfixers/new', label: 'Add Easyfixer' },
        ],
      },
      {
        label: 'Clients', icon: Building2,
        children: [
          { href: '/clients', label: 'Manage Clients' },
          { href: '/users',   label: 'Users' },
        ],
      },
    ],
  },
  {
    section: 'OPS',
    items: [
      {
        label: 'Finance', icon: Coins,
        children: [
          { href: '/finance',  label: 'Overview' },
          { href: '/invoices', label: 'Invoices' },
        ],
      },
      { label: 'Reports',       icon: BarChart3, href: '/reports' },
      { label: 'Notifications', icon: Bell,      href: '/notifications' },
      { label: 'Webhooks',      icon: Webhook,   href: '/webhooks' },
    ],
  },
  {
    section: 'SETTINGS',
    items: [
      {
        label: 'Settings', icon: Settings,
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

export function Sidebar() {
  const pathname = usePathname();

  // Auto-open any parent whose child matches the current route. Feels natural
  // on page load; user can still close it by clicking the parent header.
  const autoOpen = useMemo(() => {
    const set = new Set<string>();
    for (const group of NAV) {
      for (const item of group.items) {
        if (item.children?.some((c) => isRouteActive(pathname, c.href))) set.add(item.label);
      }
    }
    return set;
  }, [pathname]);

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
      <div className="px-5 py-5 border-b border-sidebar-accent">
        <Link href="/dashboard" className="flex items-center">
          {/* Cyan-ink logo renders directly on the dark sidebar — no white tile needed. */}
          <Image src="/logo.png" alt="EasyFix" width={144} height={60} priority className="h-10 w-auto" />
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto py-3">
        {NAV.map((group) => (
          <div key={group.section} className="px-3 py-2">
            <div className="px-2 pb-1 text-[10px] tracking-wider uppercase text-sidebar-foreground/60">{group.section}</div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;

                // Parent with children: expandable header + nested list.
                if (item.children) {
                  const open = expanded.has(item.label) || autoOpen.has(item.label);
                  const anyChildActive = item.children.some((c) => isRouteActive(pathname, c.href));
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
                            const active = isRouteActive(pathname, c.href);
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

                // Leaf link.
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

      <div className="px-5 py-3 border-t border-sidebar-accent text-xs text-sidebar-foreground/60">
        v0.1 · Phase 1B
      </div>
    </aside>
  );
}
