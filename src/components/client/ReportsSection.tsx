'use client';

/*
 * Client Profile → Reports.
 *
 * Jump-off to the reports that cover this client. Deliberately LINKS rather
 * than embedding: each of these is a full report page with its own filters,
 * date ranges and exports, and rendering one inside a profile panel would give
 * an operator a cramped copy of a screen that already exists.
 *
 * MOST OF THESE LINKS NOW PRE-FILTER TO THIS CLIENT. Each report seeds its own
 * client filter from `?clientId=` via src/lib/report-client-param.ts — one
 * parser, because the reports hold that filter in three different shapes and a
 * per-page Number() would drift silently.
 *
 * ⚠ PRIORITY JOBS IS THE EXCEPTION, and it is a real one rather than an
 * oversight: that report has NO client filter at all. It renders a clientName
 * COLUMN and nothing to narrow by. Adding one is a feature on that page, not a
 * link change, so its card says plainly that it opens unfiltered. `scoped` on
 * each entry below is what decides — flip it only once the page can honour it,
 * because a link that claims a filter it never applied is worse than one that
 * admits it cannot.
 *
 * The one genuinely client-scoped link is the TAT Calculator, which takes a
 * client as its subject — and it is also the source of the SLA-breach figure
 * in this page's headline strip.
 *
 * "The two agree by construction" was asserted here before either half was
 * true. The calculator imported no useSearchParams, so `?mode=client&clientId=`
 * was ignored and the link opened in JOB mode with nothing selected; and even
 * once it read the param, the calculator defaults to a 90-day lookback while
 * the headline KPI above is 30. Both are fixed: the page seeds its state from
 * the URL (src/lib/tat-calculator-url.ts), and this link now carries days=30 so
 * the window matches the number the operator just clicked away from. Change one
 * and you must change the other — that is what "by construction" costs.
 */

import Link from 'next/link';
import { BarChart3, ExternalLink, Timer } from 'lucide-react';
import { SectionShell } from '@/components/client/SectionShell';

/* `scoped` = the page seeds its client filter from ?clientId=. See the header. */
const REPORTS: Array<{ href: string; label: string; note: string; scoped: boolean }> = [
  { href: '/quicksight/client-performance', label: 'Client Performance', note: 'Orders, revenue, SLA and FTFR by client.',      scoped: true  },
  { href: '/quicksight/open-orders',        label: 'Open Orders',        note: 'Everything still in flight, by age.',           scoped: true  },
  { href: '/quicksight/priority-jobs',      label: 'Priority Jobs',      note: 'Escalated and ageing work.',                    scoped: false },
  { href: '/quicksight/city-performance',   label: 'City Performance',   note: 'The same numbers cut by city.',                 scoped: true  },
  { href: '/quicksight/material-report',    label: 'Material Report',    note: 'Parts and materials consumed.',                 scoped: true  },
  { href: '/quicksight/offer-acceptance',   label: 'Offer Acceptance',   note: 'How readily technicians accept this work.',     scoped: true  },
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
            /* days=30 pins the SAME window as the SLA-breach KPI at the top of
               this page (clients/[id]/page.tsx fetches ?days=30). Without it the
               calculator opens on its own 90-day default and shows a different
               number than the one that sent the operator here. */
            href={`/admin-actions/tat-calculator?mode=client&clientId=${clientId}&days=30`}
            className="text-sm text-primary hover:underline inline-flex items-center gap-1 shrink-0"
          >
            Open <ExternalLink className="size-3.5" />
          </Link>
        </div>
      </div>

      <p className="text-xs bg-info-tint text-info-strong border-l-2 border-info rounded-r px-2 py-1.5">
        These open pre-filtered to {clientName || 'this client'}. Each report keeps its
        own filter bar, so the selection can be widened or cleared there.
      </p>

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {REPORTS.map((r) => (
          <li key={r.href} className="rounded border bg-card px-3 py-2.5">
            <Link
              /* Only a scoped report gets the param. Sending it to one that
                 cannot read it is the failure this section used to warn about:
                 the operator sees a client in the URL and trusts a filter that
                 was never applied. */
              href={r.scoped ? `${r.href}?clientId=${clientId}` : r.href}
              className="font-medium text-sm text-primary hover:underline inline-flex items-center gap-1.5"
            >
              <BarChart3 className="size-4" /> {r.label} <ExternalLink className="size-3" />
            </Link>
            <p className="text-xs text-muted-foreground mt-0.5">
              {r.note}
              {!r.scoped && (
                <span className="block text-warning-strong">
                  Opens unfiltered — this report has no client filter to set.
                </span>
              )}
            </p>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}
