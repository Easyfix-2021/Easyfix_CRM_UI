'use client';

/*
 * QuickSight — Offer Acceptance report.
 *
 * How the job-offer pool converts: per technician, how many offers they were
 * extended and how many they accepted / rejected / let expire, plus acceptance
 * rate and average response time, with a by-source breakdown (Top-10 list vs
 * manual Search vs auto-assign) and an "Offered By" (job owner) breakdown.
 * Sourced from tbl_job_offer via POST /admin/quicksight/offer-acceptance/summary.
 * Gated by ef-QuickSight (family) + isQuickSightOfferAcceptanceView (per-report).
 *
 * Filters: the shared client/vertical/service-category bar, an "Offered By"
 * (job owner) multi-select, the offered_at cohort window (Offered From/To), and
 * a responded_at window (Responded From/To) — the acceptance date the tech
 * actually accepted/rejected. "Offered By" = job owner because tbl_job_offer has
 * no offered-by user column; the job owner is the closest attribution.
 */

import { useCallback, useMemo, useState } from 'react';
import { Handshake, CheckCircle2, XCircle, Clock, Hourglass, Timer, Percent } from 'lucide-react';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { usePostFetch } from '@/lib/hooks';
import { useLookup } from '@/lib/use-lookup';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QuickSightFilterBar } from '@/components/quicksight/QuickSightFilterBar';
import { ChartCard, QsBarChart, QsDonut, QsKpiTile, QS_COLORS, QS_SEMANTIC } from '@/components/quicksight/charts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';

const ACTION_KEY = 'isQuickSightOfferAcceptanceView';
const API_BASE = '/admin/quicksight/offer-acceptance';

type OfferRow = {
  efrId: number; efrName: string;
  offered: number; accepted: number; rejected: number; expired: number; open: number;
  acceptanceRate: number; avgResponseSecs: number | null;
};
type SourceRow = {
  source: string;
  offered: number; accepted: number; rejected: number; expired: number; open: number;
  acceptanceRate: number;
};
type OwnerRow = {
  ownerId: number; ownerName: string;
  offered: number; accepted: number; rejected: number; expired: number; open: number;
  acceptanceRate: number;
};
type Totals = {
  offered: number; accepted: number; rejected: number; expired: number; open: number;
  acceptanceRate: number; avgResponseSecs: number | null;
};
type DayRow = {
  day: string; // 'YYYY-MM-DD'
  offered: number; accepted: number; rejected: number; expired: number; open: number;
};
type OfferAcceptanceData = { rows: OfferRow[]; bySource: SourceRow[]; byOwner: OwnerRow[]; byDay: DayRow[]; totals: Totals };

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
const emptyFilter: FilterBody = { clientId: [], verticalId: [], serviceCategoryId: [], offeredById: [] };

function toNums(v: Array<string | number>): number[] {
  return v.map((x) => (typeof x === 'number' ? x : Number(x))).filter((n) => Number.isFinite(n));
}

export default function OfferAcceptancePage() {
  const { me } = useMe();
  const canView = actionFlags(me, [ACTION_KEY])[ACTION_KEY];
  const lookup = useLookup();
  // "Offered By" (job owner) picker superset = internal admin users, reusing the
  // existing auth-gated /shared/lookup/users list (same source the Priority Jobs
  // "Job Owner" filter uses) — no new BE lookup introduced.
  const ownerOpts = lookup.toOpts.adminUsers;

  // Draft (user edits) vs applied (live query). Clients/verticals/categories come
  // from the shared filter bar; offered-by + date ranges + source are report-specific.
  const [clientId, setClientId] = useState<number[]>([]);
  const [verticalId, setVerticalId] = useState<number[]>([]);
  const [serviceCategoryId, setServiceCategoryId] = useState<number[]>([]);
  const [offeredById, setOfferedById] = useState<number[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [respondedFrom, setRespondedFrom] = useState('');
  const [respondedTo, setRespondedTo] = useState('');
  const [source, setSource] = useState<Source>('');
  const [applied, setApplied] = useState<FilterBody>(emptyFilter);

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
  const totals = data?.totals;
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
    setDateFrom(''); setDateTo(''); setRespondedFrom(''); setRespondedTo(''); setSource('');
    setApplied(emptyFilter);
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
                placeholder="All Job Owners"
                selectedLabel="owners"
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

      {/* Per-technician table */}
      <div className="overflow-x-auto rounded-md border border-border mt-4">
        <table className="data-table">
          <thead>
            <tr>
              <th className="!text-left">Technician</th>
              <th className="!text-center">Offered</th>
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
                <td className="!text-left font-medium">
                  {r.efrName} <span className="text-[10px] text-muted-foreground">#{r.efrId}</span>
                </td>
                <td className="!text-center">{r.offered}</td>
                <td className="!text-center text-emerald-700">{r.accepted}</td>
                <td className="!text-center text-rose-700">{r.rejected}</td>
                <td className="!text-center text-amber-700">{r.expired}</td>
                <td className="!text-center">{r.open}</td>
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

      {/* Per-owner (Offered By) breakdown — offers grouped by the job owner. */}
      {byOwner.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Acceptance By Offered By</h3>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="!text-left">Offered By</th>
                  <th className="!text-center">Offered</th>
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
                    <td className="!text-left font-medium">{o.ownerName}</td>
                    <td className="!text-center">{o.offered}</td>
                    <td className="!text-center text-emerald-700">{o.accepted}</td>
                    <td className="!text-center text-rose-700">{o.rejected}</td>
                    <td className="!text-center text-amber-700">{o.expired}</td>
                    <td className="!text-center">{o.open}</td>
                    <td className="!text-center font-medium">{o.acceptanceRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </ReportPageScaffold>
  );
}
