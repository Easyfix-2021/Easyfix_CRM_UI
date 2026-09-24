'use client';

/*
 * QuickSight — MTD, as the "MTD" tab of the Performance report (rendered by
 * quicksight/performance/page.tsx, like the other tabs' bodies). There is no
 * standalone route: the tab is the whole surface.
 *
 * WHAT IT IS: the owner's MIS "MTD Client Report", rebuilt natively over live
 * data. Six KPI tiles and the report's sections in its own order, ending with
 * the per-SPOC book-of-business table this tab was first built for.
 *
 * THIS FILE OWNS THE SHELL: the filters, the window rules, the tiles, the
 * days-open selection two cards share, and the order the sections are laid out
 * in. Sections 1 to 11 are each their own component under ./sections, and the
 * one that pages (the job list behind the status-by-aging matrix) fetches for
 * itself rather than being handed rows. The per-SPOC table at the foot is
 * rendered here, from its own endpoint: it is the one part of the tab that
 * predates the report and it keeps its own paging and sort.
 *
 * LIVE, AND COMPUTED SERVER-SIDE. One GET builds the tiles and sections 1-10
 * from the database (the Manage Jobs export, the same reader the Employee
 * tab's job half uses); a second pages the job list behind any cell of the
 * status-by-aging matrix; a third serves the per-SPOC table. This file derives
 * no count of its own, not even a total. The MIS engine reads an uploaded
 * Excel; we do not, so there is no upload, no snapshot and no cache-buster
 * here — the tab's fetch keys are the filters and nothing else.
 *
 *   GET /mtd/report → the tiles and sections 1-10, plus the picker options
 *   GET /mtd/jobs   → section 11, fetched by that section itself
 *   GET /mtd        → the per-SPOC table at the foot of the tab
 *
 * THREE NUMBERS THAT LOOK WRONG AND ARE NOT. They are answered on screen, in
 * place, because every one of them has been asked before:
 *
 *   Orders created is not part of anything else. It counts the tickets RAISED
 *   in the window; Completed, Cancelled and Open count jobs by when they
 *   closed, were cancelled, or simply are — mostly other jobs from other
 *   months. A month can complete more than it created.
 *
 *   Completion % and Cancelled % are complements of each other, both over
 *   everything in hand (completed + cancelled + open). The donut in section 2
 *   shows a THIRD, higher number — completed over finished jobs only. Both are
 *   right; that card says so itself.
 *
 *   The per-SPOC table's Open and In Progress columns ignore the dates
 *   entirely: they are a snapshot of what is open right now. Both carry
 *   "(Now)" in the header and a note under that table.
 *
 * FILTERS. The window is the shared Date Range picker
 * (@/components/quicksight/DateRangeFilter), defaulting to Month To Date —
 * which is what MTD means, and is also the backend's own default window. At
 * most MAX_WINDOW_DAYS days and never past today, checked here first so the
 * message is a clear toast rather than a 400. Beside it:
 *
 *   Vertical and Zonal Manager are EXPORT PREDICATES — they narrow the SQL, so
 *   they apply to every section AND to the per-SPOC table at the foot.
 *   Client and Primary SPOC are the MIS filter bar's multi-selects, applied in
 *   memory over the rows already read, with the job counts the report itself
 *   supplies (counted with their own picker ignored, so an unticked option
 *   shows what ticking it would ADD). They narrow the report sections ONLY;
 *   the per-SPOC table's endpoint has no such parameters, and that section
 *   says so under its table.
 *
 *   The MIS bar's third multi-select — Vertical BY NAME — is supported all the
 *   way through (api.ts sends it, the backend reads it) but is deliberately
 *   NOT a second control on screen: the Vertical select above filters the same
 *   dimension and applies more widely, so two pickers both labelled "Vertical"
 *   would be a choice with a wrong answer rather than a feature.
 *
 * THE DAYS-OPEN SELECTION LIVES HERE because two cards share it: clicking a
 * band in section 4 narrows "Why cancelled" in sections 5 to 7. It never
 * refetches — every reason and theme arrives with its own per-band breakdown,
 * so the narrowing is a client-side re-sum.
 *
 * Gating: ef-QuickSight + isQuickSightMtdView. The tab stays hidden until the
 * seed migration grants that key (the intended fail-closed behaviour), and a
 * 403 from the endpoint renders the scaffold's access panel.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, CalendarRange, CheckCircle2, ClipboardList, Clock, Database, Loader2,
  Percent, RotateCcw, Timer, TrendingDown, Users, XCircle,
} from 'lucide-react';
import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QsKpiTile, QS_COLORS, QS_SEMANTIC } from '@/components/quicksight/charts';
import { DateRangeFilter } from '@/components/quicksight/DateRangeFilter';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { TablePagination, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';
import { showToast } from '@/components/ui/toast';
import { useFetch, useFetchOnce } from '@/lib/hooks';
import { SortHeader, cycleSort, type SortDir } from '@/lib/use-sort';
import { istToday } from '@/lib/due-date';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { cn, formatDate } from '@/lib/utils';
import { fmtDay, fmtDayRange, type DateWindow } from '@/lib/report-window';
import {
  ACTION_KEY, DEFAULT_SORT_BY, DEFAULT_SORT_DIR, EMPTY_FILTERS, MAX_PAGE_SIZE, MAX_WINDOW_DAYS,
  defaultWindow, narrowed, pickersInUse, reportKey, resolveWindow, tableKey, widestWindow, windowDays,
  type MtdFilters, type MtdSortKey,
} from './api';
import type { MtdCounts, MtdReportResponse, MtdTableResponse } from './types';
import { num, pct1, pctFraction } from './sections/shared';
import { TicketsCreatedVsCompletedSection } from './sections/TicketsCreatedVsCompletedSection';
import { CompletionVsCancellationSection } from './sections/CompletionVsCancellationSection';
import { WhyCancelledSection } from './sections/WhyCancelledSection';
import { CityWiseSection } from './sections/CityWiseSection';
import { StatusAgingSection } from './sections/StatusAgingSection';

/* A BE 403 (requireQuickSight) arrives as one of these messages. */
const DENIED_RE = /permission|quicksight access|access denied/i;

/* The shared lookups the two export-predicate filters are built from. */
type Vertical = { vertical_id: number; vertical_name: string };
type ManagerLite = { user_id: number; user_name: string };

/*
 * No 'All' page size on the per-SPOC table: the endpoint caps `size` at
 * MAX_PAGE_SIZE, so an "All" option would render one un-navigable page whose
 * range hint lies about what is on screen the moment a company has more SPOCs
 * than that.
 */
const PAGE_SIZE_OPTIONS: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
];

/*
 * The per-SPOC table's five counts in the order the owner listed them, which
 * is also the order a job moves through: created -> in progress -> open ->
 * completed -> cancelled. ONE list drives the header, every row and the footer
 * rows, so a column can never appear in one of them and not the others.
 *
 * `now` marks the two columns that ignore the window (see the header).
 */
type MetricColumn = { key: Exclude<MtdSortKey, 'name'>; label: string; now?: boolean };

const METRIC_COLUMNS: readonly MetricColumn[] = [
  { key: 'ticketCreated', label: 'Ticket Created' },
  { key: 'inProgress', label: 'In Progress', now: true },
  { key: 'open', label: 'Open', now: true },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

/** The header a metric column shows: the snapshot pair say so in the header itself. */
const columnLabel = (c: MetricColumn) => (c.now ? `${c.label} (Now)` : c.label);

/** Why a column does or does not move with the date range - the header's tooltip. */
const columnTitle = (c: MetricColumn, period: string) => (c.now
  ? `${c.label} right now - a snapshot, not ${period}. This column does not change with the date range.`
  : `${c.label} in ${period}`);

/*
 * What a failed reconciliation check is called on screen. The backend may add
 * a check before this map does, so an unknown key degrades to its own words
 * rather than printing a machine slug at a reader.
 */
const CHECK_LABEL: Record<string, string> = {
  inHand: 'Jobs in hand',
  percentHalves: 'Completion % and Cancelled %',
  daily: 'The day-wise chart',
  daysOpen: 'The days-open split',
  reasons: 'Cancel reasons',
  themes: 'Comment themes',
  cancelBands: 'Cancel reasons and themes by days open',
  cities: 'The city table',
  statusAging: 'Jobs by status and aging',
  jobs: 'The job list',
};

function checkLabel(key: string): string {
  const known = CHECK_LABEL[key];
  if (known) return known;
  const words = key.replace(/([A-Z])/g, ' $1').replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function MtdBody() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY]);
  const canView = flags[ACTION_KEY];

  // The IST day the tab opened on: the default window ends here and no later date can be picked.
  const [today] = useState(istToday);

  const [filters, setFilters] = useState<MtdFilters>(EMPTY_FILTERS);
  /*
   * Sections 3 and 4's selection — the days-open bands narrowing "Why
   * cancelled" below. Held as bucket KEYS ('0-2', '3-5', …) rather than
   * indexes, so a change to the band list on the backend cannot silently
   * re-point a selection at a different band.
   *
   * It survives a filter change, as the MIS report's does: the bands are the
   * same four whatever the window, so clearing it would only make the reader
   * re-pick what they already picked.
   */
  const [ageBuckets, setAgeBuckets] = useState<string[]>([]);

  /* The per-SPOC table's own paging and sort. */
  const [page, setPage] = useState(0); // 0-indexed (TablePagination contract)
  const [pageSize, setPageSize] = useState<TablePageSize>(20);
  /*
   * Sort mirrors the server's default rather than starting empty, so the arrow
   * on the header tells the truth about the order the first page arrives in.
   */
  const [sort, setSort] = useState<{ sortBy: MtdSortKey; sortDir: SortDir }>({
    sortBy: DEFAULT_SORT_BY, sortDir: DEFAULT_SORT_DIR,
  });

  /* ── lookups (fetch-hooks only; both are shared, cached endpoints) ──────── */

  const verticalsRes = useFetchOnce<Vertical[]>('/shared/lookup/verticals');
  const zonalRes = useFetchOnce<ManagerLite[]>('/shared/lookup/zonal-managers');

  const verticalOptions = useMemo<SearchOption[]>(
    () => [
      { value: 0, label: 'All Verticals' },
      ...(verticalsRes.data ?? []).map((v) => ({ value: v.vertical_id, label: v.vertical_name })),
    ],
    [verticalsRes.data],
  );
  const zonalOptions = useMemo<SearchOption[]>(
    () => [
      { value: 0, label: 'All Zonal Managers' },
      ...(zonalRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    ],
    [zonalRes.data],
  );

  /* ── the report ─────────────────────────────────────────────────────────── */

  // What every request sends: the filters with the window made explicit.
  const query = useMemo(() => resolveWindow(filters, today), [filters, today]);

  const rKey = canView ? reportKey(query) : null;
  const reportRes = useFetch<MtdReportResponse>(rKey);
  const report = reportRes.data;

  const tKey = canView
    ? tableKey(query, {
      page: page + 1, // the endpoint counts pages from 1
      size: pageSizeToLimit(pageSize, MAX_PAGE_SIZE),
      sortBy: sort.sortBy,
      sortDir: sort.sortDir,
    })
    : null;
  const tableRes = useFetch<MtdTableResponse>(tKey);
  const table = tableRes.data;

  const period = fmtDayRange(query.from, query.to);
  // useFetch keeps the previous response on screen while a new key loads.
  const stale = !!report && (reportRes.refreshing || reportRes.dataKey !== rKey);

  /*
   * The two in-memory pickers' options come from the REPORT, not from a lookup
   * endpoint: each option carries how many jobs it would contribute, counted
   * with its own picker ignored, so an unticked option shows what ticking it
   * would ADD rather than the zero it has today. That is the MIS filter bar's
   * behaviour, and it is why the counts do not collapse as a selection narrows.
   */
  const clientOptions = useMemo<SearchOption[]>(
    () => (report?.filters.clients ?? []).map((c) => ({ value: c.id, label: `${c.name} (${num(c.jobs)})` })),
    [report?.filters.clients],
  );
  const spocOptions = useMemo<SearchOption[]>(
    () => (report?.filters.spocs ?? []).map((s) => ({ value: s.id, label: `${s.name} (${num(s.jobs)})` })),
    [report?.filters.spocs],
  );

  /* ── filter state ───────────────────────────────────────────────────────── */

  /*
   * Every filter change returns the per-SPOC table to its first page: page 4
   * of the old filters is not page 4 of the new ones, and may not exist at all.
   */
  const applyFilters = (patch: Partial<MtdFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  /*
   * A days-open band toggles; the All days tile (null) clears.
   *
   * Ticking every band is the MIS report's own "no filter": four of four
   * selected and none selected show the same jobs, so the state collapses to
   * the simpler of the two rather than keeping a selection that narrows
   * nothing and still reads as narrowed.
   */
  const toggleAgeBucket = (key: string | null) => {
    if (key === null) {
      setAgeBuckets([]);
      return;
    }
    setAgeBuckets((cur) => {
      const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
      const all = report?.byDaysOpen.buckets.length ?? 0;
      return all > 0 && next.length === all ? [] : next;
    });
  };

  /*
   * The Date Range picker's only way in — a preset or a typed custom range.
   * Presets are inside the cap by construction; a typed range is not, so the
   * rules live here, where the toast can say what to do about it. Returning
   * false tells the picker the window did not change, and it keeps its menu
   * open on the dates being fixed (a refused range is never truncated to fit).
   */
  const onRangeChange = (next: DateWindow): boolean => {
    if (next.from > next.to) {
      showToast({ variant: 'error', message: `The From date must be on or before the To date (${fmtDay(next.to)})` });
      return false;
    }
    if (next.to > today) {
      showToast({ variant: 'error', message: `The report ends at today: pick a To date on or before ${fmtDay(today)}` });
      return false;
    }
    const days = windowDays(next);
    if (days > MAX_WINDOW_DAYS) {
      showToast({
        variant: 'error',
        message: `Pick at most ${MAX_WINDOW_DAYS} days: ${fmtDayRange(next.from, next.to)} is ${num(days)} days`,
      });
      return false;
    }
    // A bound is stored as '' so "the default window" is one canonical fetch key.
    const def = defaultWindow(today);
    applyFilters({ from: next.from === def.from ? '' : next.from, to: next.to === def.to ? '' : next.to });
    return true;
  };

  /* Third click on a sorted column returns to the report's DEFAULT order
   * rather than to "unsorted": the endpoint always sorts by something, so an
   * empty sort would only mean "Ticket Created, highest first" with the arrow
   * hidden - a header that lies quietly. */
  const toggleSort = (col: MtdSortKey) => {
    setSort((cur) => {
      const next = cycleSort<MtdSortKey>(col, cur);
      return next.sortBy
        ? { sortBy: next.sortBy, sortDir: next.sortDir }
        : { sortBy: DEFAULT_SORT_BY, sortDir: DEFAULT_SORT_DIR };
    });
    setPage(0);
  };

  /* ── page state ─────────────────────────────────────────────────────────── */

  const fetchError = reportRes.error ?? tableRes.error;
  const accessDenied = (!!me && !canView) || (!!fetchError && DENIED_RE.test(fetchError));
  const genericError = fetchError && !accessDenied ? fetchError : null;
  // Wait for `me` (so nothing flashes while auth loads) and the first report.
  const loading = !me || (canView && !fetchError && !report);
  /*
   * Empty only when the window genuinely holds nothing: no job in hand AND no
   * ticket raised. A window that completed nothing but still has open jobs is
   * a report, not an empty state.
   */
  const isEmpty = !loading && !genericError && !accessDenied && !!report
    && report.kpis.inHand === 0 && report.kpis.ordersCreated === 0;

  const failedChecks = report && !report.reconciled
    ? Object.entries(report.checks).filter(([, ok]) => !ok).map(([k]) => checkLabel(k))
    : [];

  /* ── filters slot: status lines + filter grid ───────────────────────────── */

  const statusLine = (
    <div className="space-y-1 text-sm text-muted-foreground">
      <StatusRow icon={<Database className="size-4" />}>
        Every number live from the database
        {report && (
          <>
            {' · '}as of <span className="font-medium text-foreground">{formatDate(report.meta.readAt)}</span>
            {' · '}read{' '}
            <span className="font-medium tabular-nums text-foreground">{num(report.meta.jobsRead.ticketCreated)}</span>
            {' tickets created, '}
            <span className="font-medium tabular-nums text-foreground">{num(report.meta.jobsRead.completed)}</span>
            {' completed, '}
            <span className="font-medium tabular-nums text-foreground">{num(report.meta.jobsRead.cancelled)}</span>
            {' cancelled, '}
            <span className="font-medium tabular-nums text-foreground">{num(report.meta.jobsRead.open)}</span>
            {' open'}
          </>
        )}
        {(loading || stale) && canView && !fetchError && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs">
            <Loader2 className="size-3 animate-spin" />
            Reading {period}… the first load of a date range can take a while
          </span>
        )}
      </StatusRow>
      <StatusRow icon={<Users className="size-4" />}>
        Jobs are attributed to the <span className="font-medium text-foreground">client&rsquo;s Primary SPOC</span>,
        {' '}whose book of business the job is. Employee Productivity counts whoever performed the action instead,
        {' '}so the two tabs disagree on the same window by design.
      </StatusRow>
      {report?.asOf.dayStillFilling && (
        <StatusRow icon={<Clock className="size-4" />}>
          Today ({fmtDay(report.asOf.day)}) is still filling, so its bar in the day-wise chart is a part day and is
          left out of the forecast&rsquo;s average.
        </StatusRow>
      )}
    </div>
  );

  const filterGrid = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <FilterField label="Vertical" hint="Every section">
        <SearchSelect
          value={filters.verticalId}
          onChange={(next) => applyFilters({ verticalId: Number(next) || 0 })}
          options={verticalOptions}
          required
        />
      </FilterField>
      <FilterField label="Zonal Manager" hint="Every section">
        <SearchSelect
          value={filters.zonalManagerId}
          onChange={(next) => applyFilters({ zonalManagerId: Number(next) || 0 })}
          options={zonalOptions}
          required
        />
      </FilterField>
      <FilterField label="Date Range" hint={`Up to ${MAX_WINDOW_DAYS} days, until today`}>
        {/* The shared picker holds no cap of its own: All Dates is THIS
            report's widest window, and onRangeChange above is the only thing
            that accepts or refuses one. */}
        <DateRangeFilter
          from={query.from}
          to={query.to}
          today={today}
          onChange={onRangeChange}
          allDates={{ window: widestWindow(today), label: `All Dates (Last ${MAX_WINDOW_DAYS} Days)` }}
        />
      </FilterField>
      <FilterField label="Client" hint="Report sections only">
        <SearchMultiSelect
          value={filters.clientIds}
          onChange={(next) => applyFilters({ clientIds: next.map(Number) })}
          options={clientOptions}
          placeholder="All Clients"
          selectedLabel="clients"
        />
      </FilterField>
      <FilterField label="Primary SPOC" hint="Report sections only">
        <SearchMultiSelect
          value={filters.spocUserIds}
          onChange={(next) => applyFilters({ spocUserIds: next.map(Number) })}
          options={spocOptions}
          placeholder="All Primary SPOCs"
          selectedLabel="SPOCs"
        />
      </FilterField>
      <div className="flex items-end">
        {narrowed(filters) && (
          <Button type="button" variant="outline" className="gap-1.5" onClick={() => applyFilters(EMPTY_FILTERS)}>
            <RotateCcw className="size-4" />Reset Filters
          </Button>
        )}
      </div>
    </div>
  );

  // Denied viewers never reach this slot at all.
  const filtersSlot = canView ? (
    <div className="space-y-3">
      {statusLine}
      {filterGrid}
    </div>
  ) : undefined;

  const k = report?.kpis;

  return (
    <ReportPageScaffold
      title="MTD"
      subtitle="Month To Date: Orders Created, Completed, Cancelled, Days Open And Cancel Reasons"
      icon={CalendarRange}
      filters={filtersSlot}
      loading={loading}
      error={genericError}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
    >
      {report && k ? (
        <div className={cn('space-y-4 transition-opacity', stale && 'opacity-60')} aria-busy={stale}>
          {/*
            * The backend's own reconciliation check. False means a section's
            * parts no longer sum to its total and the server has already logged
            * an error — shown quietly and in full rather than hidden, with the
            * identities that failed named so the report is actionable. Each
            * affected section repeats the warning in place.
            */}
          {!report.reconciled && (
            <Card>
              <CardContent className="flex items-start gap-3 p-4 text-sm">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-urgent-strong" />
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">Some Of These Numbers Do Not Add Up.</span>{' '}
                  {failedChecks.length > 0
                    ? `${failedChecks.join(', ')} no longer sum to their totals for this window.`
                    : 'A section no longer sums to its total for this window.'}
                  {' '}The server has logged it as an error. Treat the affected figures as unreliable and report
                  the window ({period}) before acting on them.
                </p>
              </CardContent>
            </Card>
          )}

          {/* ── the six KPI tiles, in the MIS report's order ──────────────── */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <QsKpiTile
              label="Orders Created"
              accent={QS_COLORS[0]}
              icon={<ClipboardList className="size-5" />}
              value={<TileValue figure={num(k.ordersCreated)} note="tickets created in these dates" />}
            />
            <QsKpiTile
              label="Completed"
              accent={QS_SEMANTIC.good}
              icon={<CheckCircle2 className="size-5" />}
              value={<TileValue figure={num(k.completed)} note="by closure date" />}
            />
            <QsKpiTile
              label="Cancelled"
              accent={QS_SEMANTIC.bad}
              icon={<XCircle className="size-5" />}
              value={<TileValue figure={num(k.cancelled)} note="by cancel date" />}
            />
            <QsKpiTile
              label="Completion %"
              accent={QS_SEMANTIC.info}
              icon={<Percent className="size-5" />}
              value={(
                <TileValue
                  figure={pct1(k.completionPct)}
                  note={`${pctFraction(k.completionPct)} jobs completed or still open`}
                />
              )}
            />
            <QsKpiTile
              label="TAT %"
              accent={QS_COLORS[2]}
              icon={<Timer className="size-5" />}
              /* The denominator here is COMPLETED jobs, not everything in
                 hand — a cancelled or open job has no turnaround to have met. */
              value={<TileValue figure={pct1(k.tatPct)} note={`${pctFraction(k.tatPct)} completed in TAT`} />}
            />
            <QsKpiTile
              label="Cancelled %"
              accent={QS_COLORS[8]}
              icon={<TrendingDown className="size-5" />}
              value={(
                <TileValue
                  figure={pct1(k.cancelledPct)}
                  note={`${pctFraction(k.cancelledPct)} jobs in hand`}
                />
              )}
            />
          </div>

          {/*
            * Said once, under the tiles, because it is the question this report
            * gets asked most: the first tile counts a DIFFERENT set of jobs
            * from the three that follow it.
            */}
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Orders Created counts tickets RAISED in {period}</span>{' '}
            and is not part of the rest: Completed, Cancelled and the {num(k.open)} still open are counted by when
            they closed, were cancelled, or simply are — mostly other jobs, from other months. A month can complete
            more than it created. Completion % is (completed + open) over the {num(k.inHand)} jobs in hand, so it
            is exactly 100% minus Cancelled %.
          </p>

          {/* ── section 1 ────────────────────────────────────────────────── */}
          <TicketsCreatedVsCompletedSection daily={report.daily} />

          {/* ── sections 2, 3 and 4 (one card, as the MIS report has them) ── */}
          <CompletionVsCancellationSection
            completionVsCancellation={report.completionVsCancellation}
            byDaysOpen={report.byDaysOpen}
            selectedBuckets={ageBuckets}
            onToggleBucket={toggleAgeBucket}
          />

          {/* ── sections 5, 6 and 7 — Why cancelled, Top cancel reasons and
                 What the comments say. Narrowed by the days-open tiles above
                 with NO refetch: every reason and theme arrives with its own
                 per-band breakdown, so the narrowing is a client-side re-sum,
                 which is the whole reason the backend ships that breakdown. ── */}
          <WhyCancelledSection
            whyCancelled={report.whyCancelled}
            byDaysOpen={report.byDaysOpen}
            checks={report.checks}
            selectedBuckets={ageBuckets}
            onClearBuckets={() => toggleAgeBucket(null)}
          />

          {/* ── section 8 ────────────────────────────────────────────────── */}
          <CityWiseSection cities={report.cities} checks={report.checks} />

          {/* ── sections 9, 10 and 11 — the status-by-aging matrix and the job
                 list behind whichever cell is clicked. That list pages GET
                 /mtd/jobs itself, which the server answers from this report's
                 own cache entry, so a click costs no second read. ────────── */}
          <StatusAgingSection
            statusAging={report.statusAging}
            filters={query}
            checks={report.checks}
            enabled={canView}
          />

          {/* ── the per-SPOC book-of-business table, the tab's last section ─ */}
          <PerSpocSection
            table={table}
            period={period}
            loading={tableRes.loading}
            refreshing={tableRes.refreshing}
            page={page}
            pageSize={pageSize}
            sort={sort}
            pickersInUse={pickersInUse(filters)}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            onSort={toggleSort}
          />
        </div>
      ) : null}
    </ReportPageScaffold>
  );
}

/* ── small parts ──────────────────────────────────────────────────────────── */

/**
 * A KPI tile's figure with the MIS report's own sub-line under it — "124 of
 * 310 completed in TAT", "by cancel date".
 *
 * The sub-line ships INSIDE the tile rather than as a footnote somebody has to
 * hover for, which is how the Call Tracking tab's coverage line does it. The
 * outer span is `block` so the tile's own `truncate` clips the line rather
 * than collapsing the two onto one.
 */
function TileValue({ figure, note }: { figure: string; note: string }) {
  return (
    <span className="block">
      <span className="block">{figure}</span>
      <span className="block text-xs font-medium text-muted-foreground">{note}</span>
    </span>
  );
}

function FilterField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="flex items-baseline justify-between gap-2 text-xs font-medium text-muted-foreground">
        {label}
        {hint && <span className="font-normal">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function StatusRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0" aria-hidden>{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/*
 * The per-SPOC book-of-business table — the section this tab was FIRST built
 * for, kept whole and moved to the foot of the report.
 *
 * It is its own endpoint and its own response: one row per person, the five
 * counts, the pinned Unattributed line and the totals over the whole filtered
 * set. It takes the window and the two export predicates ONLY, so the Client
 * and Primary SPOC pickers above do not narrow it — which the note under the
 * table says in as many words whenever one of them is in use, rather than
 * letting a reader assume a table is filtered when it is not.
 */
function PerSpocSection({
  table, period, loading, refreshing, page, pageSize, sort, pickersInUse: pickersOn,
  onPageChange, onPageSizeChange, onSort,
}: {
  table: MtdTableResponse | null;
  period: string;
  loading: boolean;
  refreshing: boolean;
  page: number;
  pageSize: TablePageSize;
  sort: { sortBy: MtdSortKey; sortDir: SortDir };
  pickersInUse: number;
  onPageChange: (next: number) => void;
  onPageSizeChange: (next: TablePageSize) => void;
  onSort: (col: MtdSortKey) => void;
}) {
  const rows = table?.data ?? [];

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-base font-semibold text-ink-900">Book Of Business By Primary SPOC</h2>
            <p className="text-xs text-muted-foreground">
              One row per person — the client&rsquo;s Primary SPOC — with the five job counts for {period}
            </p>
          </div>
          {table && (
            <p className="text-xs text-muted-foreground">
              {num(table.total)} {table.total === 1 ? 'person' : 'people'}
            </p>
          )}
        </div>

        {table && !table.reconciled && (
          <p className="rounded-md border border-urgent-strong/40 bg-urgent-tint/40 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">This table does not add up.</span>{' '}
            The people plus Unattributed do not equal the totals for this window, which the server has logged as an
            error. Treat these figures as unreliable.
          </p>
        )}

        <div className={cn('overflow-x-auto rounded-md border transition-opacity', refreshing && 'opacity-60')}>
          <table className="data-table w-full">
            <thead>
              <tr>
                <SortHeader<MtdSortKey>
                  col="name"
                  align="left"
                  sortBy={sort.sortBy}
                  sortDir={sort.sortDir}
                  onSort={onSort}
                >
                  Person
                </SortHeader>
                {METRIC_COLUMNS.map((c) => (
                  <SortHeader<MtdSortKey>
                    key={c.key}
                    col={c.key}
                    align="right"
                    sortBy={sort.sortBy}
                    sortDir={sort.sortDir}
                    onSort={onSort}
                  >
                    <span title={columnTitle(c, period)}>{columnLabel(c)}</span>
                  </SortHeader>
                ))}
              </tr>
            </thead>
            <tbody>
              {!table && loading ? (
                <tr>
                  <td colSpan={METRIC_COLUMNS.length + 1} className="!text-center py-6 text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={METRIC_COLUMNS.length + 1} className="!text-center py-6 text-muted-foreground">
                    {/* Two different nothings: a window nobody carries (the footer
                        below is then the whole table), and a page past the end. */}
                    {(table?.total ?? 0) === 0
                      ? 'No person carries any of this work — every job in this window is unattributed.'
                      : 'No people on this page.'}
                  </td>
                </tr>
              ) : rows.map((r) => (
                <tr key={r.userId}>
                  <td className="whitespace-nowrap">{r.name || '—'}</td>
                  {METRIC_COLUMNS.map((c) => (
                    <td key={c.key} className="!text-right tabular-nums">{num(r[c.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            {/*
              * The two pinned rows. Unattributed is NOT a person: it has no
              * userId, it never enters the sort, and nothing about it is
              * clickable — it sits below every page of people, in its own tone,
              * so it reads as what it is. Total is the whole filtered set
              * (people + Unattributed), not this page.
              */}
            {table && (
              <tfoot>
                <CountsRow
                  label={table.unattributed.name || 'Unattributed'}
                  counts={table.unattributed}
                  tone="warn"
                  title="Jobs whose client has no Primary SPOC, or whose SPOC is not a CRM user. Counted in the totals, never dropped."
                />
                <CountsRow label="Total" counts={table.totals} tone="total" title={`Every job matching these filters · ${period}`} />
              </tfoot>
            )}
          </table>
        </div>

        <TablePagination
          page={page}
          pageSize={pageSize}
          total={table?.total ?? 0}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          loading={loading || refreshing}
        />

        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">In Progress (Now)</span> and{' '}
          <span className="font-medium text-foreground">Open (Now)</span> are a snapshot of what is open right now
          and do not change with the date range; In Progress is a subset of Open. Ticket Created, Completed and
          Cancelled are counted inside {period}, on the created, checkout and cancel date.
          {pickersOn > 0 && (
            <>
              {' '}
              <span className="font-medium text-foreground">
                The Client and Primary SPOC filters do not apply to this table
              </span>{' '}
              — it reads the whole window for the selected Vertical and Zonal Manager, so its totals will be
              larger than the sections above.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * One pinned footer row of the per-SPOC table — Unattributed or Total. Same
 * five columns as a person's row, drawn from the same METRIC_COLUMNS list, but
 * with a tone and a label that make clear it is not somebody.
 */
function CountsRow({
  label, counts, tone, title,
}: {
  label: string;
  counts: MtdCounts;
  tone: 'warn' | 'total';
  title: string;
}) {
  /*
   * The tone goes on the CELLS, not on the row: `.data-table tr:hover td`
   * paints a background on the tds, which would cover a row-level one — a
   * footer row that stops looking like a footer row exactly when somebody
   * points at it. The rule lives in the base layer, so a utility class on the
   * cell wins over it in every state.
   */
  const cell = cn('border-t-2 border-border font-semibold', tone === 'warn' ? 'bg-warning-tint/50' : 'bg-muted/60');
  return (
    <tr>
      <td className={cn(cell, 'whitespace-nowrap')} title={title}>
        <span className={cn('inline-flex items-center gap-1.5', tone === 'warn' && 'text-warning-strong')}>
          {tone === 'warn' && <AlertTriangle className="size-4" aria-hidden />}
          {label}
        </span>
      </td>
      {METRIC_COLUMNS.map((c) => (
        <td key={c.key} className={cn(cell, '!text-right tabular-nums')}>{num(counts[c.key])}</td>
      ))}
    </tr>
  );
}
