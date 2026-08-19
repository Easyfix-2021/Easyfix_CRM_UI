'use client';

/*
 * QuickSight — Premature Confirmations.
 *
 * Jobs pushed from Unconfirmed to Pending for Scheduling without the customer
 * ever confirming: no magic-link form submission (or an Unreachable outcome),
 * AND no real phone contact — zero calls, or every call under the short-call
 * threshold. Those should have been HELD in Unconfirmed via the Unreachable
 * flow; scheduling them sends a technician to an appointment nobody agreed to.
 *
 * Sourced from POST /admin/quicksight/premature-confirmations/summary. Gated by
 * ef-QuickSight (family) + isQuickSightPrematureConfirmationsView (per-report).
 *
 * ⚠ THIS REPORT NAMES INDIVIDUAL OPERATORS. Every row is a judgement about a
 * colleague's work, so the UI is deliberately built to support CHECKING rather
 * than accusing: each row spells out why it was flagged, shows the attribution
 * confidence, and lets you play the actual short calls before drawing a
 * conclusion. See `PlayCall` below.
 */

import { useCallback, useMemo, useState } from 'react';
import { ShieldAlert, PhoneOff, PhoneMissed, FileX, Play, Loader2 } from 'lucide-react';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { usePostFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { showToast } from '@/components/ui/toast';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QuickSightFilterBar } from '@/components/quicksight/QuickSightFilterBar';
import { SortHeader, useSort } from '@/lib/use-sort';
import { QsKpiTile } from '@/components/quicksight/charts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const ACTION_KEY = 'isQuickSightPrematureConfirmationsView';
const API_BASE = '/admin/quicksight/premature-confirmations';

type Row = {
  job_id: number;
  job_reference_id: string | null;
  client_ref_id: string | null;
  moved_at: string | null;
  customer_submitted_at: string | null;
  unreachable_at: string | null;
  client_name: string | null;
  city_name: string | null;
  customer_name: string | null;
  customer_mob_no: string | null;
  moved_by: string | null;
  moved_by_id: number | null;
  /* 'confirmed' = the stamped user IS the confirmer; 'creator' = the name may
     predate the confirmation. Surfaced so the report never quietly misattributes. */
  moved_by_confidence: 'confirmed' | 'creator';
  call_count: number;
  max_duration: number;
  short_calls: number;
  /* Calls that CONNECTED but ran under the threshold — the ones worth hearing. */
  short_call_ids: number[];
  flags: string[];
};
type Totals = {
  jobs: number; noCalls: number; shortCallsOnly: number;
  notSubmitted: number; unreachable: number; shortCallThresholdSecs: number;
};
type Data = { rows: Row[]; byUser: { moved_by_id: number | null; moved_by: string; jobs: number }[]; totals: Totals };

type FilterBody = {
  clientId: number[]; verticalId: number[]; serviceCategoryId: number[]; cityId: number[];
  dateFrom?: string; dateTo?: string;
};
const emptyFilter: FilterBody = { clientId: [], verticalId: [], serviceCategoryId: [], cityId: [] };
const toNums = (v: (string | number)[]) => v.map(Number).filter(Boolean);

function fmt(dt: string | null): string {
  if (!dt) return '—';
  const d = new Date(String(dt).replace(' ', 'T'));
  if (Number.isNaN(+d)) return String(dt);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

/*
 * Inline playback for one short call.
 *
 * Reuses the EXISTING GET /admin/calls/:id/recording presigned-URL endpoint —
 * the same one Call Analytics uses — rather than introducing a second audio
 * path. That keeps the recording's own access gate in force and means this
 * report gains nothing it isn't already allowed to hear.
 *
 * The URL is fetched ON CLICK, never eagerly: a page of 200 rows would
 * otherwise mint hundreds of presigned URLs nobody listens to.
 */
function PlayCall({ callId }: { callId: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (url) {
    // eslint-disable-next-line jsx-a11y/media-has-caption -- call recording; no captions exist
    return <audio src={url} controls preload="none" className="h-7 w-44 align-middle" />;
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy}
      className="h-7 px-2 text-xs"
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api.get<{ url: string }>(`/admin/calls/${callId}/recording`);
          if (r?.url) setUrl(r.url);
          else showToast({ variant: 'warning', message: 'No recording stored for this call.' });
        } catch {
          showToast({ variant: 'error', message: 'Could not load that recording.' });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
      <span className="ml-1">Play</span>
    </Button>
  );
}

export default function PrematureConfirmationsPage() {
  const { me } = useMe();
  const canView = actionFlags(me, [ACTION_KEY])[ACTION_KEY];

  const [clientId, setClientId] = useState<number[]>([]);
  const [verticalId, setVerticalId] = useState<number[]>([]);
  const [serviceCategoryId, setServiceCategoryId] = useState<number[]>([]);
  const [cityId, setCityId] = useState<number[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [applied, setApplied] = useState<FilterBody>(emptyFilter);

  const buildDraft = useCallback((): FilterBody => {
    const body: FilterBody = { clientId, verticalId, serviceCategoryId, cityId };
    if (dateFrom) body.dateFrom = dateFrom;
    if (dateTo) body.dateTo = dateTo;
    return body;
  }, [clientId, verticalId, serviceCategoryId, cityId, dateFrom, dateTo]);

  const summary = usePostFetch<Data>(canView ? `${API_BASE}/summary` : null, applied, { enabled: canView });
  const data = summary.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  /*
   * Client-side sort over the fully-loaded page (the endpoint returns the whole
   * flagged set, capped at `limit`). `useSort` gives the 3-click cycle for free —
   * asc → desc → unsorted, restoring the server's newest-first order on the
   * third click. `flags` and `short_call_ids` are arrays with no natural order,
   * so those two columns stay unsortable rather than sorting by something
   * meaningless like array length.
   */
  const { sorted, sortKey, sortDir, toggle } = useSort<Row>(rows);
  const totals = data?.totals;
  const accessDenied = canView === false || summary.status === 403;
  const isEmpty = !summary.loading && !summary.error && rows.length === 0;

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
      a.href = url; a.download = 'premature-confirmations.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch {
      /* busy state clears; page chrome stays quiet */
    } finally {
      setDownloading(false);
    }
  }, [applied]);

  function reset() {
    setClientId([]); setVerticalId([]); setServiceCategoryId([]); setCityId([]);
    setDateFrom(''); setDateTo('');
    setApplied(emptyFilter);
  }

  return (
    <ReportPageScaffold
      title="Premature Confirmations"
      subtitle="Jobs moved to Pending for Scheduling without the customer confirming — no form submission and no real call."
      icon={ShieldAlert}
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
              <label className="text-xs font-medium text-muted-foreground">Moved From</label>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} disabled={summary.loading} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Moved To</label>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} disabled={summary.loading} />
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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <QsKpiTile label="Flagged Jobs" value={totals.jobs} icon={<ShieldAlert className="h-4 w-4" />} />
          <QsKpiTile label="No Calls At All" value={totals.noCalls} icon={<PhoneOff className="h-4 w-4" />} />
          <QsKpiTile label={`Calls Under ${totals.shortCallThresholdSecs}s Only`} value={totals.shortCallsOnly} icon={<PhoneMissed className="h-4 w-4" />} />
          <QsKpiTile label="Form Not Submitted" value={totals.notSubmitted} icon={<FileX className="h-4 w-4" />} />
        </div>
      )}

      {/* Per-operator roll-up — the "who" the report exists to answer. */}
      {!!data?.byUser?.length && (
        <div className="rounded-md border bg-card p-3">
          <div className="mb-2 text-sm font-semibold">Moved By</div>
          <div className="flex flex-wrap gap-2">
            {data.byUser.map((u) => (
              <span key={String(u.moved_by_id)} className="inline-flex items-center gap-1.5 rounded-full border bg-ink-50 px-2.5 py-1 text-xs">
                {u.moved_by}
                <span className="rounded-full bg-urgent-tint px-1.5 py-0.5 font-semibold text-urgent-strong">{u.jobs}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="data-table w-full text-sm">
          <thead>
            <tr>
              <SortHeader col={'job_id' as keyof Row} sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Job</SortHeader>
              <SortHeader col={'client_name' as keyof Row} sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Client / City</SortHeader>
              <SortHeader col={'customer_name' as keyof Row} sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Customer</SortHeader>
              <SortHeader col={'moved_by' as keyof Row} sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Moved By</SortHeader>
              <SortHeader col={'moved_at' as keyof Row} sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Moved On</SortHeader>
              <SortHeader col={'call_count' as keyof Row} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Calls</SortHeader>
              <SortHeader col={'max_duration' as keyof Row} align="center" sortBy={sortKey} sortDir={sortDir} onSort={toggle}>Longest</SortHeader>
              {/* Non-scalar columns: no natural sort order. */}
              <th className="!text-left">Why Flagged</th>
              <th className="!text-left">Recording</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.job_id}>
                <td className="!text-left font-mono">
                  #{r.job_id}
                  {r.job_reference_id && <div className="text-xs text-muted-foreground">{r.job_reference_id}</div>}
                </td>
                <td className="!text-left">
                  {r.client_name || '—'}
                  <div className="text-xs text-muted-foreground">{r.city_name || '—'}</div>
                </td>
                <td className="!text-left">
                  {r.customer_name || '—'}
                  <div className="text-xs text-muted-foreground">{r.customer_mob_no || '—'}</div>
                </td>
                <td className="!text-left">
                  {r.moved_by || 'Unknown'}
                  {/* Attribution honesty — see the service header. A 'creator'
                      row means the name predates the confirmation and may not be
                      the person who moved it. */}
                  {r.moved_by_confidence === 'creator' && (
                    <div className="text-xs text-warning-strong" title="This name is the job's original creator — the confirming operator was not separately recorded.">
                      may not be the confirmer
                    </div>
                  )}
                </td>
                <td className="!text-left whitespace-nowrap">{fmt(r.moved_at)}</td>
                <td className="!text-center tabular-nums">{r.call_count}</td>
                <td className="!text-center tabular-nums">{r.call_count ? `${r.max_duration}s` : '—'}</td>
                <td className="!text-left">
                  <div className="flex flex-wrap gap-1">
                    {r.flags.map((f) => (
                      <span key={f} className="rounded-full bg-urgent-tint px-1.5 py-0.5 text-xs font-medium text-urgent-strong">{f}</span>
                    ))}
                  </div>
                </td>
                <td className="!text-left">
                  {/* Only rows with a CONNECTED short call have anything to hear.
                      Zero-duration rings leave no recording, so offering a
                      button there would just fail. */}
                  {r.short_call_ids.length
                    ? <div className="flex flex-col gap-1">{r.short_call_ids.slice(0, 3).map((id) => <PlayCall key={id} callId={id} />)}</div>
                    : <span className="text-xs text-muted-foreground">{r.call_count ? 'No connected call' : '—'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ReportPageScaffold>
  );
}
