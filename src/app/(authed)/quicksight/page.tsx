'use client';

/*
 * QuickSight Reports landing — card grid for the native EF-QuickSight
 * rebuild. One card per report (Title-Case label + short description +
 * link to /quicksight/<urlBase>).
 *
 * Gating (mirrors the /reports landing + the project permission-gating
 * rule):
 *   - The WHOLE page is gated on the family key `ef-QuickSight`. Without
 *     it the operator sees the access panel (they shouldn't reach here
 *     anyway — the sidebar QuickSight menu is hidden without the menu_id —
 *     but direct navigation is defended too).
 *   - Each card is gated on its own per-report action key
 *     (isQuickSight<Report>View) via actionFlags(me, [...]). A report card
 *     renders iff the operator holds that key, so Manage Roles can grant
 *     each report independently.
 *   - Family key held but NO report keys → a dedicated empty state.
 *
 * Permissions come from the standard me/actionFlags pattern (useMe +
 * actionFlags), identical to every other authed page. No raw fetch here —
 * me is provided by AuthProvider.
 *
 * The report list (label / urlBase / actionKey / description / icon) is
 * derived from /tmp/qs/_registry.json; the strings here MUST stay in sync
 * with that canonical registry.
 */

import Link from 'next/link';
import {
  LayoutDashboard, Lock,
  ClipboardList, Gauge, Layers, Flame, Package,
  Building2, Wrench, MapPinned, Users, BarChart3,
  ArrowRight, Handshake, UserPen, ShieldAlert, type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

/* Family gate — must be held to use any QuickSight report. */
const FAMILY_KEY = 'ef-QuickSight';

type ReportCardDef = {
  urlBase: string;
  label: string;
  actionKey: string;
  description: string;
  Icon: LucideIcon;
  /*
   * Cards that BUNDLE several reports (Performance Report = 5 tabs) are visible
   * when the user has ANY of these keys, since each tab is gated separately
   * inside the page. `actionKey` stays the primary/representative key so
   * existing consumers of this list keep working.
   */
  anyOf?: string[];
};

/*
 * Canonical report set — order + labels + urlBase + actionKey match
 * /tmp/qs/_registry.json verbatim. Descriptions are short operator-facing
 * blurbs; icons are chosen to read apart at a glance.
 */
const REPORTS: ReportCardDef[] = [
  {
    urlBase: 'open-orders',
    label: 'Open Orders',
    actionKey: 'isQuickSightOpenOrdersView',
    description: 'Owner-wise open-order alert buckets with per-owner drill-down.',
    Icon: ClipboardList,
  },
  {
    // Bundles the five performance scorecards behind gliding tabs. The three
    // standalone cards below stay — this is an additional entry point, not a
    // replacement, so nobody's bookmark or grant changes.
    urlBase: 'performance',
    label: 'Performance Report',
    actionKey: 'isQuickSightClientPerformanceView',
    anyOf: [
      'isQuickSightClientPerformanceView',
      'isQuickSightCityPerformanceView',
      'isQuickSightTechnicianPerformanceView',
      'isQuickSightStatePerformanceView',
      'isQuickSightUserPerformanceView',
    ],
    description: 'Client, City, Technician, State and User scorecards in one place.',
    Icon: Gauge,
  },
  {
    urlBase: 'client-performance',
    label: 'Client Performance',
    actionKey: 'isQuickSightClientPerformanceView',
    description: 'Monthly / weekly client KPIs grouped by project manager.',
    Icon: Gauge,
  },
  {
    urlBase: 'vertical-orders',
    label: 'Vertical Orders',
    actionKey: 'isQuickSightVerticalOrdersView',
    description: 'Open-order aging across verticals by alert category.',
    Icon: Layers,
  },
  {
    urlBase: 'priority-jobs',
    label: 'Priority Jobs',
    actionKey: 'isQuickSightPriorityJobsView',
    description: 'High-priority jobs needing immediate attention.',
    Icon: Flame,
  },
  {
    urlBase: 'material-report',
    label: 'Material Report',
    actionKey: 'isQuickSightMaterialReportView',
    description: 'Material usage and requirements across jobs.',
    Icon: Package,
  },
  {
    urlBase: 'city-performance',
    label: 'City Performance',
    actionKey: 'isQuickSightCityPerformanceView',
    description: 'City-wise order volume and completion metrics.',
    Icon: Building2,
  },
  {
    urlBase: 'technician-performance',
    label: 'Technician Performance',
    actionKey: 'isQuickSightTechnicianPerformanceView',
    description: 'Per-technician throughput, ratings and outcomes.',
    Icon: Wrench,
  },
  {
    urlBase: 'supply-gap',
    label: 'Supply Gap Analysis',
    actionKey: 'isQuickSightSupplyGapView',
    description: 'Cities with open demand but insufficient technician supply.',
    Icon: MapPinned,
  },
  {
    urlBase: 'employee-productivity',
    label: 'Employee Productivity',
    actionKey: 'isQuickSightEmployeeProductivityView',
    description: 'CRM-user activity and productivity roll-up.',
    Icon: Users,
  },
  {
    urlBase: 'admin-dashboard',
    label: 'Admin Dashboard',
    actionKey: 'isQuickSightAdminDashboardView',
    description: 'Cross-report operational overview for administrators.',
    Icon: BarChart3,
  },
  {
    urlBase: 'offer-acceptance',
    label: 'Offer Acceptance',
    actionKey: 'isQuickSightOfferAcceptanceView',
    description: 'Job-offer acceptance, rejection & response time by technician and source.',
    Icon: Handshake,
  },
  {
    urlBase: 'profile-update-requests',
    label: 'Profile Update Requests',
    actionKey: 'isQuickSightProfileUpdateRequestsView',
    description: 'Easyfixer profile-update link funnel — sent vs submitted by technician.',
    Icon: UserPen,
  },
  {
    urlBase: 'premature-confirmations',
    label: 'Premature Confirmations',
    actionKey: 'isQuickSightPrematureConfirmationsView',
    description: 'Jobs moved to Pending for Scheduling without the customer confirming — no form, no real call.',
    Icon: ShieldAlert,
  },
];

export default function QuickSightLandingPage() {
  const { me } = useMe();

  // One bulk lookup: the family key + every per-report key.
  const flags = actionFlags(me, [
    FAMILY_KEY,
    ...REPORTS.map((r) => r.actionKey),
    // Bundle cards gate on ANY of their tabs' keys, so those must be resolved too.
    ...REPORTS.flatMap((r) => r.anyOf ?? []),
  ]);
  const hasFamily = flags[FAMILY_KEY];
  const visible = REPORTS.filter((r) => (r.anyOf ? r.anyOf.some((k) => flags[k]) : flags[r.actionKey]));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <LayoutDashboard className="size-6" /> QuickSight Reports
        </h1>
        <p className="text-sm text-muted-foreground">
          Native operational reports rebuilt from EF-QuickSight. Open a report
          to filter and download as XLSX.
        </p>
      </div>

      {/* Family-key gate: no ef-QuickSight → access panel, nothing else. */}
      {!hasFamily ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
              <Lock className="size-6" />
            </span>
            <div className="space-y-1">
              <div className="text-base font-semibold">Access Denied</div>
              <p className="max-w-md text-sm text-muted-foreground">
                You don’t have permission to view QuickSight reports. Ask an
                admin to grant you QuickSight access
                (<code className="mx-0.5">ef-QuickSight</code>) in Settings →
                Manage Roles.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : visible.length === 0 ? (
        // Family key held but no individual report keys granted.
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <LayoutDashboard className="size-8 text-muted-foreground" />
            <div className="space-y-1">
              <div className="text-base font-semibold">No Reports Available</div>
              <p className="max-w-md text-sm text-muted-foreground">
                You have QuickSight access but no individual reports are granted
                to your role yet. Ask an admin to grant the specific report
                permissions in Settings → Manage Roles.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((r) => (
            <Link
              key={r.urlBase}
              href={`/quicksight/${r.urlBase}`}
              className="group block focus:outline-none"
            >
              <Card className="h-full transition-colors group-hover:border-primary/50 group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-primary/40">
                <CardContent className="flex h-full flex-col gap-2 p-4">
                  <div className="flex items-center gap-2">
                    <r.Icon className="size-5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1 font-medium">{r.label}</div>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                  </div>
                  <p className="text-xs text-muted-foreground">{r.description}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
