'use client';

/*
 * AddressEditDialog — small focused modal that lets an operator edit
 * one saved tbl_address row in place. Opens from the ✎ pencil button
 * next to each saved address in the JobModal's address picker.
 *
 * FIELD ROLES (aligned 2026-09-07 with Book New Call, the job Edit Address
 * dialog and the public job-completion page):
 *   - Service Address  -> `address`   PLAIN input. The one column
 *                         formatServiceAddress reads, so it is what the CRM
 *                         and the technician see. Not an autocomplete: this
 *                         field WAS one, and every Google pick overwrote the
 *                         operator's service address with formatted_address.
 *   - Search Location  -> `building` + `gps_location`. The autocomplete.
 *     On Map            Sets the pin only; never touches the Service Address.
 *   - SearchSelect for City, bare Input for PIN, read-only GPS.
 *
 * GPS STAYS IN STEP WITH THE SEARCH TEXT. A pick sets it, and so does a
 * debounced forward-geocode 800ms after typing stops — because GPS is
 * read-only, and before that watcher a hand-edited address saved against the
 * PREVIOUS coordinates with nothing on screen admitting it.
 *
 * ⚠ THIS EDITS A SHARED ROW. The PATCH goes to
 * /admin/customers/:id/addresses/:addrId — tbl_address — so a change here
 * applies to EVERY job referencing that address, not just the booking the
 * dialog was opened from.
 *
 * On Save we bubble the freshly-returned row up via onSaved so the parent
 * JobModal can patch its `prefillCustomer.addresses` slot without a refetch.
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

  /*
   * The map-search text whose coordinates are already in `gps_location`.
   *
   * Two things skip on it: a pick (which sets GPS itself) and the value the
   * dialog opened with. Without the second, opening the dialog would fire a
   * geocode for text that was already reconciled when the row was saved — a
   * Google call per open, for nothing.
   */
  const lastGeocodedSearchRef = React.useRef<string>('');
  const [geocoding, setGeocoding] = React.useState(false);

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
    // Seed: the stored search text already matches the stored GPS, so the
    // watcher must not fire for it on open.
    lastGeocodedSearchRef.current = address.building || '';
    setErr(null);
  }, [open, address]);

  /*
   * TYPED EDIT → RE-SYNC GPS (2026-09-07).
   *
   * GPS is read-only here and used to change on a Google PICK only. So an
   * operator who edited the text by hand — the common case, correcting a
   * house number — saved a NEW location against the OLD coordinates, with
   * nothing on screen showing the two no longer agreed. Silently wrong
   * coordinates are worse than absent ones: the technician is routed
   * confidently to the previous place.
   *
   * 800ms after typing stops, forward-geocode the search text and update the
   * pin. Same debounce as the manual-GPS watcher in AddressPickerWithMap.
   *
   * GPS ONLY — not PIN, not city. A half-typed string is not a confirmed
   * place; the pick above is the confirmation, and that one does set all
   * three. Quietly re-classifying a job's city from an in-progress keystroke
   * is the failure this fix exists to avoid, not one to reintroduce.
   */
  React.useEffect(() => {
    if (!open) return;
    const text = f.building.trim();
    if (text.length < 5) return;
    if (text === lastGeocodedSearchRef.current) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      if (cancelled) return;
      setGeocoding(true);
      try {
        const r = await api.get<{ lat?: number; lng?: number }>(
          '/admin/maps/geocode', { address: text },
        );
        if (cancelled) return;
        if (r.lat != null && r.lng != null) {
          lastGeocodedSearchRef.current = text;
          setF((s2) => ({ ...s2, gps_location: `${r.lat},${r.lng}` }));
        }
      } catch {
        // Best-effort. A failed lookup leaves the previous pin in place and
        // says so in the field's helper text rather than blocking the save —
        // the operator may be correcting an address Google cannot resolve.
      } finally {
        if (!cancelled) setGeocoding(false);
      }
    }, 800);
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.building, open]);

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
          {/*
            * Service Address — `address`, the ONE column formatServiceAddress
            * reads, so this is what the CRM and the technician see.
            *
            * A PLAIN input, deliberately. This used to be the Google
            * autocomplete, so every pick replaced the operator's service
            * address with Google's formatted_address — the same inversion
            * fixed in Book New Call, the job Edit Address dialog and the
            * public page. The search moved to `building` below.
            */}
          <div>
            <Label className="block mb-1" required>Service Address</Label>
            <Input
              value={f.address}
              onChange={(e) => patch('address', e.target.value)}
              placeholder="Flat / house, street, area — as the customer gave it"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Shown as the Service Address everywhere in the CRM and to the technician.
            </p>
          </div>
          {/*
            * Google-Map SEARCH — the repurposed `building` field. Sets the GPS
            * pin only; it never touches the Service Address above.
            */}
          <div>
            <Label className="block mb-1">Search Location On Map</Label>
            <AddressAutocomplete
              value={f.building}
              onChange={(v) => patch('building', v)}
              onPick={(p) => {
                const picked = p.description;
                // A pick is a CONFIRMED place, so it may set PIN and city too —
                // the typed watcher below deliberately does not.
                lastGeocodedSearchRef.current = picked;
                setF((s) => ({
                  ...s,
                  building: picked,
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
              placeholder="Search a place to set the GPS pin"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Used only to set the GPS pin — it does not change the Service Address.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
            <Label className="block mb-1">
              GPS (auto-detected){geocoding ? ' · updating…' : ''}
            </Label>
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
