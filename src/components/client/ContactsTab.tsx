'use client';

/*
 * Contacts (SPOCs) tab — list + Add/Edit/Delete with inline duplicate-check.
 *
 * Backed by:
 *   GET    /admin/clients/:clientId/contacts
 *   GET    /admin/clients/:clientId/contacts/check-duplicate?email=&phone=&excludeId=
 *   POST   /admin/clients/:clientId/contacts
 *   PUT    /admin/clients/contacts/:id
 *   DELETE /admin/clients/contacts/:id
 *
 * Uses useFetch (per the mandatory fetch-hooks rule). Mutations call
 * invalidateFetch() so the list refreshes after save/delete.
 */

import { useRef, useState, type FormEvent } from 'react';
import { Plus, Pencil, Trash2, Mail, Phone, AlertCircle, Upload, Download } from 'lucide-react';
import { downloadXlsx } from '@/lib/download-xlsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';
import type { ClientContact, ContactFormPayload } from '@/lib/client-types';

type Props = {
  clientId: number;
  canEdit: boolean;
};

export function ContactsTab({ clientId, canEdit }: Props) {
  const key = `/admin/clients/${clientId}/contacts`;
  const { data, loading, error, refetch } = useFetch<ClientContact[]>(key);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ClientContact | null>(null);
  const [uploading, setUploading] = useState(false);
  const confirm = useConfirm();

  const items = (data ?? []).filter((c) => c.status !== 0);

  async function onDelete(c: ClientContact) {
    const ok = await confirm({
      title: 'Delete Contact',
      description: `Delete contact ${c.contact_name ?? ''}? This can be reversed by an admin.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    const toastId = showToast({ variant: 'loading', message: 'Deleting…' });
    try {
      await api.delete<{ deleted: boolean }>(`/admin/clients/contacts/${c.id}`);
      invalidateFetch((k) => k.startsWith(`/admin/clients/${clientId}/contacts`));
      refetch();
      showToast({ variant: 'success', message: 'Contact deleted.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Delete failed.' });
    } finally { void toastId; }
  }

  return (
    <div className="pt-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {loading ? 'Loading…' : `${items.length} contact${items.length === 1 ? '' : 's'}`}
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  downloadXlsx({
                    url: `/admin/clients/spoc-template`,
                    filename: 'client-spoc-template.xlsx',
                  }).catch((e) => showToast({ variant: 'error', message: e instanceof Error ? e.message : 'Download failed.' }));
                }}
              >
                <Download className="size-3.5 mr-1" /> Template
              </Button>
              <Button size="sm" variant="outline" onClick={() => setUploading(true)}>
                <Upload className="size-3.5 mr-1" /> Bulk Upload
              </Button>
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus className="size-3.5 mr-1" /> Add Contact
              </Button>
            </>
          )}
        </div>
      </div>
      {error && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}
      {!loading && items.length === 0 && (
        <div className="text-sm text-muted-foreground italic">No contacts on file.</div>
      )}
      <ul className="space-y-1">
        {items.map((c) => (
          <li key={c.id} className="rounded border bg-card px-3 py-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium truncate">{c.contact_name ?? '—'}</div>
              <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5">
                {c.contact_email && (
                  <span className="flex items-center gap-1"><Mail className="size-3" /> {c.contact_email}</span>
                )}
                {c.contact_no && (
                  <span className="flex items-center gap-1"><Phone className="size-3" /> {c.contact_no}</span>
                )}
                {c.contact_desgn && <span>· {c.contact_desgn}</span>}
              </div>
            </div>
            {canEdit && (
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDelete(c)} className="text-red-600 hover:text-red-700">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {(adding || editing) && (
        <ContactFormDialog
          clientId={clientId}
          initial={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => {
            invalidateFetch((k) => k.startsWith(`/admin/clients/${clientId}/contacts`));
            refetch();
          }}
        />
      )}

      {uploading && (
        <BulkUploadDialog
          clientId={clientId}
          onClose={() => setUploading(false)}
          onUploaded={() => {
            invalidateFetch((k) => k.startsWith(`/admin/clients/${clientId}/contacts`));
            refetch();
          }}
        />
      )}
    </div>
  );
}

/* ─── Form dialog (create + edit) ─────────────────────────────────── */

function ContactFormDialog({
  clientId, initial, onClose, onSaved,
}: {
  clientId: number;
  initial: ClientContact | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial;
  const [form, setForm] = useState<ContactFormPayload>(() => ({
    contactName: initial?.contact_name ?? '',
    contactEmail: initial?.contact_email ?? '',
    contactNo: initial?.contact_no ?? '',
    contactAltNo: initial?.contact_alt_no ?? '',
    contactDesgn: initial?.contact_desgn ?? '',
    managerId: initial?.manager_id ?? null,
  }));
  const [saving, setSaving] = useState(false);
  const [dupWarning, setDupWarning] = useState<string | null>(null);

  function update<K extends keyof ContactFormPayload>(key: K, value: ContactFormPayload[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (key === 'contactEmail' || key === 'contactNo') setDupWarning(null);
  }

  async function checkDuplicate(email: string, phone: string): Promise<boolean> {
    // Skip the check if neither field is fully formed yet.
    const hasEmail = /.+@.+\..+/.test(email);
    const hasPhone = /^[0-9]{10}$/.test(phone);
    if (!hasEmail && !hasPhone) return false;
    try {
      const p = new URLSearchParams();
      if (hasEmail) p.set('email', email);
      if (hasPhone) p.set('phone', phone);
      if (isEdit && initial?.id) p.set('excludeId', String(initial.id));
      const res = await api.get<{ duplicate: { id: number; contact_name?: string; contact_email?: string; contact_no?: string } | null }>(
        `/admin/clients/${clientId}/contacts/check-duplicate?${p}`,
      );
      if (res.duplicate) {
        const tag = res.duplicate.contact_email === email ? 'email' : 'phone';
        setDupWarning(`A contact with this ${tag} already exists: ${res.duplicate.contact_name ?? '#' + res.duplicate.id}`);
        return true;
      }
      return false;
    } catch {
      // Defensive: never block save because the dup-check itself failed.
      return false;
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!form.contactName?.trim() || !form.contactEmail?.trim() || !form.contactNo?.trim()) {
      showToast({ variant: 'error', message: 'Name, email and phone are required.' });
      return;
    }
    if (!/^[0-9]{10}$/.test(form.contactNo)) {
      showToast({ variant: 'error', message: 'Phone must be 10 digits.' });
      return;
    }
    setSaving(true);
    try {
      // Inline dup-check before the save call so the user sees the
      // conflict cleanly instead of a 409 toast.
      const isDup = await checkDuplicate(form.contactEmail, form.contactNo);
      if (isDup) { setSaving(false); return; }
      if (isEdit && initial?.id) {
        await api.put<{ updated: boolean }>(`/admin/clients/contacts/${initial.id}`, form as never);
      } else {
        await api.post<{ id: number }>(`/admin/clients/${clientId}/contacts`, form as never);
      }
      showToast({ variant: 'success', message: isEdit ? 'Contact updated.' : 'Contact added.' });
      onSaved();
      onClose();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Save failed.';
      showToast({ variant: 'error', message: msg });
    } finally { setSaving(false); }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !saving });

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="!max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Contact' : 'Add Contact'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" required full>
              <Input value={form.contactName} onChange={(e) => update('contactName', e.target.value)} maxLength={200} required />
            </Field>
            <Field label="Email" required>
              <Input type="email" value={form.contactEmail} onChange={(e) => update('contactEmail', e.target.value)} maxLength={255} required />
            </Field>
            <Field label="Phone" required>
              <Input value={form.contactNo} onChange={(e) => update('contactNo', e.target.value.replace(/\D/g, '').slice(0, 10))} required />
            </Field>
            <Field label="Alt Phone">
              <Input value={form.contactAltNo ?? ''} onChange={(e) => update('contactAltNo', e.target.value.replace(/\D/g, '').slice(0, 10))} />
            </Field>
            <Field label="Designation">
              <Input value={form.contactDesgn ?? ''} onChange={(e) => update('contactDesgn', e.target.value)} maxLength={100} />
            </Field>
          </div>
          {dupWarning && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 flex items-center gap-1">
              <AlertCircle className="size-3.5" /> {dupWarning}
            </div>
          )}
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Contact')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, required, full, children }: { label: string; required?: boolean; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <Label className="text-xs">{label}{required && <span className="text-red-600 ml-0.5">*</span>}</Label>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

/* ─── Bulk-upload dialog ──────────────────────────────────────────── */

type BulkResult = {
  rowNumber: number;
  status: 'created' | 'skipped' | 'invalid' | 'failed';
  contactId?: number;
  errors?: string[];
  reason?: string;
};

function BulkUploadDialog({
  clientId, onClose, onUploaded,
}: {
  clientId: number;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{
    summary: { total: number; created: number; skipped: number; invalid: number };
    results: BulkResult[];
  } | null>(null);

  async function onUpload() {
    if (!fileRef.current?.files?.[0]) {
      showToast({ variant: 'error', message: 'Choose an .xlsx file first.' });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', fileRef.current.files[0]);
      const res = await api.post<typeof result>(`/admin/clients/${clientId}/contacts/bulk-upload`, fd);
      setResult(res);
      if (res && res.summary.created > 0) onUploaded();
      showToast({ variant: 'success', message: `${res?.summary.created ?? 0} contact(s) created.` });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Upload failed.' });
    } finally { setUploading(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !uploading && onClose()}>
      <DialogContent className="!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk Upload Contacts</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 pt-1">
          <div className="text-xs text-muted-foreground">
            Upload an .xlsx with columns: <b>Contact Name</b>, <b>Email</b>, <b>Phone (10 digits)</b>, Alt Phone (optional), Designation (optional).
            Duplicate (by email or phone) rows are <b>skipped</b>, not overwritten.
          </div>
          <div className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-9">
              <Label className="text-xs">File</Label>
              <Input
                ref={fileRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              />
            </div>
            <div className="col-span-3">
              <Button onClick={onUpload} disabled={uploading} className="w-full">
                <Upload className="size-3.5 mr-1" /> {uploading ? 'Uploading…' : 'Upload'}
              </Button>
            </div>
          </div>

          {result && (
            <div className="mt-3 rounded border bg-card p-3 space-y-1">
              <div className="text-sm font-medium">
                Total {result.summary.total} · Created {result.summary.created} ·
                Skipped {result.summary.skipped} · Invalid/Failed {result.summary.invalid}
              </div>
              <div className="max-h-60 overflow-auto text-xs border rounded">
                <table className="w-full">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left px-2 py-1">Row</th>
                      <th className="text-left px-2 py-1">Status</th>
                      <th className="text-left px-2 py-1">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {result.results.map((r, i) => (
                      <tr key={i} className={
                        r.status === 'created' ? 'bg-emerald-50/30'
                        : r.status === 'skipped' ? 'bg-amber-50/30'
                        : 'bg-red-50/30'
                      }>
                        <td className="px-2 py-1 font-mono">{r.rowNumber}</td>
                        <td className="px-2 py-1">{r.status}</td>
                        <td className="px-2 py-1">{r.reason ?? r.errors?.join('; ') ?? (r.contactId ? `id #${r.contactId}` : '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={onClose} disabled={uploading}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
