'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  PhoneCall, ShoppingCart, CalendarClock, BellRing,
  Play, CheckCircle2, ShieldCheck, MessageSquare,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatEasyfixerName, statusColorClass, statusLabel } from '@/lib/utils';

/*
 * Dashboard — legacy CRM-inspired data-flow layout.
 *
 * The 8 cards follow the REAL order a job travels through the funnel, so ops
 * can read left-to-right as an operational narrative:
 *
 *   Orders in Followup   →  low-intent leads that need a phone-bump
 *   Unconfirmed Orders   →  customer hasn't confirmed details
 *   Pending Scheduling   →  confirmed but no tech assigned
 *   Pending App Ack      →  tech assigned, awaiting acceptance on app
 *   Pending to Start     →  accepted, awaiting check-in
 *   Pending to Close     →  technician is on-site
 *   Audit & Complete     →  visit finished, awaiting QA
 *   Pending for Feedback →  closed but no customer rating yet
 *
 * Our simple status model (0..10) doesn't have a separate "app acknowledged"
 * flag, so App-Ack + Pending-to-Start both filter on SCHEDULED (1). The label
 * differentiation is intentional — ops understand them as two workflow phases
 * even if they're stored as the same status code. Honest approximation; when
 * the ack flag lands in the schema, the cards sharpen automatically.
 *
 * Every card is a <Link> to /jobs?tab=<value> — the jobs list reads the `tab`
 * query param and preselects that status tab, so clicking a card drops ops
 * straight into the filtered list.
 */

type JobRow = {
  job_id: number; job_status: number; job_type: string; customer_name: string;
  client_name: string; city_name: string; easyfixer_name: string | null;
  created_date_time: string; requested_date_time: string;
};
type ListResp = { items: JobRow[]; total: number };

// Card config — order mirrors the funnel. Tint uses the legacy palette vibe
// (warm orange → amber → slate-blue → sky → teal → green) so the flow reads
// as "warming up the lead → cooling into a closed ticket".
type FlowCard = {
  title: string;
  sub: string;
  icon: LucideIcon;
  tint: string;       // Tailwind gradient + text for the whole card
  statKey: keyof Stats;
  href: string;       // deep-link into jobs list
};
type Stats = {
  followup: number;
  unconfirmed: number;
  pendingScheduling: number;
  pendingAppAck: number;
  pendingToStart: number;
  pendingToClose: number;
  auditComplete: number;
  pendingFeedback: number;
};

/*
 * Card → status mapping (DB truth, documented 2026-04-20):
 *   Orders in Followup   → status 21 (Fulfilment On Hold)        — ops attention
 *   Unconfirmed Orders   → status 9                                — booked from web/API
 *   Pending Scheduling   → status 0 + fk_easyfixter_id IS NULL
 *   Pending App Ack      → status 0 + fk_easyfixter_id IS NOT NULL
 *   Pending to Start     → status 1                                — accepted on app
 *   Pending to Close     → status 2 OR 20                          — checked in
 *   Audit & Complete     → status 3 OR 5                           — closed
 *   Pending for Feedback → status 10                               — closed from app
 *
 * Deep-link slugs match TABS in /jobs: the list page parses `?tab=<slug>` and
 * selects the matching tab (which carries its own status/statuses/assigned
 * filter payload).
 */
/*
 * Card order mirrors the My Orders sidebar sequence (user's canonical order
 * per 2026-04-20). Sidebar + dashboard staying in step means ops can read
 * left-to-right and click any card to land on the matching sidebar sub-item.
 * All hrefs point to /my-orders (user-scoped flow), not /jobs.
 */
const FLOW: FlowCard[] = [
  { title: 'Unconfirmed Orders',      sub: 'Booked from web / API',     icon: ShoppingCart,  tint: 'from-red-500 to-red-600',          statKey: 'unconfirmed',       href: '/my-orders?tab=unconfirmed' },
  { title: 'Pending for Scheduling',  sub: 'Confirmed, no tech yet',    icon: CalendarClock, tint: 'from-orange-500 to-orange-600',    statKey: 'pendingScheduling', href: '/my-orders?tab=pending-scheduling' },
  { title: 'Pending to Start',        sub: 'Accepted, pre check-in',    icon: Play,          tint: 'from-sky-500 to-sky-600',          statKey: 'pendingToStart',    href: '/my-orders?tab=pending-start' },
  { title: 'Pending App Ack',         sub: 'Assigned, awaiting tech',   icon: BellRing,      tint: 'from-amber-500 to-amber-600',      statKey: 'pendingAppAck',     href: '/my-orders?tab=pending-app-ack' },
  { title: 'Pending to Close',        sub: 'Technician on-site',        icon: CheckCircle2,  tint: 'from-blue-500 to-blue-600',        statKey: 'pendingToClose',    href: '/my-orders?tab=pending-close' },
  { title: 'Audit & Complete',        sub: 'Closed — QA review',        icon: ShieldCheck,   tint: 'from-emerald-500 to-emerald-600',  statKey: 'auditComplete',     href: '/my-orders?tab=audit-complete' },
  { title: 'Pending for Feedback',    sub: 'Closed from app',           icon: MessageSquare, tint: 'from-teal-500 to-teal-600',        statKey: 'pendingFeedback',   href: '/my-orders?tab=pending-feedback' },
  { title: 'Orders in Followup',      sub: 'Fulfilment on hold',        icon: PhoneCall,     tint: 'from-fuchsia-500 to-fuchsia-600',  statKey: 'followup',          href: '/my-orders?tab=onhold' },
];

/*
 * Card layout is intentionally vertical — at xl:grid-cols-8, each card is
 * ~150px wide, which can't fit "ORDERS IN FOLLOWUP" on one line when letter-
 * spacing is wide. Solution: drop the tracking-wide + uppercase treatment
 * (they ate most of the horizontal budget), stack the icon above the title,
 * and let the title use line-clamp-2 so it wraps cleanly instead of getting
 * clipped by the overflow box.
 *
 * Visual rhythm — top: small icon chip · middle: title (2 lines max) +
 * one-line sub · bottom: big count. Same gradient palette as before.
 */
function FlowCardTile({ card, value, loading }: { card: FlowCard; value: number; loading: boolean }) {
  const Icon = card.icon;
  return (
    <Link href={card.href} className="block">
      <div className={`rounded-lg bg-gradient-to-br ${card.tint} text-white shadow-sm hover:shadow-md hover:scale-[1.02] transition-all p-3 h-full flex flex-col gap-2 min-h-[130px]`}>
        <div className="flex items-center justify-between">
          <div className="h-7 w-7 rounded-md bg-white/15 grid place-items-center shrink-0">
            <Icon className="h-4 w-4" />
          </div>
          {/* Large count lives on the same row as the icon — balances the card
              and guarantees the number never wraps/clips, regardless of title length. */}
          <div className="text-2xl font-semibold tabular-nums leading-none text-right">
            {loading ? <span className="inline-block h-6 w-10 rounded bg-white/20 animate-pulse" /> : value.toLocaleString('en-IN')}
          </div>
        </div>
        <div className="mt-auto">
          <div className="text-[13px] font-semibold leading-snug line-clamp-2">{card.title}</div>
          <div className="text-[11px] opacity-80 leading-snug truncate">{card.sub}</div>
        </div>
      </div>
    </Link>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats>({
    followup: 0, unconfirmed: 0, pendingScheduling: 0, pendingAppAck: 0,
    pendingToStart: 0, pendingToClose: 0, auditComplete: 0, pendingFeedback: 0,
  });
  const [recent, setRecent] = useState<JobRow[]>([]);
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingRecent, setLoadingRecent] = useState(true);

  useEffect(() => {
    // One counts query covers every status bucket we need. Two requests fire
    // in parallel (counts + recent list). Single pool hit per request.
    (async () => {
      try {
        const r = await api.get<{
          total: number;
          byStatus: Record<string, number>;
          bookedUnassigned: number;
          bookedAssigned: number;
        }>('/admin/jobs/counts');
        const b = r.byStatus || {};
        /*
         * Canonical status → card mapping (2026-04-20 truth):
         *   21                  → Orders in Followup
         *   9                   → Unconfirmed Orders
         *   0 + tech null       → Pending for Scheduling (bookedUnassigned)
         *   0 + tech not null   → Pending App Ack        (bookedAssigned)
         *   1                   → Pending to Start
         *   2, 20               → Pending to Close
         *   3, 5                → Audit & Complete
         *   10                  → Pending for Feedback
         */
        setStats({
          followup:          b['21'] ?? 0,
          unconfirmed:       b['9']  ?? 0,
          pendingScheduling: r.bookedUnassigned ?? 0,
          pendingAppAck:     r.bookedAssigned   ?? 0,
          pendingToStart:    b['1']  ?? 0,
          pendingToClose:    (b['2'] ?? 0) + (b['20'] ?? 0),
          auditComplete:     (b['3'] ?? 0) + (b['5']  ?? 0),
          pendingFeedback:   b['10'] ?? 0,
        });
      } finally { setLoadingStats(false); }
    })();
    (async () => {
      try {
        const r = await api.get<ListResp>('/admin/jobs', { limit: 8 });
        setRecent(r.items);
      } finally { setLoadingRecent(false); }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Operations snapshot — click any card to open the filtered job list</p>
      </div>

      {/*
        * Data-flow funnel — 8 cards left-to-right, wraps on narrow viewports.
        * Breakpoints tuned so each card has ≥150 px of content width:
        *   <640  → 2 cols (cards ~45% viewport, fits title comfortably)
        *   640+  → 4 cols (half-width still comfortable)
        *   1024+ → 4 cols held (2xl would be too tight on typical laptops)
        *   1536+ → 8 cols (ultrawide: full funnel visible in one row)
        */}
      <div className="grid grid-cols-2 sm:grid-cols-4 2xl:grid-cols-8 gap-3">
        {FLOW.map((card) => (
          <FlowCardTile key={card.title} card={card} value={stats[card.statKey]} loading={loadingStats} />
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between p-5 pb-3">
            <div>
              <h2 className="text-base font-semibold">Recent Jobs</h2>
              <p className="text-xs text-muted-foreground">Latest 8 jobs across the platform</p>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Job #</th><th>Client</th><th>Customer</th><th>City</th>
                <th>Tech</th><th>Status</th><th>Created</th>
              </tr>
            </thead>
            <tbody>
              {loadingRecent && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: 7 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-24 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!loadingRecent && recent.length === 0 && (
                <tr><td colSpan={7} className="text-center text-muted-foreground py-8">No jobs yet</td></tr>
              )}
              {!loadingRecent && recent.map((j) => (
                <tr key={j.job_id}>
                  <td className="font-medium">#{j.job_id}</td>
                  <td>{j.client_name ?? '—'}</td>
                  <td>{j.customer_name ?? '—'}</td>
                  <td>{j.city_name ?? '—'}</td>
                  <td>{j.easyfixer_name ? formatEasyfixerName(j.easyfixer_name) : <span className="text-muted-foreground">unassigned</span>}</td>
                  <td>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColorClass(j.job_status)}`}>
                      {/* Use easyfixer_name presence as a proxy for tech assignment — the
                          dashboard row doesn't carry fk_easyfixter_id directly, but the name
                          comes from a LEFT JOIN on that FK, so null ⇔ no tech. */}
                      {statusLabel(j.job_status, { assigned: !!j.easyfixer_name })}
                    </span>
                  </td>
                  <td className="text-muted-foreground text-xs">{new Date(j.created_date_time).toLocaleDateString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
