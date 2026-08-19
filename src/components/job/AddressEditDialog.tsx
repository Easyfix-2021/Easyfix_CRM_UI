'use client';

/*
 * AddressEditDialog — small focused modal that lets an operator edit
 * one saved tbl_address row in place. Opens from the ✎ pencil button
 * next to each saved address in the JobModal's address picker.
 *
 * Re-uses the same primitives as the JobModal address fields:
 *   - AddressAutocomplete for the street-address line (Google Places
 *     proxy + GPS auto-fill)
 *   - SearchSelect for City
 *   - bare Input for Building / PIN / GPS (readonly)
 *
 * On Save we PATCH /admin/customers/:id/addresses/:addrId and bubble
 * the freshly-returned row up via onSaved so the parent JobModal can
 * patch its `prefillCustomer.addresses` slot without a refetch.
 */

import * as React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CancelButton } from '@/components/ui/cancel-button';
import { CitySelect } from '@/components/ui/city-select';
import { AddressAutocomplete } from '@/components/ui/address-autocomplete';
import { api, ApiError } from '@/lib/api';
import { useLookup } from '@/lib/use-lookup';
import { useFormDirtyGuard } from '@/lib/use-form-dirty-guard';

export type EditableAddress = {
  address_id: number;
  address: string;
  building?: string | null;
  landmark?: string | null;
  locality?: string | null;
  city_id: number | null;
  city_name?: string | null;
  pin_code?: string | null;
  gps_location?: string | null;
};

export function AddressEditDialog({
  open,
  onClose,
  customerId,
  address,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customerId: number;
  address: EditableAddress | null;
  /** Fires with the fresh row (city_name joined) after a successful
   *  PATCH so the parent can update its local addresses list without
   *  refetching the customer. */
  onSaved: (updated: EditableAddress) => void;
}) {
  const lk = useLookup();
  // Local form state — seeded from the supplied address on open.
  const [f, setF] = React.useState({
    address: '', building: '', landmark: '',
    city_id: '' as string,
    pin_code: '', gps_location: '',
  });
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !address) return;
    setF({
      address: address.address || '',
      building: address.building || '',
      landmark: address.landmark || '',
      city_id: address.city_id != null ? String(address.city_id) : '',
      pin_code: address.pin_code || '',
      gps_location: address.gps_location || '',
    });
    setErr(null);
  }, [open, address]);

  function patch<K extends keyof typeof f>(k: K, v: typeof f[K]) {
    setF((s) => ({ ...s, [k]: v }));
  }

  async function save() {
    if (!address) return;
    if (!f.address.trim()) { setErr('Address is required'); return; }
    if (!f.city_id) { setErr('City is required'); return; }
    if (!/^[0-9]{6}$/.test(f.pin_code)) { setErr('PIN must be exactly 6 digits'); return; }
    setSaving(true); setErr(null);
    try {
      const updated = await api.patch<EditableAddress>(
        `/admin/customers/${customerId}/addresses/${address.address_id}`,
        {
          address: f.address.trim(),
          building: f.building || undefined,
          landmark: f.landmark || undefined,
          city_id: Number(f.city_id),
          pin_code: f.pin_code,
          gps_location: f.gps_location || undefined,
        }
      );
      onSaved(updated);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const guardedOpenChange = useFormDirtyGuard(onClose, { when: () => !saving });

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="!max-w-[640px] w-[95vw]">
        <DialogHeader>
          <DialogTitle>Edit Address</DialogTitle>
        </DialogHeader>
        <div className="px-1 space-y-3">
          <div>
            <Label className="block mb-1" required>Address</Label>
            <AddressAutocomplete
              value={f.address}
              onChange={(v) => patch('address', v)}
              onPick={(p) => {
                setF((s) => ({
                  ...s,
                  address: p.description,
                  gps_location: p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : s.gps_location,
                  pin_code: p.components.postal_code || s.pin_code,
                  city_id: (() => {
                    const wanted = (p.components.city || '').toLowerCase();
                    if (!wanted) return s.city_id;
                    const hit = lk.toOpts.cities.find(
                      (o) => String(o.label).toLowerCase() === wanted
                    );
                    return hit ? String(hit.value) : s.city_id;
                  })(),
                }));
              }}
              placeholder="Start typing — Google will suggest matches"
              required
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label className="block mb-1">Building</Label>
              <Input value={f.building} onChange={(e) => patch('building', e.target.value)} />
            </div>
            <div>
              <Label className="block mb-1" required>City</Label>
              <CitySelect
                required
                value={f.city_id}
                onChange={(id) => patch('city_id', id)}
                placeholder="— Select city —"
              />
            </div>
            <div>
              <Label className="block mb-1" required>PIN</Label>
              <Input
                required
                pattern="[0-9]{6}"
                value={f.pin_code}
                onChange={(e) => patch('pin_code', e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="font-mono"
              />
            </div>
          </div>
          <div>
            <Label className="block mb-1">GPS (auto-detected)</Label>
            <Input
              value={f.gps_location}
              readOnly
              disabled
              placeholder="Pick an address suggestion above to auto-fill"
            />
          </div>
          {err && <div className="text-sm text-urgent-strong bg-urgent-tint border border-urgent rounded px-2 py-1">{err}</div>}
        </div>
        <DialogFooter>
          <CancelButton onCancel={onClose} disabled={saving} />
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Update Address'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
