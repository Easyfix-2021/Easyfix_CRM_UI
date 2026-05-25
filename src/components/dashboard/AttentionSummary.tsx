'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Clock, CheckCircle2, XCircle, BellRing, PhoneOff,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useFetch } from '@/lib/hooks';

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
];

export function AttentionSummary() {
  const fetched = useFetch<Resp>('/admin/jobs/attention-summary');
  const data: Resp = fetched.data ?? {
    runningLate: 0,
    estimateApproved: 0,
    estimateRejected: 0,
    pendingTechAccept: 0,
    customerUnreachable: 0,
  };

  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-5 pt-4 pb-2">
          <h2 className="text-base font-semibold">Orders Needing Immediate Attention</h2>
          <p className="text-xs text-muted-foreground">
            Click any tile to open the filtered list and act on the queue.
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 p-4">
          {TILES.map((t) => {
            const Icon = t.icon;
            const value = data[t.key];
            return (
              <Link
                key={t.key}
                href={t.href}
                // Removing the link decoration so the tile reads as a
                // tile, not as a hyperlink — hover-only shadow conveys
                // it's clickable.
                className="block rounded-lg border bg-card hover:shadow-md hover:border-foreground/20 transition-all p-3"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div className={`h-9 w-9 shrink-0 rounded-md grid place-items-center ${t.iconBg}`}>
                    <Icon className={`h-5 w-5 ${t.iconFg}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-2xl font-semibold tabular-nums leading-none">
                      {fetched.loading
                        ? <span className="inline-block h-6 w-10 rounded bg-muted animate-pulse" />
                        : (value ?? 0).toLocaleString('en-IN')}
                    </div>
                    <div className="text-[13px] font-medium mt-1 leading-snug truncate">
                      {t.title}
                    </div>
                    <div className="text-[11px] text-muted-foreground leading-snug truncate">
                      {t.sub}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
