'use client';

import * as React from 'react';
import { Loader2, UploadCloud } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { showToast } from '@/components/ui/toast';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { Label } from '@/components/ui/label';
import { RetentionNote } from './retention-note';
import type { ReportDetail } from './types';

/*
 * Upload dialog — Replace or Append a report's data from a filled .xlsx/.csv.
 * Append is disabled whenever the current upload's columns no longer match
 * the report definition (`columnsChanged`) or there's no current upload to
 * append onto — same rule the contract states for the BE 400.
 */
export function UploadDialog({
  reportId,
  current,
  columnsChanged,
  onClose,
  onUploaded,
}: {
  reportId: number;
  current: ReportDetail['current'];
  columnsChanged: boolean;
  onClose: () => void;
  onUploaded: (detail: ReportDetail) => void;
}) {
  const [file, setFile] = React.useState<File | null>(null);
  const [mode, setMode] = React.useState<'replace' | 'append'>('replace');
  const [submitting, setSubmitting] = React.useState(false);
  const guardedOpenChange = useFormDirtyGuard(onClose, { isDirty: () => !!file, when: () => !submitting });

  const appendDisabled = !current || columnsChanged;
  const appendReason = !current
    ? 'No current upload to append onto yet.'
    : columnsChanged
      ? 'The report’s columns changed since the last upload — append is disabled until you Replace.'
      : null;

  async function submit() {
    if (!file || submitting) return;
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', mode);
      const detail = await api.post<ReportDetail>(`/admin/quicksight/dynamic-reports/${reportId}/upload`, fd);
      showToast({ variant: 'success', message: 'Upload complete.' });
      onUploaded(detail);
      onClose();
    } catch (e) {
      // Contract: the 400 `error` text is operator-readable (header mismatch,
      // row errors, caps) — surface it verbatim rather than a generic message.
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Upload failed.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadCloud className="size-4" /> Upload Data
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="block mb-1" required>File (.xlsx or .csv)</Label>
            <input
              type="file"
              accept=".xlsx,.csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label className="block">Mode</Label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="radio" className="accent-primary" checked={mode === 'replace'} onChange={() => setMode('replace')} />
              Replace — the new file becomes the current upload
            </label>
            <label className={`flex items-center gap-1.5 text-sm ${appendDisabled ? 'text-muted-foreground' : ''}`}>
              <input
                type="radio"
                className="accent-primary"
                checked={mode === 'append'}
                disabled={appendDisabled}
                onChange={() => setMode('append')}
              />
              Append — add these rows to the current upload
            </label>
            {appendDisabled && appendReason && (
              <p className="text-xs text-muted-foreground pl-5">{appendReason}</p>
            )}
          </div>

          <RetentionNote />
        </div>

        <DialogFooter>
          <CancelButton onCancel={onClose} disabled={submitting} />
          <Button onClick={submit} disabled={!file || submitting}>
            {submitting ? <><Loader2 className="mr-1 size-4 animate-spin" /> Uploading…</> : 'Upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
