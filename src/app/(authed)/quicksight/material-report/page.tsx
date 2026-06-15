'use client';

/*
 * QuickSight — Material Report page (native rebuild of the legacy Angular
 * "materiallist" slug).
 *
 *   registry slug : materiallist   ·   urlBase: material-report
 *   action key    : isQuickSightMaterialReportView
 *   BE endpoint   : GET /api/admin/quicksight/material-report
 *                       ?clientId=&from=&to=[&format=xlsx]
 *
 * Legacy source: Angular_ClientDashboard material-list.component.{ts,html}.
 * The legacy page was DOWNLOAD-ONLY (it POSTed a {startDate,endDate} body +
 * clientId query, and the server generated an Excel + returned a URL). The
 * native rebuild renders the data on-screen as a table AND keeps the Excel as
 * a ?format=xlsx export — the same 27 columns, one row per element-deployed
 * line.
 *
 * Filters (legacy parity):
 *   - Client (single-select, REQUIRED) — sourced from the shared clients
 *     lookup (legacy pmJobs/pmJobsFilterList?type=client → /shared/lookup/clients).
 *   - Date Range (From / To, REQUIRED, max = today) with a 60-DAY cap enforced
 *     BOTH client-side (inline message) AND server-side (BE Joi). Message copy
 *     matches legacy: 'Date difference should be less than 60 days'.
 *
 * Data fetching uses the mandatory shared useFetch hook (keyed on the
 * serialized filter state) — never raw useEffect+api.get. Permission gating
 * mirrors the BE requireQuickSight contract: the page is gated on the
 * ef-QuickSight family key + the per-report isQuickSightMaterialReportView key
 * via actionFlags; a missing key (or a BE 403) renders the scaffold's
 * accessDenied panel.
 *
 * Title Case throughout; modal-free (no drill-down — the legacy report had
 * none). Export via the shared green DownloadButton → download-xlsx helper.
 */

import { useMemo, useState } from 'react';
import { PackageOpen } from 'lucide-react';

import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { MaterialReportCharts } from './MaterialReportCharts';
import { Button } from '@/components/ui/button';
import { SearchSelect } from '@/components/ui/search-select';
import { useFetch } from '@/lib/hooks';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useLookup } from '@/lib/use-lookup';
import { api } from '@/lib/api';

const FAMILY_KEY = 'ef-QuickSight';
const ACTION_KEY = 'isQuickSightMaterialReportView';
const API_BASE = '/admin/quicksight/material-report';
const MAX_DAYS = 60;

// ── API row shape (one row per element-deployed line; matches BE service) ──
type MaterialRow = {
  jobId: number;
  clientRefId: string | null;
  branchDetails: string | null;
  customerName: string | null;
  address: string | null;
  ticketCreatedDateTime: string | null;
  appointmentDateTime: string | null;
  checkInDateTime: string | null;
  appCheckoutDateTime: string | null;
  estimateSentOn: string | null;
  estimateActionOn: string | null;
  poUploadDate: string | null;
  checkOutDateTime: string | null;
  jobDesc: string | null;
  serviceType: 'Service' | 'Material';
  serviceName: string | null;
  unit: number;
  cxCharge: number;
  totalCost: number;
  clientSpocName: string | null;
  cityName: string | null;
  stateName: string | null;
  zonalManager: string | null;
  customProperty: string | null;
  poImageLink: string | null;
  jobSheetLink: string | null;
  feedbackLink: string | null;
};

// 27 columns — EXACT legacy order + spelling ('PO Recieved Date',
// 'Qty /sqrft/nos'), Title Case where the legacy headers already were.
type ColAlign = 'left' | 'center' | 'right';
const COLUMNS: Array<{ key: keyof MaterialRow; label: string; align: ColAlign; kind?: 'date' | 'link' }> = [
  { key: 'jobId', label: 'Job Id', align: 'left' },
  { key: 'clientRefId', label: 'Ref Id', align: 'left' },
  { key: 'branchDetails', label: 'Branch', align: 'left' },
  { key: 'customerName', label: 'Customer Name', align: 'left' },
  { key: 'address', label: 'Address', align: 'left' },
  { key: 'ticketCreatedDateTime', label: 'Ticket Created On', align: 'left', kind: 'date' },
  { key: 'appointmentDateTime', label: 'Appointment On', align: 'left', kind: 'date' },
  { key: 'checkInDateTime', label: 'App CheckIn On', align: 'left', kind: 'date' },
  { key: 'appCheckoutDateTime', label: 'App checkOut Date', align: 'left', kind: 'date' },
  { key: 'estimateSentOn', label: 'Estimate Sent On', align: 'left', kind: 'date' },
  { key: 'estimateActionOn', label: 'Estimate Action On', align: 'left', kind: 'date' },
  { key: 'poUploadDate', label: 'PO Recieved Date', align: 'left', kind: 'date' },
  { key: 'checkOutDateTime', label: 'Checkout Date Time', align: 'left', kind: 'date' },
  { key: 'jobDesc', label: 'Job Desc', align: 'left' },
  { key: 'serviceType', label: 'Service Type', align: 'left' },
  { key: 'serviceName', label: 'Element Deployed', align: 'left' },
  { key: 'unit', label: 'Qty /sqrft/nos', align: 'right' },
  { key: 'cxCharge', label: 'Rate', align: 'right' },
  { key: 'totalCost', label: 'Total Amount', align: 'right' },
  { key: 'clientSpocName', label: 'Client SPOC', align: 'left' },
  { key: 'cityName', label: 'City', align: 'left' },
  { key: 'stateName', label: 'State', align: 'left' },
  { key: 'zonalManager', label: 'Zonal Manager', align: 'left' },
  { key: 'customProperty', label: 'Custom Property', align: 'left' },
  { key: 'poImageLink', label: 'PO', align: 'left', kind: 'link' },
  { key: 'jobSheetLink', label: 'JobSheet Link', align: 'left', kind: 'link' },
  { key: 'feedbackLink', label: 'Feedback Link', align: 'left', kind: 'link' },
];

const ALIGN_CLASS: Record<ColAlign, string> = {
  left: '!text-left',
  center: '!text-center',
  right: '!text-right',
};

// Render a DB DATETIME string as dd-MM-yyyy HH:mm (IST clock fields). Empty on
// null / unparseable (legacy left these blank).
function fmtDate(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Today as yyyy-mm-dd (max selectable date — legacy maxDate=today).
function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Inclusive day span between two yyyy-mm-dd strings (UTC anchor → no DST slip).
function daySpan(from: string, to: string): number {
  const f = Date.parse(`${from}T00:00:00Z`);
  const t = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(f) || Number.isNaN(t)) return NaN;
  return (t - f) / 86400000;
}

export default function MaterialReportPage() {
  const { me } = useMe();
  const flags = actionFlags(me, [FAMILY_KEY, ACTION_KEY]);
  const hasAccess = flags[FAMILY_KEY] && flags[ACTION_KEY];

  const lookup = useLookup();
  const today = useMemo(() => todayStr(), []);

  // ── Draft (editing) vs applied (drives the fetch) filter state ──────────
  const [clientId, setClientId] = useState<string>('');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [applied, setApplied] = useState<{ clientId: string; from: string; to: string } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Set briefly when an image presign/open fails (non-fatal, surfaced inline).
  const [imageError, setImageError] = useState<string | null>(null);
  // Tracks the link currently being presigned so we can disable it mid-flight.
  const [openingLink, setOpeningLink] = useState<string | null>(null);

  // Client-side guard mirroring the BE Joi rules (required + ≤60 days + order).
  function validate(): boolean {
    if (!clientId) {
      setValidationError('Please Select A Client.');
      return false;
    }
    if (!from || !to) {
      setValidationError('Please Select A Date Range.');
      return false;
    }
    const span = daySpan(from, to);
    if (Number.isNaN(span) || span < 0) {
      setValidationError('To Date Must Be On Or After From Date.');
      return false;
    }
    if (span > MAX_DAYS) {
      setValidationError('Date difference should be less than 60 days');
      return false;
    }
    setValidationError(null);
    return true;
  }

  function applyFilters() {
    if (!validate()) return;
    setApplied({ clientId, from, to });
  }

  function resetFilters() {
    setClientId('');
    setFrom('');
    setTo('');
    setApplied(null);
    setValidationError(null);
  }

  // Build the GET key — only fire when access + a valid applied filter exist.
  const queryStr = useMemo(() => {
    if (!applied) return null;
    const qs = new URLSearchParams({
      clientId: applied.clientId,
      from: applied.from,
      to: applied.to,
    });
    return `${API_BASE}?${qs.toString()}`;
  }, [applied]);

  const fetchKey = hasAccess && queryStr ? queryStr : null;
  const { data, loading, error } = useFetch<MaterialRow[]>(fetchKey);

  // BE hard-403 fallback → access panel instead of a raw error string.
  const beDenied = !!error && /permission|quicksight access/i.test(error);
  const accessDenied = !hasAccess || beDenied;

  const rows = data ?? [];
  // Empty = an applied filter returned zero rows (legacy "No records found").
  const isEmpty = !accessDenied && !loading && !error && !!applied && rows.length === 0;

  async function handleDownload() {
    if (!applied) return;
    setDownloading(true);
    try {
      const qs = new URLSearchParams({
        clientId: applied.clientId,
        from: applied.from,
        to: applied.to,
        format: 'xlsx',
      });
      await downloadXlsx({
        url: `${API_BASE}?${qs.toString()}`,
        filename: `material-report-${applied.to}.xlsx`,
      });
    } catch {
      // The scaffold surfaces fetch errors; a failed export is non-fatal.
    } finally {
      setDownloading(false);
    }
  }

  /*
   * Fetch a short-TTL presigned S3 URL for one PO / JobSheet / Feedback image,
   * then open it in a new tab. We do NOT point a raw <img src=/api/...> at the
   * proxy — that 401s with no Authorization header. Instead we hit the
   * Bearer-gated image-url endpoint via the authenticated api client; it
   * returns a presigned URL the browser can open without any auth header.
   *
   * `storedLink` is the row value built by the BE service:
   *   /api/admin/quicksight/material-report/image-url?key=<encoded-image-key>
   * api.get prepends NEXT_PUBLIC_API_URL (which already ends in /api), so we
   * strip the leading /api and re-send `key` as a typed query param.
   */
  async function openImage(storedLink: string) {
    setImageError(null);
    setOpeningLink(storedLink);
    try {
      const u = new URL(storedLink, window.location.origin);
      const key = u.searchParams.get('key') ?? '';
      const path = u.pathname.replace(/^\/api/, '');
      const res = await api.get<{ url: string | null }>(path, { key });
      if (res?.url) {
        window.open(res.url, '_blank', 'noopener,noreferrer');
      } else {
        setImageError('Image Not Found.');
      }
    } catch {
      // Non-fatal: surface a short inline message; the report stays usable.
      setImageError('Could Not Open Image. Please Retry.');
    } finally {
      setOpeningLink(null);
    }
  }

  return (
    <ReportPageScaffold
      title="Material Report"
      subtitle="Material & Service Usage Across Completed Jobs (60-Day Max Window)"
      icon={PackageOpen}
      loading={loading}
      error={accessDenied ? null : error}
      accessDenied={accessDenied}
      isEmpty={isEmpty}
      onDownload={applied ? handleDownload : undefined}
      downloading={downloading}
      filters={
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Client</label>
              <SearchSelect
                value={clientId}
                onChange={setClientId}
                options={lookup.toOpts.clients}
                placeholder="Select Client"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">From Date</label>
              <input
                type="date"
                value={from}
                max={to || today}
                onChange={(e) => setFrom(e.target.value)}
                className="flex h-9 w-full items-center rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">To Date</label>
              <input
                type="date"
                value={to}
                min={from || undefined}
                max={today}
                onChange={(e) => setTo(e.target.value)}
                className="flex h-9 w-full items-center rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none"
              />
            </div>
          </div>

          {validationError && (
            <p className="text-sm font-medium text-red-600">{validationError}</p>
          )}

          <div className="flex gap-2">
            <Button onClick={applyFilters} disabled={loading}>
              View Report
            </Button>
            <Button variant="outline" onClick={resetFilters} disabled={loading}>
              Reset
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <MaterialReportCharts rows={rows} />

        <div className="space-y-2">
          <h2 className="text-base font-semibold">Client Element Deployed</h2>
          {imageError && (
            <p className="text-sm font-medium text-red-600">{imageError}</p>
          )}
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="data-table">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={ALIGN_CLASS[c.align]}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.jobId}-${i}`}>
                    {COLUMNS.map((c) => (
                      <td key={c.key} className={ALIGN_CLASS[c.align]}>
                        {renderCell(r, c, openImage, openingLink)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </ReportPageScaffold>
  );
}

// Render one cell honouring its kind (date / link / scalar).
function renderCell(
  row: MaterialRow,
  col: { key: keyof MaterialRow; kind?: 'date' | 'link' },
  onOpenImage: (storedLink: string) => void,
  openingLink: string | null,
) {
  const v = row[col.key];
  if (col.kind === 'date') return fmtDate(v as string | null);
  if (col.kind === 'link') {
    if (!v) return '';
    // PO / JobSheet labels mirror the legacy hyperlink text ('PO_{jobId}',
    // 'JobSheet_{jobId}'); feedback shows a plain 'Link'. The stored value is
    // a Bearer-gated image-url endpoint path — a raw <a href> / <img src> at
    // it 401s, so we trigger an authenticated presign fetch then open the
    // returned S3 URL in a new tab.
    let label = 'Link';
    if (col.key === 'poImageLink') label = `PO_${row.jobId}`;
    else if (col.key === 'jobSheetLink') label = `JobSheet_${row.jobId}`;
    const storedLink = String(v);
    const busy = openingLink === storedLink;
    return (
      <button
        type="button"
        onClick={() => onOpenImage(storedLink)}
        disabled={busy}
        className="text-primary hover:underline disabled:opacity-50"
      >
        {busy ? 'Opening…' : label}
      </button>
    );
  }
  return v == null ? '' : String(v);
}
