'use client';

/*
 * QuickSight — Technician Performance (monthly / weekly).
 *
 * Native rebuild of the legacy Angular `txperformance` report. Paginated over
 * technicians; each row carries 3 period column-blocks of 4 metrics each
 * (Tickets Assigned · SDA% · TAT% · Open Order In App), with fixed left columns
 * State · City · Name & Id (link → category drill-down modal) · C.B & At
 * (current balance + today/tomorrow attendance chips).
 *
 * Conventions honoured:
 *   - Fetches ONLY via useFetch keyed on the serialized filter/flag/page state
 *     (mandatory fetch-hooks rule — no raw useEffect+api.get).
 *   - ReportPageScaffold for the header band + the four mutually-exclusive
 *     states.
 *   - DownloadButton wired to the BE ?format=xlsx endpoint via downloadXlsx,
 *     guarded by the legacy ≥1-of-(state/client/city/zonal) filter rule.
 *   - Page gated on actionFlags(me, [ef-QuickSight, actionKey]); a 403 from the
 *     endpoint surfaces the scaffold's accessDenied panel.
 *   - Client ⇄ Reporting Manager mutual exclusivity enforced client-side.
 *   - Monthly/Weekly toggle persisted to sessionStorage 'selectedTab'.
 *   - Title Case labels; .data-table density; numeric columns right-aligned.
 */

import { useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SearchMultiSelect } from '@/components/ui/search-multi-select';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { showToast } from '@/components/ui/toast';
import { useFetch, useFetchOnce } from '@/lib/hooks';
import { useLookup } from '@/lib/use-lookup';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { TechnicianCategoryModal } from './TechnicianCategoryModal';
import { TechnicianPerformanceCharts } from './TechnicianPerformanceCharts';

const FAMILY_KEY = 'ef-QuickSight';
const ACTION_KEY = 'isQuickSightTechnicianPerformanceView';
const STORAGE_KEY = 'selectedTab';
// BE Joi caps pageSize at 100 — map the "All" sentinel to that cap.
const BE_PAGE_SIZE_MAX = 100;

type Flag = 'monthly' | 'weekly';
type FilterValue = Array<string | number>;

type PeriodDateWise = {
  txTktCreated: number;
  txOpenOrder: number;
  txSdaPercentage: number | null;
  txTatPercentage: number | null;
  txCancelOrder: number;
  txSdaCount: number;
  txCompletedOrder: number;
  workedOrder: number;
  detailsFor: string;
  startDate: string;
  endDate: string;
};

type TechnicianRow = {
  txId: number | null;
  txName: string;
  txCity: string;
  stateName: string;
  txStatus: '0' | '1';
  txCurrentBalance: number;
  txTodayAttendance: string;
  txTomAttendance: string;
  technicianPerformanceDataDateWise: PeriodDateWise[];
};

type TechnicianPerfPayload = {
  data: TechnicianRow[];
  page: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
};

type ManagerLite = { user_id: number; user_name: string };

const METRIC_HEADERS = ['Tickets Assigned', 'SDA%', 'TAT%', 'Open Order In App'] as const;

/* Date-only formatter for weekly period headers; monthly labels pass through. */
function fmtDateOnly(iso: string): string {
  const d = new Date(`${iso}T00:00:00+05:30`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
}

function periodHeader(p: PeriodDateWise, flag: Flag): string {
  if (flag === 'monthly') return p.detailsFor;
  return `${fmtDateOnly(p.startDate)} - ${fmtDateOnly(p.endDate)}`;
}

/* '-' when null, else 'N%'; green when >=85 else red (legacy colour rule). */
function pctCell(v: number | null) {
  if (v == null) return <span className="text-muted-foreground">-</span>;
  const ok = v >= 85;
  return <span className={ok ? 'text-success font-medium' : 'text-urgent font-medium'}>{v}%</span>;
}

/* One attendance chip — green when present ('P'), neutral/red otherwise. */
function AttChip({ label, status }: { label: string; status: string }) {
  const present = status === 'P';
  return (
    <span
      title={`${label}: ${status}`}
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded px-1 text-xs font-semibold',
        present ? 'bg-success-tint text-success-strong' : 'bg-urgent-tint text-urgent-strong',
      )}
    >
      {status}
    </span>
  );
}

/* Build the query string shared by the JSON fetch + the xlsx download. */
function buildQuery(
  flag: Flag,
  page: number,
  pageSize: number,
  clients: FilterValue,
  states: FilterValue,
  cities: FilterValue,
  zonalManagers: FilterValue,
  serviceCategories: FilterValue,
  reportingManagerId: string,
): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set('flag', flag);
  qs.set('page', String(page));
  qs.set('pageSize', String(pageSize));
  states.forEach((v) => qs.append('stateId', String(v)));
  cities.forEach((v) => qs.append('cityId', String(v)));
  zonalManagers.forEach((v) => qs.append('zonalManagerId', String(v)));
  serviceCategories.forEach((v) => qs.append('serviceCategoryId', String(v)));
  // Client ⇄ RM mutual exclusivity: send clientId ONLY when no RM is selected.
  if (reportingManagerId) {
    qs.set('reportingManagerId', reportingManagerId);
  } else {
    clients.forEach((v) => qs.append('clientId', String(v)));
  }
  return qs;
}

export function TechnicianPerformanceBody() {
  const { me } = useMe();
  const flags = actionFlags(me, [FAMILY_KEY, ACTION_KEY]);
  const canView = flags[FAMILY_KEY] && flags[ACTION_KEY];

  const lookup = useLookup();

  // Monthly/Weekly toggle, persisted to sessionStorage (legacy 'selectedTab').
  const [flag, setFlag] = useState<Flag>('monthly');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    if (saved === 'weekly' || saved === 'monthly') setFlag(saved);
  }, []);
  function changeFlag(next: Flag) {
    setFlag(next);
    setPage(0);
    if (typeof window !== 'undefined') window.sessionStorage.setItem(STORAGE_KEY, next);
  }

  // Filters.
  const [clients, setClients] = useState<FilterValue>([]);
  const [states, setStates] = useState<FilterValue>([]);
  const [cities, setCities] = useState<FilterValue>([]);
  const [zonalManagers, setZonalManagers] = useState<FilterValue>([]);
  const [serviceCategories, setServiceCategories] = useState<FilterValue>([]);
  const [reportingManagerId, setReportingManagerId] = useState<string>('');
  const [showClientWarning, setShowClientWarning] = useState(false);

  // Pagination (0-indexed page for TablePagination; +1 at the API boundary).
  const [page, setPage] = useState(0);
  const [pageSizeOpt, setPageSizeOpt] = useState<TablePageSize>(10);
  const pageSize = pageSizeToLimit(pageSizeOpt, BE_PAGE_SIZE_MAX);

  const [downloading, setDownloading] = useState(false);

  // Drill-down modal state.
  const [modalTx, setModalTx] = useState<{ txId: number; txName: string } | null>(null);

  // Zonal Manager options (tbl_city.state_user) — not in useLookup; fetched once.
  const zonalRes = useFetchOnce<ManagerLite[]>('/shared/lookup/zonal-managers');
  const zonalManagerOptions = useMemo<SearchOption[]>(
    () => (zonalRes.data ?? []).map((u) => ({ value: u.user_id, label: u.user_name })),
    [zonalRes.data],
  );

  // Reporting Manager options — the admin-group user list (the BE resolves the
  // RM-team manage_clients scoping from the chosen user id).
  const reportingManagerOptions = useMemo<SearchOption[]>(
    () => lookup.adminUsers.map((u) => ({ value: u.user_id, label: u.user_name })),
    [lookup.adminUsers],
  );

  // Service-category options sorted A→Z.
  const svcCatOpts = useMemo(
    () => [...lookup.toOpts.serviceCategories].sort((a, b) => a.label.localeCompare(b.label)),
    [lookup.toOpts.serviceCategories],
  );

  // Client ⇄ RM mutual exclusivity handlers.
  function onClientsChange(next: FilterValue) {
    if (reportingManagerId) {
      // Client is blocked while an RM is selected (legacy clientChange guard).
      setShowClientWarning(true);
      return;
    }
    setShowClientWarning(false);
    setClients(next);
    setPage(0);
  }
  function onReportingManagerChange(v: string) {
    setReportingManagerId(v);
    if (v) {
      // Selecting an RM clears the Client filter (mutually exclusive).
      setClients([]);
      setShowClientWarning(false);
    }
    setPage(0);
  }

  // Reset to page 0 on any non-client filter change.
  function withReset<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setPage(0); };
  }

  const queryString = useMemo(
    () =>
      buildQuery(
        flag, page + 1, pageSize, clients, states, cities, zonalManagers,
        serviceCategories, reportingManagerId,
      ).toString(),
    [flag, page, pageSize, clients, states, cities, zonalManagers, serviceCategories, reportingManagerId],
  );
  const fetchKey = canView ? `/admin/quicksight/technician-performance?${queryString}` : null;

  const { data, loading, error } = useFetch<TechnicianPerfPayload>(fetchKey);

  const rows = data?.data ?? [];
  const totalRecords = data?.totalRecords ?? 0;

  // The BE emits a synthetic "No Technician" row (txId=null) when nothing
  // matches — treat that as empty for the scaffold's empty-state.
  const hasRealRows = rows.some((r) => r.txId != null);

  // Period headers (3 blocks) derived from the first row's date-wise list.
  const periodHeaders = useMemo(() => {
    const sample = rows[0]?.technicianPerformanceDataDateWise ?? [];
    return sample.map((p) => periodHeader(p, flag));
  }, [rows, flag]);

  // 403 → access panel.
  const accessDenied =
    !canView || (!!error && /permission|quicksight access|access denied/i.test(error));
  const genericError = error && !accessDenied ? error : null;
  const isEmpty = !loading && !genericError && !accessDenied && !hasRealRows;

  // Copy-Data parity guard: ≥1 of state/client/city/zonal selected.
  const exportFiltersValid =
    states.length > 0 || clients.length > 0 || cities.length > 0 || zonalManagers.length > 0;

  async function handleDownload() {
    if (!exportFiltersValid) {
      // Legacy areFiltersValid alert — at least one scope filter is required.
      showToast({ variant: 'error', message: 'Select at least one of State, Client, City, or Zonal Manager to export.' });
      return;
    }
    setDownloading(true);
    try {
      // Export the full result set (not just the current page) at the BE max.
      const qs = buildQuery(
        flag, 1, BE_PAGE_SIZE_MAX, clients, states, cities, zonalManagers,
        serviceCategories, reportingManagerId,
      );
      qs.set('format', 'xlsx');
      await downloadXlsx({
        url: `/admin/quicksight/technician-performance?${qs.toString()}`,
        filename: `technician-performance-${flag}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
    } catch {
      showToast({ variant: 'error', message: 'Could not download the report. Please retry.' });
    } finally {
      setDownloading(false);
    }
  }

  const filters = (
    <div className="space-y-3">
      <Tabs value={flag} onValueChange={(v) => changeFlag(v as Flag)}>
        <TabsList>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
          <TabsTrigger value="weekly">Weekly</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="State">
          <SearchMultiSelect
            value={states}
            onChange={withReset(setStates)}
            options={lookup.toOpts.states}
            placeholder="All States"
            selectedLabel="states"
            disabled={loading}
          />
        </Field>
        <Field label="Client">
          <SearchMultiSelect
            value={clients}
            onChange={onClientsChange}
            options={lookup.toOpts.clients}
            placeholder={reportingManagerId ? 'Cleared (Reporting Manager Selected)' : 'All Clients'}
            selectedLabel="clients"
            disabled={loading || !!reportingManagerId}
          />
        </Field>
        <Field label="City">
          <SearchMultiSelect
            value={cities}
            onChange={withReset(setCities)}
            options={lookup.toOpts.cities}
            placeholder="All Cities"
            selectedLabel="cities"
            disabled={loading}
          />
        </Field>
        <Field label="Zonal Manager">
          <SearchMultiSelect
            value={zonalManagers}
            onChange={withReset(setZonalManagers)}
            options={zonalManagerOptions}
            placeholder="All Zonal Managers"
            selectedLabel="managers"
            disabled={loading}
          />
        </Field>
        <Field label="Service Category">
          <SearchMultiSelect
            value={serviceCategories}
            onChange={withReset(setServiceCategories)}
            options={svcCatOpts}
            placeholder="All Service Categories"
            selectedLabel="categories"
            disabled={loading}
          />
        </Field>
        <Field label="Reporting Manager">
          <SearchSelect
            value={reportingManagerId}
            onChange={onReportingManagerChange}
            options={reportingManagerOptions}
            placeholder="All Reporting Managers"
            disabled={loading}
          />
        </Field>
      </div>

      {showClientWarning && (
        <p className="text-xs text-warning">
          Client filter is disabled while a Reporting Manager is selected. Clear the Reporting
          Manager to filter by Client.
        </p>
      )}
    </div>
  );

  return (
    <ReportPageScaffold
      title="Technician Performance"
      subtitle="Monthly / weekly technician KPIs across three periods."
      icon={Users}
      filters={filters}
      loading={loading}
      error={genericError}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={handleDownload}
      downloading={downloading}
    >
      <div className="space-y-4">
        <TechnicianPerformanceCharts rows={rows} periodLabel={periodHeaders[0] ?? ''} />

        <div className="overflow-x-auto rounded-md border">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th rowSpan={2} className="!text-left">State</th>
                <th rowSpan={2} className="!text-left">City</th>
                <th rowSpan={2} className="!text-left">Name &amp; Id</th>
                <th rowSpan={2} className="!text-left">C.B &amp; Attendance</th>
                {periodHeaders.map((lbl, i) => (
                  <th key={i} colSpan={METRIC_HEADERS.length} className="!text-center border-l">
                    {lbl}
                  </th>
                ))}
              </tr>
              <tr>
                {periodHeaders.map((_, i) =>
                  METRIC_HEADERS.map((h, j) => (
                    <th
                      key={`${i}-${j}`}
                      className={`!text-right whitespace-nowrap ${j === 0 ? 'border-l' : ''}`}
                    >
                      {h}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={row.txId ?? `synthetic-${idx}`}>
                  <td className="!text-left">{row.stateName || '—'}</td>
                  <td className="!text-left">{row.txCity || '—'}</td>
                  <td className="!text-left">
                    {row.txId != null ? (
                      <button
                        type="button"
                        onClick={() => setModalTx({ txId: row.txId as number, txName: row.txName })}
                        className={cn(
                          'rounded px-1.5 py-0.5 text-left font-medium underline-offset-2 hover:underline',
                          row.txStatus === '1'
                            ? 'text-success-strong bg-success-tint'
                            : 'text-urgent-strong bg-urgent-tint',
                        )}
                      >
                        {row.txName} - {row.txId}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">{row.txName}</span>
                    )}
                  </td>
                  <td className="!text-left">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold tabular-nums">
                        {row.txCurrentBalance.toLocaleString('en-IN')}
                      </span>
                      <AttChip label="Today" status={row.txTodayAttendance} />
                      <AttChip label="Tomorrow" status={row.txTomAttendance} />
                    </div>
                  </td>
                  {row.technicianPerformanceDataDateWise.map((p, i) => (
                    <PeriodCells key={i} p={p} firstOfBlock />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <TablePagination
          page={page}
          pageSize={pageSizeOpt}
          total={totalRecords}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSizeOpt(s); setPage(0); }}
        />
      </div>

      <TechnicianCategoryModal
        txId={modalTx?.txId ?? null}
        txName={modalTx?.txName ?? ''}
        flag={flag}
        open={modalTx != null}
        onOpenChange={(o) => { if (!o) setModalTx(null); }}
      />
    </ReportPageScaffold>
  );
}

/* Small labelled wrapper shared by every filter (Title-Case label). */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

/* The 4 numeric cells for one period block. `firstOfBlock` adds the left
 * border so the three blocks read apart. Open Order In App is amber-bold
 * (legacy fixed amber background). */
function PeriodCells({ p, firstOfBlock }: { p: PeriodDateWise; firstOfBlock?: boolean }) {
  const cls = '!text-right whitespace-nowrap';
  return (
    <>
      <td className={`${cls} ${firstOfBlock ? 'border-l' : ''}`}>{p.txTktCreated}</td>
      <td className={cls}>{pctCell(p.txSdaPercentage)}</td>
      <td className={cls}>{pctCell(p.txTatPercentage)}</td>
      <td className={`${cls} bg-warning-tint font-semibold`}>{p.txOpenOrder}</td>
    </>
  );
}
