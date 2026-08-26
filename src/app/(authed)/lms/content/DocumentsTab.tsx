'use client';

/*
 * Documents — the PPT/PDF tab of LMS ▸ Content.
 *
 * Unlike Training Videos next door, this catalogue OWNS its media:
 * `lms_document.file_key` is an S3 object key and the list endpoint presigns it
 * per read. That is why a URL is never stored and never edited here — a stored
 * link would either expire or have to be public — and why the file itself is
 * immutable after upload: there is no replace endpoint, and swapping the file
 * under an id would silently change what every technician who already
 * acknowledged it agreed they had read. Re-upload as a new document instead.
 *
 * COMPLETION, for context on why an "Acknowledge" concept exists at all: a PPT
 * has no watch percentage, so a technician completes a document by
 * acknowledging it (lms_document_ack, keyed on the CONTENT row — the same PDF
 * in two courses must be acknowledged for each). Nothing on this tab writes
 * that; it is the technician app's side of the same model.
 *
 * Backend: /admin/lms/documents, gated by requireLmsManage for writes.
 */

import * as React from 'react';
import {
  Search, Plus, Pencil, Trash2, AlertTriangle, ExternalLink, UploadCloud, FileText,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { IconButton } from '@/components/ui/icon-button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TablePagination, type TablePageSize, pageSizeToLimit } from '@/components/ui/table-pagination';
import { api, ApiError } from '@/lib/api';
import { useFetch, useDebouncedValue, invalidateFetch } from '@/lib/hooks';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useMe } from '@/lib/auth-context';
import { actionFlags } from '@/lib/permissions';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import { formatDate } from '@/lib/utils';

type LmsDocument = {
  id: number;
  title: string;
  mime_type: string;
  size_bytes: number | null;
  page_count: number | null;
  created_at: string | null;
  /* Presigned by the list endpoint on every read. Short-lived by nature, so it
   * is only ever handed to a click — never persisted, never put in an <img>. */
  url: string | null;
};
type ListResponse = { rows: LmsDocument[]; total: number; limit: number; offset: number };

const MAX_TITLE = 255;

/*
 * 'All' is withheld, same as the courses list. This endpoint's own `limit`
 * ceiling is not something the page can see, and TablePagination's 'All'
 * renders "Showing 1–N of N" whether or not the server actually returned N —
 * a silent lie on any endpoint that caps lower. Guessing a cap here would be
 * inventing a number the API never promised.
 */
const PAGE_SIZES: ReadonlyArray<{ value: TablePageSize; label: string }> = [
  { value: 10, label: '10' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
];

/*
 * What the file picker accepts. Extensions AND mime types: Windows reports the
 * Office types inconsistently, and an extension-only accept silently rejects a
 * .pptx served from some corporate installs. The backend re-validates the mime
 * and is the real gate — this only shapes the OS dialog.
 */
const ACCEPT = [
  '.pdf', '.ppt', '.pptx',
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
].join(',');

/* Client-side size ceiling, mirrored from the backend's upload limit so a
 * 90 MB deck fails instantly instead of after a two-minute upload. */
const MAX_BYTES = 25 * 1024 * 1024;

function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/* PPT vs PDF, for the type column. Anything else is shown verbatim rather than
 * guessed at — an unexpected mime is information, not a rendering problem. */
function kindLabel(mime: string): string {
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'PPT';
  return mime;
}

export function DocumentsTab() {
  const confirm = useConfirm();
  const { me } = useMe();
  const can = actionFlags(me, ['isLmsManage']);

  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState<TablePageSize>(20);
  const [editing, setEditing] = React.useState<LmsDocument | null>(null);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [retiringId, setRetiringId] = React.useState<number | null>(null);

  const dq = useDebouncedValue(search, 300);
  /* A narrowed search invalidates the page number — page 3 of the full list is
   * usually past the end of a filtered one, and the table would go blank with
   * no visible cause. */
  React.useEffect(() => { setPage(0); }, [dq]);

  const limit = pageSizeToLimit(pageSize);
  const offset = page * limit;
  const qs = new URLSearchParams();
  if (dq.trim()) qs.set('q', dq.trim());
  qs.set('limit', String(limit));
  qs.set('offset', String(offset));
  const listUrl = `/admin/lms/documents?${qs.toString()}`;

  const { data, loading, error, refetch } = useFetch<ListResponse>(listUrl);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  /* Both calls are load-bearing: invalidateFetch only EVICTS the module cache
   * (no subscribers), so a mounted useFetch keeps rendering its last result
   * until refetch() re-runs the effect. */
  function refresh() {
    invalidateFetch((k) => k.startsWith('/admin/lms/documents'));
    refetch();
  }

  async function handleRetire(d: LmsDocument) {
    const ok = await confirm({
      title: 'Retire This Document?',
      description:
        `"${d.title}" will stop appearing in the picker when building a course. This is a soft `
        + 'retire — the file is not deleted, and any course that already contains it keeps working. '
        + 'A document still used by a course cannot be retired.',
      confirmLabel: 'Retire',
      variant: 'destructive',
    });
    if (!ok) return;
    setRetiringId(d.id);
    try {
      await api.delete(`/admin/lms/documents/${d.id}`);
      showToast({ variant: 'success', message: `"${d.title}" Retired.` });
      refresh();
    } catch (e) {
      /* 409 = still referenced by an lms_content row. The count is not on the
       * list response, so unlike the videos tab this cannot be pre-disabled —
       * the server's message names the blocker and is shown verbatim. */
      showToast({
        variant: 'error',
        message: e instanceof ApiError ? e.message : 'Retire Failed.',
      });
      refresh();
    } finally {
      setRetiringId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            PPT and PDF material a technician reads and acknowledges. Add one to a course from
            LMS ▸ Manage Courses.
          </p>
          <p className="text-xs text-muted-foreground mt-1 max-w-3xl">
            The file is stored once and cannot be swapped afterwards — technicians acknowledge a
            specific document, so replacing the file under it would change what they agreed they had
            read. Upload a new document instead.
          </p>
        </div>
        {can.isLmsManage && (
          <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
            <Plus className="size-4 mr-1" /> Add Document
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-3 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="size-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by title…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-3 flex items-center gap-2 text-sm text-urgent">
            <AlertTriangle className="size-4" /> {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="data-table w-full" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {/* Title */}
              <col style={{ width: '46%' }} />
              {/* Type */}
              <col style={{ width: '12%' }} />
              {/* Size */}
              <col style={{ width: '12%' }} />
              {/* Added */}
              <col style={{ width: '16%' }} />
              {/* Actions */}
              <col style={{ width: '14%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="!text-left whitespace-nowrap">Title</th>
                <th className="!text-center whitespace-nowrap">Type</th>
                <th className="!text-right whitespace-nowrap">Size</th>
                <th className="!text-left whitespace-nowrap">Added</th>
                <th className="!text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {Array.from({ length: 5 }).map((_, c) => (
                    <td key={c}><div className="h-3 w-24 rounded bg-muted animate-pulse" /></td>
                  ))}
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="!text-center text-muted-foreground py-8">
                    No documents match the current search.
                  </td>
                </tr>
              )}
              {!loading && rows.map((d) => (
                <tr key={d.id}>
                  <td className="!text-left font-medium truncate" title={d.title}>
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{d.title}</span>
                    </span>
                    {/* Page count is optional on the row — the backend fills it
                        only for formats it can count. Shown when known because
                        "how long is this" is the first thing an operator
                        building a syllabus wants. */}
                    {d.page_count !== null && (
                      <span className="block text-xs text-muted-foreground">
                        {d.page_count} page{d.page_count === 1 ? '' : 's'}
                      </span>
                    )}
                  </td>
                  <td className="!text-center whitespace-nowrap text-xs">{kindLabel(d.mime_type)}</td>
                  <td className="!text-right whitespace-nowrap tabular-nums">{formatBytes(d.size_bytes)}</td>
                  <td className="!text-left whitespace-nowrap">{formatDate(d.created_at)}</td>
                  <td className="!text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-0.5">
                      {/*
                        Opening the file is a READ and is not gated — someone
                        reviewing what technicians are being taught needs it
                        whether or not they can edit the catalogue.

                        window.open, not an <a>: the href is a presigned S3 URL
                        that expires, so it must be read at click time rather
                        than baked into the DOM at render time. `noopener` is
                        set explicitly because the opened tab is a third-party
                        origin.
                      */}
                      <IconButton
                        icon={ExternalLink}
                        label={d.url ? 'Open Document' : 'File Not Available'}
                        disabled={!d.url}
                        onClick={() => { if (d.url) window.open(d.url, '_blank', 'noopener,noreferrer'); }}
                      />
                      {can.isLmsManage && (
                        <IconButton
                          icon={Pencil}
                          label="Rename Document"
                          intent="primary"
                          onClick={() => { setEditing(d); setModalOpen(true); }}
                        />
                      )}
                      {can.isLmsManage && (
                        <IconButton
                          icon={Trash2}
                          label="Retire Document"
                          intent="danger"
                          busy={retiringId === d.id}
                          onClick={() => handleRetire(d)}
                        />
                      )}
                      {!can.isLmsManage && (
                        <span className="text-xs text-muted-foreground">View Only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-3 py-2 border-t">
            <TablePagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
              pageSizeOptions={PAGE_SIZES}
            />
          </div>
        </CardContent>
      </Card>

      {can.isLmsManage && (
        <DocumentFormModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          editing={editing}
          onSaved={() => { setModalOpen(false); refresh(); }}
        />
      )}
    </div>
  );
}

/* ─── Add (upload) / Rename modal ───────────────────────────────────────── */

/*
 * One modal, two shapes, because they are two genuinely different operations:
 *   Add    — title + FILE, multipart POST. The file is required.
 *   Rename — title only, JSON PATCH. There is no file control at all, rather
 *            than a disabled one: a greyed-out file picker reads as "not right
 *            now", when the truth is "never for this document".
 */
function DocumentFormModal({
  open, onClose, editing, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing: LmsDocument | null;
  onSaved: () => void;
}) {
  const isEdit = !!editing;
  const [title, setTitle] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* Seed on OPEN, not on close — the dialog animates out, and clearing during
   * that window makes the fields visibly blank as it fades. */
  React.useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? '');
    setFile(null);
    setError(null);
  }, [open, editing]);

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !submitting });

  function pickFile(f: File | null) {
    setError(null);
    if (!f) { setFile(null); return; }
    if (f.size > MAX_BYTES) {
      setError(`That file is ${formatBytes(f.size)}. The limit is ${formatBytes(MAX_BYTES)}.`);
      setFile(null);
      return;
    }
    setFile(f);
    /* Default the title to the filename minus its extension, but only while the
     * operator has not typed one — a helpful default, never an overwrite. */
    setTitle((t) => (t.trim() ? t : f.name.replace(/\.[^.]+$/, '').slice(0, MAX_TITLE)));
  }

  async function handleSubmit() {
    const t = title.trim();
    if (!t) { setError('Title is required.'); return; }
    if (!isEdit && !file) { setError('Choose a PPT or PDF file to upload.'); return; }
    setError(null);
    setSubmitting(true);
    try {
      if (isEdit) {
        await api.patch(`/admin/lms/documents/${editing!.id}`, { title: t });
        showToast({ variant: 'success', message: 'Document Renamed.' });
      } else {
        /* Multipart, not JSON — api.post passes a FormData body straight
         * through and deliberately omits the Content-Type header so the
         * browser can set its own multipart boundary. */
        const fd = new FormData();
        fd.append('title', t);
        fd.append('file', file!);
        await api.post<{ id: number }>('/admin/lms/documents', fd);
        showToast({ variant: 'success', message: 'Document Uploaded.' });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="truncate">
            {isEdit ? `Rename "${editing!.title}"` : 'Add Document'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {!isEdit && (
            <div>
              <Label className="block mb-1" required>File</Label>
              <label className="flex items-center justify-center gap-2 h-9 rounded-md border border-dashed border-input bg-background px-3 text-sm cursor-pointer hover:bg-muted/40 transition-colors">
                <UploadCloud className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground truncate">
                  {file ? `${file.name} · ${formatBytes(file.size)}` : 'Choose A PPT Or PDF File'}
                </span>
                <input
                  type="file"
                  accept={ACCEPT}
                  className="hidden"
                  disabled={submitting}
                  onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <p className="text-xs text-muted-foreground mt-0.5">
                PPT, PPTX or PDF, up to {formatBytes(MAX_BYTES)}. The file cannot be changed after
                upload.
              </p>
            </div>
          )}

          {isEdit && (
            <p className="text-xs text-muted-foreground">
              Renaming changes only the label operators and technicians see. The file itself,
              its type and its size are unchanged — {kindLabel(editing!.mime_type)} ·{' '}
              {formatBytes(editing!.size_bytes)}.
            </p>
          )}

          <div>
            <Label className="block mb-1" required>Title</Label>
            <Input
              value={title}
              maxLength={MAX_TITLE}
              onChange={(e) => setTitle(e.target.value)}
              placeholder='e.g. "Treadmill Belt Alignment — Field Guide"'
            />
          </div>

          {error && (
            <div className="text-sm text-urgent flex items-start gap-1">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" /> {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <CancelButton onCancel={onClose} disabled={submitting} />
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting
                ? (isEdit ? 'Saving…' : 'Uploading…')
                : (isEdit ? 'Save Changes' : 'Upload Document')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
