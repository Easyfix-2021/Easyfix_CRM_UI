'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  Home, Briefcase, UserCircle2, Users, Building2,
  BarChart3, Settings, Coins, ShoppingBag, Wallet, User, MapPin,
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

/*
 * Parent menu structure mirrors legacy tbl_menu (Apr 2026 snapshot) — 12
 * top-level parents in the order / case from the DB. Children are the
 * filtered, active rows under each parent, flattened where legacy had a
 * 3-level nest (e.g. Tracking → Call Center → … collapses to Tracking → …).
 *
 * Unmigrated features route to /coming-soon?title=…&legacyPath=… rather than
 * each having its own .tsx stub. Swap a WIP href to the real route when the
 * feature lands; no file churn needed. See `wip()` helper below.
 */
const wip = (title: string, legacyPath?: string) => {
  const q = new URLSearchParams({ title });
  if (legacyPath) q.set('legacyPath', legacyPath);
  return `/coming-soon?${q.toString()}`;
};

const NAV: NavGroup[] = [
  {
    section: 'MAIN',
    items: [
      { label: 'Home', icon: Home, href: '/dashboard' },
      {
        label: 'Jobs', icon: Briefcase, group: ADMIN_ALL,
        children: [
          { href: '/jobs',                                         label: 'Manage Jobs' },
          { href: wip('App Job', 'androidAppJob'),                 label: 'App Job' },
          { href: '/jobs/upload',                                  label: 'Upload Jobs' },
          { href: wip('Change Job Owner', 'changeJobOwner'),       label: 'Change Job Owner' },
          { href: wip('Call Later', 'callLater'),                  label: 'Call Later' },
          { href: '/auto-assign',                                  label: 'Auto Assignment' },
        ],
      },
      {
        label: 'My Orders', icon: ShoppingBag,
        children: [
          { href: wip('Unconfirmed',                  'dashboardChecking?enumDesc=UnConfirmed'),              label: 'Unconfirmed' },
          { href: wip('Pending to Scheduling',        'dashboardChecking?enumDesc=PendingForScheduling'),     label: 'Pending to Scheduling' },
          { href: wip('Pending to Start',             'dashboardChecking?enumDesc=NotStarted'),               label: 'Pending to Start' },
          { href: wip('Pending to APP Acknowledge',   'dashboardChecking?enumDesc=PendingForAcknowledgement'),label: 'Pending to APP Acknowledge' },
          { href: wip('Pending to Close on App',      'dashboardChecking?enumDesc=NotCompleted'),             label: 'Pending to Close on App' },
          { href: wip('Audit & Complete',             'dashboardChecking?enumDesc=PendingForCheckout'),       label: 'Audit & Complete' },
          { href: wip('Pending for Feedback',         'dashboardChecking?enumDesc=PendingFeedback'),          label: 'Pending for Feedback' },
          { href: wip('Orders in Follow-up',          'dashboardChecking?enumDesc=PendingForApproval'),       label: 'Orders in Follow-up' },
        ],
      },
    ],
  },
  {
    section: 'MANAGE',
    items: [
      {
        label: 'Customers', icon: Users, group: ADMIN_ALL,
        children: [
          { href: wip('Manage Customers', 'customer'), label: 'Manage Customers' },
        ],
      },
      {
        label: 'Clients', icon: Building2,
        allow: ['Admin', 'Business Development', 'Project Manager', 'Technology team'],
        children: [
          { href: wip('Manage Clients', 'client'), label: 'Manage Clients' },
        ],
      },
      {
        label: 'EasyFixers', icon: UserCircle2,
        allow: ['Admin', 'Executive Supply', 'Admin Supply', 'Project Manager', 'Zonal Field Team', 'Solution expert', 'Technology team'],
        children: [
          { href: '/easyfixers',                                 label: 'Manage EasyFixers' },
          { href: '/easyfixers/zones',                           label: 'Easyfixer Zones' },
          { href: wip('Easyfixer Search', 'checkBalance'),       label: 'Search' },
          { href: wip('Registered EasyFixer', 'efer-registration'), label: 'Registered EasyFixer' },
          { href: wip('Servicemen Payout', 'servicemenPayout'),  label: 'Servicemen Payout' },
        ],
      },
      {
        label: 'User', icon: User, allow: ['Admin', 'Technology team'],
        children: [
          { href: wip('Manage User', 'user'), label: 'Manage User' },
        ],
      },
    ],
  },
  {
    section: 'OPS',
    items: [
      {
        label: 'Finance', icon: Coins, allow: ['Admin', 'Finance', 'Technology team'],
        children: [
          { href: wip('Easyfixer Debit',     'easyfixerDebit'),     label: 'Easyfixer Debit' },
          { href: wip('Easyfixer Credit',    'easyfixerCredit'),    label: 'Easyfixer Credit' },
          { href: wip('Client Invoice',      'clientInvoice'),      label: 'Client Invoice' },
          { href: wip('NDM Collection',      'ndmCollection'),      label: 'NDM Collection' },
          { href: wip('Collection Approval', 'updateRecharge'),     label: 'Collection Approval' },
        ],
      },
      {
        label: 'Easyfixer Advance', icon: Wallet,
        allow: ['Admin', 'Finance', 'Technology team'],
        children: [
          { href: wip('Audit Advance', 'easyfixerAdvance'), label: 'Audit Advance' },
        ],
      },
      {
        label: 'Report', icon: BarChart3, group: ADMIN_ALL,
        children: [
          { href: wip('Complete Jobs Report', 'completedJobsReport'),    label: 'Complete Jobs Report' },
          { href: wip('EFR Report',           'manageEfrReport'),        label: 'EFR Report' },
          { href: wip('Escalation Report',    'manageEscalationReport'), label: 'Escalation Report' },
          { href: wip('Finance Report',       'manageFinanceReport'),    label: 'Finance Report' },
        ],
      },
      {
        label: 'Tracking', icon: MapPin, group: ADMIN_ALL,
        children: [
          { href: wip('PM Weekly Performance',     'userLoggingHours'), label: 'PM Weekly Performance' },
          { href: wip('Tx Open Orders',            'jobTracking'),      label: 'Tx Open Orders' },
          { href: wip('Monthly Client Performance','clientTracking'),   label: 'Monthly Client Performance' },
          { href: wip('Available Tx in City',      'cityAnalysis'),     label: 'Available Tx in City' },
        ],
      },
    ],
  },
  {
    section: 'SETTINGS',
    items: [
      {
        label: 'Settings', icon: Settings,
        allow: ['Admin', 'Technology team'],
        children: [
          { href: wip('Manage Cities',           'city'),                     label: 'Manage Cities' },
          { href: wip('Manage Vertical',         'vertical'),                 label: 'Manage Vertical' },
          { href: wip('Manage Service Category', 'servicecategory'),          label: 'Manage Service Category' },
          { href: wip('Manage Service Type',     'servicetype'),              label: 'Manage Service Type' },
          { href: wip('Manage Services',         'clientratecard'),           label: 'Manage Services' },
          { href: wip('Manage Role',             'usertype'),                 label: 'Manage Role' },
          { href: wip('Manage Document Type',    'documentType'),             label: 'Manage Document Type' },
          { href: wip('Manage Skill Level',      'skill'),                    label: 'Manage Skill Level' },
          { href: wip('Manage Tools',            'tool'),                     label: 'Manage Tools' },
          { href: '/settings/deep-skills',                                    label: 'Manage Deep Skills' },
          { href: wip('Admin Action',            'generateClientInvoice'),    label: 'Admin Action' },
        ],
      },
    ],
  },
];

function isRouteActive(pathname: string, currentSearch: string, href: string) {
  // hrefs carrying a query (our WIP /coming-soon?title=… routes) must match
  // BOTH the pathname AND the `title` param, otherwise every WIP sidebar entry
  // would light up simultaneously whenever any coming-soon page is open.
  const [hrefPath, hrefQuery] = href.split('?');
  const onPath = pathname === hrefPath || pathname.startsWith(hrefPath + '/');
  if (!hrefQuery) return onPath;
  if (!onPath) return false;
  const hrefParams = new URLSearchParams(hrefQuery);
  const currentParams = new URLSearchParams(currentSearch);
  return hrefParams.get('title') === currentParams.get('title');
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
  const searchParams = useSearchParams();
  const currentSearch = searchParams.toString();
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
        if (item.children?.some((c) => isRouteActive(pathname, currentSearch, c.href))) set.add(item.label);
      }
    }
    return set;
  }, [pathname, currentSearch, visible]);

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
                      .filter((c) => isRouteActive(pathname, currentSearch, c.href))
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

                const active = isRouteActive(pathname, currentSearch, item.href!);
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
