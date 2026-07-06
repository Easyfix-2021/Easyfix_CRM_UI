'use client';

/*
 * QuickSight — Profile Update Requests report.
 *
 * The easyfixer profile-update magic-link funnel: per technician who was sent a
 * link, whether they SUBMITTED it (inferred from a technician-authored
 * serviceable-pincodes write on/after the send), plus send-count, last-action
 * and days-to-submit. Sourced from POST /admin/quicksight/profile-update-requests/summary.
 * Gated by ef-QuickSight (family) + isQuickSightProfileUpdateRequestsView.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { UserPen, CheckCircle2, Clock, Hourglass, Send, Percent, CalendarClock } from 'lucide-react';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { usePostFetch, useFetch } from '@/lib/hooks';
import type { SearchOption } from '@/components/ui/search-select';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QuickSightFilterBar } from '@/components/quicksight/QuickSightFilterBar';
import { ChartCard, QsBarChart, QsDonut, QsKpiTile, QS_COLORS, QS_SEMANTIC } from '@/components/quicksight/charts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const ACTION_KEY = 'isQuickSightProfileUpdateRequestsView';
const API_BASE = '/admin/quicksight/profile-update-requests';

type Row = {
  efrId: number; efrName: string; efrMobile: string | null; cityName: string | null;
  sentAt: string | null; sendCount: number; lastAction: string | null;
  submitted: boolean; submittedAt: string | null; daysToSubmit: number | null; status: string;
};
type Totals = {
  requests: number; submitted: number; pending: number; expired: number;
  totalSends: number; submissionRate: number; avgDaysToSubmit: number | null;
};
type ByStatus = { submitted: number; pending: number; expired: number };
type DayRow = { day: string; sent: number; submitted: number };
type ReportData = { rows: Row[]; byStatus: ByStatus; byDay: DayRow[]; totals: Totals };

type ManagerLite = { user_id: number; user_name: string };
type Status = 'submitted' | 'pending' | 'expired' | '';
type LastAction = 'first' | 'reminder' | 'resend' | '';
type FilterBody = {
  zonalManagerId: number[];
  dateFrom?: string; dateTo?: string;
  submittedStatus?: Exclude<Status, ''>;
  lastAction?: Exclude<LastAction, ''>;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDayLabel = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1] ?? ''}`;
};
const fmtDt = (dt: string | null) => (dt ? String(dt).replace('T', ' ').replace('Z', '').slice(0, 16) : '—');
const titleCase = (s: string | null) => (s ? s.replace(/\b\w/g, (m) => m.toUpperCase()) : '—');
const STATUS_TONE: Record<string, string> = { Submitted: 'text-emerald-700', Pending: 'text-amber-700', Expired: 'text-rose-700' };
const emptyFilter: FilterBody = { zonalManagerId: [] };

function toNums(v: Array<string | number>): number[] {
  return v.map((x) => (typeof x === 'number' ? x : Number(x))).filter((n) => Number.isFinite(n));
}

export default function ProfileUpdateRequestsPage() {
  const { me } = useMe();
  const canView = actionFlags(me, [ACTION_KEY])[ACTION_KEY];

  const [zonalManagers, setZonalManagers] = useState<number[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [status, setStatus] = useState<Status>('');
  const [lastAction, setLastAction] = useState<LastAction>('');
  const [applied, setApplied] = useState<FilterBody>(emptyFilter);

  const zonalRes = useFetch<ManagerLite[]>(canView ? '/shared/lookup/zonal-managers' : null);
  const zonalManagerOptions = useMemo<SearchOption[]>(
    () => (zonalRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [zonalRes.data],
  );
  useEffect(() => {
    if (!zonalRes.data) return;
    const valid = new Set(zonalManagerOptions.map((o) => Number(o.value)));
    setZonalManagers((prev) => {
      const next = prev.filter((v) => valid.has(Number(v)));
      return next.length === prev.length ? prev : next;
    });
  }, [zonalManagerOptions, zonalRes.data]);

  const buildDraft = useCallback((): FilterBody => {
    const body: FilterBody = { zonalManagerId: zonalManagers };
    if (dateFrom) body.dateFrom = dateFrom;
    if (dateTo) body.dateTo = dateTo;
    if (status) body.submittedStatus = status;
    if (lastAction) body.lastAction = lastAction;
    return body;
  }, [zonalManagers, dateFrom, dateTo, status, lastAction]);

  const summary = usePostFetch<ReportData>(
    canView ? `${API_BASE}/summary` : null,
    applied,
    { enabled: canView },
  );

  const data = summary.data;
  const rows = data?.rows ?? [];
  const totals = data?.totals;
  const accessDenied = canView === false || summary.status === 403;
  const isEmpty = !summary.loading && !summary.error && rows.length === 0;

  const trendChart = useMemo(
    () => (data?.byDay ?? []).map((d) => ({ day: fmtDayLabel(d.day), Sent: d.sent, Submitted: d.submitted })),
    [data?.byDay],
  );
  const statusDonut = useMemo(
    () => (data ? [
      { name: 'Submitted', value: data.byStatus.submitted },
      { name: 'Pending', value: data.byStatus.pending },
      { name: 'Expired', value: data.byStatus.expired },
    ] : []),
    [data],
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
      a.href = url; a.download = 'profile-update-requests.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch {
      /* busy state clears; keep chrome quiet */
    } finally {
      setDownloading(false);
    }
  }, [applied]);

  function reset() {
    setZonalManagers([]); setDateFrom(''); setDateTo(''); setStatus(''); setLastAction('');
    setApplied(emptyFilter);
  }

  return (
    <ReportPageScaffold
      title="Profile Update Requests"
      subtitle="Easyfixer profile-update link funnel — sent vs submitted, by technician."
      icon={UserPen}
      loading={summary.loading}
      error={summary.status === 403 ? null : summary.error}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={onDownload}
      downloading={downloading}
      filters={
        <div className="space-y-3">
          <QuickSightFilterBar
            show={{ zonalManagers: true }}
            zonalManagers={zonalManagers}
            onZonalManagersChange={(v) => setZonalManagers(toNums(v))}
            zonalManagerOptions={zonalManagerOptions}
            disabled={summary.loading}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Sent From</label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} disabled={summary.loading} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Sent To</label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} disabled={summary.loading} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as Status)}
                disabled={summary.loading}
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">All</option>
                <option value="submitted">Submitted</option>
                <option value="pending">Pending</option>
                <option value="expired">Expired</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Last Action</label>
              <select
                value={lastAction}
                onChange={(e) => setLastAction(e.target.value as LastAction)}
                disabled={summary.loading}
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">All</option>
                <option value="first">First</option>
                <option value="reminder">Reminder</option>
                <option value="resend">Resend</option>
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
      {totals && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <QsKpiTile label="Requests (Sent)" value={totals.requests.toLocaleString()} accent={QS_COLORS[0]} icon={<Send className="size-5" />} />
          <QsKpiTile label="Submitted" value={totals.submitted.toLocaleString()} accent={QS_SEMANTIC.good} icon={<CheckCircle2 className="size-5" />} />
          <QsKpiTile label="Submission Rate" value={`${totals.submissionRate}%`} accent={QS_SEMANTIC.good} icon={<Percent className="size-5" />} />
          <QsKpiTile label="Pending" value={totals.pending.toLocaleString()} accent={QS_SEMANTIC.warn} icon={<Clock className="size-5" />} />
          <QsKpiTile label="Expired" value={totals.expired.toLocaleString()} accent={QS_SEMANTIC.bad} icon={<Hourglass className="size-5" />} />
          <QsKpiTile label="Avg Days To Submit" value={totals.avgDaysToSubmit != null ? String(totals.avgDaysToSubmit) : '—'} accent={QS_COLORS[4]} icon={<CalendarClock className="size-5" />} />
        </div>
      )}

      {(trendChart.length > 0 || statusDonut.some((s) => s.value > 0)) && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <ChartCard title="Links Sent vs Submitted — Daily" subtitle="Sent and inferred-submitted per day (by send date)">
            <QsBarChart
              data={trendChart}
              xKey="day"
              series={[
                { key: 'Sent', color: QS_COLORS[0] },
                { key: 'Submitted', color: QS_SEMANTIC.good },
              ]}
              height={300}
            />
          </ChartCard>
          <ChartCard title="Requests By Status" subtitle="Submitted / Pending / Expired share">
            <QsDonut data={statusDonut} nameKey="name" valueKey="value" height={300} />
          </ChartCard>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        <span className="font-medium">Submitted</span> is inferred — the technician saved deep skills +
        serviceable pincodes via the link (a serviceable-pincodes row authored by the technician on/after
        the send). <span className="font-medium">Expired</span> = un-submitted more than 30 days after the
        last send.
      </p>

      <div className="overflow-x-auto rounded-md border border-border mt-3">
        <table className="data-table">
          <thead>
            <tr>
              <th className="!text-left">Technician</th>
              <th className="!text-left">City</th>
              <th className="!text-left">Link Sent At</th>
              <th className="!text-center">Send Count</th>
              <th className="!text-left">Last Action</th>
              <th className="!text-left">Status</th>
              <th className="!text-left">Submitted At</th>
              <th className="!text-center">Days To Submit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.efrId}>
                <td className="!text-left font-medium">
                  {r.efrName} <span className="text-[10px] text-muted-foreground">#{r.efrId}</span>
                </td>
                <td className="!text-left">{r.cityName || '—'}</td>
                <td className="!text-left whitespace-nowrap">{fmtDt(r.sentAt)}</td>
                <td className="!text-center">{r.sendCount}</td>
                <td className="!text-left">{titleCase(r.lastAction)}</td>
                <td className={`!text-left font-medium ${STATUS_TONE[r.status] ?? ''}`}>{r.status}</td>
                <td className="!text-left whitespace-nowrap">{fmtDt(r.submittedAt)}</td>
                <td className="!text-center">{r.daysToSubmit == null ? '—' : r.daysToSubmit}</td>
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr className="bg-muted/60 font-semibold">
                <td className="!text-left">Total · {totals.requests}</td>
                <td className="!text-left" />
                <td className="!text-left" />
                <td className="!text-center">{totals.totalSends}</td>
                <td className="!text-left" />
                <td className="!text-left">{totals.submitted} Submitted</td>
                <td className="!text-left" />
                <td className="!text-center">{totals.avgDaysToSubmit ?? '—'}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </ReportPageScaffold>
  );
}
