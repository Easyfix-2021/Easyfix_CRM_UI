'use client';

/*
 * QuickSight — Employee Performance, as the "Employee" tab of the Performance
 * report (rendered by quicksight/performance/page.tsx, like the other tabs'
 * bodies). The old standalone route redirects here.
 *
 * NATIVE VIEW OVER LIVE DATA (owner decisions, final). The MIS dashboard
 * rebuilt in the CRM's own tiles, tables, filters and dialog. Every number is
 * computed server-side by EasyFix_Backend
 * services/quicksight/employee-performance (live.service.js composes the
 * dashboard object, aggregate.js — proven identical to the dashboard — reads
 * it). This file only chooses filters and lays out what the endpoints return:
 *
 *   - open jobs (every job open NOW), closed jobs and CRM counts (both inside
 *     the selected window) come LIVE from the database;
 *   - target list, emp detail, Secondary spoc target list, time champ data and
 *     ivr data record come from the Excel uploaded here (UploadExcelDialog).
 *
 *   GET  /live/options      filter lists + meta          (this file)
 *   GET  /live/summary      KPIs, team panel, sections 1, 3–5, 6 (zonal), 7–10 + meta
 *   GET  /live/open-jobs    section 2 table     (fetched inside OpenJobRecordSection)
 *   GET  /live/technicians  section 6 TX table  (fetched inside ZonalSection)
 *   GET  /live/member       team-member dialog  (fetched inside MemberDetailDialog)
 *   GET  /live/template     the 5-sheet Excel   (Download Template)
 *   POST /live/upload       check / save        (Upload Excel)
 *
 * meta (on options and summary, one build per window) drives the status line:
 * when the jobs were read, what each upload source holds, the last upload, the
 * Unattributed line (jobs whose SPOC / A&CO user is on no emp detail — reported,
 * never dropped), and the note on uploads missing for the selected months.
 *
 * WHO IS NAMED (owner's rule, ./visibility.ts): only the people on the uploaded
 * emp detail of every month in the window. A month without that sheet names
 * NOBODY — its jobs, revenue and CRM rows land under Unattributed, which the
 * Total Revenue, Jobs Completed, Jobs Open and Total Jobs tiles count — so the
 * report can be complete in those totals and name nobody at the same time.
 * VisibilityNotes says so at the top, in ONE note naming the
 * one rule that is actually biting; the Team panel and each section's empty
 * state repeat the reason in place.
 *
 * Layout follows the dashboard so MIS recognises it: filters, 7 KPI tiles,
 * 0 Team, then sections 1–10 in the original order.
 *
 * FILTERS:
 *   - Vertical / Employee are multi-selects; empty = Select All. Changing
 *     Vertical resets Employee to All (the dashboard rebuilds that select) and
 *     the Employee list only offers SPOCs of the selected verticals.
 *   - Zonal Manager stays a single select ('ALL' default).
 *   - THE WINDOW is live: Month picks a whole month (up to today); the Date
 *     Range picks any from / to up to today, at most 3 months (the backend's
 *     limit, checked here first so the message is clear). Default: the
 *     current IST month, 1st .. today. A range inside the chosen month keeps
 *     the month; one outside it switches Month back to All. Every request
 *     carries the effective from / to (api.ts resolveWindow), so a window
 *     change is a new key and refetches.
 *   - Any filter change closes the member dialog.
 *
 * Gating: ef-QuickSight + isQuickSightEmployeePerformanceView (the tab itself);
 * isQuickSightEmployeePerformanceUpload additionally shows "Download Template"
 * and "Upload Excel".
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Briefcase, CalendarX, CheckCircle2, Clock, Database, EyeOff, FileSpreadsheet, IndianRupee,
  Info, Loader2, Percent, RotateCcw, Target, TrendingUp, Users,
} from 'lucide-react';
import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QsKpiTile, QS_COLORS, QS_SEMANTIC } from '@/components/quicksight/charts';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { DateRangePopover } from '@/components/ui/date-range-popover';
import { showToast } from '@/components/ui/toast';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { downloadXlsx } from '@/lib/download-xlsx';
import { istToday } from '@/lib/due-date';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import {
  ACTION_KEY, ALL, EMPTY_FILTERS, LIVE_BASE, MAX_RANGE_MONTHS, TEMPLATE_FILENAME, TEMPLATE_URL, UPLOAD_KEY,
  filtersQuery, lastAllowedTo, optionsKey, recentMonths, resolveWindow, summaryKey, windowBounds,
  type DateWindow,
} from './api';
import {
  fmtDay, fmtDayRange, fmtMonth, fmtMonthList, fmtMonthLong, fmtMonthLongList, fmtStamp, money, num, pct1,
} from './format';
import {
  hiddenPeopleNote, missingMonthsPhrase, rosterGap, teamEmptyState, unattributedTilesNote, uploadedRosterPhrase,
  visibilityStory, type RosterGap,
} from './visibility';
import type {
  Filters, LiveDailyCoverage, LiveMeta, LiveOptionsResponse, LiveSummaryResponse, LiveUnattributed,
  TeamMemberChip, UnattributedUser,
} from './types';
import { TeamPanel } from './TeamPanel';
import { MemberDetailDialog } from './MemberDetailDialog';
import { UploadExcelButton } from './UploadExcelDialog';
import { LocalTable, type Column } from './sections/shared';
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

/* How many months back the Month select offers (newest first). */
const MONTH_CHOICES = 12;

export function EmployeePerformanceBody() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY, UPLOAD_KEY]);
  const canView = flags[ACTION_KEY];
  const canUpload = canView && flags[UPLOAD_KEY];

  // The IST day the tab opened on: the default window ends here and no later date can be picked.
  const [today] = useState(istToday);
  // Bumped when an upload is saved, so every data key changes and nothing pre-upload is served from cache.
  const [revision, setRevision] = useState(0);
  const v = `r${revision}`;

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [member, setMember] = useState<TeamMemberChip | null>(null);

  // What every request sends: the filters with the window made explicit.
  const query = useMemo(() => resolveWindow(filters, today), [filters, today]);
  const win: DateWindow = { from: query.from, to: query.to };

  const optsKey = canView ? optionsKey(v, win) : null;
  const sumKey = canView ? summaryKey(v, query) : null;
  const options = useFetch<LiveOptionsResponse>(optsKey);
  const summary = useFetch<LiveSummaryResponse>(sumKey);
  const opts = options.data;
  const s = summary.data;
  const meta = s?.meta ?? opts?.meta ?? null;
  // useFetch keeps the previous response on screen while a new key loads.
  const stale = !!s && (summary.refreshing || summary.dataKey !== sumKey);
  // Who this window can name at all: the notes, the Team panel and every
  // section's empty text come from it. Empty (and silent) until meta arrives.
  const gap = rosterGap(s?.meta ?? null, s?.team.members.length);

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
    () => [
      { value: ALL, label: 'All Months (Use Date Range)' },
      ...recentMonths(today, MONTH_CHOICES).map((m) => ({ value: m, label: fmtMonthLong(m) })),
    ],
    [today],
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

  const period = fmtDayRange(query.from, query.to);
  const monthPicked = !!filters.month && filters.month !== ALL;

  const onRangeChange = (next: DateWindow) => {
    const limit = lastAllowedTo(next.from);
    if (next.to > limit) {
      showToast({
        variant: 'error',
        message: `Pick at most ${MAX_RANGE_MONTHS} months: a range starting ${fmtDay(next.from)} can end on ${fmtDay(limit)} at the latest`,
      });
      return;
    }
    const month = monthPicked && next.from.startsWith(filters.month) && next.to.startsWith(filters.month)
      ? filters.month
      : ALL;
    // A bound is stored as '' so "the whole default window" is one canonical fetch key.
    const bounds = windowBounds(month, today);
    applyFilters({ month, from: next.from === bounds.from ? '' : next.from, to: next.to === bounds.to ? '' : next.to });
  };

  const narrowed = filtersQuery(filters) !== '';

  /* ── uploads ────────────────────────────────────────────────────────────── */

  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const onDownloadTemplate = async () => {
    setDownloadingTemplate(true);
    try {
      await downloadXlsx({ url: TEMPLATE_URL, filename: TEMPLATE_FILENAME });
    } catch (err) {
      showToast({ variant: 'error', message: err instanceof Error ? err.message : 'Download failed' });
    } finally {
      setDownloadingTemplate(false);
    }
  };

  // A saved upload changes targets, teams and productivity: drop every live
  // response and move to new keys (the dialog has already toasted).
  const onUploadSaved = useCallback(() => {
    invalidateFetch((k) => k.startsWith(LIVE_BASE));
    setRevision((r) => r + 1);
    setMember(null);
  }, []);

  /* ── page state ─────────────────────────────────────────────────────────── */

  const fetchError = options.error ?? summary.error;
  const accessDenied = (!!me && !canView) || (!!fetchError && DENIED_RE.test(fetchError));
  const genericError = fetchError && !accessDenied ? fetchError : null;
  // Wait for `me` (so nothing flashes while auth loads) and the first options + summary.
  const loading = !me || (canView && !fetchError && (!opts || !s));

  /* ── filters slot: status lines + filter grid ───────────────────────────── */

  const statusLine = (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1 text-muted-foreground">
          <StatusRow icon={<Database className="size-4" />}>
            {meta ? (
              <>
                Jobs &amp; CRM data live from the database
                {' · '}as of <span className="font-medium text-foreground">{fmtStamp(meta.jobsAsOf)}</span>
              </>
            ) : 'Jobs & CRM data live from the database'}
            {(loading || stale) && canView && !fetchError && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs">
                <Loader2 className="size-3 animate-spin" />
                Reading {period}… the first load of a date range can take up to a minute
              </span>
            )}
          </StatusRow>
          {meta && <UploadsRow meta={meta} />}
        </div>
        {canUpload && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={onDownloadTemplate} disabled={downloadingTemplate}>
              <FileSpreadsheet className="size-4" />{downloadingTemplate ? 'Downloading…' : 'Download Template'}
            </Button>
            <UploadExcelButton onSaved={onUploadSaved} />
          </div>
        )}
      </div>
      {/* Full width, so its user table is not squeezed beside the buttons. */}
      {meta && <UnattributedRow unattributed={meta.unattributed} />}
    </div>
  );

  const filterGrid = (
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
      <FilterField label="Date Range" hint={`Up to ${MAX_RANGE_MONTHS} months, until today`}>
        <DateRangePopover from={query.from} to={query.to} onChange={onRangeChange} maxDate={today} />
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

  // Denied viewers never reach this slot at all.
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
        {s ? (
          <div className={cn('space-y-4 transition-opacity', stale && 'opacity-60')} aria-busy={stale}>
            <VisibilityNotes gap={gap} canUpload={canUpload} />
            <MissingUploadsNote meta={s.meta} canUpload={canUpload} />

            {s.dates.count === 0 && (
              <Card>
                <CardContent className="flex items-start gap-3 p-4 text-sm">
                  <CalendarX className="mt-0.5 size-5 shrink-0 text-warning-strong" />
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">No Dates In The Selected Range.</span>{' '}
                    Revenue, closed-job and productivity figures show zero; open jobs are every job open now and still show.
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

            <TeamPanel team={s.team} activeKey={member?.key ?? null} onSelect={setMember} empty={teamEmptyState(gap)} />

            <RevenuePerformanceSection summary={s} />
            <OpenJobRecordSection summary={s} v={v} filters={query} />
            <ClientWiseSection summary={s} />
            <CityWiseSection summary={s} />
            <TatSdaSection summary={s} />
            <ZonalSection summary={s} v={v} filters={query} />
            <ProductivitySection summary={s} />
            <PerformanceSection summary={s} />
            <ShortSummarySection summary={s} />
            <SuggestionsSection summary={s} />
          </div>
        ) : null}
      </ReportPageScaffold>

      <MemberDetailDialog v={v} filters={query} member={member} period={period} onClose={closeMember} />
    </>
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

function StatusRow({ icon, tone, children }: { icon: ReactNode; tone?: 'warn'; children: ReactNode }) {
  return (
    <div className={cn('flex items-start gap-2', tone === 'warn' && 'text-warning-strong')}>
      <span className="mt-0.5 shrink-0" aria-hidden>{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** '1 closed job' / '2 closed jobs' — counts in running text. */
function count(n: number, noun: string): string {
  return `${num(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/* ── status: what the uploads hold ────────────────────────────────────────── */

function UploadsRow({ meta }: { meta: LiveMeta }) {
  const { storage, coverage, lastBatch } = meta.uploads;
  if (storage === 'missing' || !coverage) {
    return (
      <StatusRow icon={<FileSpreadsheet className="size-4" />} tone="warn">
        Uploaded sheets: upload storage is not set up on this server yet
      </StatusRow>
    );
  }
  return (
    <StatusRow icon={<FileSpreadsheet className="size-4" />}>
      Uploaded sheets: TimeChamp {fmtDayRange(coverage.timechamp.from, coverage.timechamp.to)}
      {', '}IVR {fmtDayRange(coverage.ivr.from, coverage.ivr.to)}
      {', '}Emp detail {fmtMonthList(coverage.empDetail.months)}
      {', '}Targets {fmtMonthList(coverage.primaryTargets.months)}
      {', '}Secondary targets {fmtMonthList(coverage.secondaryTargets.months)}
      {' · '}
      {lastBatch ? (
        <>
          last upload <span className="font-medium text-foreground">{fmtStamp(lastBatch.uploadedAt)}</span>
          {lastBatch.uploadedBy.name ? ` by ${lastBatch.uploadedBy.name}` : ''}
        </>
      ) : 'nothing uploaded yet'}
    </StatusRow>
  );
}

/* ── status: the Unattributed line ────────────────────────────────────────── */

/*
 * Every reason sources.service.js resolvePeople() can put on an Unattributed
 * user, in the order it tests them. 'not-on-every-roster' is the multi-month
 * intersection and so the commonest of the seven: it fires for everybody the
 * moment the window spans months, which is most of them.
 *
 * The two that blank a whole window — 'roster-not-uploaded' (no sheet for the
 * month) and 'not-on-every-roster' (a sheet that does not list them every
 * month) — are the ones the reader can act on, and they need different actions:
 * upload a sheet, or pick a single month.
 */
const REASON_LABEL: Record<string, string> = {
  'no-user': 'No user on the job',
  'outside-window': 'Outside the date range',
  'roster-not-uploaded': 'Emp detail not uploaded for the month',
  'unknown-user': 'User not found',
  'not-internal': 'Not an internal user',
  'not-on-roster': 'Not on the month’s emp detail',
  'not-on-every-roster': 'Not on every selected month’s emp detail',
};

/* The two roster reasons, which blank the tab rather than dropping one row. */
const ROSTER_NOT_UPLOADED = 'roster-not-uploaded';
const NOT_ON_EVERY_ROSTER = 'not-on-every-roster';

/**
 * A reason as the "Why" column prints it. A reason the backend adds before this
 * map catches up degrades to its own words ('not-on-every-roster' → 'Not on
 * every roster') — readable English in a user-facing cell, never a machine slug.
 */
function reasonLabel(reason: string): string {
  const known = REASON_LABEL[reason];
  if (known) return known;
  const words = reason.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '—';
}

const UNATTRIBUTED_COLUMNS: ReadonlyArray<Column<UnattributedUser>> = [
  { key: 'name', label: 'CRM User', sticky: true, render: (r) => (r.name ? `${r.name}${r.userId != null ? ` (#${r.userId})` : ''}` : '—') },
  { key: 'reasons', label: 'Why', wrap: true, render: (r) => r.reasons.map(reasonLabel).join('; ') },
  { key: 'months', label: 'Months', render: (r) => r.months.map(fmtMonth).join(', ') },
  { key: 'closedJobs', label: 'Closed Jobs', align: 'right', render: (r) => num(r.closedJobs) },
  { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => money(r.revenue) },
  { key: 'openJobs', label: 'Open Jobs', align: 'right', render: (r) => num(r.openJobs) },
  { key: 'acoJobs', label: 'A&CO Jobs', align: 'right', render: (r) => num(r.acoJobs) },
  { key: 'acoRevenue', label: 'A&CO Revenue', align: 'right', render: (r) => money(r.acoRevenue) },
  { key: 'crmRows', label: 'CRM Rows', align: 'right', render: (r) => num(r.crmRows) },
];

function UnattributedRow({ unattributed: u }: { unattributed: LiveUnattributed }) {
  const [open, setOpen] = useState(false);
  const parts: string[] = [];
  if (u.closedJobs > 0 || u.revenue !== 0) parts.push(`${money(u.revenue)} revenue`, count(u.closedJobs, 'closed job'));
  if (u.openJobs > 0) parts.push(count(u.openJobs, 'open job'));
  if (u.acoJobs > 0) parts.push(`${count(u.acoJobs, 'A&CO job')} (${money(u.acoRevenue)})`);
  if (u.crm.rows > 0) parts.push(count(u.crm.rows, 'CRM row'));
  if (parts.length === 0) return null;
  // When a roster rule is the WHOLE story, say which one: the fix differs
  // (upload the sheet / pick a single month), and every other reason is a
  // per-row accident rather than something the reader can act on.
  const reasons = new Set(u.users.flatMap((x) => x.reasons));
  const rosterOnly = reasons.size > 0
    && [...reasons].every((r) => r === ROSTER_NOT_UPLOADED || r === NOT_ON_EVERY_ROSTER);
  const noSheet = reasons.has(ROSTER_NOT_UPLOADED);
  const notEveryMonth = reasons.has(NOT_ON_EVERY_ROSTER);
  let why = 'not counted on any employee';
  if (rosterOnly && noSheet && notEveryMonth) {
    why = 'not on any employee because emp detail is missing for some of these months and does not list them for all of the rest';
  } else if (rosterOnly && noSheet) {
    why = 'not on any employee because emp detail is not uploaded for these months';
  } else if (rosterOnly) {
    why = 'not on any employee because they are not on every selected month’s emp detail';
  }

  return (
    <div className="space-y-2">
      <StatusRow icon={<AlertTriangle className="size-4" />} tone="warn">
        <span className="font-medium">{u.label || 'Unattributed'}:</span> {parts.join(' · ')}
        {' — '}{why}
        {u.users.length > 0 && (
          <>
            {' · '}
            <button
              type="button"
              className="font-medium underline underline-offset-2 hover:no-underline"
              aria-expanded={open}
              onClick={() => setOpen((x) => !x)}
            >
              {open ? 'Hide users' : `Show ${count(u.users.length, 'user')}`}
            </button>
          </>
        )}
      </StatusRow>
      {open && (
        <LocalTable
          rows={u.users}
          columns={UNATTRIBUTED_COLUMNS}
          rowKey={(r, i) => `${r.userId ?? 'none'}-${i}`}
          emptyText="No users"
          pageSize={u.users.length > 10 ? 10 : undefined}
        />
      )}
    </div>
  );
}

/* ── the notes on who this window can name ────────────────────────────────── */

/*
 * The owner's visibility rules, explained where they bite (./visibility.ts):
 *
 *   - a month with no emp detail uploaded shows NO employee name. Nothing is
 *     invented from the CRM's job SPOCs, and no earlier month's team is
 *     inherited;
 *   - a window over several months lists only the people on EVERY one of those
 *     months' sheets.
 *
 * Both leave the job and revenue tiles complete — Unattributed keeps the work —
 * while no table names a person and the ones that belong to a person (revenue
 * against target, productivity) go empty, which without a word of explanation
 * reads as a broken report. Same NoteCard treatment, and the same grid, as the
 * upload notes below it.
 *
 * ONE NOTE, NOT TWO. A window with a sheet for some of its months and none for
 * the others trips both rules at once, and the second of them then reports the
 * whole uploaded roster as "on some months but not all" — an accusation against
 * a rule that never ran, for a blackout the missing sheet had already caused.
 * visibilityStory() picks the single true story instead, and the missing sheet
 * wins because uploading it is what brings the names back.
 *
 * The missing-sheet story is gated on gap.blank — no name listed anywhere — so
 * it never claims an emptiness the reader can see is not there. The
 * intersection story is not: people can be hidden while the rest of the team is
 * listed, and that is exactly when it needs saying.
 */
function VisibilityNotes({ gap, canUpload }: { gap: RosterGap; canUpload: boolean }) {
  const story = visibilityStory(gap);
  if (story === 'none') return null;
  // The people this window has a sheet for and still cannot name. Present only
  // in the mixed case, which is also the case the old copy got wrong.
  const kept = uploadedRosterPhrase(gap);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {story === 'missing-sheet' ? (
        <NoteCard
          icon={<Users className="size-5 shrink-0 text-warning-strong" />}
          title={kept ? 'No Employee Names For The Selected Dates' : `No Employee Names For ${fmtMonthLongList(gap.missingMonths)}`}
        >
          {kept && (
            <>
              {fmtMonthLongList(gap.missingMonths)} {gap.missingMonths.length === 1 ? 'has' : 'have'} no emp detail, and
              a window names only the people on every one of its months’ sheets — so not even {kept} can be listed.{' '}
            </>
          )}
          Upload the emp detail sheet for {kept ? fmtMonthLongList(gap.missingMonths) : missingMonthsPhrase(gap)} to
          see names{canUpload ? ' (Download Template → Upload Excel).' : '.'}{' '}
          {unattributedTilesNote(' below')}
        </NoteCard>
      ) : (
        <NoteCard
          icon={<EyeOff className="size-5 shrink-0 text-muted-foreground" />}
          title="Listed Only When On Every Month’s Emp Detail"
        >
          {hiddenPeopleNote(gap)} Pick a single month to see that month’s full team.{' '}
          {unattributedTilesNote(' below')}
        </NoteCard>
      )}
    </div>
  );
}

/* ── the note on uploads missing for the selected months ──────────────────── */

/* A daily source against the window: null when it covers it end to end (as far as min / max can tell). */
function dailyGap(label: string, c: LiveDailyCoverage, win: DateWindow): string | null {
  if (!c.from || !c.to || c.to < win.from || c.from > win.to) return `${label}: nothing uploaded for these dates`;
  const gaps: string[] = [];
  if (c.from > win.from) gaps.push(`starts ${fmtDay(c.from)}`);
  if (c.to < win.to) gaps.push(`only up to ${fmtDay(c.to)}`);
  return gaps.length ? `${label}: ${gaps.join(', ')}` : null;
}

function MissingUploadsNote({ meta, canUpload }: { meta: LiveMeta; canUpload: boolean }) {
  const { storage, coverage, hidden } = meta.uploads;
  const win = { from: meta.from, to: meta.to };

  if (storage === 'missing' || !coverage) {
    return (
      <NoteCard icon={<Info className="size-5 shrink-0 text-info-strong" />} title="Excel Uploads Are Not Set Up Yet">
        Job and CRM numbers are live and complete. Targets, teams, TimeChamp and IVR figures need the upload storage,
        which is not set up on this server yet.
      </NoteCard>
    );
  }

  const lines: string[] = [];
  for (const m of meta.months) {
    const missing: string[] = [];
    if (!m.rosterUploaded) missing.push('emp detail');
    if (!coverage.primaryTargets.months.includes(m.month)) missing.push('target list');
    if (!coverage.secondaryTargets.months.includes(m.month)) missing.push('Secondary spoc target list');
    if (missing.length) lines.push(`${fmtMonth(m.month)}: ${missing.join(', ')}`);
  }
  for (const gap of [dailyGap('time champ data', coverage.timechamp, win), dailyGap('ivr data record', coverage.ivr, win)]) {
    if (gap) lines.push(gap);
  }

  const hiddenLines = ([
    ['time champ data', hidden.timechamp],
    ['ivr data record', hidden.ivr],
    ['target list', hidden.primaryTargets],
    ['Secondary spoc target list', hidden.secondaryTargets],
  ] as const)
    .filter(([, h]) => h.rows > 0)
    .map(([label, h]) => ({
      text: `${label}: ${count(h.rows, 'row')} for ${num(h.names.length)} ${h.names.length === 1 ? 'person' : 'people'}`,
      names: h.names.join(', '),
    }));

  if (lines.length === 0 && hiddenLines.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {lines.length > 0 && (
        <NoteCard
          icon={<FileSpreadsheet className="size-5 shrink-0 text-warning-strong" />}
          title="Uploads Missing For The Selected Dates"
        >
          <ul className="list-disc space-y-0.5 pl-4">
            {lines.map((l) => <li key={l}>{l}</li>)}
          </ul>
          <p className="mt-1">
            Job and CRM numbers are live and complete; targets, teams and productivity fill in once these are uploaded
            {canUpload ? ' (Download Template → Upload Excel).' : '.'}
          </p>
        </NoteCard>
      )}
      {hiddenLines.length > 0 && (
        <NoteCard
          icon={<EyeOff className="size-5 shrink-0 text-muted-foreground" />}
          title="Hidden Until Added To Emp Detail"
        >
          <ul className="list-disc space-y-0.5 pl-4">
            {hiddenLines.map((h) => <li key={h.text} title={h.names}>{h.text}</li>)}
          </ul>
          <p className="mt-1">
            These uploaded rows are saved, but the people are not on that month’s emp detail, so they are not counted.
          </p>
        </NoteCard>
      )}
    </div>
  );
}

function NoteCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4 text-sm">
        <span className="mt-0.5" aria-hidden>{icon}</span>
        <div className="min-w-0 text-muted-foreground">
          <div className="font-medium text-foreground">{title}</div>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}
