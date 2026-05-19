'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { Upload, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { SearchSelect } from '@/components/ui/search-select';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { statusColorClass } from '@/lib/utils';

/*
 * Bulk job upload (rev. 2026-05-19) — every uploaded row creates an
 * Unconfirmed (status=9) job for the picked client. Operators then
 * fill the remaining details (city, pin, service type, time slot,
 * etc.) via the per-row Confirm & Schedule flow before the order is
 * actually booked.
 *
 * Spreadsheet format mirrors the file external clients send:
 *   0  Client Reference ID
 *   1  Customer Name *
 *   2  Customer Mobile Number *  (10 digits)
 *   3  Service Delivery Address *
 *   4  Date of Appointment *     (dd-mm-yyyy)
 *   5  Product Quantity          (int)
 *   6  Mode of Payment           (Free for customer / Paid by Customer)
 *   7  Type of Service           (Installation / Repair / UnInstallation)
 *   8  Job Description
 *   9  Special Comments
 *
 * The download-template endpoint emits an .xlsx with the same headers
 * + hidden vocabulary sheets for the two dropdowns, so the file ops
 * gives external clients is byte-equivalent to what they paste back.
 */

const TEMPLATE_URL = (process.env.NEXT_PUBLIC_API_URL || '/api') + '/admin/jobs/upload-template';

async function downloadTemplate() {
  const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
  const res = await fetch(TEMPLATE_URL, {
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) { alert(`Template download failed: HTTP ${res.status}`); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'easyfix-unconfirmed-jobs-upload-template.xlsx';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

type Report = {
  summary: {
    totalRows: number; createdCount: number; failedCount: number; skipCount: number;
    dryRun: boolean;
    clientId?: number; clientName?: string;
    landingTab?: string;
  };
  // Each result carries the row's Client Reference ID + Date of
  // Appointment regardless of outcome so the report table can render
  // them without a separate raw-row dict. `date_of_appointment` is
  // ISO when the row parsed successfully; the original cell string
  // when it didn't (e.g. malformed date).
  results: Array<{
    rowNumber: number;
    status: string;
    jobId?: number;
    reason?: string;
    errors?: string[];
    client_ref_id?: string | null;
    date_of_appointment?: string | null;
  }>;
};

/*
 * Status-string normalisation for the report table. The BE returns
 * `valid | created | failed | skipped`; ops just wants Valid vs.
 * Invalid in this view.
 */
function displayStatus(s: string): 'Valid' | 'Invalid' {
  return s === 'valid' || s === 'created' ? 'Valid' : 'Invalid';
}

/*
 * Date formatter for the Date-of-Appointment column. ISO strings
 * come back from the BE on success rows; malformed inputs come back
 * as raw strings. Either way we surface a "dd MMM yyyy" form when
 * we can parse it, else the raw string verbatim.
 */
function formatAppointment(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function JobUploadPage() {
  const lk = useLookup();
  const inputRef = useRef<HTMLInputElement>(null);
  const [clientId, setClientId] = useState<string>('');
  const [dryRun, setDryRun] = useState(true);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setReport(null);
    if (!clientId) return setError('Pick a client before uploading.');
    const file = inputRef.current?.files?.[0];
    if (!file) return setError('Pick an .xlsx file');
    const fd = new FormData();
    fd.set('file', file);
    fd.set('clientId', String(clientId));
    setLoading(true);
    try {
      const r = await api.post<Report>(`/admin/jobs/upload?dryRun=${dryRun}`, fd);
      setReport(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally { setLoading(false); }
  }

  // Deep-link target for the "view created rows" link on a successful
  // non-dry-run upload — lands the operator on the Unconfirmed bucket
  // of the Jobs page where every freshly-created row appears.
  const unconfirmedLink = '/jobs?tab=unconfirmed';
  const createdAny = report && !report.summary.dryRun && report.summary.createdCount > 0;

  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">Bulk Job Upload (Unconfirmed)</h1>
      <p className="text-sm text-muted-foreground">
        Every row creates an <strong>Unconfirmed</strong> order against the picked client. Operators
        complete city / PIN / service type / time slot via the per-row <em>Confirm &amp; Schedule</em>
        action on the Unconfirmed bucket.
      </p>
      <Card>
        <CardHeader><CardTitle>Upload Excel</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {/* Client picker is REQUIRED — the new spreadsheet doesn't
                have a per-row client column, so one batch = one client. */}
            <div>
              <Label>Client *</Label>
              <SearchSelect
                value={clientId}
                onChange={setClientId}
                options={lk.toOpts.clients.map((o) => ({ value: o.value, label: String(o.label) }))}
                placeholder="— Pick the client these rows belong to —"
                required
              />
              <p className="text-xs text-muted-foreground mt-1">
                All rows in the uploaded file will be created against this client.
              </p>
            </div>
            <div>
              <Label>.xlsx file (row 1 = header, data from row 2)</Label>
              <input ref={inputRef} type="file" accept=".xlsx,.xls" className="block mt-1.5 text-sm" required />
              <p className="text-xs text-muted-foreground mt-2">
                Columns: Client Reference ID · Customer Name · Mobile · Address · Date of Appointment (dd-mm-yyyy)
                · Product Quantity · Mode of Payment · Type of Service · Job Description · Special Comments
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              <span>Dry Run (validation only)</span>
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={loading}>
                <Upload className="h-4 w-4 mr-1" /> {loading ? 'Processing…' : (dryRun ? 'Validate' : 'Upload & Create')}
              </Button>
              <Button type="button" variant="outline" onClick={downloadTemplate}>
                <Download className="h-4 w-4 mr-1" /> Download template
              </Button>
            </div>
            {error && <div className="text-sm text-destructive">{error}</div>}
          </form>
        </CardContent>
      </Card>

      {report && (
        <Card>
          <CardHeader>
            <CardTitle>
              Report · {report.summary.dryRun ? 'Dry run' : 'Upload complete'}
              {report.summary.clientName && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  · {report.summary.clientName}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-3 mb-4">
              <Stat label="Total rows" v={report.summary.totalRows} tint="bg-slate-100" />
              <Stat label="Created / Valid" v={report.summary.createdCount || report.results.filter(r => r.status === 'valid').length} tint="bg-emerald-100 text-emerald-700" />
              <Stat label="Failed" v={report.summary.failedCount} tint="bg-red-100 text-red-700" />
              <Stat label="Skipped" v={report.summary.skipCount} tint="bg-slate-100 text-slate-600" />
            </div>
            {createdAny && (
              <div className="mb-3">
                <Link href={unconfirmedLink} className="inline-flex items-center gap-1 text-sm text-sky-700 hover:underline">
                  → Open the Unconfirmed bucket and start confirming these orders
                </Link>
              </div>
            )}
            <table className="data-table">
              <thead>
                <tr>
                  <th>Client Reference ID</th>
                  <th>Date of Appointment</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {report.results.map((r) => {
                  const valid = r.status === 'valid' || r.status === 'created';
                  // Details column shows nothing on Valid rows (per ops
                  // spec). On Invalid rows it carries the human reason
                  // — either the skip reason (malformed mobile/date),
                  // the per-row create error, or the validation errors
                  // joined into one phrase.
                  const details = valid
                    ? ''
                    : (r.errors?.length ? r.errors.join('; ') : (r.reason || ''));
                  return (
                    <tr key={r.rowNumber}>
                      <td className="text-xs">{r.client_ref_id || '—'}</td>
                      <td className="text-xs">{formatAppointment(r.date_of_appointment)}</td>
                      <td>
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          valid
                            ? statusColorClass(1)
                            : 'bg-red-100 text-red-700'
                        }`}>
                          {displayStatus(r.status)}
                        </span>
                      </td>
                      <td className="text-xs">
                        {/* Created rows still surface the new job_id
                            so ops can jump to the record; everything
                            else is the failure reason text. */}
                        {r.jobId ? <span>job #{r.jobId}</span> : <span>{details}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, v, tint }: { label: string; v: number | string; tint: string }) {
  return (
    <div className={`rounded-lg p-3 ${tint}`}>
      <div className="text-2xl font-semibold tabular-nums">{v}</div>
      <div className="text-xs opacity-80">{label}</div>
    </div>
  );
}
