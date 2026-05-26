'use client';

/*
 * Custom Properties tab — list + Add/Edit/Delete free-form key/value
 * properties attached to a client.
 *
 * Backed by:
 *   GET    /admin/clients/:clientId/custom-properties
 *   POST   /admin/clients/:clientId/custom-properties
 *   PUT    /admin/clients/custom-properties/:id
 *   DELETE /admin/clients/custom-properties/:id
 *
 * The GET endpoint returns NORMALISED shapes: { id, name, label, value,
 * mandatory, raw }. The `name` field is lower-cased + trimmed — used
 * by Book-New-Call to detect which optional inputs to render (branch_name,
 * product_code, etc.). We persist exactly what the user typed; the
 * normalisation happens only on read.
 */

import { useState, type FormEvent } from 'react';
import { Plus, Pencil, Trash2, AlertCircle, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetch, invalidateFetch } from '@/lib/hooks';
import type { ClientCustomProperty, CustomPropertyFormPayload } from '@/lib/client-types';

type Props = {
  clientId: number;
  canEdit: boolean;
};

export function CustomPropsTab({ clientId, canEdit }: Props) {
  const key = `/admin/clients/${clientId}/custom-properties`;
  const { data, loading, error, refetch } = useFetch<ClientCustomProperty[]>(key);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ClientCustomProperty | null>(null);
  const confirm = useConfirm();

  const items = data ?? [];

  async function onDelete(p: ClientCustomProperty) {
    const ok = await confirm({
      title: 'Delete Custom Property',
      description: `Delete "${p.label ?? p.name}"?`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok || !p.id) return;
    try {
      await api.delete<{ deleted: boolean }>(`/admin/clients/custom-properties/${p.id}`);
      invalidateFetch((k) => k.startsWith(`/admin/clients/${clientId}/custom-properties`));
      refetch();
      showToast({ variant: 'success', message: 'Property deleted.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Delete failed.' });
    }
  }

  return (
    <div className="pt-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {loading ? 'Loading…' : `${items.length} propert${items.length === 1 ? 'y' : 'ies'}`}
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5 mr-1" /> Add Property
          </Button>
        )}
      </div>
      {error && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}
      {!loading && items.length === 0 && (
        <div className="text-sm text-muted-foreground italic">No custom properties configured.</div>
      )}
      <ul className="space-y-1">
        {items.map((p, idx) => (
          <li key={p.id ?? idx} className="rounded border bg-card px-3 py-2 flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono bg-muted/50 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                  <Tag className="size-3" /> {p.name}
                </span>
                {p.label && <span className="text-sm font-medium">{p.label}</span>}
                {p.mandatory && <span className="text-[10px] uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-1 rounded">Required</span>}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {p.value ? <span>Value: <span className="font-mono">{p.value}</span></span> : <span className="italic">No default value</span>}
              </div>
            </div>
            {canEdit && p.id && (
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDelete(p)} className="text-red-600 hover:text-red-700">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {(adding || editing) && (
        <CustomPropFormDialog
          clientId={clientId}
          initial={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => {
            invalidateFetch((k) => k.startsWith(`/admin/clients/${clientId}/custom-properties`));
            refetch();
          }}
        />
      )}
    </div>
  );
}

function CustomPropFormDialog({
  clientId, initial, onClose, onSaved,
}: {
  clientId: number;
  initial: ClientCustomProperty | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial;
  const [form, setForm] = useState<CustomPropertyFormPayload>(() => ({
    name: initial?.name ?? '',
    label: initial?.label ?? '',
    value: initial?.value ?? '',
    mandatory: initial?.mandatory ?? false,
  }));
  const [saving, setSaving] = useState(false);

  function update<K extends keyof CustomPropertyFormPayload>(key: K, value: CustomPropertyFormPayload[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!form.name?.trim()) {
      showToast({ variant: 'error', message: 'Property name is required.' });
      return;
    }
    // Normalise the key to lower-snake-ish for consistency — the BE
    // doesn't require this, but it keeps the new rows consistent with
    // what Book-New-Call expects ("branch_name" not "Branch Name").
    const normalisedName = form.name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!normalisedName) {
      showToast({ variant: 'error', message: 'Property name must contain letters or numbers.' });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: normalisedName,
        label: form.label?.trim() || null,
        value: form.value?.trim() || null,
        mandatory: !!form.mandatory,
      };
      if (isEdit && initial?.id) {
        await api.put<{ updated: boolean }>(`/admin/clients/custom-properties/${initial.id}`, payload as never);
      } else {
        await api.post<{ id: number }>(`/admin/clients/${clientId}/custom-properties`, payload as never);
      }
      showToast({ variant: 'success', message: isEdit ? 'Property updated.' : 'Property added.' });
      onSaved();
      onClose();
    } catch (err) {
      showToast({ variant: 'error', message: err instanceof ApiError ? err.message : 'Save failed.' });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="!max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Custom Property' : 'Add Custom Property'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3 pt-1">
          <Field label="Property Key" required>
            <Input
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              maxLength={100}
              required
              placeholder="branch_name"
              disabled={isEdit}
            />
            <div className="text-[11px] text-muted-foreground mt-1">
              {isEdit ? 'Key is immutable after creation (Book-New-Call binds to it).' : 'Lower-snake. Spaces become underscores; punctuation is stripped.'}
            </div>
          </Field>
          <Field label="Label">
            <Input value={form.label ?? ''} onChange={(e) => update('label', e.target.value)} maxLength={200} placeholder="Branch Name" />
          </Field>
          <Field label="Default Value">
            <Input value={form.value ?? ''} onChange={(e) => update('value', e.target.value)} maxLength={500} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!form.mandatory}
              onChange={(e) => update('mandatory', e.target.checked)}
            />
            Required at Booking Time
          </label>
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Property')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs">{label}{required && <span className="text-red-600 ml-0.5">*</span>}</Label>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
