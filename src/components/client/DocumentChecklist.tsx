'use client';

/*
 * Client Profile → Overview → the document column.
 *
 * Replaces DocumentsTab (deleted). Same three endpoints, same tbl_client_document
 * rows, same 10MB / PNG-JPEG-WEBP-GIF-PDF allowlist:
 *   GET    /admin/clients/:clientId/documents
 *   POST   /admin/clients/:clientId/documents/upload   (multipart)
 *   DELETE /admin/clients/documents/:id
 *
 * WHY REPLACE RATHER THAN REUSE. DocumentsTab asked the operator to pick a type
 * from a dropdown, type a label and then choose a file — three decisions for a
 * task that is really a checklist ("has this client given us their PAN yet?").
 * The answer to that question was only visible by reading the list. Here the
 * question IS the UI: every expected document is a named slot that is either
 * filled or shows an upload control, so a gap is visible without reading
 * anything. Anything uploaded outside the named set still renders, under
 * "Other documents", so nothing becomes unreachable.
 *
 * SLOT → doc_type MAPPING. The backend vocabulary is fixed
 * (pan | tan | gstin | aadhaar | other) and predates the labels ops use, so the
 * slots translate rather than rename the API:
 *   CIN  → tan       (the legacy CIN-in-tan_number convention, same as the
 *                     create form's "CIN NO" field)
 *   PAN  → pan
 *   GST  → gstin
 *   MOU  → aadhaar   (the legacy MOU-in-client_aadhaar convention)
 *   Logo → other, doc_label 'Logo'
 * Logo, Profile Photo and About Media all ride on 'other' distinguished by
 * doc_label, because inventing three new doc_type values would mean a backend
 * enum change for what is purely a labelling distinction.
 */

import { useMemo, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf';

type Slot = {
  key: string;
  label: string;
  docType: 'pan' | 'tan' | 'gstin' | 'aadhaar' | 'other';
  /* Only for 'other' slots — the doc_label that identifies this slot. */
  docLabel?: string;
};

const CHECKLIST: Slot[] = [
  { key: 'cin',  label: 'CIN',  docType: 'tan' },
  { key: 'pan',  label: 'PAN',  docType: 'pan' },
  { key: 'gst',  label: 'GST',  docType: 'gstin' },
  { key: 'mou',  label: 'MOU',  docType: 'aadhaar' },
  { key: 'logo', label: 'Logo', docType: 'other', docLabel: 'Logo' },
];

const PROFILE_PHOTO: Slot = { key: 'photo', label: 'Profile Photo', docType: 'other', docLabel: 'Profile Photo' };
const ABOUT_MEDIA_LABEL = 'About Media';

export function DocumentChecklist({ clientId, canEdit }: { clientId: number; canEdit: boolean }) {
  const key = `/admin/clients/${clientId}/documents`;
  const { data, loading, error, refetch } = useFetch<ClientDocument[]>(key);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const confirm = useConfirm();

  const items = useMemo(() => data ?? [], [data]);
  // 503 from the BE when tbl_client_document has not been provisioned.
  const notProvisioned = !!error && /not provisioned|not migrated/i.test(error);

  /* First match wins — re-uploading a slot adds a row rather than replacing
     one, and the newest row is what the endpoint returns first. */
  function find(slot: Slot): ClientDocument | undefined {
    return items.find((d) => d.doc_type === slot.docType
      && (slot.docLabel ? (d.doc_label ?? '') === slot.docLabel : true));
  }

  /* Everything the named slots did not claim. */
  const aboutMedia = items.filter((d) => (d.doc_label ?? '') === ABOUT_MEDIA_LABEL);
  const claimed = new Set<number>();
  for (const s of [...CHECKLIST, PROFILE_PHOTO]) {
    const hit = find(s);
    if (hit) claimed.add(hit.document_id);
  }
  for (const m of aboutMedia) claimed.add(m.document_id);
  const others = items.filter((d) => !claimed.has(d.document_id));

  async function upload(slotKey: string, file: File, docType: string, docLabel?: string) {
    setBusySlot(slotKey);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('docType', docType);
      if (docLabel) fd.append('docLabel', docLabel);
      await api.post(`/admin/clients/${clientId}/documents/upload`, fd as never);
      invalidateFetch((k) => k === key);
      refetch();
      showToast({ variant: 'success', message: 'Document uploaded.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Upload failed.' });
    } finally { setBusySlot(null); }
  }

  async function remove(d: ClientDocument, label: string) {
    const ok = await confirm({
      title: 'Remove Document',
      description: `Remove ${label}${d.original_filename ? ` (${d.original_filename})` : ''}? This is a soft delete — an admin can restore it from the DB.`,
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.delete(`/admin/clients/documents/${d.document_id}`);
      invalidateFetch((k) => k === key);
      refetch();
      showToast({ variant: 'success', message: 'Document removed.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Remove failed.' });
    }
  }

  if (notProvisioned) {
    return (
      <aside className="space-y-2">
        <h4 className="text-sm font-semibold">Document Checklist</h4>
        <div className="text-xs text-warning-strong bg-warning-tint border border-warning rounded px-2 py-2 flex items-start gap-2">
          <AlertCircle className="size-4 mt-0.5 shrink-0" />
          <div>
            Document storage isn&apos;t provisioned here. Run:
            <pre className="font-mono mt-1 text-xs whitespace-pre-wrap">
              migrations/2026-05-25-create-client-documents.sql
            </pre>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="space-y-5">
      <section className="space-y-2">
        <h4 className="text-sm font-semibold">Document Checklist</h4>
        {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {!loading && error && (
          <p className="text-xs text-urgent-strong flex items-center gap-1">
            <AlertCircle className="size-3.5" /> {error}
          </p>
        )}
        <ul className="space-y-2">
          {CHECKLIST.map((slot) => (
            <SlotRow
              key={slot.key}
              slot={slot}
              doc={find(slot)}
              canEdit={canEdit}
              busy={busySlot === slot.key}
              onUpload={(file) => upload(slot.key, file, slot.docType, slot.docLabel)}
              onRemove={(d) => remove(d, slot.label)}
            />
          ))}
        </ul>
        <p className="text-xs bg-info-tint text-info-strong border-l-2 border-info rounded-r px-2 py-1.5">
          Attach NDA, SLA, MOU and the signed rate card here — anything without a
          slot goes under &ldquo;Other&rdquo;.
        </p>
        <SlotUploadButton
          label="Other"
          canEdit={canEdit}
          busy={busySlot === 'other'}
          onPick={(file) => upload('other', file, 'other')}
        />
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">Profile Photo</h4>
        <SlotRow
          slot={PROFILE_PHOTO}
          doc={find(PROFILE_PHOTO)}
          canEdit={canEdit}
          busy={busySlot === PROFILE_PHOTO.key}
          preview
          onUpload={(file) => upload(PROFILE_PHOTO.key, file, PROFILE_PHOTO.docType, PROFILE_PHOTO.docLabel)}
          onRemove={(d) => remove(d, PROFILE_PHOTO.label)}
        />
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">About-The-Client Media</h4>
        <p className="text-xs text-muted-foreground">Briefing decks, site videos, walkthrough PDFs.</p>
        {aboutMedia.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground italic">Nothing uploaded.</p>
        )}
        <ul className="space-y-1">
          {aboutMedia.map((d) => (
            <li key={d.document_id} className="rounded border bg-card px-2 py-1.5 flex items-center justify-between gap-2 text-xs">
              <DocLink doc={d} fallback="Media" />
              {canEdit && (
                <button
                  type="button"
                  aria-label="Remove media"
                  onClick={() => remove(d, 'this media file')}
                  className="text-urgent hover:text-urgent-strong shrink-0"
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
        <SlotUploadButton
          label="Media"
          canEdit={canEdit}
          busy={busySlot === 'about'}
          onPick={(file) => upload('about', file, 'other', ABOUT_MEDIA_LABEL)}
        />
      </section>

      {others.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-sm font-semibold">Other Documents</h4>
          <ul className="space-y-1">
            {others.map((d) => (
              <li key={d.document_id} className="rounded border bg-card px-2 py-1.5 flex items-center justify-between gap-2 text-xs">
                <DocLink doc={d} fallback={d.doc_type.toUpperCase()} />
                {canEdit && (
                  <button
                    type="button"
                    aria-label="Remove document"
                    onClick={() => remove(d, d.doc_label || d.doc_type.toUpperCase())}
                    className="text-urgent hover:text-urgent-strong shrink-0"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

/* ── One checklist slot: filled row, or an upload control ───────────── */
function SlotRow({
  slot, doc, canEdit, busy, preview, onUpload, onRemove,
}: {
  slot: Slot;
  doc?: ClientDocument;
  canEdit: boolean;
  busy: boolean;
  preview?: boolean;
  onUpload: (file: File) => void;
  onRemove: (doc: ClientDocument) => void;
}) {
  if (!doc) {
    return (
      <li>
        <SlotUploadButton label={slot.label} canEdit={canEdit} busy={busy} onPick={onUpload} />
      </li>
    );
  }
  const isImage = !!doc.content_type?.startsWith('image/');
  return (
    <li className="rounded border bg-muted/40 px-2 py-1.5 flex items-center justify-between gap-2 text-xs">
      <span className="flex items-center gap-2 min-w-0">
        {preview && isImage && doc.url
          /* The BE returns a PRESIGNED S3 url, so a plain <img> works here —
             it is not an authenticated CRM endpoint and needs no bearer. */
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={doc.url} alt={slot.label} className="size-8 rounded object-cover shrink-0" />
          : <FileText className="size-3.5 text-muted-foreground shrink-0" />}
        <span className="min-w-0">
          <span className="font-medium">{slot.label}</span>
          {doc.original_filename && (
            <span className="text-muted-foreground"> — {doc.original_filename}</span>
          )}
        </span>
      </span>
      <span className="flex items-center gap-2 shrink-0">
        {doc.url && (
          <a href={doc.url} target="_blank" rel="noopener noreferrer"
            className="text-primary hover:underline inline-flex items-center gap-0.5">
            <ExternalLink className="size-3" /> Open
          </a>
        )}
        {canEdit && (
          <button type="button" aria-label={`Remove ${slot.label}`}
            onClick={() => onRemove(doc)} className="text-urgent hover:text-urgent-strong">
            <Trash2 className="size-3.5" />
          </button>
        )}
      </span>
    </li>
  );
}

/*
 * A "+ Upload X" button over a hidden <input type="file">. The input is reset
 * after every pick so re-choosing the SAME file fires change again — without
 * that, a failed upload cannot be retried with the same file.
 */
function SlotUploadButton({
  label, canEdit, busy, onPick,
}: {
  label: string;
  canEdit: boolean;
  busy: boolean;
  onPick: (file: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  if (!canEdit) {
    return (
      <div className="rounded border border-dashed px-2 py-2 text-xs text-muted-foreground text-center">
        {label} — not uploaded
      </div>
    );
  }
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onPick(f);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => ref.current?.click()}
        className="w-full border-dashed text-muted-foreground font-normal"
      >
        {busy ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Plus className="size-3.5 mr-1" />}
        {busy ? 'Uploading…' : `Upload ${label}`}
      </Button>
    </>
  );
}

function DocLink({ doc, fallback }: { doc: ClientDocument; fallback: string }) {
  const name = doc.doc_label || doc.original_filename || fallback;
  return (
    <span className="flex items-center gap-2 min-w-0">
      <FileText className="size-3.5 text-muted-foreground shrink-0" />
      {doc.url
        ? <a href={doc.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate">{name}</a>
        : <span className="truncate">{name}</span>}
    </span>
  );
}
