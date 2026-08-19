'use client';

/*
 * QuickSight — Offer Acceptance report.
 *
 * How the job-offer pool converts: per technician, how many offers they were
 * extended and how many they accepted / rejected / let expire, plus acceptance
 * rate and average response time, with a by-source breakdown (Top-10 list vs
 * manual Search vs auto-assign) and an "Offered By" (who made the offer) breakdown.
 * Sourced from tbl_job_offer via POST /admin/quicksight/offer-acceptance/summary.
 * Gated by ef-QuickSight (family) + isQuickSightOfferAcceptanceView (per-report).
 *
 * Filters: the shared client/vertical/service-category bar, an "Offered By"
 * multi-select, the offered_at cohort window (Offered From/To), and a
 * responded_at window (Responded From/To) — the acceptance date the tech
 * actually accepted/rejected. "Offered By" = the user who made the offer
 * (tbl_job_offer.offered_by_user_id); NULL (auto / pre-migration offers) shows
 * as "Unassigned".
 */

import { useCallback, useMemo, useState } from 'react';
import { Handshake, CheckCircle2, XCircle, Clock, Hourglass, Timer, Percent } from 'lucide-react';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { usePostFetch, useFetch } from '@/lib/hooks';
import { useLookup } from '@/lib/use-lookup';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QuickSightFilterBar } from '@/components/quicksight/QuickSightFilterBar';
import { ChartCard, QsBarChart, QsDonut, QsKpiTile, QS_COLORS, QS_SEMANTIC } from '@/components/quicksight/charts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { GlidingTabs } from '@/components/ui/gliding-tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { StatusChip } from '@/components/ui/StatusChip';
import { formatDate, statusLabel, statusTone } from '@/lib/utils';
import { JobRefLink } from '@/components/job/JobRefLink';
import { JobModalHost } from '@/components/job/JobModalHost';

const ACTION_KEY = 'isQuickSightOfferAcceptanceView';
const API_BASE = '/admin/quicksight/offer-acceptance';

/*
 * THREE different "how many offers" numbers, deliberately named apart because
 * tbl_job_offer keeps ONE row per (job, technician) and a re-offer UPDATEs that
 * row (offer_count + 1) rather than inserting:
 *
 *   offered   COUNT(*)                     — how many were offered
 *   reoffers  SUM(offer_count) − COUNT(*)  — how many of those were REPEAT offers
 *   waves     COUNT(DISTINCT offered_at)   — how many times ops pressed "Offer"
 *             (per job only; shown as "Rounds" — 5 techs in round 1 + 3 more in
 *             round 2 = 2)
 *
 * `rounds` on the wire is the raw SUM(offer_count) that `reoffers` derives from;
 * it is never rendered directly, so "Rounds" on screen always means waves.
 */
type OfferRow = {
  efrId: number; efrName: string;
  offered: number; rounds: number; reoffers: number; accepted: number; rejected: number; expired: number; open: number;
  acceptanceRate: number; avgResponseSecs: number | null;
};
type SourceRow = {
  source: string;
  offered: number; rounds: number; reoffers: number; accepted: number; rejected: number; expired: number; open: number;
  acceptanceRate: number;
};
type OwnerRow = {
  ownerId: number; ownerName: string;
  offered: number; rounds: number; reoffers: number; accepted: number; rejected: number; expired: number; open: number;
  acceptanceRate: number;
};
type JobOfferer = { ownerId: number; ownerName: string; offers: number; rounds: number };
type JobRow = {
  jobId: number; clientName: string | null; jobStatus: number | null;
  /** Whether the JOB has a tech assigned — drives the BOOKED sub-label split. */
  assigned: boolean;
  techsOffered: number;
  /** Offer WAVES — how many times ops pressed "Offer" for this job. */
  waves: number;
  offered: number; rounds: number; reoffers: number; accepted: number; rejected: number; expired: number; open: number;
  acceptanceRate: number;
  acceptedBy: string | null;
  firstOfferedAt: string | null; lastOfferedAt: string | null; acceptedAt: string | null;
  timeToAcceptSecs: number | null;
  offerers: JobOfferer[];
};
type Totals = {
  offered: number; rounds: number; reoffers: number; accepted: number; rejected: number; expired: number; open: number;
  acceptanceRate: number; avgResponseSecs: number | null;
};
type DayRow = {
  day: string; // 'YYYY-MM-DD'
  offered: number; accepted: number; rejected: number; expired: number; open: number;
};
type OfferAcceptanceData = { rows: OfferRow[]; bySource: SourceRow[]; byOwner: OwnerRow[]; byJob: JobRow[]; byDay: DayRow[]; totals: Totals };

/*
 * The three groupings share ONE API response, so switching tabs is instant —
 * no refetch, no spinner. Only the table below the charts swaps.
 */
type BreakdownTab = 'technician' | 'offerer' | 'job';

type Source = 'top10' | 'search' | 'auto' | '';
type FilterBody = {
  clientId: number[]; verticalId: number[]; serviceCategoryId: number[]; offeredById: number[];
  dateFrom?: string; dateTo?: string; respondedFrom?: string; respondedTo?: string; source?: Exclude<Source, ''>;
};

// 'unknown' = offer_source was never recorded (auto-assign, an offer made
// without a source, or a pre-source-tracking row) — labelled "Untracked" so
// operators read it as "origin not captured", not a mystery bucket.
const SOURCE_LABEL: Record<string, string> = { top10: 'Top-10', search: 'Search', auto: 'Auto', unknown: 'Untracked' };
// Avg response as m:ss (h:mm:ss past an hour) from a seconds value. '—' when
// there were no genuine responses (accepts/rejects) to average — e.g. every
// offer expired, which is NOT a response.
const fmtDuration = (secs: number | null) => {
  if (secs == null) return '—';
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
};
// 'YYYY-MM-DD' -> short axis label like "3 Jul" (built from parts, no Date/TZ math).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDayLabel = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1] ?? ''}`;
};
/*
 * Timestamp as TWO non-breaking lines: date on the first, time on the second.
 * A single string in a narrow column wraps wherever it likes ("29 Jul / 2026, /
 * 02:58 / pm" — four lines and unreadable). Splitting it makes the break point
 * OURS, and `whitespace-nowrap` on each half guarantees neither is ever broken
 * mid-value; the table scrolls horizontally instead.
 */
function DateTimeCell({ value, seconds }: { value: string | null; seconds?: boolean }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const d = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return <span className="whitespace-nowrap">{String(value)}</span>;
  const opts = { timeZone: 'Asia/Kolkata' } as const;
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', ...opts });
  const time = d.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), ...opts,
  });
  return (
    <span className="inline-block">
      <span className="block whitespace-nowrap">{date}</span>
      <span className="block whitespace-nowrap text-muted-foreground">{time}</span>
    </span>
  );
}

const emptyFilter: FilterBody = { clientId: [], verticalId: [], serviceCategoryId: [], offeredById: [] };

function toNums(v: Array<string | number>): number[] {
  return v.map((x) => (typeof x === 'number' ? x : Number(x))).filter((n) => Number.isFinite(n));
}

export default function OfferAcceptancePage() {
  const { me } = useMe();
  const canView = actionFlags(me, [ACTION_KEY])[ACTION_KEY];
  const lookup = useLookup();
  // "Offered By" picker superset = internal admin users (the people who make
  // offers via Schedule & Assign), reusing the existing auth-gated
  // /shared/lookup/users list — no new BE lookup introduced.
  const ownerOpts = lookup.toOpts.adminUsers;

  // Default the OFFERED-date filter to TODAY (IST). en-CA in Asia/Kolkata yields
  // 'YYYY-MM-DD', matching the filter's date format + the BE's IST day compare.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

  // Draft (user edits) vs applied (live query). Clients/verticals/categories come
  // from the shared filter bar; offered-by + date ranges + source are report-specific.
  const [clientId, setClientId] = useState<number[]>([]);
  const [verticalId, setVerticalId] = useState<number[]>([]);
  const [serviceCategoryId, setServiceCategoryId] = useState<number[]>([]);
  const [offeredById, setOfferedById] = useState<number[]>([]);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [respondedFrom, setRespondedFrom] = useState('');
  const [respondedTo, setRespondedTo] = useState('');
  const [source, setSource] = useState<Source>('');
  // Seed the live query with today's offered-date range so the report loads
  // scoped to TODAY by default (not the full offer history).
  const [applied, setApplied] = useState<FilterBody>({ ...emptyFilter, dateFrom: today, dateTo: today });

  const buildDraft = useCallback((): FilterBody => {
    const body: FilterBody = { clientId, verticalId, serviceCategoryId, offeredById };
    if (dateFrom) body.dateFrom = dateFrom;
    if (dateTo) body.dateTo = dateTo;
    if (respondedFrom) body.respondedFrom = respondedFrom;
    if (respondedTo) body.respondedTo = respondedTo;
    if (source) body.source = source;
    return body;
  }, [clientId, verticalId, serviceCategoryId, offeredById, dateFrom, dateTo, respondedFrom, respondedTo, source]);

  const summary = usePostFetch<OfferAcceptanceData>(
    canView ? `${API_BASE}/summary` : null,
    applied,
    { enabled: canView },
  );

  const data = summary.data;
  const rows = data?.rows ?? [];
  const byOwner = data?.byOwner ?? [];
  const byJob = data?.byJob ?? [];
  const totals = data?.totals;
  // Which breakdown the table below the charts is showing. Purely client-side —
  // all three grains ride on the one summary response.
  const [tab, setTab] = useState<BreakdownTab>('technician');
  // Count drill-down: which CELL was clicked — the dimension (job / technician /
  // offerer), its label for the dialog title, and which outcome.
  const [drill, setDrill] = useState<Drill | null>(null);

  const accessDenied = canView === false || summary.status === 403;
  const isEmpty = !summary.loading && !summary.error && rows.length === 0;

  // Daily outcome trend — one stacked bar per day (gap-filled server-side, so the
  // axis is a continuous window even on days with no offers).
  const trendChart = useMemo(
    () => (data?.byDay ?? []).map((d) => ({
      day: fmtDayLabel(d.day),
      Accepted: d.accepted, Rejected: d.rejected, Expired: d.expired, Open: d.open,
    })),
    [data?.byDay],
  );
  const offersDonut = useMemo(
    () => (data?.bySource ?? []).map((s) => ({ name: SOURCE_LABEL[s.source] ?? s.source, value: s.offered })),
    [data?.bySource],
  );

  const [downloading, setDownloading] = useState(false);
  const onDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const base = process.env.NEXT_PUBLIC_API_URL || '/api';
      const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
      const resp = await fetch(`${base}${API_BASE}/summary`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ ...applied, format: 'xlsx' }),
        cache: 'no-store',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'offer-acceptance.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch {
      /* busy state simply clears; keep the page chrome quiet */
    } finally {
      setDownloading(false);
    }
  }, [applied]);

  function reset() {
    setClientId([]); setVerticalId([]); setServiceCategoryId([]); setOfferedById([]);
    // Reset returns the offered-date filter to its default (today), not blank.
    setDateFrom(today); setDateTo(today); setRespondedFrom(''); setRespondedTo(''); setSource('');
    setApplied({ ...emptyFilter, dateFrom: today, dateTo: today });
  }

  return (
    <ReportPageScaffold
      title="Offer Acceptance"
      subtitle="How the job-offer pool converts — acceptance, rejection & response time by technician and source."
      icon={Handshake}
      loading={summary.loading}
      error={summary.status === 403 ? null : summary.error}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={onDownload}
      downloading={downloading}
      filters={
        <div className="space-y-3">
          <QuickSightFilterBar
            show={{ clients: true, verticals: true, serviceCategories: true }}
            clients={clientId}
            onClientsChange={(v) => setClientId(toNums(v))}
            verticals={verticalId}
            onVerticalsChange={(v) => setVerticalId(toNums(v))}
            serviceCategories={serviceCategoryId}
            onServiceCategoriesChange={(v) => setServiceCategoryId(toNums(v))}
            disabled={summary.loading}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Offered By</label>
              <SearchMultiSelect
                value={offeredById}
                onChange={(v) => setOfferedById(toNums(v))}
                options={ownerOpts}
                placeholder="All Users"
                selectedLabel="users"
                disabled={summary.loading}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Offered From</label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} disabled={summary.loading} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Offered To</label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} disabled={summary.loading} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Responded From</label>
              <Input type="date" value={respondedFrom} onChange={(e) => setRespondedFrom(e.target.value)} disabled={summary.loading} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Responded To</label>
              <Input type="date" value={respondedTo} onChange={(e) => setRespondedTo(e.target.value)} disabled={summary.loading} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Offer Source</label>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as Source)}
                disabled={summary.loading}
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">All Sources</option>
                <option value="top10">Top-10</option>
                <option value="search">Search</option>
                <option value="auto">Auto</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setApplied(buildDraft())} disabled={summary.loading}>Filter</Button>
            <Button variant="outline" onClick={reset} disabled={summary.loading}>Reset</Button>
          </div>
        </div>
      }
    >
      {/* KPI tiles */}
      {totals && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <QsKpiTile label="Total Offered" value={totals.offered.toLocaleString()} accent={QS_COLORS[0]} icon={<Handshake className="size-5" />} />
          <QsKpiTile label="Accepted" value={totals.accepted.toLocaleString()} accent={QS_SEMANTIC.good} icon={<CheckCircle2 className="size-5" />} />
          <QsKpiTile label="Acceptance Rate" value={`${totals.acceptanceRate}%`} accent={QS_SEMANTIC.good} icon={<Percent className="size-5" />} />
          <QsKpiTile label="Avg Response (m:ss)" value={fmtDuration(totals.avgResponseSecs)} accent={QS_COLORS[4]} icon={<Timer className="size-5" />} />
          <QsKpiTile label="Rejected" value={totals.rejected.toLocaleString()} accent={QS_SEMANTIC.bad} icon={<XCircle className="size-5" />} />
          <QsKpiTile label="Expired" value={totals.expired.toLocaleString()} accent={QS_SEMANTIC.warn} icon={<Hourglass className="size-5" />} />
          <QsKpiTile label="Still Open" value={totals.open.toLocaleString()} accent={QS_SEMANTIC.info} icon={<Clock className="size-5" />} />
        </div>
      )}

      {/* Trend + source charts */}
      {(trendChart.length > 0 || offersDonut.length > 0) && (
        <div className="mt-4 space-y-2">
          <div className="grid gap-4 md:grid-cols-2">
            <ChartCard
              title="Offer Outcomes — Daily"
              subtitle="Accepted / Rejected / Expired / Open per day (last 7 days, or the selected range)"
            >
              <QsBarChart
                data={trendChart}
                xKey="day"
                stacked
                series={[
                  { key: 'Accepted', color: QS_SEMANTIC.good },
                  { key: 'Rejected', color: QS_SEMANTIC.bad },
                  { key: 'Expired', color: QS_SEMANTIC.warn },
                  { key: 'Open', color: QS_SEMANTIC.info },
                ]}
                height={300}
              />
            </ChartCard>
            <ChartCard title="Offers By Source" subtitle="Share of offers made from each source">
              <QsDonut data={offersDonut} nameKey="name" valueKey="value" height={300} />
            </ChartCard>
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Untracked</span> = offer origin not recorded (auto-assigned,
            offered without a source, or made before source-tracking). New offers made from the Top-10
            list or Search results are tagged automatically.
          </p>
        </div>
      )}

      {/*
        * Breakdown tabs — the SAME offer set sliced three ways: who was offered
        * (Technician), who did the offering (Offerer), and how hard each job had
        * to be worked (Job). One response feeds all three, so switching is
        * instant. Counts on the chips are row counts, not offer counts.
        */}
      <div className="mt-4">
        <GlidingTabs
          ariaLabel="Offer breakdown"
          value={tab}
          onChange={(v) => setTab(v as BreakdownTab)}
          tabs={[
            { value: 'technician', label: 'Technician', count: rows.length },
            { value: 'offerer',    label: 'Offerer',    count: byOwner.length },
            { value: 'job',        label: 'Job',        count: byJob.length },
          ]}
        />
      </div>

      {/* Per-technician table */}
      {tab === 'technician' && (
      <div className="overflow-x-auto rounded-md border border-border mt-4">
        <table className="data-table">
          <thead>
            <tr>
              <th className="!text-left">Technician</th>
              <th className="!text-center">Offered</th>
              <th className="!text-center" title="How many of these were REPEAT offers — the same job offered to the same technician again">Re-Offers</th>
              <th className="!text-center">Accepted</th>
              <th className="!text-center">Rejected</th>
              <th className="!text-center">Expired</th>
              <th className="!text-center">Open</th>
              <th className="!text-center">Acceptance %</th>
              <th className="!text-center">Avg Response (m:ss)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.efrId}>
                <td className="!text-left font-medium whitespace-nowrap">
                  {r.efrName} <span className="text-xs text-muted-foreground">#{r.efrId}</span>
                </td>
                <td className="!text-center">
                  <CountLink n={r.offered} onClick={() => setDrill({ efrId: r.efrId, label: r.efrName, status: 'all' })} />
                </td>
                <td className="!text-center">{r.reoffers}</td>
                <td className="!text-center">
                  <CountLink n={r.accepted} tone="text-success-strong" onClick={() => setDrill({ efrId: r.efrId, label: r.efrName, status: 'accepted' })} />
                </td>
                <td className="!text-center">
                  <CountLink n={r.rejected} tone="text-urgent-strong" onClick={() => setDrill({ efrId: r.efrId, label: r.efrName, status: 'rejected' })} />
                </td>
                <td className="!text-center">
                  <CountLink n={r.expired} tone="text-warning-strong" onClick={() => setDrill({ efrId: r.efrId, label: r.efrName, status: 'expired' })} />
                </td>
                <td className="!text-center">
                  <CountLink n={r.open} onClick={() => setDrill({ efrId: r.efrId, label: r.efrName, status: 'open' })} />
                </td>
                <td className="!text-center font-medium">{r.acceptanceRate}%</td>
                <td className="!text-center">{fmtDuration(r.avgResponseSecs)}</td>
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr className="bg-muted/60 font-semibold">
                <td className="!text-left">Total</td>
                <td className="!text-center">{totals.offered}</td>
                <td className="!text-center">{totals.reoffers}</td>
                <td className="!text-center">{totals.accepted}</td>
                <td className="!text-center">{totals.rejected}</td>
                <td className="!text-center">{totals.expired}</td>
                <td className="!text-center">{totals.open}</td>
                <td className="!text-center">{totals.acceptanceRate}%</td>
                <td className="!text-center">{fmtDuration(totals.avgResponseSecs)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      )}

      {/* Acceptance By Offerer — offers grouped by the user who MADE the offer.
          The column header follows the tab/section name; the FILTER above keeps
          its "Offered By" label (it reads as a verb phrase there). */}
      {tab === 'offerer' && (
        <div className="overflow-x-auto rounded-md border border-border mt-4">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-left">Offerer</th>
                <th className="!text-center">Offered</th>
                <th className="!text-center" title="How many of these were REPEAT offers — the same job offered to the same technician again">Re-Offers</th>
                <th className="!text-center">Accepted</th>
                <th className="!text-center">Rejected</th>
                <th className="!text-center">Expired</th>
                <th className="!text-center">Open</th>
                <th className="!text-center">Acceptance %</th>
              </tr>
            </thead>
            <tbody>
              {byOwner.map((o) => (
                <tr key={o.ownerId}>
                  <td className="!text-left font-medium whitespace-nowrap">{o.ownerName}</td>
                  <td className="!text-center">
                    <CountLink n={o.offered} onClick={() => setDrill({ offererId: o.ownerId, label: o.ownerName, status: 'all' })} />
                  </td>
                  <td className="!text-center">{o.reoffers}</td>
                  <td className="!text-center">
                    <CountLink n={o.accepted} tone="text-success-strong" onClick={() => setDrill({ offererId: o.ownerId, label: o.ownerName, status: 'accepted' })} />
                  </td>
                  <td className="!text-center">
                    <CountLink n={o.rejected} tone="text-urgent-strong" onClick={() => setDrill({ offererId: o.ownerId, label: o.ownerName, status: 'rejected' })} />
                  </td>
                  <td className="!text-center">
                    <CountLink n={o.expired} tone="text-warning-strong" onClick={() => setDrill({ offererId: o.ownerId, label: o.ownerName, status: 'expired' })} />
                  </td>
                  <td className="!text-center">
                    <CountLink n={o.open} onClick={() => setDrill({ offererId: o.ownerId, label: o.ownerName, status: 'open' })} />
                  </td>
                  <td className="!text-center font-medium">{o.acceptanceRate}%</td>
                </tr>
              ))}
              {byOwner.length === 0 && (
                <tr><td colSpan={8} className="!text-center text-muted-foreground py-6">No Offers In This Window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/*
        * Per-JOB breakdown — how hard each job had to be worked. "Offerers"
        * collapses the (job × offerer) grain into one cell (`Meena (5)`), so a
        * job stays ONE scannable row while still answering "who offered this,
        * and how many times". Sorted by Offer Rounds desc server-side: the jobs
        * that took the most work float to the top, which is the reason to open
        * this tab at all.
        */}
      {tab === 'job' && (
        <>
          <div className="overflow-x-auto rounded-md border border-border mt-4">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!text-left">Job #</th>
                <th className="!text-left">Client</th>
                {/* "Job Status", not "Status" — this row also carries OFFER
                    outcomes (Accepted / Rejected / Expired / Open), so a bare
                    "Status" reads as if it described the offer. */}
                <th className="!text-center" title="Where the JOB is now — distinct from the offer outcomes in the columns to the right">Job Status</th>
                <th className="!text-center" title="Distinct technicians this job was offered to — click a count to see who">Techs Offered</th>
                {/* Honest about the derivation: Rounds is inferred from distinct
                    offer timestamps, so it under-counts in exactly one case —
                    a round that re-offers EVERY technician from the previous
                    one overwrites their timestamps and the two merge. */}
                <th className="!text-center" title="Offer WAVES — how many times ops pressed Offer for this job (5 techs in round 1 + 3 more in round 2 = 2). Approximate: counted from distinct offer timestamps, so a round that re-offers every technician from the previous round merges into one.">Rounds*</th>
                <th className="!text-center">Accepted</th>
                <th className="!text-center">Rejected</th>
                <th className="!text-center">Expired</th>
                <th className="!text-center">Open</th>
                <th className="!text-left">Offerers</th>
                <th className="!text-left" title="The TECHNICIAN who accepted the offer. The job itself may since have moved on (checked in, completed) — Status shows where the job is now, this shows who took it.">Accepted By (Tech)</th>
                <th className="!text-center">First Offered</th>
                {/* Named "Time To Fill", not "Time To Accept": it is measured
                    from the job's FIRST offer, so on a job that took two rounds
                    it is longer than the accepting technician's own response
                    time (which is what the drill-down shows). Two different
                    questions — the label has to pick one and say so. */}
                <th className="!text-center" title="From the job's FIRST offer to the moment a technician accepted — how long the job took to fill. NOT the accepting technician's own response time: open the Techs Offered count to see each technician's own offer and response.">Time To Fill</th>
              </tr>
            </thead>
            <tbody>
              {byJob.map((j) => (
                <tr key={j.jobId}>
                  <td className="!text-left font-medium">
                    {/* Opens the JobModal in place (JobModalHost below) — closing
                        returns here, not to Manage Jobs. Link stays shareable. */}
                    <JobRefLink jobId={j.jobId} />
                  </td>
                  <td className="!text-left whitespace-nowrap" title={j.clientName ?? ''}>
                    {j.clientName ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-center">
                    {j.jobStatus == null
                      ? <span className="text-muted-foreground">—</span>
                      : <StatusChip tone={statusTone(j.jobStatus)}>{statusLabel(j.jobStatus, { assigned: j.assigned })}</StatusChip>}
                  </td>
                  <td className="!text-center">
                    <CountLink n={j.techsOffered} onClick={() => setDrill({ jobId: j.jobId, label: `Job #${j.jobId}`, status: 'all' })} />
                  </td>
                  <td className="!text-center font-medium">{j.waves}</td>
                  <td className="!text-center">
                    <CountLink n={j.accepted} tone="text-success-strong" onClick={() => setDrill({ jobId: j.jobId, label: `Job #${j.jobId}`, status: 'accepted' })} />
                  </td>
                  <td className="!text-center">
                    <CountLink n={j.rejected} tone="text-urgent-strong" onClick={() => setDrill({ jobId: j.jobId, label: `Job #${j.jobId}`, status: 'rejected' })} />
                  </td>
                  <td className="!text-center">
                    <CountLink n={j.expired} tone="text-warning-strong" onClick={() => setDrill({ jobId: j.jobId, label: `Job #${j.jobId}`, status: 'expired' })} />
                  </td>
                  <td className="!text-center">
                    <CountLink n={j.open} onClick={() => setDrill({ jobId: j.jobId, label: `Job #${j.jobId}`, status: 'open' })} />
                  </td>
                  {/* One offerer per LINE. A comma-joined string wrapped mid-name
                      ("Priyanka / Agarwal (4), / Harkirpa / Kaur (1)"), so each
                      entry is its own nowrap block instead. */}
                  <td className="!text-left text-xs">
                    {j.offerers.length === 0
                      ? <span className="text-muted-foreground">—</span>
                      : j.offerers.map((o) => (
                        <span key={o.ownerId} className="block whitespace-nowrap">
                          {o.ownerName} ({o.rounds})
                        </span>
                      ))}
                  </td>
                  <td className="!text-left whitespace-nowrap">
                    {j.acceptedBy ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="!text-center text-xs">
                    <DateTimeCell value={j.firstOfferedAt} />
                  </td>
                  <td className="!text-center">{fmtDuration(j.timeToAcceptSecs)}</td>
                </tr>
              ))}
              {byJob.length === 0 && (
                <tr><td colSpan={13} className="!text-center text-muted-foreground py-6">No Offers In This Window.</td></tr>
              )}
            </tbody>
          </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            <span className="font-medium">* Rounds</span> counts the distinct times this job was
            offered, derived from the offer timestamps. It is exact when each round went to
            different technicians; a round that re-offered <em>every</em> technician from the
            previous round overwrites their timestamps and reads as a single round.
          </p>
        </>
      )}
      <OfferDrilldownDialog drill={drill} filters={applied} onClose={() => setDrill(null)} />

      {/* Hosts the in-place job workspace for every <JobRefLink> on this page. */}
      <JobModalHost />
    </ReportPageScaffold>
  );
}

/*
 * A count rendered as a button when there is something to show. Zero stays
 * plain text — a clickable 0 that opens an empty list is a dead end.
 */
function CountLink({ n, tone, onClick }: { n: number; tone?: string; onClick: () => void }) {
  if (!n) return <span className={tone}>{n}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`underline decoration-dotted underline-offset-2 hover:decoration-solid ${tone ?? ''}`}
      title="Show the technicians behind this number"
    >
      {n}
    </button>
  );
}

/*
 * Drill-down — the individual offers behind a clicked count, on ANY tab.
 *
 * Posts to the report's own /offers endpoint with the SAME filters as the
 * summary plus the clicked cell, so the rows returned are exactly the ones that
 * produced the number. That filter fidelity is the reason this does NOT reuse
 * GET /admin/jobs/:id/offers — that endpoint answers "every offer on this job,
 * ever", which would show rows outside the report's window and make the count
 * look wrong.
 *
 * Fetch-on-click rather than inlining details in the summary: the report
 * returns up to 5000 rows, and shipping every row's offer list would multiply
 * the payload by the pool size for data almost none of which is opened.
 */
type DrillStatus = 'all' | 'accepted' | 'rejected' | 'expired' | 'open';
type Drill = {
  jobId?: number; efrId?: number; offererId?: number;
  /** Row identity for the dialog title — tech name, offerer name, or "Job #N". */
  label: string;
  status: DrillStatus;
};
type OfferDetail = {
  jobId: number; clientName: string | null; jobStatus: number | null;
  /** Job-level tech presence — same BOOKED sub-label split as the report/modal. */
  assigned: boolean;
  efrId: number; efrName: string | null;
  offererName: string;
  offerStatus: number;
  offeredAt: string | null; respondedAt: string | null;
  offerCount: number;
  /** This technician's own response time (offer → answer). NULL for expired /
   *  still-open offers, where responded_at is the sweep time, not an answer. */
  responseSecs: number | null;
  source: string | null; rejectReason: string | null;
};
// tbl_job_offer.offer_status — mirrors services/offer-status.js.
const OFFER_STATUS_LABEL: Record<number, string> = { 0: 'Offered', 1: 'Accepted', 2: 'Rejected', 3: 'Expired' };
const DRILL_TITLE: Record<DrillStatus, string> = {
  all: 'All Offers', open: 'Open Offers', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired',
};

function OfferDrilldownDialog({ drill, filters, onClose }: {
  drill: Drill | null;
  filters: FilterBody;
  onClose: () => void;
}) {
  /*
   * The POST body IS the cache key for usePostFetch, so it must be stable —
   * an inline object literal would refetch on every render. Null while the
   * dialog is shut so nothing is requested until it opens.
   */
  const body = useMemo(() => ({
    ...filters,
    jobId: drill?.jobId,
    efrId: drill?.efrId,
    selectedOffererId: drill?.offererId,
    status: drill && drill.status !== 'all' ? drill.status : undefined,
  }), [drill, filters]);

  const detail = usePostFetch<{ items: OfferDetail[]; capped: boolean }>(
    drill ? `${API_BASE}/offers` : null,
    body,
    { enabled: drill != null },
  );
  const items = detail.data?.items ?? null;

  /*
   * Read-only dialog → isDirty:false so the shared guard closes immediately
   * instead of asking "discard changes?" on a panel with no input. Routed
   * through the guard anyway — that is the project-wide <Dialog> contract.
   */
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: false });

  return (
    <Dialog open={drill != null} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{drill ? `${DRILL_TITLE[drill.status]} · ${drill.label}` : ''}</DialogTitle>
        </DialogHeader>
        {detail.error && <p className="text-sm text-urgent-strong">{String(detail.error)}</p>}
        {!detail.error && items === null && (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        )}
        {!detail.error && items !== null && (
          <>
            {detail.data?.capped && (
              <p className="mb-2 text-xs text-warning-strong">
                Showing the 500 most recent offers — narrow the filters to see the rest.
              </p>
            )}
            <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="!text-left">Job #</th>
                    <th className="!text-left">Client</th>
                    <th className="!text-center">Job Status</th>
                    <th className="!text-left">Technician</th>
                    <th className="!text-left">Offerer</th>
                    <th className="!text-center">Outcome</th>
                    <th className="!text-center" title="Times this technician was offered THIS job">Times Offered</th>
                    <th className="!text-center">Offered At</th>
                    <th className="!text-center">Responded At</th>
                    {/* The number that answers "was this tech slow?" — distinct
                        from the job-level Time To Fill in the report table. */}
                    <th className="!text-center" title="This technician's own response time (their offer → their answer). Blank for expired or still-open offers: an expired offer's Responded At is the expiry sweep, not a reply.">Response</th>
                    <th className="!text-left">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((o) => (
                    <tr key={`${o.jobId}-${o.efrId}`}>
                      <td className="!text-left font-medium">
                        {/* Close this drill-down first, then open the job in
                            place — one modal at a time (beforeOpen). */}
                        <JobRefLink jobId={o.jobId} beforeOpen={onClose} />
                      </td>
                      <td className="!text-left whitespace-nowrap" title={o.clientName ?? ''}>
                        {o.clientName ?? <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="!text-center">
                        {o.jobStatus == null
                          ? <span className="text-muted-foreground">—</span>
                          : <StatusChip tone={statusTone(o.jobStatus)}>{statusLabel(o.jobStatus, { assigned: o.assigned })}</StatusChip>}
                      </td>
                      <td className="!text-left whitespace-nowrap">
                        {o.efrName || `Efr #${o.efrId}`}{' '}
                        <span className="text-xs text-muted-foreground">#{o.efrId}</span>
                      </td>
                      <td className="!text-left whitespace-nowrap">{o.offererName}</td>
                      <td className="!text-center">{OFFER_STATUS_LABEL[o.offerStatus] ?? o.offerStatus}</td>
                      <td className="!text-center">{o.offerCount}</td>
                      <td className="!text-center text-xs"><DateTimeCell value={o.offeredAt} seconds /></td>
                      <td className="!text-center text-xs"><DateTimeCell value={o.respondedAt} seconds /></td>
                      <td className="!text-center">{fmtDuration(o.responseSecs)}</td>
                      {/* Reason is the ONE column that should wrap — it is a
                          sentence, not an identifier. min-w keeps it from being
                          squeezed to one word per line. */}
                      <td className="!text-left text-xs min-w-[14rem] whitespace-normal break-words">
                        {o.rejectReason || <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                  {items.length === 0 && (
                    <tr><td colSpan={11} className="!text-center text-muted-foreground py-6">No Offers In This Bucket.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
