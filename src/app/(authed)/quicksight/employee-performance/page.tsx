'use client';

/*
 * QuickSight — Employee Performance.
 *
 * The MIS "Employee Performance Dashboard" (revenue vs target, open jobs,
 * client / city / TAT-SDA, zonal breakdown, TimeChamp productivity, IVR),
 * shown INSIDE the CRM exactly as MIS built it. Its sources (targets,
 * TimeChamp, IVR) are not in the DB, so it is not queried like the other
 * reports: MIS runs update_dashboard.bat, then uploads the resulting data.js
 * here, and every viewer sees that snapshot.
 *
 *   GET  /admin/quicksight/employee-performance/meta       who uploaded what, when
 *   GET  /admin/quicksight/employee-performance/dashboard  { html } page + data
 *   POST /admin/quicksight/employee-performance/upload     data.js (gzipped here)
 *
 * The page arrives as ONE html string and is rendered through `srcDoc` in an
 * iframe sandboxed to `allow-scripts` only — no same-origin — so the
 * dashboard's own script runs but can never read the CRM's token, cookies or
 * DOM. The backend stores the upload re-serialised as pure JSON, so what runs
 * is always the reviewed template plus data.
 *
 * Gating: ef-QuickSight + isQuickSightEmployeePerformanceView to view;
 * isQuickSightEmployeePerformanceUpload additionally shows "Upload Data".
 */

import { useRef, useState, type ChangeEvent } from 'react';
import { TrendingUp, Upload, Inbox } from 'lucide-react';
import { ReportPageScaffold } from '@/components/quicksight/ReportPageScaffold';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { showToast, dismissToast } from '@/components/ui/toast';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

const ACTION_KEY = 'isQuickSightEmployeePerformanceView';
const UPLOAD_KEY = 'isQuickSightEmployeePerformanceUpload';
const API_BASE = '/admin/quicksight/employee-performance';

type SnapshotMeta = {
  dateFrom: string;
  dateTo: string;
  employeeCount: number;
  spocCount: number;
  uploadedAt: string;
  uploadedBy: { userId: number | null; name: string | null };
  originalName: string | null;
  sizeBytes: number;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* 'YYYY-MM-DD' → '01 Aug 2026' without a Date, so no timezone can shift the day. */
function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

function fmtStamp(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/*
 * data.js is ~7 MB of JSON that compresses ~10x; sending it gzipped keeps the
 * upload well under every proxy body limit. A browser without
 * CompressionStream sends the file as-is (the backend accepts both).
 */
async function gzipFile(file: File): Promise<Blob> {
  if (typeof CompressionStream === 'undefined') return file;
  return new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

export default function EmployeePerformancePage() {
  const { me } = useMe();
  const flags = actionFlags(me, [ACTION_KEY, UPLOAD_KEY]);
  const canView = flags[ACTION_KEY];
  const canUpload = canView && flags[UPLOAD_KEY];

  const meta = useFetch<SnapshotMeta | null>(canView ? `${API_BASE}/meta` : null);
  const snapshot = meta.data;
  // Keyed on the upload time, so a new upload is a new key and never a cache hit.
  const dashboard = useFetch<{ html: string }>(
    snapshot ? `${API_BASE}/dashboard?v=${encodeURIComponent(snapshot.uploadedAt)}` : null,
  );

  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const onFilePicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // picking the same file again must still fire
    if (!file) return;
    setUploading(true);
    const toastId = showToast({ variant: 'loading', message: 'Uploading dashboard data…' });
    try {
      const body = await gzipFile(file);
      const fd = new FormData();
      fd.append('file', body, body === file ? file.name : `${file.name}.gz`);
      const next = await api.post<SnapshotMeta>(`${API_BASE}/upload`, fd);
      invalidateFetch((k) => k.startsWith(API_BASE));
      meta.refetch();
      showToast({ variant: 'success', message: `Dashboard updated: ${fmtDay(next.dateFrom)} – ${fmtDay(next.dateTo)}` });
    } catch (err) {
      showToast({ variant: 'error', message: err instanceof ApiError ? err.message : 'Upload failed' });
    } finally {
      dismissToast(toastId);
      setUploading(false);
    }
  };

  // Snapshot status + upload share the scaffold's filters row: this report has
  // no filters of its own (the dashboard carries them inside the frame).
  const statusBar = canView && (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <div className="text-muted-foreground">
        {snapshot ? (
          <>
            Data <span className="font-medium text-foreground">{fmtDay(snapshot.dateFrom)} – {fmtDay(snapshot.dateTo)}</span>
            {' · '}{snapshot.employeeCount} employees{' · '}
            Updated {fmtStamp(snapshot.uploadedAt)}{snapshot.uploadedBy.name ? ` by ${snapshot.uploadedBy.name}` : ''}
          </>
        ) : meta.loading ? 'Checking for uploaded data…' : 'No data uploaded yet'}
      </div>
      {canUpload && (
        <>
          <input ref={fileInput} type="file" accept=".js,.json" className="hidden" onChange={onFilePicked} />
          <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
            <Upload className="size-4" /> {uploading ? 'Uploading…' : 'Upload Data'}
          </Button>
        </>
      )}
    </div>
  );

  return (
    <ReportPageScaffold
      title="Employee Performance"
      subtitle="Revenue vs target, open jobs, TAT / SDA and productivity by SPOC and team."
      icon={TrendingUp}
      filters={statusBar}
      loading={meta.loading || dashboard.loading}
      error={meta.error || dashboard.error}
      // Wait for `me` before denying, so the panel never flashes while auth loads.
      accessDenied={!!me && !canView}
      isEmpty={false}
    >
      {snapshot && dashboard.data ? (
        <iframe
          title="Employee Performance Dashboard"
          srcDoc={dashboard.data.html}
          sandbox="allow-scripts"
          className="block h-[calc(100vh-11rem)] min-h-[600px] w-full rounded-lg border border-border bg-white"
        />
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <Inbox className="size-8 text-muted-foreground" />
            <div className="space-y-1">
              <div className="text-base font-semibold">No Data Uploaded Yet</div>
              <p className="max-w-md text-sm text-muted-foreground">
                {canUpload
                  ? 'Run update_dashboard.bat on the latest Excel file, then click Upload Data and choose the data.js it creates.'
                  : 'The dashboard appears here once MIS uploads the latest data.'}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </ReportPageScaffold>
  );
}
