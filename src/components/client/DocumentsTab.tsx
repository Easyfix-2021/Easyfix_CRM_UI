'use client';

/*
 * Documents tab — upload + list + delete client documents.
 *
 * Backed by:
 *   GET    /admin/clients/:clientId/documents
 *   POST   /admin/clients/:clientId/documents/upload   (multipart)
 *   DELETE /admin/clients/documents/:id
 *
 * Doc types: pan | tan | gstin | aadhaar | other. Accepted MIMEs
 * mirror the BE allowlist: PNG / JPEG / WEBP / GIF / PDF, max 10MB.
 *
 * If the BE returns 503 (tbl_client_document not migrated yet), we
 * surface a clear hint with the migration filename so the user knows
 * exactly what to run.
 */

import { useRef, useState } from 'react';
import { FileText, Trash2, Upload, AlertCircle, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';

type ClientDocument = {
  document_id: number;
  client_id: number;
  doc_type: string;
  doc_label: string | null;
  s3_key: string;
  original_filename: string | null;
  content_type: string | null;
  uploaded_at: string;
  url: string | null;
};

const DOC_TYPES: { value: string; label: string }[] = [
  { value: 'pan',     label: 'PAN' },
  { value: 'tan',     label: 'TAN' },
  { value: 'gstin',   label: 'GSTIN' },
  { value: 'aadhaar', label: 'Aadhaar' },
  { value: 'other',   label: 'Other' },
];

type Props = {
  clientId: number;
  canEdit: boolean;
};

export function DocumentsTab({ clientId, canEdit }: Props) {
  const key = `/admin/clients/${clientId}/documents`;
  const { data, loading, error, refetch } = useFetch<ClientDocument[]>(key);
  const [uploading, setUploading] = useState(false);
  const [docType, setDocType] = useState('pan');
  const [docLabel, setDocLabel] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  const items = data ?? [];
  // 503 (storage not provisioned) returns a friendlier banner instead
  // of the generic error.
  const notProvisioned = !!error && /not provisioned|not migrated/i.test(error);

  async function onUpload() {
    if (!fileRef.current?.files?.[0]) {
      showToast({ variant: 'error', message: 'Choose a file first.' });
      return;
    }
    if (!docType) {
      showToast({ variant: 'error', message: 'Pick a document type.' });
      return;
    }
    setUploading(true);
    try {
      // FormData — api.post passes FormData through unchanged.
      const fd = new FormData();
      fd.append('file', fileRef.current.files[0]);
      fd.append('docType', docType);
      if (docLabel.trim()) fd.append('docLabel', docLabel.trim());
      await api.post<{ document_id: number; s3_key: string; url: string | null }>(
        `/admin/clients/${clientId}/documents/upload`,
        fd,
      );
      // Reset form
      if (fileRef.current) fileRef.current.value = '';
      setDocLabel('');
      invalidateFetch((k) => k === key);
      refetch();
      showToast({ variant: 'success', message: 'Document uploaded.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Upload failed.' });
    } finally { setUploading(false); }
  }

  async function onDelete(d: ClientDocument) {
    const ok = await confirm({
      title: 'Delete Document',
      description: `Delete ${docTypeLabel(d.doc_type)}${d.doc_label ? ` (${d.doc_label})` : ''}? This is a soft delete; an admin can restore it from the DB.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.delete<{ deleted: boolean }>(`/admin/clients/documents/${d.document_id}`);
      invalidateFetch((k) => k === key);
      refetch();
      showToast({ variant: 'success', message: 'Document deleted.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Delete failed.' });
    }
  }

  return (
    <div className="pt-2 space-y-3">
      {notProvisioned && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-2 flex items-start gap-2">
          <AlertCircle className="size-4 mt-0.5 shrink-0" />
          <div>
            Documents storage isn&apos;t provisioned on this environment. Run:
            <pre className="font-mono mt-1 text-[11px]">
              mysql … &lt; migrations/2026-05-25-create-client-documents.sql
            </pre>
          </div>
        </div>
      )}
      {!notProvisioned && error && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}

      {canEdit && !notProvisioned && (
        <div className="rounded border bg-card p-3 space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Upload New Document</div>
          <div className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-3">
              <Label className="text-xs">Type</Label>
              <select
                className="border rounded h-9 px-2 text-sm w-full bg-background"
                value={docType}
                onChange={(e) => setDocType(e.target.value)}
              >
                {DOC_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="col-span-4">
              <Label className="text-xs">Label (Optional)</Label>
              <Input value={docLabel} onChange={(e) => setDocLabel(e.target.value)} placeholder="e.g. FY 2025 PAN" maxLength={255} />
            </div>
            <div className="col-span-3">
              <Label className="text-xs">File</Label>
              <Input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" />
            </div>
            <div className="col-span-2">
              <Button onClick={onUpload} disabled={uploading} className="w-full">
                <Upload className="size-3.5 mr-1" /> {uploading ? 'Uploading…' : 'Upload'}
              </Button>
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground">
            PNG / JPEG / WEBP / GIF / PDF · max 10 MB.
          </div>
        </div>
      )}

      <div>
        <div className="text-xs text-muted-foreground mb-1">
          {loading ? 'Loading…' : `${items.length} document${items.length === 1 ? '' : 's'}`}
        </div>
        {!loading && items.length === 0 && !notProvisioned && (
          <div className="text-sm text-muted-foreground italic">No documents uploaded.</div>
        )}
        <ul className="space-y-1">
          {items.map((d) => (
            <li key={d.document_id} className="rounded border bg-card px-3 py-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium flex items-center gap-2">
                  <FileText className="size-3.5 text-muted-foreground" />
                  <span>{docTypeLabel(d.doc_type)}</span>
                  {d.doc_label && <span className="text-muted-foreground">— {d.doc_label}</span>}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                  {d.original_filename && <span>{d.original_filename}</span>}
                  {d.url && (
                    <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline inline-flex items-center gap-0.5">
                      <ExternalLink className="size-3" /> Open
                    </a>
                  )}
                </div>
              </div>
              {canEdit && (
                <Button size="sm" variant="ghost" onClick={() => onDelete(d)} className="text-red-600 hover:text-red-700">
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function docTypeLabel(t: string): string {
  const found = DOC_TYPES.find((d) => d.value === t);
  return found?.label ?? t.toUpperCase();
}
