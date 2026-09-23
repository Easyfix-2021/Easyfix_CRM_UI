'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { buildJobsKey } from '@/lib/jobs-query';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { UnconfirmedJobsTable } from './UnconfirmedJobsTable';

/*
 * My Orders → Unconfirmed → "Booking queue" — the tab ops asked for.
 *
 * ── WHAT IT SHOWS, AND WHY IT IS NOT THE OTHER TAB ────────────────────────
 *
 * The "Old view" groups the same orders by APPOINTMENT DATE (Overdue /
 * Upcoming / Future). On the real book that files ~80% of them under Overdue,
 * which tells an executive nothing about what to do next. This tab groups by
 * WHERE THE ORDER IS STUCK instead:
 *
 *   New                waiting for the hourly WhatsApp link
 *   No link needed     the client's setting says call, never send a link
 *   Response received  the customer answered the link
 *   No response        the link went, nobody replied
 *   Delivery failed    WhatsApp could not deliver it — call, never re-send
 *
 * The two tabs are ALTERNATIVE CUTS OF THE SAME ORDERS and must never be shown
 * together: a job that is "Overdue" there is "No response" here, so one screen
 * carrying both would count it twice.
 *
 * ── THE TWO NUMBERS ON A LINK TILE, WHICH ARE NOT THE SAME QUESTION ───────
 *
 *   25 / 100          what happened to the links SENT in the period. A fact
 *                     about the day; it does not move when the team works.
 *   7 waiting         how many of those still need somebody. This goes down.
 *
 * Both come from ONE backend row per tile, so they cannot disagree, and the
 * grid lists exactly the second number — see booking-queue.service.js, which
 * also owns the `bucket=` predicate this grid sends, so a tile and its rows are
 * physically incapable of describing different populations.
 *
 * New / No link needed have no link outcome to report, so they show Today ·
 * Old instead. "Old" is load-bearing: it is where an order goes when its link
 * never went out, and without it those would vanish from every tile.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * Client queue (ops still to define its blockers) and the "overdue" alert
 * (ops has not settled what overdue means on this page). Both are parked, not
 * forgotten — the Client queue renders as a visible placeholder rather than
 * being silently dropped, so nobody ships thinking it was built.
 */

type LinkKey = 'response_received' | 'no_response' | 'delivery_failed';
type WaitKey = 'new' | 'no_link_needed';
type BucketKey = LinkKey | WaitKey;

type Counts = {
  period: string;
  links: Record<'sent' | LinkKey, number>;
  /* Every OPEN order in the bucket, whatever day its link went out. */
  open: Record<LinkKey, number>;
  /* The same three narrowed to the period's links — only "closed" reads this. */
  period_open?: Record<LinkKey, number>;
  waiting: Record<WaitKey, { today: number; old: number }>;
};
type Resp = { items: ComponentProps<typeof UnconfirmedJobsTable>['rows']; total: number };
type TableProps = ComponentProps<typeof UnconfirmedJobsTable>;
type JobsQuery = Record<string, string | number | undefined>;

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
] as const;

// `/admin/jobs` caps limit at 500, so "All" must send 500 and not the helper's
// 1000 default (which 400s). Same value as the other My Orders views.
const JOBS_MAX_LIMIT = 500;

// Remembered per operator, so the tab they work in is the one that opens.
const PERIOD_KEY = 'easyfix.crm.bookingQueue.period.v1';

export function BookingQueueView({
  query, ownerId, onMutation, ...tableProps
}: Omit<TableProps, 'rows' | 'loading'> & {
  query: JobsQuery;
  ownerId?: number;
  onMutation?: () => void;
}) {
  const [period, setPeriod] = useState<string>('today');
  const [bucket, setBucket] = useState<BucketKey>('new');
  const [escalated, setEscalated] = useState(false);
  const [rescheduled, setRescheduled] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  /*
   * Post-mutation refresh. invalidateFetch ALONE does not refresh a mounted
   * view: useFetch re-runs on [key, enabled, tick] and the key is a pure
   * function of the query, so after a send or a reschedule it is byte-identical
   * and the effect never fires. UnconfirmedSections carries the same note.
   */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(PERIOD_KEY);
      if (saved && PERIODS.some((p) => p.key === saved)) setPeriod(saved);
    } catch { /* private window / blocked storage — the default is fine */ }
  }, []);

  function pickPeriod(p: string) {
    setPeriod(p);
    setPage(0);
    try { localStorage.setItem(PERIOD_KEY, p); } catch { /* not worth failing over */ }
  }

  const countsKey = `/admin/jobs/booking-queue?period=${period}${ownerId ? `&ownerId=${ownerId}` : ''}`;
  const counts = useFetch<Counts>(countsKey);

  const rowsKey = buildJobsKey({
    ...query,
    bucket,
    isEscalated: escalated ? 'true' : undefined,
    customerRescheduled: rescheduled ? 'true' : undefined,
    limit: pageSizeToLimit(pageSize, JOBS_MAX_LIMIT),
    offset: page * pageSizeToLimit(pageSize, JOBS_MAX_LIMIT),
  });
  const rows = useFetch<Resp>(rowsKey);

  /*
   * A filter or search change makes the current page number meaningless — page
   * 4 of a 60-row bucket is empty once a search narrows it to 8. Reset, but not
   * on the first render, which would fight the mount.
   */
  const queryKey = JSON.stringify(query);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setPage(0);
  }, [queryKey]);

  const firstReload = useRef(true);
  useEffect(() => {
    if (firstReload.current) { firstReload.current = false; return; }
    counts.refetch();
    rows.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  function handleMutation() {
    invalidateFetch((k) => k.startsWith('/admin/jobs'));
    setReloadKey((k) => k + 1);
    onMutation?.();
  }

  const c = counts.data;
  const sent = c?.links.sent ?? 0;
  /*
   * "closed" = of the PERIOD'S links, the ones already dealt with. Derived from
   * the period subset, never from the all-time open count — subtracting a
   * whole-board number from a one-day number produces a negative that reads as
   * a bug. Clamped at 0 against an older backend that sends no period_open.
   */
  const openTotal = c
    ? c.open.response_received + c.open.no_response + c.open.delivery_failed
      + c.waiting.new.today + c.waiting.new.old
      + c.waiting.no_link_needed.today + c.waiting.no_link_needed.old
    : 0;
  function closedIn(k: LinkKey) {
    if (!c) return undefined;
    return Math.max(0, c.links[k] - (c.period_open?.[k] ?? c.links[k]));
  }

  if (counts.error) {
    return (
      <div className="m-3 rounded-lg border border-warning bg-warning-tint px-3 py-2 text-xs text-warning-strong">
        The booking-queue counts could not be loaded, so the tiles are not shown. Reload to try again.
        Switch to <strong>Old view</strong> to keep working in the meantime.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Period — applies to the three LINK tiles only. New / No link needed
          are "waiting now" counts, which a date window would misdescribe. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">
          {/* The tiles add up to this, which is the number the tab header shows
              — say so, so a wrong total is visible rather than inferred. */}
          Open orders:{' '}
          <span className="text-sm font-semibold text-foreground">{c ? openTotal : '—'}</span>
          <span className="ml-2 font-normal">
            · links sent {PERIODS.find((p) => p.key === period)?.label.toLowerCase()}: {c ? sent : '—'}
          </span>
        </span>
        <div className="ml-auto flex overflow-hidden rounded-lg border border-border">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => pickPeriod(p.key)}
              className={`px-3 py-1.5 text-xs font-semibold ${
                period === p.key ? 'bg-foreground text-background' : 'bg-card text-foreground hover:bg-muted'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        <WaitingTile
          label="New — waiting for link" hint="Link goes out on the next hourly run"
          counts={c?.waiting.new} selected={bucket === 'new'}
          onClick={() => { setBucket('new'); setPage(0); }}
        />
        <LinkTile
          label="Response received" tone="info"
          value={c?.links.response_received} sent={sent} open={c?.open.response_received}
          closed={closedIn('response_received')}
          openLabel="waiting to attach SKU"
          selected={bucket === 'response_received'}
          onClick={() => { setBucket('response_received'); setPage(0); }}
        />
        {/* PARKED, not dropped. Ops has still to define the blocker list, and a
            missing tile would read as "already built and empty". */}
        <div className="rounded-lg border border-dashed border-border bg-card px-3.5 py-3 opacity-70">
          <div className="text-2xl font-semibold leading-none text-muted-foreground">—</div>
          <div className="mt-1.5 text-xs font-semibold">Client queue — pending</div>
          <div className="mt-1 text-xs text-muted-foreground">Parked · rules to follow</div>
        </div>
        <LinkTile
          label="No response" tone="warning"
          value={c?.links.no_response} sent={sent} open={c?.open.no_response}
          closed={closedIn('no_response')}
          openLabel="still to call"
          selected={bucket === 'no_response'}
          onClick={() => { setBucket('no_response'); setPage(0); }}
        />
        <LinkTile
          label="Delivery failed — call, no resend" tone="danger"
          value={c?.links.delivery_failed} sent={sent} open={c?.open.delivery_failed}
          closed={closedIn('delivery_failed')}
          openLabel="to call"
          selected={bucket === 'delivery_failed'}
          onClick={() => { setBucket('delivery_failed'); setPage(0); }}
        />
        <WaitingTile
          label="No link needed — calling" hint="Client setting: auto process = false"
          counts={c?.waiting.no_link_needed} selected={bucket === 'no_link_needed'}
          onClick={() => { setBucket('no_link_needed'); setPage(0); }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold text-muted-foreground">Flags</span>
        <FlagChip on={escalated} tone="danger" onClick={() => { setEscalated((v) => !v); setPage(0); }}>
          🔥 Escalated
        </FlagChip>
        <FlagChip on={rescheduled} tone="warning" onClick={() => { setRescheduled((v) => !v); setPage(0); }}>
          ↻ Rescheduled by customer
        </FlagChip>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
          <span>
            <strong className="text-foreground">{rows.data?.total ?? '—'}</strong> open ·{' '}
            {TILE_LABEL[bucket]}
          </span>
          <span>Newest first</span>
        </div>
        <div className="overflow-x-auto">
          <UnconfirmedJobsTable
            rows={rows.data?.items ?? []}
            loading={rows.loading}
            onMagicLinkSent={handleMutation}
            {...tableProps}
          />
        </div>
        {rows.data && rows.data.total > 0 && (
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={rows.data.total}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
          />
        )}
      </div>
    </div>
  );
}

const TILE_LABEL: Record<BucketKey, string> = {
  new: 'New — waiting for link',
  no_link_needed: 'No link needed — calling',
  response_received: 'Response received',
  no_response: 'No response',
  delivery_failed: 'Delivery failed',
};

/*
 * Tile tones, as token classes rather than hex — the CRM ships light and dark
 * and a literal colour would be right in exactly one of them.
 */
const TONE: Record<string, string> = {
  info: 'bg-info-tint border-info/30 text-info-strong',
  warning: 'bg-warning-tint border-warning/30 text-warning-strong',
  danger: 'bg-destructive/10 border-destructive/30 text-destructive',
};

function tileClass(selected: boolean, tone?: string) {
  return [
    'rounded-lg border px-3.5 py-3 text-left transition-shadow',
    tone ? TONE[tone] : 'border-border bg-card',
    selected ? 'ring-2 ring-foreground' : 'hover:border-foreground/30',
  ].join(' ');
}

/*
 * A link tile. TWO numbers, and which one is the HEADLINE matters.
 *
 * The headline is the WORK: every open order in this bucket, whatever day its
 * link went out. That is what the grid below lists, and the five headlines add
 * up to the tab total — the check that catches a bucket quietly claiming
 * nobody. The first cut made the period funnel the headline and the work a
 * subset of it, which on the real book read 0 / 0 across every tile while 133
 * open orders sat in No response from older links: the page accounted for 13
 * of 149 orders and looked finished.
 *
 * The funnel is still here, underneath, because it is how ops measures the day
 * — but it is labelled as the period's links so it cannot be read as the queue.
 */
function LinkTile({
  label, tone, value, sent, open, closed, openLabel, selected, onClick,
}: {
  label: string; tone: string; value?: number; sent: number;
  open?: number; closed?: number; openLabel: string; selected: boolean; onClick: () => void;
}) {
  const loaded = open !== undefined;
  return (
    <button type="button" onClick={onClick} className={tileClass(selected, tone)}>
      {/* An em dash until the count arrives: a 0 that means "not loaded yet" is
          indistinguishable from a 0 that means "none", and on this page that
          difference is the whole point. */}
      <div className="text-2xl font-semibold leading-none">{loaded ? open : '—'}</div>
      <div className="mt-1.5 text-xs font-semibold">{label}</div>
      {loaded && (
        <div className="mt-1 text-xs opacity-80">{openLabel}</div>
      )}
      {loaded && sent > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-foreground px-2 py-0.5 text-xs font-semibold text-background">
            {value ?? 0} of {sent} links
          </span>
          <span className="rounded-full border border-current/20 bg-card/70 px-2 py-0.5 text-xs font-semibold">
            {closed ?? 0} closed
          </span>
        </div>
      )}
    </button>
  );
}

/** A tile with no link outcome to report — a plain "waiting now" count. */
function WaitingTile({
  label, hint, counts, selected, onClick,
}: {
  label: string; hint: string;
  counts?: { today: number; old: number }; selected: boolean; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={tileClass(selected)}>
      <div className="text-2xl font-semibold leading-none">
        {counts ? counts.today + counts.old : '—'}
      </div>
      <div className="mt-1.5 text-xs font-semibold">{label}</div>
      {counts && (
        <div className="mt-1.5 flex gap-3 text-xs text-muted-foreground">
          <span>Today: <strong className="text-foreground">{counts.today}</strong></span>
          <span>Old: <strong className="text-foreground">{counts.old}</strong></span>
        </div>
      )}
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </button>
  );
}

function FlagChip({
  on, tone, onClick, children,
}: { on: boolean; tone: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE[tone]} ${
        on ? 'ring-2 ring-foreground ring-offset-0' : ''
      }`}
      aria-pressed={on}
    >
      {children}
    </button>
  );
}
