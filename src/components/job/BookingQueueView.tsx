'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { buildJobsKey } from '@/lib/jobs-query';
import { cycleSort, type SortDir } from '@/lib/use-sort';
import {
  TablePagination,
  type TablePageSize,
  pageSizeToLimit,
} from '@/components/ui/table-pagination';
import { BookingQueueTable, type BookingQueueRow } from './BookingQueueTable';

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
 * ── ONE NUMBER PER TILE, AND THE PILLS THAT BREAK IT DOWN ─────────────────
 *
 * Every tile is the same kind of number: open orders in that bucket. The five
 * add up to the total printed in the strip header, which is the check that
 * catches a bucket quietly claiming nobody.
 *
 * Inside each tile, Day 0 / 1 / 2 / 3+ splits it by how long the ticket has
 * been waiting, and those four sum to the tile. Response received carries the
 * three kinds of answer as well, because what the customer asked for is what
 * decides who picks the order up.
 *
 * Every count on screen is also a FILTER: clicking a tile or a pill narrows the
 * grid to exactly the orders it counted. The predicate lives in
 * booking-queue.service.js and serves both the count and the list, so a tile
 * and its rows are physically incapable of describing different populations.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * Client queue (ops still to define its blockers) and the "overdue" alert
 * (ops has not settled what overdue means on this page). Both are parked, not
 * forgotten — the Client queue renders as a visible placeholder rather than
 * being silently dropped, so nobody ships thinking it was built.
 */

type LinkKey = 'response_received' | 'no_response' | 'delivery_failed';
type WaitKey = 'new' | 'no_link_needed' | 'client_queue';
/*
 * The three answers a link can produce. They are grid filters as well as
 * counts, so clicking one narrows the rows below — the backend accepts them
 * through the same `bucket=` parameter the tiles use.
 */
type ResponseKind = 'ready' | 'reschedule' | 'cancel';
type BucketKey = LinkKey | WaitKey | `response_${ResponseKind}`;

/*
 * How old the ticket is, in IST calendar days. '3plus' is THREE OR MORE, not
 * three: the oldest open order on the real book was raised five months ago, and
 * a plain "Day 3" would leave every one of those in no pill — the pills would
 * stop summing to the tile, and the longest-waiting orders, which is what the
 * pills exist to surface, would be the invisible ones.
 */
type DayKey = '0' | '1' | '2' | '3plus';
type DayCounts = Record<DayKey, number>;

type Counts = {
  /* Every open order, one bucket each. Sums to `total`. */
  open: Record<LinkKey | WaitKey, number>;
  total: number;
  /* What the customers who answered asked for. Sums to open.response_received. */
  response_breakdown?: Record<ResponseKind, number>;
  /* Each bucket's four day pills. Each set sums to that bucket's own count. */
  days?: Record<LinkKey | WaitKey, DayCounts>;
  /* How many of these orders have had a link go out. Context, not a bucket. */
  links_sent: number;
};

type Resp = { items: BookingQueueRow[]; total: number };
/* `bucket` is the VIEW's state, so it is not part of what the page hands down. */
type TableProps = Omit<ComponentProps<typeof BookingQueueTable>, 'bucket'>;
type JobsQuery = Record<string, string | number | undefined>;

/*
 * THE DAY PILLS REPLACED A DATE FILTER AT THE TOP (ops, 2026-09-23).
 *
 * The page carried All / Today / Yesterday / Last 7 days above the tiles. It
 * worked, and ops asked for it to go: a date control at the top answers "how
 * many came in yesterday", while the question in front of an executive is
 * "which of the orders on my desk have waited longest" — and that is per
 * bucket, not per page. Two date controls on one screen was also one too many.
 *
 * So the age lives INSIDE each tile now, and the tile's own number stays the
 * whole bucket. Day N = N IST calendar days since the ticket came in.
 */
const DAYS: { key: DayKey; label: string }[] = [
  { key: '0', label: 'Day 0' },
  { key: '1', label: 'Day 1' },
  { key: '2', label: 'Day 2' },
  { key: '3plus', label: 'Day 3+' },
];

// `/admin/jobs` caps limit at 500, so "All" must send 500 and not the helper's
// 1000 default (which 400s). Same value as the other My Orders views.
const JOBS_MAX_LIMIT = 500;

export function BookingQueueView({
  query, ownerId, onMutation, onCounts, reloadSignal, ...tableProps
}: Omit<TableProps, 'rows' | 'loading'> & {
  query: JobsQuery;
  ownerId?: number;
  onMutation?: () => void;
  /*
   * Reports the page header's sub-line up. This component owns the counts
   * endpoint, so it is the only thing that should be stating how many orders
   * are open — a header computing its own would be a second opinion.
   */
  onCounts?: (line: string) => void;
  /*
   * Bumped by the PAGE after a JobModal save. It is the only way a mutation
   * made outside this component reaches it: invalidateFetch alone does not
   * refresh a MOUNTED useFetch (the key is a pure function of the query, so it
   * is byte-identical after the save and the effect never re-runs), and this
   * view never unmounts while the tab is open. Without it, confirming an order
   * in the modal leaves it sitting in the tile it has just left.
   */
  reloadSignal?: number;
}) {
  /*
   * The page opens on RESPONSE RECEIVED (ops, 2026-09-24). Those customers have
   * already answered and are one click from being booked — the fastest work on
   * the board — whereas New is waiting on a cron nobody has to watch.
   */
  const [bucket, setBucket] = useState<BucketKey>('response_received');
  /*
   * The day pill inside the selected tile, or null for the whole bucket.
   * Cleared whenever the tile changes: "Day 2" of one bucket means nothing in
   * another, and carrying it across would silently show a narrower list than
   * the tile the operator just clicked.
   */
  const [day, setDay] = useState<DayKey | null>(null);
  const [escalated, setEscalated] = useState(false);
  const [rescheduled, setRescheduled] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  /*
   * Sort state lives HERE, not on the page: the booking queue sorts its own
   * buckets and the other My Orders tabs keep their own ordering. Server-side,
   * so it orders the whole bucket rather than the ten rows on screen.
   */
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  function toggleSort(col: string) {
    const next = cycleSort<string>(col, { sortBy: sortKey, sortDir });
    setSortKey(next.sortBy);
    setSortDir(next.sortDir);
    setPage(0);
  }
  /*
   * Post-mutation refresh. invalidateFetch ALONE does not refresh a mounted
   * view: useFetch re-runs on [key, enabled, tick] and the key is a pure
   * function of the query, so after a send or a reschedule it is byte-identical
   * and the effect never fires. UnconfirmedSections carries the same note.
   */
  const [reloadKey, setReloadKey] = useState(0);

  function pickBucket(b: BucketKey, d: DayKey | null = null) {
    setBucket(b);
    setDay(d);
    setPage(0);
  }

  const countsKey = `/admin/jobs/booking-queue${ownerId ? `?ownerId=${ownerId}` : ''}`;
  const counts = useFetch<Counts>(countsKey);

  /*
   * ESCALATED IS A BOARD-WIDE QUESTION (ops, 2026-09-24). "Show me everything
   * escalated" means every escalated order, whichever bucket it sits in — an
   * escalation that only shows inside the tile you happen to have selected is
   * the one you will miss. So the flag DROPS the bucket filter rather than
   * narrowing within it, and the caption below says so.
   */
  const rowsKey = buildJobsKey({
    ...query,
    bucket: escalated ? undefined : bucket,
    // The day pill rides INSIDE the bucket predicate server-side, so the grid
    // gets exactly the rows the pill counted rather than a second filter that
    // looks right on its own.
    ageDay: escalated ? undefined : (day ?? undefined),
    isEscalated: escalated ? 'true' : undefined,
    customerRescheduled: rescheduled ? 'true' : undefined,
    sortBy: sortKey || undefined,
    sortDir: sortKey ? sortDir : undefined,
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
  }, [reloadKey, reloadSignal]);

  function handleMutation() {
    invalidateFetch((k) => k.startsWith('/admin/jobs'));
    setReloadKey((k) => k + 1);
    onMutation?.();
  }

  const c = counts.data;
  useEffect(() => {
    if (c) onCounts?.(`Open orders: ${c.total.toLocaleString()} · link already sent for ${c.links_sent.toLocaleString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c]);

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
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">
          {/* The tiles add up to this, which is also the grid's population —
              say it on the page so a wrong total is visible, not inferred. */}
          Open orders:{' '}
          <span className="text-sm font-semibold text-foreground">{c ? c.total : '—'}</span>
          <span className="ml-2 font-normal">· link already sent for {c ? c.links_sent : '—'}</span>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        <Tile
          label="New — waiting for link" hint="Link goes out on the next hourly run"
          open={c?.open.new} days={c?.days?.new}
          selected={bucket === 'new'} activeDay={bucket === 'new' ? day : null}
          onPick={(d) => pickBucket('new', d)}
        />
        <Tile
          label="Response received" tone="info" hint="the customer answered"
          open={c?.open.response_received} days={c?.days?.response_received}
          selected={bucket.startsWith('response')}
          activeDay={bucket.startsWith('response') ? day : null}
          onPick={(d) => pickBucket('response_received', d)}
          /*
           * Response received carries BOTH splits, and they answer different
           * questions: how old it is, and what the customer actually asked for.
           * The answer is the one that decides who picks it up, so it sits
           * first. Selecting one clears the other — an order cannot be filtered
           * by two different narrowings of the same tile at once without the
           * count on screen ceasing to describe the rows.
           */
          extra={RESPONSE_KINDS.map((k) => ({
            key: k,
            label: RESPONSE_LABEL[k],
            n: c?.response_breakdown?.[k],
            on: bucket === `response_${k}`,
            onPick: () => pickBucket(`response_${k}`),
          }))}
        />
        <Tile
          label="Client queue — pending" tone="grey"
          hint="waiting on the client — not your action"
          open={c?.open.client_queue} days={c?.days?.client_queue}
          dayPrefix="With client"
          selected={bucket === 'client_queue'} activeDay={bucket === 'client_queue' ? day : null}
          onPick={(d) => pickBucket('client_queue', d)}
        />
        <Tile
          label="No response" tone="warning" hint="still to call"
          open={c?.open.no_response} days={c?.days?.no_response}
          selected={bucket === 'no_response'} activeDay={bucket === 'no_response' ? day : null}
          onPick={(d) => pickBucket('no_response', d)}
        />
        <Tile
          label="Delivery failed — call, no resend" tone="danger" hint="to call"
          open={c?.open.delivery_failed} days={c?.days?.delivery_failed}
          selected={bucket === 'delivery_failed'} activeDay={bucket === 'delivery_failed' ? day : null}
          onPick={(d) => pickBucket('delivery_failed', d)}
        />
        <Tile
          label="No link needed — calling" tone="purple" hint="client setting: auto process = false"
          open={c?.open.no_link_needed} days={c?.days?.no_link_needed}
          selected={bucket === 'no_link_needed'} activeDay={bucket === 'no_link_needed' ? day : null}
          onPick={(d) => pickBucket('no_link_needed', d)}
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
        {/* Only offered when something is actually filtered — a permanently
            visible "Clear filter" trains people to ignore it. */}
        {(escalated || rescheduled || day) && (
          <button
            type="button"
            onClick={() => { setEscalated(false); setRescheduled(false); setDay(null); setPage(0); }}
            className="ml-auto text-xs font-semibold text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Clear filter
          </button>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
          <span>
            <strong className="text-foreground">{rows.data?.total ?? '—'}</strong> open ·{' '}
            {escalated ? 'Escalated · every bucket' : TILE_LABEL[bucket]}
            {!escalated && day && ` · ${DAYS.find((d) => d.key === day)?.label}`}
            {rescheduled && ' · rescheduled by customer'}
          </span>
          <span>Newest first</span>
        </div>
        <div className="overflow-x-auto">
          {/* A different column set per bucket — see BookingQueueTable. */}
          <BookingQueueTable
            rows={rows.data?.items ?? []}
            loading={rows.loading}
            bucket={bucket}
            onMagicLinkSent={handleMutation}
            sortBy={sortKey}
            sortDir={sortDir}
            onSort={toggleSort}
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

const RESPONSE_KINDS: ResponseKind[] = ['ready', 'reschedule', 'cancel'];
const RESPONSE_LABEL: Record<ResponseKind, string> = {
  ready: 'Ready for SKU',
  reschedule: 'Reschedule',
  cancel: 'Cancel',
};

const TILE_LABEL: Record<BucketKey, string> = {
  new: 'New — waiting for link',
  no_link_needed: 'No link needed — calling',
  client_queue: 'Client queue — pending',
  response_received: 'Response received',
  no_response: 'No response',
  delivery_failed: 'Delivery failed',
  response_ready: 'Response received · ready for SKU',
  response_reschedule: 'Response received · reschedule asked',
  response_cancel: 'Response received · cancel asked',
};

/*
 * Tile tones, as token classes rather than hex — the CRM ships light and dark
 * and a literal colour would be right in exactly one of them.
 */
const TONE: Record<string, string> = {
  info: 'bg-info-tint border-info/30 text-info-strong',
  warning: 'bg-warning-tint border-warning/30 text-warning-strong',
  danger: 'bg-destructive/10 border-destructive/30 text-destructive',
  purple: 'bg-accent border-accent-foreground/20 text-accent-foreground',
  grey: 'bg-muted border-border text-foreground',
};

function tileClass(selected: boolean, tone?: string) {
  return [
    'rounded-lg border px-3.5 py-3 text-left transition-shadow',
    tone ? TONE[tone] : 'border-border bg-card',
    selected ? 'ring-2 ring-foreground' : 'hover:border-foreground/30',
  ].join(' ');
}

type ExtraPill = { key: string; label: string; n?: number; on: boolean; onPick: () => void };

/*
 * One tile: a bucket's count, and the pills that break it down.
 *
 * There used to be two components — one for the link buckets, one for the
 * waiting ones — because their numbers meant different things. They do not any
 * more: every tile is "open orders in this bucket", so one component is the
 * honest shape, and a reader cannot wonder whether the two count differently.
 */
function Tile({
  label, tone, hint, open, days, selected, activeDay, onPick, extra, dayPrefix,
}: {
  label: string; tone?: string; hint: string;
  open?: number; days?: DayCounts;
  selected: boolean; activeDay: DayKey | null;
  onPick: (day: DayKey | null) => void;
  extra?: ExtraPill[];
  /*
   * Client queue counts days SINCE IT REACHED THE CLIENT, every other tile
   * counts days since the ticket arrived. Same-looking pills, different
   * clocks — so that tile labels its own, and nobody reads "Day 2" as the
   * order being two days old when it is five months old and two days theirs.
   */
  dayPrefix?: string;
}) {
  const loaded = open !== undefined;
  return (
    // The tile is a plain div, not a button: it CONTAINS buttons (the pills),
    // and a button inside a button is invalid HTML that browsers silently
    // reflow. The headline row is the clickable part.
    <div className={tileClass(selected, tone)}>
      <button
        type="button"
        onClick={() => onPick(null)}
        className="block w-full text-left"
        aria-pressed={selected && !activeDay}
      >
        {/* An em dash until the count arrives: a 0 that means "not loaded yet"
            is indistinguishable from a 0 that means "none", and on this page
            that difference is the whole point. */}
        <div className="text-2xl font-semibold leading-none">{loaded ? open : '—'}</div>
        <div className="mt-1.5 text-xs font-semibold">{label}</div>
        <div className="mt-1 text-xs opacity-80">{hint}</div>
      </button>
      {loaded && extra && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {extra.map((p) => (
            <Pill key={p.key} on={p.on} onPick={p.onPick}>{p.label} {p.n ?? 0}</Pill>
          ))}
        </div>
      )}
      {loaded && days && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {DAYS.map((d) => (
            <Pill
              key={d.key}
              on={selected && activeDay === d.key}
              onPick={() => onPick(activeDay === d.key ? null : d.key)}
            >
              {dayPrefix ? `${dayPrefix} ` : ''}{d.label} · {days[d.key] ?? 0}
            </Pill>
          ))}
        </div>
      )}
    </div>
  );
}

/* A pill: a filter, and the count it filters to. */
function Pill({ on, onPick, children }: { on: boolean; onPick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
        on ? 'bg-foreground text-background' : 'border border-current/20 bg-card/70'
      }`}
    >
      {children}
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
