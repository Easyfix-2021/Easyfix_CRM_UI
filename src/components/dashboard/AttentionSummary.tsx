'use client';

import * as React from 'react';
// Link removed 2026-06-03: tiles deep-link to /jobs and /my-orders tab
// filters that currently route to menus hidden by the env-driven menu
// filter (see hidden-menu-ids feature). Until those destinations are
// surfaced again, the tiles render as static cards — counts still
// update, but clicks are no-ops so ops don't land on a Coming-Soon page.
// Re-enable by reinstating the `<Link>` wrapper below when the target
// menus come back online.
import {
  Clock, CheckCircle2, XCircle, BellRing, PhoneOff,
  // PackageX — visual cue for "Booked but no services attached"
  // (line-items missing). Reads like a half-empty parcel; pairs with
  // the amber tint that mirrors the row-level No-Services pill.
  PackageX,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useFetch } from '@/lib/hooks';
import { MarqueeOnHover } from '@/components/dashboard/MarqueeOnHover';

/*
 * AttentionSummary — replaces the older "Recent Jobs" card on the
 * dashboard with a 5-tile action-focused row.
 *
 * Why this exists: Recent Jobs surfaced raw activity (latest 8 across
 * platform) but didn't tell the operator what NEEDED them. The five
 * metrics here are all "click to act" — every tile deep-links to a
 * pre-filtered job list.
 *
 * Counts come from a single round-trip to /admin/jobs/attention-summary,
 * which respects the caller's RBAC scope (clients × cities × verticals
 * via req.scope on the BE — same as /counts).
 *
 * Sub-query failures on the BE return 0 for the failed metric (logged
 * server-side) rather than 500-ing — so a temporary blip on the
 * quotation table doesn't blank out the running-late tile.
 */

type Resp = {
  runningLate: number;
  estimateApproved: number;
  estimateRejected: number;
  pendingTechAccept: number;
  customerUnreachable: number;
  // BOOKED jobs with zero ACTIVE rows in tbl_job_services (added
  // 2026-05-28). Surfaced as the 6th tile; click lands on the BOOKED
  // tab where the row-level No-Services pill is visible per row.
  bookedNoServices: number;
};

type Tile = {
  key: keyof Resp;
  title: string;
  sub: string;
  icon: LucideIcon;
  // Tailwind classes for tint. Each tile uses a distinct hue so an
  // operator scanning the row picks up the priority by colour: red
  // for late + rejected (urgent), amber for approved (action), sky
  // for ack pending, indigo for unreachable.
  iconBg: string;
  iconFg: string;
  href: string;
};

/*
 * Tile order is deliberate — most-urgent first:
 *   1. Running Late      — every minute that passes hurts CX
 *   2. Estimate Approved — money's been said yes to; close the loop
 *   3. Estimate Rejected — recover or close cleanly
 *   4. Pending Tech Ack  — assignment risk; reassign if stale
 *   5. Customer Unreach  — retry queue; lower urgency
 *
 * Hrefs deep-link into /my-orders or /jobs with the matching tab/filter:
 *   - Running Late + Pending Ack live under /my-orders tabs already.
 *   - Estimate Approved/Rejected go to /jobs with a focus param the
 *     jobs list can pick up. The BE list endpoint doesn't currently
 *     filter by quotation status, so the tile drops the operator on
 *     the jobs page; a dedicated `tab=estimate-approved` / -rejected
 *     filter can be wired in /jobs as a follow-up.
 *   - Unreachable maps to status=9 (CALL_LATER), already a /jobs tab.
 */
const TILES: Tile[] = [
  {
    key: 'runningLate',
    title: 'Running Late',
    sub: 'Past Scheduled Time',
    icon: Clock,
    iconBg: 'bg-rose-100',
    iconFg: 'text-rose-700',
    href: '/jobs?tab=running-late',
  },
  {
    key: 'estimateApproved',
    title: 'Estimate Approved',
    sub: 'Align A Transaction',
    icon: CheckCircle2,
    iconBg: 'bg-emerald-100',
    iconFg: 'text-emerald-700',
    href: '/jobs?tab=estimate-approved',
  },
  {
    key: 'estimateRejected',
    title: 'Estimate Rejected',
    sub: 'Immediate Follow-up',
    icon: XCircle,
    iconBg: 'bg-amber-100',
    iconFg: 'text-amber-700',
    href: '/jobs?tab=estimate-rejected',
  },
  {
    key: 'pendingTechAccept',
    title: 'Pending Tech Acceptance',
    sub: 'Awaiting App Ack',
    icon: BellRing,
    iconBg: 'bg-sky-100',
    iconFg: 'text-sky-700',
    href: '/my-orders?tab=pending-app-ack',
  },
  {
    key: 'customerUnreachable',
    title: 'Customer Unreachable',
    sub: 'Retry Queue',
    icon: PhoneOff,
    iconBg: 'bg-violet-100',
    iconFg: 'text-violet-700',
    href: '/jobs?tab=call-later',
  },
  /*
   * Booked-No-Services (added 2026-05-28). Counts BOOKED jobs with
   * zero ACTIVE service rows — the data-quality gap that prompted the
   * row-level No-Services pill on /jobs + /my-orders + /customers/[id].
   * Click deep-links to the BOOKED tab where each anomalous row shows
   * its own clickable pill; from there ops can hop straight to the
   * Services tab to add line items.
   *
   * Tint = amber, matching the row pill, so an operator scanning the
   * dashboard recognises the same "needs Services line items"
   * signal at both levels.
   */
  {
    key: 'bookedNoServices',
    title: 'Booked With No Services',
    sub: 'Add Line Items',
    icon: PackageX,
    iconBg: 'bg-amber-100',
    iconFg: 'text-amber-700',
    // `noServices=true` is the BE list filter (2026-05-28) that pins
    // status=0 + anti-joins tbl_job_services on job_service_status=1.
    // The list page narrows to the exact rows this tile counted.
    href: '/jobs?noServices=true',
  },
];

export function AttentionSummary() {
  const fetched = useFetch<Resp>('/admin/jobs/attention-summary');
  const data: Resp = fetched.data ?? {
    runningLate: 0,
    estimateApproved: 0,
    estimateRejected: 0,
    pendingTechAccept: 0,
    customerUnreachable: 0,
    bookedNoServices: 0,
  };

  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-5 pt-4 pb-2">
          <h2 className="text-base font-semibold">Orders Needing Immediate Attention</h2>
          <p className="text-xs text-muted-foreground">
            Live counts across the queue. Drill-down links are paused while the
            target menus are off in the hidden-menu filter.
          </p>
        </div>

        {/* 6 tiles now (Booked-No-Services added 2026-05-28). lg:6 keeps
            them on one row at desktop; sm:3 keeps the 2-row 3-col layout
            stable at tablet widths so the new tile slots into the
            existing rhythm without reflow. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 p-4">
          {TILES.map((t) => (
            <AttentionTile
              key={t.key}
              tile={t}
              value={data[t.key]}
              loading={fetched.loading}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/*
 * AttentionTile (2026-05-28) — extracted from the inline map so each
 * tile can own its own per-line marquee state. Mirrors the FlowCardTile
 * sync pattern:
 *   1. each `MarqueeOnHover` reports `(overflows, exitDist)` via
 *      `onMeasure`,
 *   2. the tile unions both overflow flags into `animateBoth` so
 *      either-or-both triggers the visual on hover,
 *   3. the tile computes a shared `durationMs` from the MAX exitDist
 *      so the title and sub complete each scroll cycle in lockstep,
 *      eliminating loop-by-loop desync.
 *
 * Idle tiles (neither line overflows) stay still — no JS rAF cost.
 * MarqueeOnHover gates the CSS animation behind the parent <a>:hover
 * rule, so even animating tiles cost nothing until the operator
 * hovers them.
 */
function AttentionTile({ tile, value, loading }: {
  tile: Tile;
  value: number | undefined;
  loading: boolean;
}) {
  const Icon = tile.icon;
  const [titleOverflows, setTitleOverflows] = React.useState(false);
  const [subOverflows,   setSubOverflows]   = React.useState(false);
  const [titleExit, setTitleExit] = React.useState(0);
  const [subExit,   setSubExit]   = React.useState(0);
  const animateBoth = titleOverflows || subOverflows;
  const PX_PER_SEC = 80;
  const sharedDurationMs = Math.max(
    3000,
    Math.round((Math.max(titleExit, subExit) / PX_PER_SEC) * 1000),
  );
  return (
    // Non-clickable tile (2026-06-03). Was previously a <Link href={tile.href}>
    // with hover-shadow that signalled clickability; now a static <div>
    // because the deep-link destinations (e.g. /jobs?tab=estimate-approved,
    // /my-orders?tab=pending-app-ack) currently route to menus in the
    // hidden-menu env filter, so a click lands on Coming Soon. The count
    // is still meaningful — operators read it and act via the visible
    // menus they have access to. Reinstate the <Link> wrapper (and the
    // hover-shadow class) when the target menus are surfaced.
    <div
      className="block rounded-lg border bg-card p-3 cursor-default select-none"
      aria-disabled="true"
      title={`${tile.title} — drill-down temporarily disabled`}
    >
      <div className="flex items-start gap-3 min-w-0">
        <div className={`h-9 w-9 shrink-0 rounded-md grid place-items-center ${tile.iconBg}`}>
          <Icon className={`h-5 w-5 ${tile.iconFg}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-2xl font-semibold tabular-nums leading-none">
            {loading
              ? <span className="inline-block h-6 w-10 rounded bg-muted animate-pulse" />
              : (value ?? 0).toLocaleString('en-IN')}
          </div>
          {/*
           * Title + sub share `animateBoth` (overflow union) and
           * `sharedDurationMs` (duration union) so they move in
           * perfect lockstep on hover. Marquee replaces the previous
           * `truncate` ellipsis — long titles like "Booked With No
           * Services" stay readable rather than getting clipped.
           */}
          <MarqueeOnHover
            className="text-[13px] font-medium mt-1 leading-snug"
            animateOverride={animateBoth}
            durationOverride={sharedDurationMs}
            onMeasure={(ov, dist) => { setTitleOverflows(ov); setTitleExit(dist); }}
          >
            {tile.title}
          </MarqueeOnHover>
          <MarqueeOnHover
            className="text-[11px] text-muted-foreground leading-snug"
            animateOverride={animateBoth}
            durationOverride={sharedDurationMs}
            onMeasure={(ov, dist) => { setSubOverflows(ov); setSubExit(dist); }}
          >
            {tile.sub}
          </MarqueeOnHover>
        </div>
      </div>
    </div>
  );
}
