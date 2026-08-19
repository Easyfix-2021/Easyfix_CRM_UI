'use client';
import * as React from 'react';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  PhoneCall, ShoppingCart, CalendarClock, BellRing,
  Play, CheckCircle2, ShieldCheck, MessageSquare,
  type LucideIcon,
} from 'lucide-react';
import { useFetchOnce } from '@/lib/hooks';
import { JobModal, type JobModalMode } from '@/components/job/JobModal';
import { NoticeStrip } from '@/components/notice/NoticeStrip';
import { UpcomingEvents } from '@/components/dashboard/UpcomingEvents';
import { AttentionSummary } from '@/components/dashboard/AttentionSummary';
import { MarqueeOnHover } from '@/components/dashboard/MarqueeOnHover';

/*
 * Dashboard fetches now go through `useFetchOnce` (lib/hooks.ts) —
 * the module-level dedupe + 30s cache means the dashboard's `/counts`
 * call shares its Promise + cache entry with the Navbar's identical
 * `/counts` call instead of firing it separately. Down from 3 calls
 * on first dashboard load (1 dashboard + 2 Strict-Mode-doubled
 * Navbar) to 1 total.
 */

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

// JobRow / ListResp removed 2026-05-22: Recent Jobs is no longer
// rendered on the dashboard; the AttentionSummary card replaces it.
// If a future surface needs the recent-jobs query, restore both the
// type and the recentFetch/state from git history.

// Card config — order mirrors the funnel. Tint uses the legacy palette vibe
// (warm orange → amber → slate-blue → sky → teal → green) so the flow reads
// as "warming up the lead → cooling into a closed ticket".
type FlowCard = {
  title: string;
  sub: string;
  icon: LucideIcon;
  tint: string;       // card surface + on-tint text; see the adjacency rule below
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
/*
 * COLOUR ADJACENCY RULE — the grid is 4 columns x 2 rows, so card N sits beside
 * N±1 and directly above N+4. No card may share a tint with either.
 *
 * This is not fussiness. An earlier pass mapped each stage to its "meaning"
 * colour and produced green beside green and amber above amber, because eight
 * funnel stages do not have eight distinct meanings to draw on. Reading down
 * the column below, the sequence is:
 *
 *   row 1   urgent   warning  info     neutral
 *   row 2   info     success  warning  urgent
 *
 * Every horizontal pair differs; every vertical pair differs. Gold is absent by
 * rule 3 (grade and rewards only). If a ninth card is added, re-check both axes
 * rather than appending whichever colour looks free.
 */
const FLOW: FlowCard[] = [
  { title: 'Unconfirmed Orders',      sub: 'Booked from web / API',     icon: ShoppingCart,  tint: 'bg-urgent-tint text-urgent-strong',          statKey: 'unconfirmed',       href: '/my-orders?tab=unconfirmed' },
  { title: 'Pending for Scheduling',  sub: 'Confirmed, no tech yet',    icon: CalendarClock, tint: 'bg-warning-tint text-warning-strong',    statKey: 'pendingScheduling', href: '/my-orders?tab=pending-scheduling' },
  { title: 'Pending to Start',        sub: 'Accepted, pre check-in',    icon: Play,          tint: 'bg-info-tint text-info-strong',          statKey: 'pendingToStart',    href: '/my-orders?tab=pending-start' },
  { title: 'Pending App Ack',         sub: 'Assigned, awaiting tech',   icon: BellRing,      tint: 'bg-neutral-tint text-neutral-strong',      statKey: 'pendingAppAck',     href: '/my-orders?tab=pending-app-ack' },
  { title: 'Pending to Close',        sub: 'Technician on-site',        icon: CheckCircle2,  tint: 'bg-info-tint text-info-strong',        statKey: 'pendingToClose',    href: '/my-orders?tab=pending-close' },
  { title: 'Audit & Complete',        sub: 'Closed — QA review',        icon: ShieldCheck,   tint: 'bg-success-tint text-success-strong',  statKey: 'auditComplete',     href: '/my-orders?tab=audit-complete' },
  { title: 'Pending for Feedback',    sub: 'Closed from app',           icon: MessageSquare, tint: 'bg-warning-tint text-warning-strong',        statKey: 'pendingFeedback',   href: '/my-orders?tab=pending-feedback' },
  { title: 'Orders in Followup',      sub: 'Fulfilment on hold',        icon: PhoneCall,     tint: 'bg-urgent-tint text-urgent-strong',  statKey: 'followup',          href: '/my-orders?tab=onhold' },
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
/*
 * Card now sized for a SINGLE 8-up row at all viewport widths above
 * the mobile breakpoint. Each card is constrained to a fixed height
 * (`h-32` = 128px) so the row is visually uniform regardless of which
 * title text wraps. Title and sub-text use the new MarqueeOnHover
 * helper: if the text doesn't fit on one line it scrolls horizontally
 * while the operator hovers the card, so nothing is hidden behind a
 * truncating ellipsis.
 */
function FlowCardTile({ card, value, loading }: { card: FlowCard; value: number; loading: boolean }) {
  const Icon = card.icon;
  // Operator feedback: cards that animate only ONE of their two lines
  // look uneven. Either both move on hover or neither does. We hoist
  // the overflow decision up to the card: each MarqueeOnHover reports
  // its own overflow state via `onMeasure`, and we pass an `animate`
  // flag down so both children either run the marquee or stay still
  // together.
  const [titleOverflows, setTitleOverflows] = React.useState(false);
  const [subOverflows, setSubOverflows] = React.useState(false);
  /*
   * Track each line's inner scrollWidth so we can pin both to a
   * shared duration (2026-05-28). The max of the two becomes the
   * common `durationOverride` for both children — title and sub
   * complete each scroll cycle at exactly the same moment regardless
   * of their individual text lengths. Without this, the shorter line
   * loops faster and the two visually desync after a few iterations.
   */
  const [titleExit, setTitleExit] = React.useState(0);
  const [subExit,   setSubExit]   = React.useState(0);
  const animateBoth = titleOverflows || subOverflows;
  const PX_PER_SEC = 80;
  const sharedDurationMs = Math.max(
    3000,
    Math.round((Math.max(titleExit, subExit) / PX_PER_SEC) * 1000),
  );
  // Dashboard cards are now display-only — clicks disabled per ops 2026-06-04.
  // Previously each card linked to `/my-orders?tab=<slug>`; that drove operators
  // off the dashboard mid-glance. The funnel-narrative + count read better as a
  // single overview surface; navigation lives on the sidebar / Jobs menu now.
  // Hover lift / shadow stay so the cards still feel alive, just non-interactive.
  return (
    <div className="block h-full group/card cursor-default">
      <div className={`rounded-lg ${card.tint} shadow-sm p-3 h-32 flex flex-col gap-2 overflow-hidden`}>
        <div className="flex items-center justify-between">
          <div className="h-7 w-7 rounded-md bg-card/60 grid place-items-center shrink-0">
            <Icon className="h-4 w-4" />
          </div>
          {/* Large count lives on the same row as the icon — balances the card
              and guarantees the number never wraps/clips, regardless of title length. */}
          <div className="text-2xl font-semibold tabular-nums leading-none text-right">
            {loading ? <span className="inline-block h-6 w-10 rounded bg-card/40 animate-pulse" /> : value.toLocaleString('en-IN')}
          </div>
        </div>
        <div className="mt-auto min-w-0">
          <MarqueeOnHover
            className="text-[13px] font-semibold leading-snug"
            animateOverride={animateBoth}
            durationOverride={sharedDurationMs}
            onMeasure={(ov, dist) => { setTitleOverflows(ov); setTitleExit(dist); }}
          >
            {card.title}
          </MarqueeOnHover>
          <MarqueeOnHover
            className="text-xs opacity-80 leading-snug"
            animateOverride={animateBoth}
            durationOverride={sharedDurationMs}
            onMeasure={(ov, dist) => { setSubOverflows(ov); setSubExit(dist); }}
          >
            {card.sub}
          </MarqueeOnHover>
        </div>
      </div>
    </div>
  );
}

/*
 * MarqueeOnHover was extracted on 2026-05-28 to
 * `src/components/dashboard/MarqueeOnHover.tsx` so AttentionSummary
 * could reuse the same pattern. The CSS keyframe + trigger
 * (`marquee-scroll` / `.group-hover-marquee`) live in
 * `app/globals.css`. This file imports the component from the shared
 * module above.
 */

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats>({
    followup: 0, unconfirmed: 0, pendingScheduling: 0, pendingAppAck: 0,
    pendingToStart: 0, pendingToClose: 0, auditComplete: 0, pendingFeedback: 0,
  });
  const [loadingStats, setLoadingStats] = useState(true);

  /*
   * Book New Call deep-link handler — the Navbar's button pushes
   * `/dashboard?new=1` so the modal lives WITH the dashboard, not the
   * Manage Jobs page. Ops 2026-05-14: redirecting operators to the
   * jobs queue interrupted the booking flow with a queue refresh they
   * didn't want.
   */
  const router = useRouter();
  const searchParams = useSearchParams();
  const [modal, setModal] = useState<{ open: boolean; mode: JobModalMode }>({ open: false, mode: 'create' });

  useEffect(() => {
    if (searchParams.get('new') === '1') setModal({ open: true, mode: 'create' });
  }, [searchParams]);

  function closeModal() {
    setModal((m) => ({ ...m, open: false }));
    // Strip the ?new=1 so a refresh doesn't auto-reopen the modal and
    // the URL goes back to a clean /dashboard.
    if (searchParams.get('new')) router.replace('/dashboard');
  }

  /*
   * /admin/jobs/counts goes through `useFetchOnce` (lib/hooks.ts) — the
   * hook keys by URL so this SHARES its cache entry with the Navbar's
   * identical call. One round-trip serves both. The setStats translation
   * happens in the useEffect below.
   *
   * /admin/jobs?limit=8 (Recent Jobs) was retired 2026-05-22 in favour
   * of the AttentionSummary card, which has its own /attention-summary
   * fetch wired internally.
   */
  const countsFetch = useFetchOnce<{
    total: number;
    byStatus: Record<string, number>;
    bookedUnassigned: number;
    bookedAssigned: number;
  }>('/admin/jobs/counts');

  useEffect(() => {
    if (countsFetch.loading) return;
    if (countsFetch.data) {
      const r = countsFetch.data;
      const b = r.byStatus || {};
      /*
       * Canonical status → card mapping (revised 2026-06-03 per ops):
       *   15, 21              → Orders in Followup    (estimate-pending + on-hold)
       *   9                   → Unconfirmed Orders
       *   0 + tech null       → Pending for Scheduling (bookedUnassigned)
       *   0 + tech not null   → Pending App Ack        (bookedAssigned)
       *   1                   → Pending to Start
       *   2, 20               → Pending to Close
       *   10                  → Audit & Complete       (CHANGED — was 3+5)
       *   10                  → Pending for Feedback   (kept; same status, different ops surface)
       *
       * The two changes:
       *   • Audit & Complete now counts REVISIT (status 10) instead of
       *     COMPLETED+COMPLETED_ALT (3+5). REVISIT is the state where
       *     the booking is back in the audit queue — closer to the
       *     "QA review" semantics of the tile's subtitle.
       *   • Orders in Followup now adds "Estimate Pending Approval"
       *     (status 15) to the existing "Fulfilment On Hold" (21).
       *     Both are operationally "we're waiting on someone".
       *
       * NOTE: Audit & Complete and Pending for Feedback now both surface
       * the same status (10). Per ops they are deliberately twin counts
       * — the cards differ only in which sub-action surface they deep-
       * link into (audit-complete vs pending-feedback list views).
       */
      setStats({
        followup:          (b['15'] ?? 0) + (b['21'] ?? 0),
        unconfirmed:       b['9']  ?? 0,
        pendingScheduling: r.bookedUnassigned ?? 0,
        pendingAppAck:     r.bookedAssigned   ?? 0,
        pendingToStart:    b['1']  ?? 0,
        pendingToClose:    (b['2'] ?? 0) + (b['20'] ?? 0),
        auditComplete:     b['10'] ?? 0,
        pendingFeedback:   b['10'] ?? 0,
      });
    }
    setLoadingStats(false);
  }, [countsFetch.loading, countsFetch.data]);

  return (
    <div className="space-y-4">
      {/* Dashboard title removed per UI ops 2026-05-22 — the route is already
          named "Home" in the sidebar and the funnel cards make the operational
          context obvious. Recovering vertical space lets the Notice Board
          strip + cards + Recent Jobs all sit above the fold on a 1080p monitor. */}

      {/* Notice Board strip — full-width band at the very top. Collapsed
          by default per spec; expand surfaces active notices targeted to
          the CRM surface. Visibility is universal (any admin user reads
          notices); the "+ New Notice" / "View All" affordances inside
          gate themselves on the isNoticeManage action key. */}
      <NoticeStrip />

      {/*
        * Two-column layout below the strip (2026-05-28 refactor):
        *   - Left column (flex-1): the 8 status funnel cards
        *     reflowed to 2×4.
        *   - Right column (lg:w-72): Upcoming Events rail driven by
        *     the /admin/holidays/upcoming endpoint (Nager.Date-backed).
        *
        * `items-stretch` (default — explicit comment for clarity) so
        * the right rail Card grows to exactly the 2×4 cards' height.
        * UpcomingEvents is laid out as a flex column with the events
        * `ul` taking `flex-1 min-h-0 overflow-y-auto`, so a long
        * holiday list scrolls inside the cell rather than pushing the
        * AttentionSummary down. On md and below the columns stack so
        * the dashboard stays readable on tablets/phones.
        *
        * AttentionSummary was previously nested inside the left
        * column — that constrained its width to the left cell, which
        * truncated tile copy ("Estimat...", "Pending..."). Lifting it
        * out as a sibling underneath lets it use the full page width.
        */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem] gap-4">
        {/*
          * Funnel cards — 2-row 4-up grid (`md:grid-cols-4`). The
          * marquee-on-overflow behaviour inside each card handles the
          * card dimensions gracefully as the available width shifts.
          */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 gap-3 min-w-0">
          {FLOW.map((card) => (
            <FlowCardTile key={card.title} card={card} value={stats[card.statKey]} loading={loadingStats} />
          ))}
        </div>

        {/* Right rail — Upcoming Events. Fixed width on lg+; full-width
            stacked below on md and smaller. The wrapper `min-w-0`
            allows the inner Card to shrink if needed (otherwise grid
            items refuse to go below their content's intrinsic size
            and force horizontal overflow). */}
        <div className="min-w-0">
          <UpcomingEvents days={7} />
        </div>
      </div>

      {/*
       * AttentionSummary moved here (2026-05-28) so it spans the full
       * page width instead of being constrained to the left column.
       * The 6 attention tiles need horizontal room to render their
       * full titles ("Booked With No Services", "Customer Unreachable")
       * without truncating to "Booked W…" / "Custom…". Sits below the
       * cards + rail row, full-bleed.
       *
       * Recent Jobs replaced with AttentionSummary (2026-05-22) per
       * ops review: operators don't need a chronological activity
       * list, they need "what action is mine right now?". The 6
       * tiles each click through to a filtered job queue.
       */}
      <AttentionSummary />

      {/* Book New Call modal — mounted here (not on /jobs) so the
          booking flow keeps the dashboard context behind it. Saving a
          new job doesn't auto-refresh the cards/recent list to avoid
          a perceived "jump" right after the operator hits Book Call;
          the next genuine page load picks up the count. */}
      <JobModal
        open={modal.open}
        mode={modal.mode}
        onClose={closeModal}
        onSaved={() => { /* dashboard cards refresh on next page load */ }}
      />
    </div>
  );
}
