'use client';

/*
 * Bulk Upload Pincodes — dedicated page (/settings/pincodes/upload)
 * ────────────────────────────────────────────────────────────────
 * Replaces the old in-page `UploadModal` (formerly in
 * settings/pincodes/page.tsx) with a full-page flow.
 *
 * Flow (no separate "Dry Run" button):
 *   1. Download the starter template (GET /admin/pincodes/template/download).
 *   2. Pick an .xlsx — this AUTOMATICALLY fires a dry-run
 *      (POST /admin/pincodes/upload?dryRun=true) and shows a spinner.
 *   3. Review the summary (Total/Created/Skipped/Failed) + per-row table.
 *   4. Commit (POST /admin/pincodes/upload?dryRun=false) — enabled ONLY
 *      when the dry-run reports at least 1 row that WOULD be created.
 *      On success → toast + navigate back to /settings/pincodes.
 *
 * Backend: dry-run and commit share ONE endpoint, differentiated by the
 *   `?dryRun=` query param (multipart field name is literally `file`).
 *   See routes/admin/pincodes.js + services/pincode-upload.service.js.
 *
 * Permission gate: isPincodeUpload — same flag that gated the old modal's
 *   toolbar button. The whole page is gated; non-permitted users get a
 *   "no access" card with a back link.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, AlertTriangle, UploadCloud, FileSpreadsheet } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DownloadButton } from '@/components/ui/download-button';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';

// Response shape — verbatim from the old UploadModal (page.tsx:1403–1412).
type UploadResult = {
  summary: { totalRows: number; createdCount: number; failedCount: number; skipCount: number; dryRun: boolean };
  results: Array<{
    rowNumber: number | null;
    status: 'created' | 'skipped' | 'failed';
    pincode?: string;
    reason?: string;
    errors?: string[];
  }>;
};

export default function PincodesBulkUploadPage() {
  const { me } = useMe();
  // Same flag that gated the old modal's toolbar button (page.tsx:106,241).
  const can = actionFlags(me, ['isPincodeUpload']);
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<UploadResult | null>(null);
  // 'idle' (no file) → 'dry-run' (preview shown) → 'committed' | 'error'.
  const [phase, setPhase] = useState<'idle' | 'dry-run' | 'committed' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);

  // ─── Permission gate (mirrors deep-skills/upload) ───────────────────
  if (me && !can.isPincodeUpload) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Upload Pincodes</h1>
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-sm text-muted-foreground">
              You don&apos;t have permission to upload pincodes.
            </p>
            <Link
              href="/settings/pincodes"
              className="mt-3 inline-flex items-center gap-1 text-sm text-sky-700 hover:underline"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Pincodes
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Template download — Bearer-auth blob via the shared helper (defers
  // object-URL revocation so browsers don't race the download path).
  async function downloadTemplate() {
    setDownloadingTemplate(true);
    setError(null);
    try {
      await downloadXlsx({
        url: '/admin/pincodes/template/download',
        filename: 'manage-pincodes-template.xlsx',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloadingTemplate(false);
    }
  }

  // Single endpoint for both modes; `dryRun` is a QUERY param, same body.
  async function send(picked: File, dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', picked); // multipart field name matches BE multer
      const r = await api.post<UploadResult>(`/admin/pincodes/upload?dryRun=${dryRun}`, fd);
      setReport(r);
      setPhase(dryRun ? 'dry-run' : 'committed');
      if (!dryRun) {
        showToast({
          variant: 'success',
          message: `Upload complete — ${r.summary.createdCount} pincode(s) created.`,
        });
        router.push('/settings/pincodes');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload failed');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  // AUTOMATIC dry-run on file select — no separate "Dry Run" button.
  function handlePick(picked: File | null) {
    setFile(picked);
    setReport(null);
    setError(null);
    setPhase('idle');
    if (picked) void send(picked, true);
  }

  // Commit is enabled ONLY when the dry-run found ≥1 row that WOULD be
  // created. A mismatched sheet (e.g. 59 total / 0 created) leaves this
  // disabled so the operator can't silently insert nothing.
  const canCommit =
    !!file &&
    !busy &&
    phase === 'dry-run' &&
    (report?.summary.createdCount ?? 0) >= 1;

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Page header — Back sits ABOVE the title */}
      <div className="space-y-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings/pincodes')}
          className="gap-1 -ml-2 h-auto px-2 py-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to Pincodes
        </Button>
        <div>
          <h1 className="text-xl font-bold">Upload Pincodes</h1>
          <p className="text-xs text-muted-foreground">
            Download the starter template, fill the Pincodes sheet, then pick the file —
            it validates rows automatically without inserting anything. Commit once the
            dry-run looks right.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          {/* Section header row — "Select File" on the left, Download Template
              RIGHT-ALIGNED with the exact label "Download Template". Keeping a
              label here stops the card reading half-empty. */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Select File</h2>
              <p className="text-xs text-muted-foreground">
                Upload the filled template to validate it automatically.
              </p>
            </div>
            <DownloadButton
              onClick={downloadTemplate}
              downloading={downloadingTemplate}
              label="Download Template"
              loadingLabel="Preparing Template…"
            />
          </div>

          {/* File picker — FULL-WIDTH dashed drop-zone. The <label> wraps a
              hidden native <input>, so clicking anywhere in the zone opens the
              file dialog while keeping the input fully functional. Selecting a
              file auto-fires the dry-run. We clear the input value after handing
              off the File so re-selecting the SAME filename (e.g. after fixing
              headers in place) still re-fires the dry-run (native file inputs
              only fire onChange when the value changes). */}
          <label
            className={`flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors ${
              busy
                ? 'cursor-not-allowed border-input bg-muted/30 opacity-60'
                : 'cursor-pointer border-input bg-muted/30 hover:border-primary/50 hover:bg-muted/60'
            }`}
          >
            {file ? (
              <FileSpreadsheet className="size-8 text-emerald-600" />
            ) : (
              <UploadCloud className="size-8 text-muted-foreground" />
            )}
            <div className="space-y-0.5">
              <div className="text-sm font-medium">
                {file ? file.name : 'Choose an .xlsx file'}
              </div>
              <div className="text-xs text-muted-foreground">
                {file
                  ? 'Click to choose a different file'
                  : 'Click to browse — .xlsx or .xls'}
              </div>
            </div>
            <input
              type="file"
              accept=".xlsx,.xls"
              disabled={busy}
              className="sr-only"
              onChange={(e) => { handlePick(e.target.files?.[0] ?? null); e.target.value = ''; }}
            />
          </label>

          {busy && phase === 'idle' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Validating…
            </div>
          )}

          {error && (
            <div className="text-sm text-red-600 flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}

          {report && (
            <div className="border rounded p-3 bg-muted/40 space-y-2 text-sm">
              <div className="font-medium">
                {phase === 'committed' ? 'Upload complete' : 'Dry-run results'}
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                <Stat label="Total"   value={report.summary.totalRows} />
                <Stat label="Created" value={report.summary.createdCount} tone="ok" />
                <Stat label="Skipped" value={report.summary.skipCount} tone="warn" />
                <Stat label="Failed"  value={report.summary.failedCount} tone="err" />
              </div>
              {!!report.results.length && (
                <div className="max-h-72 overflow-auto border rounded">
                  <table className="data-table w-full text-xs">
                    <thead>
                      <tr><th>Row</th><th>Status</th><th>Detail</th></tr>
                    </thead>
                    <tbody>
                      {report.results.slice(0, 200).map((r, i) => (
                        <tr key={i}>
                          <td className="!text-center">{r.rowNumber ?? '—'}</td>
                          <td className="!text-center">{r.status}</td>
                          <td className="!text-left">
                            {r.status === 'failed' ? (r.errors?.join('; ') ?? '') : (r.reason ?? r.pincode ?? '')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {phase === 'dry-run' && (report.summary.createdCount ?? 0) < 1 && (
                <div className="text-xs text-amber-700 flex items-center gap-1">
                  <AlertTriangle className="size-3.5" />
                  No rows would be created — check that the sheet headers match the
                  template (pincode / location / city_name / district).
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => router.push('/settings/pincodes')} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={!canCommit}
              title={
                !file
                  ? 'Pick a file first'
                  : phase !== 'dry-run'
                    ? 'Run the dry-run first'
                    : (report?.summary.createdCount ?? 0) < 1
                      ? 'No rows would be created — nothing to commit'
                      : ''
              }
              onClick={() => file && send(file, false)}
            >
              {busy && phase === 'dry-run' ? 'Uploading…' : 'Commit Upload'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Summary stat tile — identical to the helper in settings/pincodes/page.tsx.
function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'err' }) {
  const color =
    tone === 'ok' ? 'text-emerald-700'
      : tone === 'warn' ? 'text-amber-700'
      : tone === 'err' ? 'text-red-700'
      : '';
  return (
    <div className="border rounded p-2 bg-background">
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
