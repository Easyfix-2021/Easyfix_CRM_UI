'use client';

/*
 * QuickSight — MTD, as the "MTD" tab of the Performance report (rendered by
 * quicksight/performance/page.tsx, like the other tabs' bodies). There is no
 * standalone route: the tab is the whole surface.
 *
 * WHAT IT ANSWERS (owner's decision, final): whose BOOK OF BUSINESS this is.
 * One row per person, five job counts — Ticket Created, In Progress, Open,
 * Completed, Cancelled — where the person is the CLIENT'S PRIMARY SPOC, the
 * same attribution the Employee tab uses.
 *
 * ⚠ IT WILL DISAGREE WITH EMPLOYEE PRODUCTIVITY, ON PURPOSE. That report
 * attributes a job to whoever performed the action ("who did the work"); this
 * one to the account's Primary SPOC ("whose account is it"). The same window
 * shows different numbers in the two tabs and both are correct. The status
 * line says so on screen, so the difference is answered before it is filed as
 * a bug. EasyFix_Backend services/quicksight/mtd.service.js carries the
 * decision in full.
 *
 * LIVE, and computed server-side: one GET builds all five counts from the
 * database (the Manage Jobs export, the same reader the Employee tab's job
 * half uses). This file chooses filters and lays out what that endpoint
 * returns — it derives no count of its own, not even a total.
 *
 *   GET /mtd  → the page of people, PLUS totals / attributed / unattributed /
 *               reconciled over the WHOLE filtered set on every page.
 *
 * That last part is why there is ONE request here and not two: the tiles, the
 * Unattributed line and the Total row are all in the table's own response.
 * The backend's /mtd/summary exists for a tab that paints tiles before a
 * table; this tab has no use for it (see ./api.ts).
 *
 * TWO COLUMNS DO NOT MOVE WITH THE DATES, and that is not a bug: Open and In
 * Progress are a snapshot of what is open RIGHT NOW (the backend reads them
 * with no date filter), In Progress being a subset of Open. Both carry "(Now)"
 * in the header and a note under the table, so a reader changing the range is
 * never surprised by two columns that stay put.
 *
 * FILTERS: Vertical and Zonal Manager (0 = All, the sentinel every QuickSight
 * report uses) and the shared Date Range picker
 * (@/components/quicksight/DateRangeFilter), defaulting to Month To Date —
 * which is what MTD means, and is also the backend's own default window. At
 * most MAX_WINDOW_DAYS days and never past today, checked here first so the
 * message is a clear toast rather than a 400.
 *
 * UNATTRIBUTED is a pinned FOOTER row, never a person: it is the jobs whose
 * client has no Primary SPOC (or whose SPOC is not a resolvable user), it
 * carries no userId, it is not sortable into the middle of the people, and it
 * is not clickable. It is shown rather than dropped because the totals count
 * it — attributed + unattributed = totals — which is the same treatment the
 * Employee tab gives its own Unattributed line.
 *
 * Gating: ef-QuickSight + isQuickSightMtdView. The tab stays hidden until the
 * seed migration grants that key (the intended fail-closed behaviour), and a
 * 403 from the endpoint renders the scaffold's access panel.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, CalendarRange, CheckCircle2, ClipboardList, Clock, Database, FolderOpen, Loader2,
  RotateCcw, Users, XCircle,
} from 'lucide-react';
import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QsKpiTile, QS_COLORS, QS_SEMANTIC } from '@/components/quicksight/charts';
import { DateRangeFilter } from '@/components/quicksight/DateRangeFilter';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
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
  defaultWindow, narrowed, resolveWindow, tableKey, widestWindow, windowDays,
  type MtdFilters, type MtdSortKey,
} from './api';
import type { MtdCounts, MtdTableResponse } from './types';

/* A BE 403 (requireQuickSight) arrives as one of these messages. */
const DENIED_RE = /permission|quicksight access|access denied/i;

/* The shared lookups the two dimension filters are built from. */
type Vertical = { vertical_id: number; vertical_name: string };
type ManagerLite = { user_id: number; user_name: string };

/*
 * No 'All' page size: the endpoint caps `size` at MAX_PAGE_SIZE, so an "All"
 * option would render one un-navigable page whose range hint lies about what
 * is on screen the moment a company has more SPOCs than that.
 */
const PAGE_SIZE_OPTIONS: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
];

/*
 * The five counts in the order the owner listed them, which is also the order
 * a job moves through: created → in progress → open → completed → cancelled.
 * ONE list drives the header, every row, the footer rows and the tiles, so a
 * column can never appear in one of them and not the others.
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

/** Why a column does or does not move with the date range — the header's tooltip. */
const columnTitle = (c: MetricColumn, period: string) => (c.now
  ? `${c.label} right now — a snapshot, not ${period}. This column does not change with the date range.`
  : `${c.label} in ${period}`);

const TILE_ACCENT: Record<MetricColumn['key'], string> = {
  ticketCreated: QS_COLORS[0],
  inProgress: QS_SEMANTIC.warn,
  open: QS_COLORS[7],
  completed: QS_SEMANTIC.good,
  cancelled: QS_SEMANTIC.bad,
};

const TILE_ICON: Record<MetricColumn['key'], ReactNode> = {
  ticketCreated: <ClipboardList className="size-5" />,
  inProgress: <Clock className="size-5" />,
  open: <FolderOpen className="size-5" />,
  completed: <CheckCircle2 className="size-5" />,
  cancelled: <XCircle className="size-5" />,
};

// Built once: an Intl.NumberFormat is far cheaper to reuse than toLocaleString per cell.
const EN_IN = new Intl.NumberFormat('en-IN');
/** 1,23,456 — counts, Indian grouping, as the other QuickSight tabs print them. */
const num = (n: number | null | undefined): string => EN_IN.format(Number(n || 0));

export function MtdBody() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY]);
  const canView = flags[ACTION_KEY];

  // The IST day the tab opened on: the default window ends here and no later date can be picked.
  const [today] = useState(istToday);

  const [filters, setFilters] = useState<MtdFilters>(EMPTY_FILTERS);
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

  /* ── the request ────────────────────────────────────────────────────────── */

  // What every request sends: the filters with the window made explicit.
  const query = useMemo(() => resolveWindow(filters, today), [filters, today]);
  const key = canView
    ? tableKey(query, {
      page: page + 1, // the endpoint counts pages from 1
      size: pageSizeToLimit(pageSize, MAX_PAGE_SIZE),
      sortBy: sort.sortBy,
      sortDir: sort.sortDir,
    })
    : null;
  const res = useFetch<MtdTableResponse>(key);
  const d = res.data;
  const rows = d?.data ?? [];
  const period = fmtDayRange(query.from, query.to);
  // useFetch keeps the previous response on screen while a new key loads.
  const stale = !!d && (res.refreshing || res.dataKey !== key);

  /* ── filter state ───────────────────────────────────────────────────────── */

  // Every filter change returns to the first page: page 4 of the old filters
  // is not page 4 of the new ones, and may not exist at all.
  const applyFilters = (patch: Partial<MtdFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
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
   * hidden — a header that lies quietly. */
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

  const accessDenied = (!!me && !canView) || (!!res.error && DENIED_RE.test(res.error));
  const genericError = res.error && !accessDenied ? res.error : null;
  // Wait for `me` (so nothing flashes while auth loads) and the first response.
  const loading = !me || (canView && !res.error && !d);
  /*
   * Empty only when there is genuinely nothing: no people AND no unattributed
   * work. A window that names nobody but still counted jobs must render the
   * table, because that table's footer is the only place those jobs appear.
   */
  const isEmpty = !loading && !genericError && !accessDenied && !!d
    && d.total === 0 && METRIC_COLUMNS.every((c) => d.totals[c.key] === 0);

  /* ── filters slot: status lines + filter grid ───────────────────────────── */

  const statusLine = (
    <div className="space-y-1 text-sm text-muted-foreground">
      <StatusRow icon={<Database className="size-4" />}>
        Counts live from the database
        {d && (
          <>
            {' · '}as of <span className="font-medium text-foreground">{formatDate(d.meta.readAt)}</span>
          </>
        )}
        {(loading || stale) && canView && !res.error && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs">
            <Loader2 className="size-3 animate-spin" />
            Reading {period}… the first load of a date range can take a while
          </span>
        )}
      </StatusRow>
      <StatusRow icon={<Users className="size-4" />}>
        One row per person: the <span className="font-medium text-foreground">client&rsquo;s Primary SPOC</span>,
        {' '}whose book of business the job is. Employee Productivity counts whoever performed the action instead,
        {' '}so the two tabs disagree on the same window by design.
      </StatusRow>
    </div>
  );

  const filterGrid = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <FilterField label="Vertical">
        <SearchSelect
          value={filters.verticalId}
          onChange={(next) => applyFilters({ verticalId: Number(next) || 0 })}
          options={verticalOptions}
          required
        />
      </FilterField>
      <FilterField label="Zonal Manager">
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

  return (
    <ReportPageScaffold
      title="MTD"
      subtitle="Ticket Created, In Progress, Open, Completed And Cancelled By Primary SPOC"
      icon={CalendarRange}
      filters={filtersSlot}
      loading={loading}
      error={genericError}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
    >
      {d ? (
        <div className={cn('space-y-4 transition-opacity', stale && 'opacity-60')} aria-busy={stale}>
          {/* The backend's own reconciliation check. False means it logged an
              error: say so instead of printing numbers that do not add up. */}
          {!d.reconciled && (
            <Card>
              <CardContent className="flex items-start gap-3 p-4 text-sm">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-urgent-strong" />
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">These Numbers Do Not Add Up.</span>{' '}
                  The people plus Unattributed do not equal the totals for this window, which the server has
                  logged as an error. Treat the figures below as unreliable and report the window
                  ({period}) before acting on them.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Tiles — the same five counts over the whole filtered set. They
              come from the table's own response, so they cost no request. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {METRIC_COLUMNS.map((c) => (
              <QsKpiTile
                key={c.key}
                label={columnLabel(c)}
                value={num(d.totals[c.key])}
                accent={TILE_ACCENT[c.key]}
                icon={TILE_ICON[c.key]}
              />
            ))}
          </div>

          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold text-ink-900">People</h2>
                <p className="text-xs text-muted-foreground">
                  {num(d.total)} {d.total === 1 ? 'person' : 'people'} · {period}
                </p>
              </div>

              <div className="overflow-x-auto rounded-md border">
                <table className="data-table w-full">
                  <thead>
                    <tr>
                      <SortHeader<MtdSortKey>
                        col="name"
                        align="left"
                        sortBy={sort.sortBy}
                        sortDir={sort.sortDir}
                        onSort={toggleSort}
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
                          onSort={toggleSort}
                        >
                          <span title={columnTitle(c, period)}>{columnLabel(c)}</span>
                        </SortHeader>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={METRIC_COLUMNS.length + 1} className="!text-center py-6 text-muted-foreground">
                          {/* Two different nothings: a window nobody carries (the footer
                              below is then the whole report), and a page past the end. */}
                          {d.total === 0
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
                    * The two pinned rows. Unattributed is NOT a person: it has
                    * no userId, it never enters the sort, and nothing about it
                    * is clickable — it sits below every page of people, in its
                    * own tone, so it reads as what it is. Total is the whole
                    * filtered set (people + Unattributed), not this page.
                    */}
                  <tfoot>
                    <CountsRow
                      label={d.unattributed.name || 'Unattributed'}
                      counts={d.unattributed}
                      tone="warn"
                      title="Jobs whose client has no Primary SPOC, or whose SPOC is not a CRM user. Counted in the totals, never dropped."
                    />
                    <CountsRow label="Total" counts={d.totals} tone="total" title={`Every job matching these filters · ${period}`} />
                  </tfoot>
                </table>
              </div>

              <TablePagination
                page={page}
                pageSize={pageSize}
                total={d.total}
                onPageChange={setPage}
                onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                loading={res.loading || stale}
              />

              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">In Progress (Now)</span> and{' '}
                <span className="font-medium text-foreground">Open (Now)</span> are a snapshot of what is open
                right now and do not change with the date range; In Progress is a subset of Open. Ticket Created,
                Completed and Cancelled are counted inside {period}, on the created, checkout and cancel date.
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </ReportPageScaffold>
  );
}

/* ── small parts ──────────────────────────────────────────────────────────── */

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

/**
 * One pinned footer row — Unattributed or Total. Same five columns as a
 * person's row, drawn from the same METRIC_COLUMNS list, but with a tone and a
 * label that make clear it is not somebody.
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
