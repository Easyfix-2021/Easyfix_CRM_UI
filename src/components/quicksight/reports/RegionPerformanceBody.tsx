'use client';

/*
 * QuickSight — STATE / USER Performance scorecard body.
 *
 * ONE component, two dimensions (`dimension` prop), because they are the same
 * table over a different GROUP BY — exactly as the backend shares one service
 * and one route for both. Metrics, periods and SDA/TAT definitions are identical
 * to City Performance (the backend imports them from that service, so they can
 * never drift).
 *
 * Rendered inside the Performance Report page's tabs. Each dimension carries its
 * OWN action key, so a user granted State but not User sees only the State tab.
 *
 * The USER dimension's rows can overlap — two users managing the same region
 * each count that region's jobs in full — so the API returns a `note` and this
 * component renders it ABOVE the table. Do not drop it: without it the column
 * totals look inflated for no visible reason.
 */

import { useCallback, useMemo, useState } from 'react';
import { MapPin, UserCog } from 'lucide-react';

import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFetch, useFetchOnce } from '@/lib/hooks';
import { downloadXlsx } from '@/lib/download-xlsx';
import { showToast } from '@/components/ui/toast';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { QuickSightFilterBar } from '@/components/quicksight/QuickSightFilterBar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type SearchOption } from '@/components/ui/search-select';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { TablePagination, pageSizeToLimit, type TablePageSize } from '@/components/ui/table-pagination';
import { RegionPerformanceCharts } from '@/components/quicksight/reports/RegionPerformanceCharts';

export type RegionDimension = 'state' | 'user';

const ACTION_KEY: Record<RegionDimension, string> = {
  state: 'isQuickSightStatePerformanceView',
  user: 'isQuickSightUserPerformanceView',
};
const API_BASE: Record<RegionDimension, string> = {
  state: '/admin/quicksight/state-performance',
  user: '/admin/quicksight/user-performance',
};
// Matches the route's Joi pageSize.max — pass it to pageSizeToLimit so "All"
// sends 200 rather than the hook default (which the endpoint would reject).
const PAGE_SIZE_MAX = 200;

type Flag = 'monthly' | 'weekly';
type Bucket = {
  detailsFor: string; startDate: string; endDate: string;
  tktCreated: number; openOrders: number; processJobs: number;
  // Raw SDA/TAT numerators + denominators — the charts recompute page-level
  // percentages from these rather than averaging the per-row ones.
  sdaCount: number; tatCount: number; completedOrders: number;
  sdaPercentage: number | null; tatPercentage: number | null;
};
type Row = {
  stateId?: number | null; stateName?: string;
  userId?: number | null; userName?: string;
  regionCount?: number | null; allRegions?: boolean;
  periods: Bucket[];
};
type Payload = {
  data: Row[]; page: number; pageSize: number; totalRecords: number; totalPages: number;
  /** USER dimension only — the overlapping-regions caveat. */
  note?: string;
};
type ManagerLite = { user_id: number; user_name: string };

const pct = (v: number | null) => (v == null ? '—' : `${v}%`);

export function RegionPerformanceBody({ dimension }: { dimension: RegionDimension }) {
  const { me } = useMe();
  const actionKey = ACTION_KEY[dimension];
  const canView = actionFlags(me, [actionKey])[actionKey];
  const isUser = dimension === 'user';

  const [flag, setFlag] = useState<Flag>('monthly');
  const [clients, setClients] = useState<Array<string | number>>([]);
  const [verticals, setVerticals] = useState<Array<string | number>>([]);
  const [serviceCategories, setServiceCategories] = useState<Array<string | number>>([]);
  const [zonalManagers, setZonalManagers] = useState<Array<string | number>>([]);
  const [states, setStates] = useState<Array<string | number>>([]);
  const [page, setPage] = useState(0); // 0-indexed (TablePagination convention)
  const [pageSize, setPageSize] = useState<TablePageSize>(10);
  const [downloading, setDownloading] = useState(false);

  // Same lookup wiring as City Performance: Zonal Managers scoped to the picked
  // clients/verticals, States static.
  const zonalManagerKey = useMemo(() => {
    const qs = new URLSearchParams();
    clients.forEach((v) => qs.append('clientId', String(v)));
    verticals.forEach((v) => qs.append('verticalId', String(v)));
    const s = qs.toString();
    return s ? `/shared/lookup/zonal-managers?${s}` : '/shared/lookup/zonal-managers';
  }, [clients, verticals]);
  const zonalRes = useFetch<ManagerLite[]>(zonalManagerKey);
  const stateRes = useFetchOnce<Array<{ state_id: number; state_name: string }>>('/shared/lookup/states');

  const zonalManagerOptions = useMemo<SearchOption[]>(
    () => (zonalRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [zonalRes.data],
  );
  const stateOptions = useMemo<SearchOption[]>(
    () => (stateRes.data ?? []).map((s) => ({ value: s.state_id, label: s.state_name })),
    [stateRes.data],
  );

  const limit = pageSizeToLimit(pageSize, PAGE_SIZE_MAX);

  const query = useMemo(() => {
    const qs = new URLSearchParams();
    qs.set('flag', flag);
    qs.set('page', String(page + 1));
    qs.set('pageSize', String(limit));
    clients.forEach((v) => qs.append('clientId', String(v)));
    verticals.forEach((v) => qs.append('verticalId', String(v)));
    serviceCategories.forEach((v) => qs.append('serviceCategoryId', String(v)));
    zonalManagers.forEach((v) => qs.append('zonalManagerId', String(v)));
    states.forEach((v) => qs.append('stateId', String(v)));
    return qs.toString();
  }, [flag, page, limit, clients, verticals, serviceCategories, zonalManagers, states]);

  const key = canView ? `${API_BASE[dimension]}?${query}` : null;
  const { data, loading, error } = useFetch<Payload>(key);

  const rows = data?.data ?? [];
  // Period labels come from the first row's buckets — every row carries the same
  // three periods, so there is no separate "columns" call to keep in sync.
  const periodLabels = rows[0]?.periods?.map((p) => p.detailsFor) ?? [];
  const isEmpty = !loading && !error && data != null && data.totalRecords === 0;

  const onDownload = useCallback(async () => {
    setDownloading(true);
    try {
      await downloadXlsx({
        url: `${API_BASE[dimension]}?${query}&format=xlsx`,
        filename: `${dimension}-performance-${flag}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
    } catch {
      showToast({ variant: 'error', message: 'Could not download the report. Please retry.' });
    } finally {
      setDownloading(false);
    }
  }, [dimension, query, flag]);

  return (
    <ReportPageScaffold
      title={isUser ? 'User Performance' : 'State Performance'}
      subtitle={isUser
        ? 'Tickets, SDA % and TAT % for the regions each user manages'
        : 'Tickets, SDA % and TAT % by state'}
      icon={isUser ? UserCog : MapPin}
      loading={loading}
      error={error ? String(error) : null}
      accessDenied={canView === false}
      isEmpty={isEmpty}
      onDownload={onDownload}
      downloading={downloading}
      filters={(
        <div className="space-y-2">
          <QuickSightFilterBar
            show={{ clients: true, verticals: true, serviceCategories: true, zonalManagers: true }}
            clients={clients}
            onClientsChange={(v) => { setClients(v); setPage(0); }}
            verticals={verticals}
            onVerticalsChange={(v) => { setVerticals(v); setPage(0); }}
            serviceCategories={serviceCategories}
            onServiceCategoriesChange={(v) => { setServiceCategories(v); setPage(0); }}
            zonalManagers={zonalManagers}
            onZonalManagersChange={(v) => { setZonalManagers(v); setPage(0); }}
            zonalManagerOptions={zonalManagerOptions}
          />
          <div className="max-w-xs space-y-1">
            <label className="text-xs font-medium text-muted-foreground">States</label>
            <SearchMultiSelect
              value={states}
              onChange={(v) => { setStates(v); setPage(0); }}
              options={stateOptions}
              placeholder="All States"
            />
          </div>
        </div>
      )}
    >
      {/* Monthly / Weekly — the shared Radix strip, matching the other
          performance reports (the GLIDING tabs are the outer report switcher). */}
      <Tabs value={flag} onValueChange={(v) => { setFlag(v as Flag); setPage(0); }}>
        <TabsList>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
          <TabsTrigger value="weekly">Weekly</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* The overlapping-regions caveat, straight from the API so the wording
          lives with the numbers. USER dimension only. */}
      {data?.note && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-semibold">How to read this: </span>{data.note}
        </p>
      )}

      {rows.length > 0 && (
        <div className="mt-4">
          <RegionPerformanceCharts rows={rows} dimension={dimension} />
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-md border border-border">
        <table className="data-table">
          <thead>
            <tr>
              <th className="!text-left" rowSpan={2}>{isUser ? 'User' : 'State'}</th>
              {isUser && (
                <th className="!text-center" rowSpan={2} title="How many regions (states) this user manages. 'All' = every region.">Regions</th>
              )}
              {periodLabels.map((label) => (
                <th key={label} className="!text-center" colSpan={4}>{label}</th>
              ))}
            </tr>
            <tr>
              {periodLabels.map((label) => [
                <th key={`${label}-tkt`} className="!text-center">Tickets</th>,
                <th key={`${label}-sda`} className="!text-center" title="Same-Day-Attendance: checked in on or before the original appointment date">SDA %</th>,
                <th key={`${label}-tat`} className="!text-center" title="Turn-Around-Time within the SLA for the city tier + service category">TAT %</th>,
                <th key={`${label}-open`} className="!text-center">Open</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={isUser ? `u${r.userId}` : `s${r.stateId}`}>
                <td className="!text-left font-medium whitespace-nowrap">
                  {isUser ? (r.userName || '—') : (r.stateName || '—')}
                </td>
                {isUser && (
                  <td className="!text-center">{r.allRegions ? 'All' : (r.regionCount ?? '—')}</td>
                )}
                {r.periods.map((p) => [
                  <td key={`${p.detailsFor}-tkt`} className="!text-center">{p.tktCreated}</td>,
                  <td key={`${p.detailsFor}-sda`} className="!text-center">{pct(p.sdaPercentage)}</td>,
                  <td key={`${p.detailsFor}-tat`} className="!text-center">{pct(p.tatPercentage)}</td>,
                  <td key={`${p.detailsFor}-open`} className="!text-center">{p.openOrders}</td>,
                ])}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <TablePagination
        page={page}
        pageSize={pageSize}
        total={data?.totalRecords ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
      />
    </ReportPageScaffold>
  );
}
