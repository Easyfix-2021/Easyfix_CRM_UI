'use client';

/*
 * Shared bulk-import dialog for both Materials and Brands: Download
 * Template → pick a file (auto-fires a preview) → review outcomes →
 * Download Error Report (blocked rows) → Import (commits the same file).
 * Parameterized by the caller so the one component covers both entities'
 * endpoints and preview-row shapes (see the contract's Materials vs
 * Brands import tables).
 */

import { useState } from 'react';
import { AlertTriangle, FileSpreadsheet, UploadCloud } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { DownloadButton } from '@/components/ui/download-button';
import { StatusChip, type StatusChipTone } from '@/components/ui/StatusChip';
import { showToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { downloadXlsx } from '@/lib/download-xlsx';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import type { ImportRow } from './types';

function outcomeTone(outcome: string): StatusChipTone {
  switch (outcome) {
    case 'NEW': return 'success';
    case 'UPDATE': return 'info';
    case 'EXISTS': return 'neutral';
    case 'PRICE_PENDING': return 'warning';
    case 'BLOCKED': return 'urgent';
    default: return 'neutral';
  }
}

export function ImportDialog<S extends Record<string, unknown>>({
  open,
  onClose,
  entityLabel,
  templateUrl,
  templateFilename,
  previewUrl,
  commitUrl,
  errorsUrl,
  renderRowLabel,
  summaryStats,
  extraNotice,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  entityLabel: string; // "Material" | "Brand"
  templateUrl: string;
  templateFilename: string;
  previewUrl: string;
  commitUrl: string;
  errorsUrl: string;
  renderRowLabel: (row: ImportRow) => string;
  summaryStats: (summary: S) => Array<{ label: string; value: number; tone?: 'ok' | 'warn' | 'err' }>;
  extraNotice?: (summary: S) => React.ReactNode;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [summary, setSummary] = useState<S | null>(null);
  const [phase, setPhase] = useState<'idle' | 'preview' | 'committed'>('idle');
  const [busy, setBusy] = useState(false);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const [downloadingErrors, setDownloadingErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setRows(null);
    setSummary(null);
    setPhase('idle');
    setError(null);
  }

  function handleClose() {
    if (busy) return;
    reset();
    onClose();
  }

  async function downloadTemplate() {
    setDownloadingTemplate(true);
    setError(null);
    try {
      await downloadXlsx({ url: templateUrl, filename: templateFilename });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloadingTemplate(false);
    }
  }

  async function runPreview(picked: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', picked);
      const res = await api.post<{ rows: ImportRow[]; summary: S }>(previewUrl, fd);
      setRows(res.rows);
      setSummary(res.summary);
      setPhase('preview');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  }

  function handlePick(picked: File | null) {
    setFile(picked);
    setRows(null);
    setSummary(null);
    setError(null);
    setPhase('idle');
    if (picked) void runPreview(picked);
  }

  async function downloadErrors() {
    if (!file) return;
    setDownloadingErrors(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const base = process.env.NEXT_PUBLIC_API_URL || '/api';
      const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
      const resp = await fetch(`${base}${errorsUrl}`, {
        method: 'POST',
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `${entityLabel.toLowerCase()}-import-errors.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error report download failed');
    } finally {
      setDownloadingErrors(false);
    }
  }

  async function commitImport() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.post<{ summary: S }>(commitUrl, fd);
      setSummary(res.summary);
      setPhase('committed');
      showToast({ variant: 'success', message: `${entityLabel} import complete.` });
      onImported();
      handleClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  const hasBlocked = !!rows?.some((r) => r.outcome === 'BLOCKED');
  const canCommit = !!file && phase === 'preview' && !busy && !!rows?.some((r) => r.outcome !== 'BLOCKED');

  // Not a form with free-text input — a picked file is easy to re-pick, so
  // this closes plainly (still respecting an in-flight request) rather than
  // prompting "discard changes?".
  const guardedOpenChange = useFormDirtyGuard(handleClose, { isDirty: false, when: () => !busy });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import {entityLabel}s</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Download the template, fill it in, then pick the file — it validates automatically without saving anything.
            </p>
            <DownloadButton
              onClick={downloadTemplate}
              downloading={downloadingTemplate}
              label="Download Template"
              loadingLabel="Preparing…"
            />
          </div>

          <label
            className={`flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors ${
              busy
                ? 'cursor-not-allowed border-input bg-muted/30 opacity-60'
                : 'cursor-pointer border-input bg-muted/30 hover:border-primary/50 hover:bg-muted/60'
            }`}
          >
            {file ? <FileSpreadsheet className="size-8 text-success" /> : <UploadCloud className="size-8 text-muted-foreground" />}
            <div className="space-y-0.5">
              <div className="text-sm font-medium">{file ? file.name : 'Choose an .xlsx file'}</div>
              <div className="text-xs text-muted-foreground">{file ? 'Click to choose a different file' : 'Click to browse — .xlsx or .xls'}</div>
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
            <div className="text-sm text-urgent flex items-center gap-1">
              <AlertTriangle className="size-4" /> {error}
            </div>
          )}

          {summary && rows && (
            <div className="border rounded p-3 bg-muted/40 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <div className="font-medium">{phase === 'committed' ? 'Import Complete' : 'Preview Results'}</div>
                {hasBlocked && (
                  <Button variant="outline" size="sm" onClick={downloadErrors} disabled={downloadingErrors}>
                    {downloadingErrors ? 'Preparing…' : 'Download Error Report'}
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                {summaryStats(summary).map((s) => (
                  <div key={s.label} className="border rounded p-2 bg-background">
                    <div className={`text-lg font-semibold ${s.tone === 'ok' ? 'text-success-strong' : s.tone === 'warn' ? 'text-warning-strong' : s.tone === 'err' ? 'text-urgent-strong' : ''}`}>
                      {s.value}
                    </div>
                    <div className="text-xs text-muted-foreground">{s.label}</div>
                  </div>
                ))}
              </div>
              {extraNotice?.(summary)}
              {rows.length > 0 && (
                <div className="max-h-64 overflow-auto border rounded">
                  <table className="data-table w-full text-xs">
                    <thead><tr><th>Row</th><th>Name</th><th>Outcome</th><th>Errors</th></tr></thead>
                    <tbody>
                      {rows.slice(0, 200).map((r) => (
                        <tr key={r.row_number}>
                          <td className="!text-center">{r.row_number}</td>
                          <td className="!text-left">{renderRowLabel(r)}</td>
                          <td className="!text-center"><StatusChip tone={outcomeTone(r.outcome)} size="sm">{r.outcome}</StatusChip></td>
                          <td className="!text-left text-muted-foreground">{r.errors?.join('; ') ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-3">
          <CancelButton onCancel={handleClose} disabled={busy} />
          <Button onClick={commitImport} disabled={!canCommit}>
            {busy && phase === 'preview' ? 'Importing…' : 'Import'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
