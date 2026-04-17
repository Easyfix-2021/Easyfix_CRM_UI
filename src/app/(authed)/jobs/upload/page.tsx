'use client';
import { useRef, useState } from 'react';
import { Upload, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { statusColorClass } from '@/lib/utils';

/*
 * Fetches the template from the backend so the column layout stays in lockstep
 * with the parser (`utils/excel-parser.js`). We pass the JWT via the same api
 * helper path to avoid an auth bypass in the download route.
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
  a.download = 'easyfix-jobs-upload-template.xlsx';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

type Report = {
  summary: { totalRows: number; createdCount: number; failedCount: number; skipCount: number; dryRun: boolean };
  results: Array<{ rowNumber: number; status: string; jobId?: number; reason?: string; errors?: string[] }>;
};

export default function JobUploadPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dryRun, setDryRun] = useState(true);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setReport(null);
    const file = inputRef.current?.files?.[0];
    if (!file) return setError('Pick an .xlsx file');
    const fd = new FormData(); fd.set('file', file);
    setLoading(true);
    try {
      const r = await api.post<Report>(`/admin/jobs/upload?dryRun=${dryRun}`, fd);
      setReport(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally { setLoading(false); }
  }

  return (
    // No max-width: the Card below fills the whole available width between
    // sidebar and the right edge so the "white panel" visually meets the page
    // chrome with just the main-padding gap, not an internal centered island.
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold">Bulk Job Upload</h1>
      <Card>
        <CardHeader><CardTitle>Upload Excel</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label>.xlsx file (row 1 = header, data from row 2)</Label>
              <input ref={inputRef} type="file" accept=".xlsx,.xls" className="block mt-1.5 text-sm" required />
              <p className="text-xs text-muted-foreground mt-2">
                Columns: Customer Mobile · Name · Email · Client · Client Ref · Service Type · Service IDs · Description ·
                Requested DT · Address · City · PIN · Job Owner · Time Slot · Job Type · Helper · GPS
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              <span>Dry run (validate only, no rows inserted)</span>
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
            <CardTitle>Report · {report.summary.dryRun ? 'Dry run' : 'Upload complete'}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-3 mb-4">
              <Stat label="Total rows" v={report.summary.totalRows} tint="bg-slate-100" />
              <Stat label="Created / Valid" v={report.summary.createdCount || report.results.filter(r => r.status === 'valid').length} tint="bg-emerald-100 text-emerald-700" />
              <Stat label="Failed" v={report.summary.failedCount} tint="bg-red-100 text-red-700" />
              <Stat label="Skipped" v={report.summary.skipCount} tint="bg-slate-100 text-slate-600" />
            </div>
            <table className="data-table">
              <thead><tr><th>Row</th><th>Status</th><th>Details</th></tr></thead>
              <tbody>
                {report.results.map((r) => (
                  <tr key={r.rowNumber}>
                    <td className="font-medium">{r.rowNumber}</td>
                    <td>
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        r.status === 'created' ? statusColorClass(3) :
                        r.status === 'valid'   ? statusColorClass(1) :
                        r.status === 'skipped' ? 'bg-slate-100 text-slate-600' :
                        'bg-red-100 text-red-700'
                      }`}>{r.status}</span>
                    </td>
                    <td className="text-xs">
                      {r.jobId && <span>job #{r.jobId}</span>}
                      {r.reason && <span>{r.reason}</span>}
                      {r.errors && <span>{r.errors.join('; ')}</span>}
                    </td>
                  </tr>
                ))}
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
