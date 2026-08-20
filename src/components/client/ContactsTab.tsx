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
import Link from 'next/link';
import { Plus, Pencil, Trash2, Mail, Phone, AlertCircle, Upload, Download, ShieldCheck } from 'lucide-react';
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
import { INDIAN_MOBILE_REGEX, INDIAN_MOBILE_ERROR } from '@/lib/format';
import type { ClientContact, ContactFormPayload, SpocAccessCatalogue } from '@/lib/client-types';

type Props = {
  clientId: number;
  canEdit: boolean;
};

export function ContactsTab({ clientId, canEdit }: Props) {
  const key = `/admin/clients/${clientId}/contacts`;
  const { data, loading, error, refetch } = useFetch<ClientContact[]>(key);
  const [adding, setAdding] = useState(false);
  // The SPOC whose portal access is being edited. Separate from `editing`
  // (the contact form) because the two write DIFFERENT tables — contact
  // details go to tbl_client_contacts, access to easyfix_client_spoc_access.
  const [accessFor, setAccessFor] = useState<ClientContact | null>(null);
  // Ids ticked for a bulk access change. A Set rather than an array so the
  // per-row checkbox is an O(1) lookup on a 200-SPOC client.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
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
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <span>{loading ? 'Loading…' : `${items.length} contact${items.length === 1 ? '' : 's'}`}</span>
          {/* The tier above this tab: what each ROLE grants before any
              per-SPOC override. Linked from here because an operator who
              wants "Finance should see Performance" wants it for everyone,
              not one row at a time. */}
          <Link href="/clients/access-roles" className="text-primary hover:underline">
            Role Access Defaults
          </Link>
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
        <div className="text-xs text-urgent-strong flex items-center gap-1">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}
      {!loading && items.length === 0 && (
        <div className="text-sm text-muted-foreground italic">No contacts on file.</div>
      )}
      {canEdit && items.length > 1 && (
        <div className="flex flex-wrap items-center gap-3 rounded border bg-muted/30 px-3 py-2 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="size-4"
              aria-label="Select all contacts"
              checked={selected.size === items.length && items.length > 0}
              ref={(el) => {
                // Indeterminate is a DOM property, not an attribute — React
                // cannot set it through JSX, so it goes through the ref.
                if (el) el.indeterminate = selected.size > 0 && selected.size < items.length;
              }}
              onChange={(e) =>
                setSelected(e.target.checked ? new Set(items.map((c) => c.id)) : new Set())
              }
            />
            <span>Select All</span>
          </label>
          {selected.size > 0 && (
            <>
              <span className="text-muted-foreground">{selected.size} selected</span>
              <Button size="sm" variant="outline" onClick={() => setBulkOpen(true)}>
                <ShieldCheck className="size-3.5 mr-1" /> Set Portal Access
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </>
          )}
        </div>
      )}

      <ul className="space-y-1">
        {items.map((c) => (
          <li key={c.id} className="rounded border bg-card px-3 py-2 flex items-start justify-between gap-2">
            {canEdit && items.length > 1 && (
              <input
                type="checkbox"
                className="size-4 mt-1 shrink-0"
                aria-label={`Select ${c.contact_name ?? 'contact'}`}
                checked={selected.has(c.id)}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(c.id); else next.delete(c.id);
                    return next;
                  })
                }
              />
            )}
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
              <RoleChip contact={c} />
            </div>
            {canEdit && (
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" variant="ghost" title="Portal Access" onClick={() => setAccessFor(c)}>
                  <ShieldCheck className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" title="Edit Contact" onClick={() => setEditing(c)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDelete(c)} className="text-urgent hover:text-urgent-strong">
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

      {bulkOpen && (
        <AccessDialog
          clientId={clientId}
          bulkIds={[...selected]}
          onClose={() => setBulkOpen(false)}
          onSaved={() => {
            setSelected(new Set());
            invalidateFetch((k) => k.startsWith(`/admin/clients/${clientId}/contacts`));
            refetch();
          }}
        />
      )}

      {accessFor && (
        <AccessDialog
          clientId={clientId}
          contact={accessFor}
          onClose={() => setAccessFor(null)}
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


/* ─── Portal access ───────────────────────────────────────────────── */

/*
 * Role names are shown from a LOCAL map rather than fetched, because this chip
 * renders once per row and a fetch per row would be absurd. The AUTHORITATIVE
 * list still comes from the server (GET /admin/clients/contacts/access-roles)
 * and is what the dialog's dropdown is built from — this map only has to name
 * an id, and the dialog corrects it the moment anyone opens it.
 */
const ROLE_NAMES: Record<number, string> = {
  1: 'Store SPOC',
  2: 'Regional Manager',
  3: 'Senior Leader',
  4: 'Finance',
};

function RoleChip({ contact }: { contact: ClientContact }) {
  // undefined = the API did not return access columns at all (migration
  // pending). null = migrated, but nobody has assigned this SPOC a role.
  if (contact.spoc_role === undefined) return null;
  const overrides = [
    contact.can_view_performance,
    contact.can_view_invoicing,
    contact.can_approve_estimates,
    contact.can_view_all_stores,
  ].filter((v) => v !== null && v !== undefined).length;

  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs">
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium">
        <ShieldCheck className="size-3" />
        {contact.spoc_role == null ? 'No Role Set' : ROLE_NAMES[contact.spoc_role] ?? `Role ${contact.spoc_role}`}
      </span>
      {overrides > 0 && (
        <span className="text-muted-foreground">
          {overrides} override{overrides === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}

/*
 * Assign a SPOC's portal access.
 *
 * THE OVERRIDES ARE THREE-STATE, and the UI has to expose all three or the
 * model is only half usable. Each override is a three-way select:
 *
 *   Inherit  (null)  → whatever the role grants. The default.
 *   Allow    (true)  → granted to this person even though the role withholds it.
 *   Deny     (false) → revoked from this person even though the role grants it.
 *
 * A checkbox would collapse Inherit and Deny into one state, which is exactly
 * how somebody ends up unable to undo an override.
 */
const OVERRIDE_FIELDS = [
  { key: 'canViewPerformance', column: 'can_view_performance', label: 'Performance Book', surface: 'performance' },
  { key: 'canViewInvoicing', column: 'can_view_invoicing', label: 'Invoicing', surface: 'invoicing' },
  { key: 'canApproveEstimates', column: 'can_approve_estimates', label: 'Approve Estimates', surface: 'actions' },
  { key: 'canViewAllStores', column: 'can_view_all_stores', label: 'All Stores', surface: null },
] as const;

type OverrideKey = (typeof OVERRIDE_FIELDS)[number]['key'];
type TriState = boolean | null;

/*
 * One dialog serves both the single-SPOC and the bulk case.
 *
 * They differ in exactly two ways — where the initial values come from, and
 * which endpoint the save hits — so two components would be the same 150 lines
 * twice, drifting apart the first time somebody adds an override.
 *
 * In BULK mode the overrides all start at Inherit rather than at any one
 * person's current values. Pre-filling from an arbitrary member of the
 * selection would silently push that person's exceptions onto everyone else.
 */
function AccessDialog({
  clientId, contact, bulkIds, onClose, onSaved,
}: {
  clientId: number;
  contact?: ClientContact;
  bulkIds?: number[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isBulk = !!bulkIds?.length;
  const { data: catalogue } = useFetch<SpocAccessCatalogue>('/admin/clients/contacts/access-roles');
  const roles = catalogue?.roles ?? [];

  const [role, setRole] = useState<number>(contact?.spoc_role ?? 1);
  const [overrides, setOverrides] = useState<Record<OverrideKey, TriState>>(() => {
    if (isBulk) {
      // Every override starts at Inherit. Anything the operator does not
      // deliberately change is left untouched on each SPOC by the server's
      // partial-patch semantics.
      return {
        canViewPerformance: null, canViewInvoicing: null,
        canApproveEstimates: null, canViewAllStores: null,
      };
    }
    const toTri = (v: number | null | undefined): TriState => (v === null || v === undefined ? null : v === 1);
    return {
      canViewPerformance: toTri(contact?.can_view_performance),
      canViewInvoicing: toTri(contact?.can_view_invoicing),
      canApproveEstimates: toTri(contact?.can_approve_estimates),
      canViewAllStores: toTri(contact?.can_view_all_stores),
    };
  });
  const [saving, setSaving] = useState(false);

  const selected = roles.find((r) => r.id === role);

  /* What this SPOC will actually see once saved — the same fold the server
     does, shown before the operator commits, so "what does Finance mean?" is
     answered on screen instead of in a doc. */
  const effective = (() => {
    const grants = new Set(selected?.grants ?? []);
    for (const f of OVERRIDE_FIELDS) {
      if (!f.surface) continue;
      const v = overrides[f.key];
      if (v === null) continue;
      if (v) grants.add(f.surface); else grants.delete(f.surface);
    }
    grants.add('home');
    return [...grants];
  })();

  async function save() {
    setSaving(true);
    const body = {
      spocRole: role,
      canViewPerformance: overrides.canViewPerformance,
      canViewInvoicing: overrides.canViewInvoicing,
      canApproveEstimates: overrides.canApproveEstimates,
      canViewAllStores: overrides.canViewAllStores,
    };
    try {
      if (isBulk) {
        await api.put(`/admin/clients/${clientId}/contacts/access/bulk`,
          { ...body, contactIds: bulkIds } as never);
      } else {
        await api.put(`/admin/clients/contacts/${contact!.id}/access`, body as never);
      }
      showToast({
        variant: 'success',
        message: isBulk
          ? `Portal access updated for ${bulkIds!.length} SPOC${bulkIds!.length === 1 ? '' : 's'}`
          : 'Portal access updated',
      });
      onSaved();
      onClose();
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Could not save access' });
    } finally {
      setSaving(false);
    }
  }

  // Repo convention (enforced by a no-restricted-syntax lint rule): every
  // Dialog closes through the shared discard-changes guard rather than an
  // inline handler. `when: () => !saving` keeps the dialog open while a save
  // is in flight, matching the other dialogs in this file.
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !saving });

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
      <DialogContent className="!max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isBulk
              ? `Portal Access — ${bulkIds!.length} SPOC${bulkIds!.length === 1 ? '' : 's'}`
              : `Portal Access — ${contact?.contact_name ?? 'SPOC'}`}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {isBulk && (
            <p className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              The role below is applied to every selected SPOC. Overrides left on
              <b className="text-foreground"> Inherit</b> are not touched — an existing
              exception on one person survives a bulk role change.
            </p>
          )}
          <div className="space-y-1.5">
            <Label>Role</Label>
            <select
              className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              value={role}
              onChange={(e) => setRole(Number(e.target.value))}
            >
              {(roles.length ? roles : Object.entries(ROLE_NAMES).map(([id, name]) => ({ id: Number(id), name, grants: [], key: '', allStores: false }))).map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            {selected && (
              <p className="text-xs text-muted-foreground">
                Grants by default: {selected.grants.join(', ')}
                {selected.allStores ? ' · sees all stores' : ' · own booking subtree only'}
              </p>
            )}
            {/* The tier above this dialog. What the role grants by default is
                edited once, on Client Role Access — not per SPOC here. */}
            <p className="text-xs text-muted-foreground">
              <Link href="/clients/access-roles" className="text-primary hover:underline">
                Edit Role Defaults
              </Link>{' '}
              to change what a role grants for every SPOC who holds it.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Overrides</Label>
            <p className="text-xs text-muted-foreground -mt-1">
              Inherit follows the role. Allow and Deny apply to this person only.
            </p>
            {OVERRIDE_FIELDS.map((f) => (
              <div key={f.key} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm">{f.label}</div>
                  <div className="text-xs font-mono text-muted-foreground">{f.column}</div>
                </div>
                <div className="flex gap-1 shrink-0">
                  {([['Inherit', null], ['Allow', true], ['Deny', false]] as [string, TriState][]).map(([label, val]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setOverrides((o) => ({ ...o, [f.key]: val }))}
                      aria-pressed={overrides[f.key] === val}
                      className={`rounded px-2 py-1 text-xs font-medium transition ${
                        overrides[f.key] === val
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded border bg-muted/40 px-3 py-2">
            <div className="text-xs font-medium">{isBulk ? 'Each Selected SPOC Will See' : 'This SPOC Will See'}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{effective.join(' · ')}</div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : isBulk ? `Apply to ${bulkIds!.length}` : 'Save Access'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    if (!INDIAN_MOBILE_REGEX.test(form.contactNo)) {
      showToast({ variant: 'error', message: INDIAN_MOBILE_ERROR });
      return;
    }
    if (form.contactAltNo && !INDIAN_MOBILE_REGEX.test(form.contactAltNo)) {
      showToast({ variant: 'error', message: `Alt Phone: ${INDIAN_MOBILE_ERROR}` });
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
              {(() => {
                const raw = String(form.contactNo || '');
                const isValid = raw === '' || INDIAN_MOBILE_REGEX.test(raw);
                return (
                  <>
                    <Input
                      value={raw}
                      onChange={(e) => update('contactNo', e.target.value.replace(/\D/g, '').slice(0, 10))}
                      inputMode="numeric"
                      placeholder="10 digits"
                      className={`tabular-nums ${!isValid ? 'border-urgent focus-visible:ring-urgent' : ''}`}
                      aria-invalid={!isValid}
                      required
                    />
                    {!isValid && <p className="text-xs text-urgent-strong mt-1">{INDIAN_MOBILE_ERROR}</p>}
                  </>
                );
              })()}
            </Field>
            <Field label="Alt Phone">
              {(() => {
                const raw = String(form.contactAltNo ?? '');
                const isValid = raw === '' || INDIAN_MOBILE_REGEX.test(raw);
                return (
                  <>
                    <Input
                      value={raw}
                      onChange={(e) => update('contactAltNo', e.target.value.replace(/\D/g, '').slice(0, 10))}
                      inputMode="numeric"
                      placeholder="10 digits"
                      className={`tabular-nums ${!isValid ? 'border-urgent focus-visible:ring-urgent' : ''}`}
                      aria-invalid={!isValid}
                    />
                    {!isValid && <p className="text-xs text-urgent-strong mt-1">{INDIAN_MOBILE_ERROR}</p>}
                  </>
                );
              })()}
            </Field>
            <Field label="Designation">
              <Input value={form.contactDesgn ?? ''} onChange={(e) => update('contactDesgn', e.target.value)} maxLength={100} />
            </Field>
          </div>
          {dupWarning && (
            <div className="text-xs text-warning-strong bg-warning-tint border border-warning rounded px-2 py-1 flex items-center gap-1">
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
      <Label className="text-xs">{label}{required && <span className="text-urgent-strong ml-0.5">*</span>}</Label>
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

  // BulkUploadDialog missed by the earlier sweep — adding the guard now
  // so the lint rule passes. `when: () => !uploading` preserves the
  // prior "block close while an upload is in flight" idiom.
  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !uploading });

  return (
    <Dialog open onOpenChange={guardedOpenChange}>
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
                        r.status === 'created' ? 'bg-success-tint/30'
                        : r.status === 'skipped' ? 'bg-warning-tint/30'
                        : 'bg-urgent-tint/30'
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
