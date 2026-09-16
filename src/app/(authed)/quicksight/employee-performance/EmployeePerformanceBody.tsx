'use client';

/*
 * QuickSight — Employee Performance, as the "Employee" tab of the Performance
 * report (rendered by quicksight/performance/page.tsx, like the other tabs'
 * bodies). The old standalone route redirects here.
 *
 * v1 NATIVE VIEW. The MIS dashboard (dashboard_automation/dashboard.html)
 * rebuilt in the CRM's own tiles, tables, filters and dialog — not the MIS
 * HTML look. The data is the snapshot MIS uploads (data.js); every number is
 * computed server-side by EasyFix_Backend
 * services/quicksight/employee-performance/aggregate.js, which is proven
 * identical to the dashboard. This file only chooses filters and lays out
 * what the endpoints return:
 *
 *   GET  /meta          what is stored, by whom, when (null = nothing yet)
 *   POST /upload        data.js (gzipped here)
 *   GET  /options       filter lists
 *   GET  /summary       KPIs, team panel and sections 1, 3–5, 6 (zonal), 7–10
 *   GET  /open-jobs     section 2 table     (fetched inside OpenJobRecordSection)
 *   GET  /technicians   section 6 TX table  (fetched inside ZonalSection)
 *   GET  /member        team-member dialog  (fetched inside MemberDetailDialog)
 *
 * Every data key carries v = meta.uploadedAt (see api.ts), so a new upload can
 * never be served from the 30-second useFetch cache.
 *
 * Layout follows the dashboard so MIS recognises it: filters, 7 KPI tiles,
 * 0 Team, then sections 1–10 in the original order.
 *
 * FILTERS (dashboard parity):
 *   - Vertical / Employee are multi-selects; empty = Select All. Changing
 *     Vertical resets Employee to All (the dashboard rebuilds that select) and
 *     the Employee list only offers SPOCs of the selected verticals.
 *   - Zonal Manager and Month stay single-selects ('ALL' default). Changing
 *     Month clears the date range, as the dashboard clears From / To.
 *   - The date range is clamped to the snapshot's dates (or the chosen
 *     month's), like the dashboard's min / max on its date inputs.
 *   - Any filter change closes the member dialog.
 *
 * Gating: ef-QuickSight + isQuickSightEmployeePerformanceView (the tab itself);
 * isQuickSightEmployeePerformanceUpload additionally shows "Upload Data".
 */

import { useCallback, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  Briefcase, CalendarX, CheckCircle2, Clock, Inbox, IndianRupee, Loader2, Percent,
  RotateCcw, Target, TrendingUp, Upload, Users,
} from 'lucide-react';
import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QsKpiTile, QS_COLORS, QS_SEMANTIC } from '@/components/quicksight/charts';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { DateRangePopover } from '@/components/ui/date-range-popover';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import {
  ACTION_KEY, ALL, API_BASE, EMPTY_FILTERS, META_KEY, UPLOAD_KEY, UPLOAD_URL,
  filtersQuery, optionsKey, summaryKey,
} from './api';
import { fmtDay, fmtStamp, money, num, pct1 } from './format';
import type { FilterOptions, Filters, SnapshotMeta, SummaryResponse, TeamMemberChip } from './types';
import { TeamPanel } from './TeamPanel';
import { MemberDetailDialog } from './MemberDetailDialog';
import { RevenuePerformanceSection } from './sections/RevenuePerformanceSection';
import { OpenJobRecordSection } from './sections/OpenJobRecordSection';
import { ClientWiseSection } from './sections/ClientWiseSection';
import { CityWiseSection } from './sections/CityWiseSection';
import { TatSdaSection } from './sections/TatSdaSection';
import { ZonalSection } from './sections/ZonalSection';
import { ProductivitySection } from './sections/ProductivitySection';
import { PerformanceSection } from './sections/PerformanceSection';
import { ShortSummarySection } from './sections/ShortSummarySection';
import { SuggestionsSection } from './sections/SuggestionsSection';

/* A BE 403 (requireQuickSight) arrives as one of these messages. */
const DENIED_RE = /permission|quicksight access|access denied/i;

/*
 * data.js is ~7 MB of JSON that compresses ~10x; sending it gzipped keeps the
 * upload well under every proxy body limit. A browser without
 * CompressionStream sends the file as-is (the backend accepts both).
 */
async function gzipFile(file: File): Promise<Blob> {
  if (typeof CompressionStream === 'undefined') return file;
  return new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

export function EmployeePerformanceBody() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY, UPLOAD_KEY]);
  const canView = flags[ACTION_KEY];
  const canUpload = canView && flags[UPLOAD_KEY];

  const meta = useFetch<SnapshotMeta | null>(canView ? META_KEY : null);
  const snapshot = meta.data;
  const v = snapshot?.uploadedAt ?? null;

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [member, setMember] = useState<TeamMemberChip | null>(null);

  const options = useFetch<FilterOptions>(canView ? optionsKey(v) : null);
  const summary = useFetch<SummaryResponse>(canView ? summaryKey(v, filters) : null);
  const opts = options.data;
  const s = summary.data;

  /* ── filter state ───────────────────────────────────────────────────────── */

  // Every filter change also closes the member dialog (the dashboard does both).
  const applyFilters = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setMember(null);
  };
  const closeMember = useCallback(() => setMember(null), []);

  const verticalOptions = useMemo<SearchOption[]>(
    () => (opts?.verticals ?? []).map((x) => ({ value: x, label: x })),
    [opts],
  );
  const zmOptions = useMemo<SearchOption[]>(
    () => [{ value: ALL, label: 'All Zonal Managers' }, ...(opts?.zonalManagers ?? []).map((x) => ({ value: x, label: x }))],
    [opts],
  );
  const monthOptions = useMemo<SearchOption[]>(
    () => [{ value: ALL, label: 'All Months' }, ...(opts?.months ?? []).map((m) => ({ value: m.value, label: m.label }))],
    [opts],
  );
  // The dashboard's fillEmployees(): only SPOCs of the selected verticals. Ticking
  // every vertical is Select All on the server (normaliseFilters), so it is here too.
  const employeeOptions = useMemo<SearchOption[]>(() => {
    const all = opts?.verticals ?? [];
    const picked = filters.verticals;
    const everyVertical = picked.length === 0 || (all.length > 1 && all.every((x) => picked.includes(x)));
    return (opts?.employees ?? [])
      .filter((e) => everyVertical || (e.vertical !== null && picked.includes(e.vertical)))
      .map((e) => ({ value: e.value, label: e.label }));
  }, [opts, filters.verticals]);

  // The range the dashboard's date inputs allow: the chosen month's dates, or the whole snapshot.
  const monthOpt = filters.month !== ALL ? opts?.months.find((m) => m.value === filters.month) : undefined;
  const boundFrom = (monthOpt ? monthOpt.from : opts?.dateFrom) ?? '';
  const boundTo = (monthOpt ? monthOpt.to : opts?.dateTo) ?? '';
  const rangeFrom = filters.from || boundFrom;
  const rangeTo = filters.to || boundTo;
  const period = rangeFrom && rangeTo ? `${fmtDay(rangeFrom)} – ${fmtDay(rangeTo)}` : 'No Dates In Range';

  const onRangeChange = (next: { from: string; to: string }) => {
    const from = boundFrom && next.from < boundFrom ? boundFrom : next.from;
    const to = boundTo && next.to > boundTo ? boundTo : next.to;
    if (from > to) {
      showToast({ variant: 'error', message: `Pick dates between ${fmtDay(boundFrom)} and ${fmtDay(boundTo)}` });
      return;
    }
    // A bound is stored as '' so "the whole range" is one canonical fetch key.
    applyFilters({ from: from === boundFrom ? '' : from, to: to === boundTo ? '' : to });
  };

  const narrowed = filtersQuery(filters) !== '';

  /* ── upload ─────────────────────────────────────────────────────────────── */

  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const onFilePicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // picking the same file again must still fire
    if (!file) return;
    setUploading(true);
    const toastId = showToast({ variant: 'loading', message: 'Uploading dashboard data…' });
    try {
      const body = await gzipFile(file);
      const fd = new FormData();
      fd.append('file', body, body === file ? file.name : `${file.name}.gz`);
      const next = await api.post<SnapshotMeta>(UPLOAD_URL, fd);
      invalidateFetch((k) => k.startsWith(API_BASE));
      meta.refetch();
      // A new snapshot can hold other months and people: start again from Select All.
      setFilters(EMPTY_FILTERS);
      setMember(null);
      showToast({ variant: 'success', message: `Data updated: ${fmtDay(next.dateFrom)} – ${fmtDay(next.dateTo)}` });
    } catch (err) {
      showToast({ variant: 'error', message: err instanceof ApiError ? err.message : 'Upload failed' });
    } finally {
      dismissToast(toastId);
      setUploading(false);
    }
  };

  /* ── page state ─────────────────────────────────────────────────────────── */

  const fetchError = meta.error ?? options.error ?? summary.error;
  const accessDenied = (!!me && !canView) || (!!fetchError && DENIED_RE.test(fetchError));
  const genericError = fetchError && !accessDenied ? fetchError : null;
  // Wait for `me` (so the empty state never flashes while auth loads), for /meta,
  // and — once a snapshot exists — for the first options + summary.
  const loading = !me || meta.loading || (!!snapshot && (!opts || !s));

  /* ── filters slot: status line + filter grid ────────────────────────────── */

  const statusLine = (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <span>
          {snapshot ? (
            <>
              Data <span className="font-medium text-foreground">{fmtDay(snapshot.dateFrom)} – {fmtDay(snapshot.dateTo)}</span>
              {' · '}{snapshot.employeeCount} employees{' · '}
              Updated {fmtStamp(snapshot.uploadedAt)}{snapshot.uploadedBy.name ? ` by ${snapshot.uploadedBy.name}` : ''}
            </>
          ) : meta.loading ? 'Checking for uploaded data…' : 'No data uploaded yet'}
        </span>
        {s && summary.refreshing && (
          <span className="inline-flex items-center gap-1 text-xs">
            <Loader2 className="size-3 animate-spin" />Updating…
          </span>
        )}
      </div>
      {canUpload && (
        <>
          <input ref={fileInput} type="file" accept=".js,.json" className="hidden" onChange={onFilePicked} />
          {/* gap-1.5 like DownloadButton — the Button base class sets no gap itself. */}
          <Button size="sm" className="gap-1.5" onClick={() => fileInput.current?.click()} disabled={uploading}>
            <Upload className="size-4" />{uploading ? 'Uploading…' : 'Upload Data'}
          </Button>
        </>
      )}
    </div>
  );

  // Controls only once there is something to filter: no empty selects for a
  // missing snapshot (denied viewers never reach this slot at all).
  const filterGrid = snapshot && opts && (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <FilterField label="Vertical">
        <SearchMultiSelect
          value={filters.verticals}
          onChange={(next) => applyFilters({ verticals: next.map(String), employees: [] })}
          options={verticalOptions}
          placeholder="All Verticals"
          selectedLabel="verticals"
        />
      </FilterField>
      <FilterField label="Zonal Manager">
        <SearchSelect
          value={filters.zm || ALL}
          onChange={(next) => applyFilters({ zm: next || ALL })}
          options={zmOptions}
          required
        />
      </FilterField>
      <FilterField label="Employee">
        <SearchMultiSelect
          value={filters.employees}
          onChange={(next) => applyFilters({ employees: next.map(String) })}
          options={employeeOptions}
          placeholder="All Employees"
          selectedLabel="employees"
        />
      </FilterField>
      <FilterField label="Month">
        <SearchSelect
          value={filters.month || ALL}
          onChange={(next) => applyFilters({ month: next || ALL, from: '', to: '' })}
          options={monthOptions}
          required
        />
      </FilterField>
      <FilterField label="Date Range">
        <DateRangePopover from={rangeFrom} to={rangeTo} onChange={onRangeChange} maxDate={boundTo || undefined} />
      </FilterField>
      <div className="flex items-end">
        {narrowed && (
          <Button type="button" variant="outline" className="gap-1.5" onClick={() => applyFilters(EMPTY_FILTERS)}>
            <RotateCcw className="size-4" />Reset Filters
          </Button>
        )}
      </div>
    </div>
  );

  const filtersSlot = canView ? (
    <div className="space-y-3">
      {statusLine}
      {filterGrid}
    </div>
  ) : undefined;

  return (
    <>
      <ReportPageScaffold
        title="Employee Performance"
        subtitle="Revenue Vs Target, Open Jobs, TAT / SDA And Productivity By SPOC And Team"
        icon={TrendingUp}
        filters={filtersSlot}
        loading={loading}
        error={genericError}
        accessDenied={accessDenied}
        isEmpty={false}
      >
        {!snapshot || !v ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
              <Inbox className="size-8 text-muted-foreground" />
              <div className="space-y-1">
                <div className="text-base font-semibold">No Data Uploaded Yet</div>
                <p className="max-w-lg text-sm text-muted-foreground">
                  {canUpload
                    ? 'Click Upload Data to add the latest data.'
                    : 'The report appears here once MIS uploads the latest data.'}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : s ? (
          <div className="space-y-4">
            {s.dates.count === 0 && (
              <Card>
                <CardContent className="flex items-start gap-3 p-4 text-sm">
                  <CalendarX className="mt-0.5 size-5 shrink-0 text-warning-strong" />
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">No Uploaded Dates In The Selected Range.</span>{' '}
                    Revenue, closed-job and productivity figures show zero; open-job figures are a current snapshot and still show.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* KPI tiles — the dashboard's seven, in its order. */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <QsKpiTile label="Total Revenue" value={money(s.kpis.revenue)} accent={QS_COLORS[2]} icon={<IndianRupee className="size-5" />} />
              <QsKpiTile label="Jobs Completed" value={num(s.kpis.completed)} accent={QS_SEMANTIC.good} icon={<CheckCircle2 className="size-5" />} />
              <QsKpiTile label="Jobs Open" value={num(s.kpis.open)} accent={QS_COLORS[7]} icon={<Clock className="size-5" />} />
              <QsKpiTile label="Total Jobs" value={num(s.kpis.total)} accent={QS_COLORS[0]} icon={<Briefcase className="size-5" />} />
              <QsKpiTile label="Completion Rate" value={pct1(s.kpis.completionRate)} accent={QS_SEMANTIC.info} icon={<Percent className="size-5" />} />
              <QsKpiTile label="Target Achieved" value={pct1(s.kpis.targetAchieved)} accent={QS_COLORS[8]} icon={<Target className="size-5" />} />
              <QsKpiTile label="Team Members" value={num(s.kpis.teamSize)} accent={QS_COLORS[5]} icon={<Users className="size-5" />} />
            </div>

            <TeamPanel team={s.team} activeKey={member?.key ?? null} onSelect={setMember} />

            <RevenuePerformanceSection summary={s} />
            <OpenJobRecordSection summary={s} v={v} filters={filters} />
            <ClientWiseSection summary={s} />
            <CityWiseSection summary={s} />
            <TatSdaSection summary={s} />
            <ZonalSection summary={s} v={v} filters={filters} />
            <ProductivitySection summary={s} />
            <PerformanceSection summary={s} />
            <ShortSummarySection summary={s} />
            <SuggestionsSection summary={s} />
          </div>
        ) : null}
      </ReportPageScaffold>

      <MemberDetailDialog v={v} filters={filters} member={member} period={period} onClose={closeMember} />
    </>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
