'use client';

/*
 * Billing tab — list + Add/Edit/Delete billing addresses.
 *
 * Backed by:
 *   GET    /admin/clients/:clientId/billing
 *   POST   /admin/clients/:clientId/billing
 *   PUT    /admin/clients/billing/:id
 *   DELETE /admin/clients/billing/:id
 *
 * The legacy `tbl_client_billing` schema has lots of fields; we expose
 * the same surface the legacy `addEditClientsBilling.vm` form did. City
 * is captured as a free numeric id (no city dropdown here — the page
 * doesn't have a use-LookupCities hook yet; if needed later, wire
 * SearchSelect via /admin/lookups/cities).
 */

import { useState, type FormEvent } from 'react';
import { Plus, Pencil, Trash2, MapPin, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { SearchSelect } from '@/components/ui/search-select';
import { showToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { useFetch, useFetchOnce, invalidateFetch } from '@/lib/hooks';
import type { ClientBilling, BillingFormPayload } from '@/lib/client-types';

type Props = {
  clientId: number;
  canEdit: boolean;
};

export function BillingTab({ clientId, canEdit }: Props) {
  const key = `/admin/clients/${clientId}/billing`;
  const { data, loading, error, refetch } = useFetch<ClientBilling[]>(key);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ClientBilling | null>(null);
  const confirm = useConfirm();

  const items = data ?? [];

  async function onDelete(b: ClientBilling) {
    const ok = await confirm({
      title: 'Delete Billing Address',
      description: `Delete billing address "${b.c_bill_name ?? ''}"? This is permanent.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await api.delete<{ deleted: boolean }>(`/admin/clients/billing/${b.c_bill_id}`);
      invalidateFetch((k) => k.startsWith(`/admin/clients/${clientId}/billing`));
      refetch();
      showToast({ variant: 'success', message: 'Billing address deleted.' });
    } catch (e) {
      showToast({ variant: 'error', message: e instanceof ApiError ? e.message : 'Delete failed.' });
    }
  }

  return (
    <div className="pt-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {loading ? 'Loading…' : `${items.length} billing address${items.length === 1 ? '' : 'es'}`}
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5 mr-1" /> Add Billing Address
          </Button>
        )}
      </div>
      {error && (
        <div className="text-xs text-red-600 flex items-center gap-1">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}
      {!loading && items.length === 0 && (
        <div className="text-sm text-muted-foreground italic">No billing addresses on file.</div>
      )}
      <ul className="space-y-1">
        {items.map((b) => (
          <li key={b.c_bill_id} className="rounded border bg-card px-3 py-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium truncate flex items-center gap-1">
                <MapPin className="size-3.5 text-muted-foreground" /> {b.c_bill_name ?? '—'}
              </div>
              <div className="text-xs text-muted-foreground">{b.c_bill_address ?? '—'}</div>
              <div className="text-xs text-muted-foreground">
                {b.c_bill_pin && <>PIN: <span className="font-mono">{b.c_bill_pin}</span></>}
                {b.c_bill_freq_type && <> · Freq: {b.c_bill_freq_type}</>}
                {b.c_bill_payment_cycle != null && <> · Cycle: {b.c_bill_payment_cycle}d</>}
              </div>
            </div>
            {canEdit && (
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => setEditing(b)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDelete(b)} className="text-red-600 hover:text-red-700">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {(adding || editing) && (
        <BillingFormDialog
          clientId={clientId}
          initial={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => {
            invalidateFetch((k) => k.startsWith(`/admin/clients/${clientId}/billing`));
            refetch();
          }}
        />
      )}
    </div>
  );
}

type City = { city_id: number; city_name: string };

function BillingFormDialog({
  clientId, initial, onClose, onSaved,
}: {
  clientId: number;
  initial: ClientBilling | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial;
  // Cities lookup — useFetchOnce because the dropdown options never
  // change during a form session. Module-level dedupe in lib/hooks
  // ensures repeated mounts (across multiple billing dialogs) share
  // the same in-flight promise.
  const { data: cities } = useFetchOnce<City[]>(`/shared/lookup/cities?limit=1000`);
  const cityOptions = (cities ?? []).map((c) => ({ value: c.city_id, label: c.city_name }));
  const [form, setForm] = useState<BillingFormPayload>(() => ({
    name: initial?.c_bill_name ?? '',
    address: initial?.c_bill_address ?? '',
    commAddr: initial?.c_bill_comm_addr ?? '',
    cityId: initial?.c_bill_city_id ?? 0,
    pin: initial?.c_bill_pin ?? '',
    email: initial?.c_bill_email ?? '',
    frequencyType: initial?.c_bill_freq_type ?? '',
    paymentCycle: initial?.c_bill_payment_cycle ?? null,
  }));
  const [saving, setSaving] = useState(false);

  function update<K extends keyof BillingFormPayload>(key: K, value: BillingFormPayload[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!form.name?.trim() || !form.address?.trim() || !form.cityId || !form.pin) {
      showToast({ variant: 'error', message: 'Name, address, city and PIN are required.' });
      return;
    }
    if (!/^[0-9]{6}$/.test(form.pin)) {
      showToast({ variant: 'error', message: 'PIN must be 6 digits.' });
      return;
    }
    setSaving(true);
    try {
      // Strip empty strings to null so the BE stores NULL, not ''.
      const payload = Object.fromEntries(
        Object.entries(form).filter(([, v]) => v !== '' && v !== undefined),
      );
      if (isEdit && initial?.c_bill_id) {
        await api.put<{ updated: boolean }>(`/admin/clients/billing/${initial.c_bill_id}`, payload as never);
      } else {
        await api.post<{ c_bill_id: number }>(`/admin/clients/${clientId}/billing`, payload as never);
      }
      showToast({ variant: 'success', message: isEdit ? 'Billing updated.' : 'Billing added.' });
      onSaved();
      onClose();
    } catch (err) {
      showToast({ variant: 'error', message: err instanceof ApiError ? err.message : 'Save failed.' });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="!max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Billing Address' : 'Add Billing Address'}</DialogTitle>
        </DialogHeader>
        {/*
         * Field order optimised for visual balance:
         *  • Name spans full width (label-only field).
         *  • Billing Address + Communication Address are full-width text
         *    fields (operators often write long addresses).
         *  • City + PIN paired — they always travel together.
         *  • Frequency + Payment Cycle paired — both are billing-cadence
         *    concepts (was lonely Payment Cycle before; visually odd).
         *  • Billing Email full-width at the bottom.
         */}
        <form onSubmit={onSubmit} className="space-y-3 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" required full>
              <Input value={form.name} onChange={(e) => update('name', e.target.value)} maxLength={255} required />
            </Field>
            <Field label="Billing Address" required full>
              <Input value={form.address} onChange={(e) => update('address', e.target.value)} maxLength={500} required />
            </Field>
            <Field label="Communication Address" full>
              <Input value={form.commAddr ?? ''} onChange={(e) => update('commAddr', e.target.value)} maxLength={500} placeholder="(optional, defaults to billing address)" />
            </Field>
            <Field label="City" required>
              <SearchSelect
                value={form.cityId || ''}
                onChange={(val) => update('cityId', Number(val))}
                options={cityOptions}
                placeholder="Select city…"
                required
              />
            </Field>
            <Field label="PIN" required>
              <Input value={form.pin} onChange={(e) => update('pin', e.target.value.replace(/\D/g, '').slice(0, 6))} required />
            </Field>
            <Field label="Frequency">
              <select
                className="border rounded h-9 px-2 text-sm w-full bg-background"
                value={form.frequencyType ?? ''}
                onChange={(e) => update('frequencyType', e.target.value)}
              >
                <option value="">—</option>
                <option value="Monthly">Monthly</option>
                <option value="Fortnightly">Fortnightly</option>
                <option value="Weekly">Weekly</option>
              </select>
            </Field>
            <Field label="Payment Cycle (Days)">
              <Input
                type="number" min={0} max={365}
                value={form.paymentCycle ?? ''}
                onChange={(e) => update('paymentCycle', e.target.value === '' ? null : Number(e.target.value))}
              />
            </Field>
            <Field label="Billing Email" full>
              <Input type="email" value={form.email ?? ''} onChange={(e) => update('email', e.target.value)} maxLength={255} />
            </Field>
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Billing Address')}</Button>
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
