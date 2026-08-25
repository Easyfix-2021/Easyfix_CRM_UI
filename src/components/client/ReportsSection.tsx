'use client';

/*
 * Client Profile → Reports.
 *
 * Jump-off to the reports that cover this client. Deliberately LINKS rather
 * than embedding: each of these is a full report page with its own filters,
 * date ranges and exports, and rendering one inside a profile panel would give
 * an operator a cramped copy of a screen that already exists.
 *
 * ⚠ NONE OF THESE LINKS PRE-FILTER TO THIS CLIENT. No report page reads a
 * clientId from the URL today (checked across every route under /quicksight),
 * so a `?clientId=` would be silently ignored and the operator would trust a
 * filter that was never applied. Saying so in the UI is the honest version;
 * teaching the report pages to read the param is the real fix and is a
 * separate change to those pages.
 *
 * The one genuinely client-scoped link is the TAT Calculator, which takes a
 * client as its subject — and it is also the source of the SLA-breach figure
 * in this page's headline strip, so the two agree by construction.
 */

import Link from 'next/link';
import { BarChart3, ExternalLink, Timer } from 'lucide-react';
import { SectionShell } from '@/components/client/SectionShell';

const REPORTS: Array<{ href: string; label: string; note: string }> = [
  { href: '/quicksight/client-performance', label: 'Client Performance', note: 'Orders, revenue, SLA and FTFR by client.' },
  { href: '/quicksight/open-orders',        label: 'Open Orders',        note: 'Everything still in flight, by age.' },
  { href: '/quicksight/priority-jobs',      label: 'Priority Jobs',      note: 'Escalated and ageing work.' },
  { href: '/quicksight/city-performance',   label: 'City Performance',   note: 'The same numbers cut by city.' },
  { href: '/quicksight/material-report',    label: 'Material Report',    note: 'Parts and materials consumed.' },
  { href: '/quicksight/offer-acceptance',   label: 'Offer Acceptance',   note: 'How readily technicians accept this work.' },
];

export function ReportsSection({ clientId, clientName }: { clientId: number; clientName: string }) {
  return (
    <SectionShell title="Reports" note={`Reporting that covers ${clientName || 'this client'}.`}>
      <div className="rounded border bg-card px-3 py-2.5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="font-medium text-sm flex items-center gap-1.5">
              <Timer className="size-4" /> TAT Calculator
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Segment-by-segment turnaround for this client — the same engine behind
              the SLA-breach figure at the top of this page.
            </p>
          </div>
          <Link
            href={`/admin-actions/tat-calculator?mode=client&clientId=${clientId}`}
            className="text-sm text-primary hover:underline inline-flex items-center gap-1 shrink-0"
          >
            Open <ExternalLink className="size-3.5" />
          </Link>
        </div>
      </div>

      <p className="text-xs bg-info-tint text-info-strong border-l-2 border-info rounded-r px-2 py-1.5">
        The reports below open unfiltered — pick this client in the report&apos;s own
        filter bar. They do not accept a client from the URL yet.
      </p>

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {REPORTS.map((r) => (
          <li key={r.href} className="rounded border bg-card px-3 py-2.5">
            <Link href={r.href} className="font-medium text-sm text-primary hover:underline inline-flex items-center gap-1.5">
              <BarChart3 className="size-4" /> {r.label} <ExternalLink className="size-3" />
            </Link>
            <p className="text-xs text-muted-foreground mt-0.5">{r.note}</p>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}
