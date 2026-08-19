'use client';

import { useEffect, useRef, useState } from 'react';
import { Upload, Trash2, FileText, Loader2 } from 'lucide-react';
import { api, ApiError, type JobDocument, type JobDocumentCategory } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';

/*
 * JobDocumentsCard — Job Sheet + Purchase Order upload / view / delete
 * widgets for the Billing & Charges workspace tab. Replicates the legacy
 * CheckIn-detail document attachments.
 *
 *   upload  : multipart POST /admin/jobs/:id/documents { category, file }
 *   view    : AuthImage (Blob-fetch → object URL) — see the note on the
 *             component below; the doc endpoints are Bearer-authenticated,
 *             so a plain <img src> 401s.
 *   delete  : useConfirm → DELETE /admin/jobs/:id/documents/:imageId
 *
 * Every mutation calls the parent's `onMutated` so the shared charges
 * fetch re-runs (the GET returns the documents lists too).
 */

/* ─────────────────────────────────────────────────────────────────────
 * AuthImage — render an image from an authenticated endpoint.
 *
 * Established convention here (see the Images tab + memory note
 * `feedback_easyfix_auth_image_rendering`): a plain <img src> to an
 * authenticated /admin/* endpoint 401s because the browser can't attach
 * the Bearer header. Instead we fetch() the URL (with credentials + the
 * Bearer token for same-origin backend paths), read the response as a
 * Blob, and hand an object URL to <img>. The object URL is revoked on
 * unmount / src change to avoid leaks.
 *
 * `url` may be a relative API path (resolved against NEXT_PUBLIC_API_URL)
 * or an absolute presigned URL; the Authorization header + cookies are
 * only sent to our own backend (an absolute presigned URL already carries
 * its signature and would reject a stray auth header).
 *
 * The raw fetch lives in this module-level helper (not inline in the
 * effect) both to keep the effect tidy and because useFetch/useFetchOnce
 * only handle JSON — a binary Blob needs a direct fetch.
 * ───────────────────────────────────────────────────────────────────── */
async function fetchAsObjectUrl(url: string): Promise<string> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || '/api';
  const isAbsolute = /^https?:\/\//i.test(url);
  const fetchUrl = isAbsolute ? url : `${apiBase}${url.startsWith('/') ? '' : '/'}${url}`;
  const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
  // Only attach our auth to our OWN backend. Presigned/absolute URLs are
  // self-authenticating; a stray Authorization header can make S3 400.
  const headers: Record<string, string> = !isAbsolute && token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(fetchUrl, { credentials: isAbsolute ? 'omit' : 'include', headers, cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function AuthImage({
  url,
  alt,
  className,
  clickToOpen = true,
}: {
  url: string;
  alt: string;
  className?: string;
  clickToOpen?: boolean;
}) {
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setStatus('loading');
    setObjUrl(null);

    fetchAsObjectUrl(url)
      .then((objectUrl) => {
        // Revoke immediately if this effect was cleaned up mid-flight —
        // otherwise the object URL would leak (cleanup already ran).
        if (cancelled) { URL.revokeObjectURL(objectUrl); return; }
        createdUrl = objectUrl;
        setObjUrl(objectUrl);
        setStatus('ready');
      })
      .catch(() => { if (!cancelled) setStatus('error'); });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [url]);

  if (status === 'loading') {
    return (
      <div className={`flex items-center justify-center bg-muted/40 ${className ?? ''}`}>
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (status === 'error' || !objUrl) {
    return (
      <div className={`flex flex-col items-center justify-center gap-0.5 bg-muted/40 text-xs text-muted-foreground ${className ?? ''}`}>
        <FileText className="size-4" />
        <span>Unavailable</span>
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  const img = <img src={objUrl} alt={alt} className={`object-cover ${className ?? ''}`} />;
  if (!clickToOpen) return img;
  return (
    <a href={objUrl} target="_blank" rel="noopener noreferrer" title={alt} className="block">
      {img}
    </a>
  );
}

/* ─── One category widget (Job Sheet OR Purchase Order) ───────────────── */
function DocumentWidget({
  jobId,
  category,
  title,
  docs,
  canManage,
  onMutated,
}: {
  jobId: number;
  category: JobDocumentCategory;
  title: string;
  docs: JobDocument[];
  canManage: boolean;
  onMutated: () => void;
}) {
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      await api.uploadJobDocument(jobId, category, file);
      showToast({ variant: 'success', message: `${title} Uploaded` });
      onMutated();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : `Failed to upload ${title.toLowerCase()}` });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleDelete(imageId: number) {
    const ok = await confirm({
      title: `Delete ${title}?`,
      description: 'This attachment will be removed from the job. This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    setDeletingId(imageId);
    try {
      await api.deleteJobDocument(jobId, imageId);
      showToast({ variant: 'success', message: `${title} Deleted` });
      onMutated();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Delete failed' });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="text-sm font-semibold text-ink-700">{title}</div>
        {canManage && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Upload className="size-3.5 mr-1" />}
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </>
        )}
      </div>
      <div className="p-4">
        {docs.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">No {title.toLowerCase()} uploaded.</div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {docs.map((d) => (
              <div key={d.image_id} className="relative">
                <AuthImage
                  url={d.url}
                  alt={`${title} #${d.image_id}`}
                  className="h-24 w-24 rounded-md border"
                />
                {canManage && (
                  <button
                    type="button"
                    aria-label={`Delete ${title}`}
                    disabled={deletingId === d.image_id}
                    onClick={() => void handleDelete(d.image_id)}
                    className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full border border-urgent bg-card text-urgent-strong shadow-sm hover:bg-urgent/15 disabled:opacity-50"
                  >
                    {deletingId === d.image_id
                      ? <Loader2 className="size-3 animate-spin" />
                      : <Trash2 className="size-3" />}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function JobDocumentsCard({
  jobId,
  jobSheet,
  purchaseOrder,
  canManage,
  onMutated,
}: {
  jobId: number;
  jobSheet: JobDocument[];
  purchaseOrder: JobDocument[];
  canManage: boolean;
  onMutated: () => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <DocumentWidget
        jobId={jobId}
        category="JobSheet"
        title="Job Sheet"
        docs={jobSheet}
        canManage={canManage}
        onMutated={onMutated}
      />
      <DocumentWidget
        jobId={jobId}
        category="PurchaseOrder"
        title="Purchase Order"
        docs={purchaseOrder}
        canManage={canManage}
        onMutated={onMutated}
      />
    </div>
  );
}
