'use client';

/*
 * AddressPickerWithMap — split-pane address editor used by both Book
 * New Call (create-mode) and Confirm & Schedule (confirm-mode).
 *
 * Left pane (form fields):
 *   - Complete Address (Google Places autocomplete; user can type freely)
 *   - Building / Floor Number
 *   - Landmark (optional)
 *   - City (auto-matched from autocomplete pick; falls back to a dropdown
 *     of EasyFix-active cities if the geocode city doesn't match any)
 *   - PIN (auto-filled from autocomplete or reverse-geocode; mandatory
 *     when not present)
 *   - GPS Coordinates (read-only, auto-from-map only)
 *   - Address Instructions (optional, persisted to tbl_address.address_instruction)
 *
 * Right pane (map):
 *   - Google Maps JS API loaded lazily on first mount.
 *   - Marker is DRAGGABLE; dragend triggers a reverse-geocode against
 *     `/admin/maps/geocode?latlng=...` and updates Address, PIN, City
 *     from the response if those components are present.
 *   - Picking an autocomplete suggestion also re-positions the marker.
 *
 * Both panes are bound to the same `value` object via `onChange` so
 * the caller doesn't have to wire each field individually.
 */

import * as React from 'react';
import { Input } from './input';
import { Label } from './label';
import { SearchSelect } from './search-select';
import { AddressAutocomplete } from './address-autocomplete';
import { api } from '@/lib/api';

export type AddressValue = {
  address: string;
  building?: string;
  landmark?: string;
  city_id: string | number;
  pin_code: string;
  gps_location: string;        // "lat,lng" CSV
  address_instruction?: string;
};

export type CityOption = { value: string; label: string };

type Props = {
  value: AddressValue;
  onChange: (next: AddressValue) => void;
  cities: CityOption[];
  /** When false, all inputs render disabled (read-only view). */
  editable?: boolean;
};

/*
 * Module-level loader for the Google Maps JS API. Multiple instances
 * of this component share one script tag (matches Google's "load
 * once per page" rule); we resolve to the loaded `google.maps`
 * namespace whichever instance hits the load first.
 *
 * The Maps types are deliberately `unknown` here because we don't
 * bundle `@types/google.maps` — we cast at call sites to keep the
 * tsconfig lean and avoid pulling in a 200kb d.ts file just for one
 * component.
 */
type GMaps = {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => unknown;
  Marker: new (opts: Record<string, unknown>) => {
    setPosition: (latLng: { lat: number; lng: number } | unknown) => void;
    getPosition: () => { lat: () => number; lng: () => number } | null;
    addListener: (event: string, cb: () => void) => unknown;
  };
};
type GMapsWindow = { google?: { maps: GMaps } };
let mapsLoader: Promise<GMaps> | null = null;
function loadGoogleMaps(): Promise<GMaps> {
  if (mapsLoader) return mapsLoader;
  mapsLoader = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') { reject(new Error('No window')); return; }
    const w = window as unknown as GMapsWindow;
    if (w.google?.maps) { resolve(w.google.maps); return; }
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key) { reject(new Error('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY not set')); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error('Failed to load Google Maps JS API'));
    script.onload = () => {
      const ww = window as unknown as GMapsWindow;
      if (ww.google?.maps) resolve(ww.google.maps);
      else reject(new Error('Maps loaded but namespace missing'));
    };
    document.head.appendChild(script);
  });
  return mapsLoader;
}

export function AddressPickerWithMap({ value, onChange, cities, editable = true }: Props) {
  const mapRef = React.useRef<HTMLDivElement | null>(null);
  // The map + marker types are minimal at the call site — we only
  // need .panTo / .setZoom on the map and .setPosition on the marker.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstance = React.useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markerInstance = React.useRef<any>(null);
  const [mapsError, setMapsError] = React.useState<string | null>(null);

  // City name → city_id lookup, used after a reverse-geocode pick to
  // try to match the Google "city" string against an active EasyFix
  // city. Falls through to the manual dropdown if no match.
  const cityByName = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cities) m.set(c.label.toLowerCase(), c.value);
    return m;
  }, [cities]);

  // Patch helper — coerces partial updates into a fresh AddressValue.
  function patch(p: Partial<AddressValue>) {
    onChange({ ...value, ...p });
  }

  // Parse "lat,lng" CSV into a numeric pair, tolerant of whitespace
  // and any leading + signs. Returns null on malformed input.
  const initialLatLng = React.useMemo(() => {
    const csv = String(value.gps_location || '').trim();
    if (!csv) return null;
    const parts = csv.split(',').map((s) => Number(s.trim()));
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
    return { lat: parts[0], lng: parts[1] };
  }, [value.gps_location]);

  // Reverse-geocode the marker position and patch dependent fields.
  // Called from the marker's `dragend` handler. Errors are logged but
  // non-fatal — the marker still moves even if reverse-geocode fails.
  async function reverseGeocode(lat: number, lng: number) {
    try {
      const r = await api.get<{
        formatted_address?: string;
        address_components?: { postal_code?: string; city?: string };
      }>('/admin/maps/geocode', { latlng: `${lat},${lng}` });
      const next: Partial<AddressValue> = {
        gps_location: `${lat.toFixed(6)},${lng.toFixed(6)}`,
      };
      if (r.formatted_address) next.address = r.formatted_address;
      const comps = r.address_components || {};
      if (comps.postal_code) next.pin_code = comps.postal_code;
      if (comps.city) {
        const match = cityByName.get(comps.city.toLowerCase());
        if (match) next.city_id = match;
      }
      patch(next);
    } catch (_e) {
      // Reverse-geocode failed (out of quota, no result, etc.). Keep
      // the marker where it is and only update GPS — the operator can
      // still hand-correct city / PIN.
      patch({ gps_location: `${lat.toFixed(6)},${lng.toFixed(6)}` });
    }
  }

  // Map bootstrap — loads JS API + instantiates map + marker on first
  // mount. Re-uses the existing marker instance on rerenders.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const maps = await loadGoogleMaps();
        if (cancelled || !mapRef.current) return;
        // Default to Delhi if no GPS — operators almost always pan
        // anyway, but it stops the map staring at the Pacific Ocean.
        const center = initialLatLng || { lat: 28.6139, lng: 77.2090 };
        const map = new maps.Map(mapRef.current, {
          center,
          zoom: initialLatLng ? 16 : 11,
          disableDefaultUI: false,
          mapTypeControl: false,
          streetViewControl: false,
        });
        mapInstance.current = map;
        const marker = new maps.Marker({
          position: center,
          map,
          draggable: editable,
        });
        marker.addListener('dragend', () => {
          const pos = marker.getPosition();
          if (!pos) return;
          void reverseGeocode(pos.lat(), pos.lng());
        });
        markerInstance.current = marker;
        // Operators can also click anywhere on the map to drop the pin
        // — saves a drag if the destination is far from the default.
        if (editable) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (map as any).addListener('click', (e: { latLng?: { lat: () => number; lng: () => number } }) => {
            if (!e.latLng) return;
            marker.setPosition(e.latLng as unknown);
            void reverseGeocode(e.latLng.lat(), e.latLng.lng());
          });
        }
      } catch (e) {
        if (!cancelled) setMapsError(e instanceof Error ? e.message : 'Map load failed');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the marker + map view in sync when an autocomplete pick or
  // external change updates gps_location.
  React.useEffect(() => {
    if (!mapInstance.current || !markerInstance.current || !initialLatLng) return;
    markerInstance.current.setPosition(initialLatLng);
    mapInstance.current.panTo(initialLatLng);
    mapInstance.current.setZoom(16);
  }, [initialLatLng]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* Left pane — form fields. */}
      <div className="space-y-3">
        <div>
          <Label className="text-xs">Complete Address *</Label>
          <AddressAutocomplete
            value={value.address}
            onChange={(v) => patch({ address: v })}
            onPick={(p) => {
              const next: Partial<AddressValue> = { address: p.formatted_address || p.description };
              if (p.lat != null && p.lng != null) {
                next.gps_location = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
              }
              if (p.components.postal_code) next.pin_code = p.components.postal_code;
              if (p.components.city) {
                const match = cityByName.get(p.components.city.toLowerCase());
                if (match) next.city_id = match;
              }
              patch(next);
            }}
            placeholder="Start typing — Google will suggest matches"
            required
            disabled={!editable}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Building / Floor Number</Label>
            <Input
              value={value.building || ''}
              onChange={(e) => patch({ building: e.target.value })}
              placeholder="House / flat / floor"
              disabled={!editable}
            />
          </div>
          <div>
            <Label className="text-xs">Landmark</Label>
            <Input
              value={value.landmark || ''}
              onChange={(e) => patch({ landmark: e.target.value })}
              placeholder="Optional"
              disabled={!editable}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">City *</Label>
            <SearchSelect
              value={String(value.city_id || '')}
              onChange={(v) => patch({ city_id: String(v) })}
              options={cities}
              placeholder="— Select city —"
              disabled={!editable}
              required
            />
          </div>
          <div>
            <Label className="text-xs">PIN *</Label>
            <Input
              value={value.pin_code}
              onChange={(e) => patch({ pin_code: e.target.value.replace(/\D/g, '').slice(0, 6) })}
              placeholder="6 digits"
              required
              pattern="[0-9]{6}"
              disabled={!editable}
            />
          </div>
        </div>
        <div>
          <Label className="text-xs">GPS Coordinates</Label>
          {/*
           * Editable on purpose (2026-05-26 per ops). The default UX is
           * still "drag the marker to set" — the map writes GPS back on
           * every dragend / click. But admins occasionally need to fix
           * a wrong Google geocode (e.g. autocomplete resolves to the
           * wrong CB-35 in Gurgaon) and the only way out was to spend a
           * minute panning the marker. Allowing direct hand-edit lets
           * them paste known-good lat,lng and move on.
           *
           * The input keeps map sync by-design: the `initialLatLng`
           * useMemo upstream re-parses gps_location and the
           * marker-position useEffect re-centres on it.
           */}
          <Input
            value={value.gps_location}
            onChange={(e) => patch({ gps_location: e.target.value })}
            disabled={!editable}
            placeholder="Drag the marker, or paste lat,lng manually"
            className="font-mono"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            Auto-fetched from Google Maps. You can also paste a known &ldquo;lat,lng&rdquo; pair to override.
          </p>
        </div>
        <div>
          <Label className="text-xs">Address Instructions</Label>
          <textarea
            value={value.address_instruction || ''}
            onChange={(e) => patch({ address_instruction: e.target.value })}
            rows={2}
            disabled={!editable}
            className="flex w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 resize-y disabled:opacity-50"
            placeholder="Optional — landing notes for the technician (e.g. back gate open after 9pm)"
          />
        </div>
      </div>
      {/* Right pane — Google Map. Falls back to a placeholder card if
          NEXT_PUBLIC_GOOGLE_MAPS_API_KEY isn't set or the script fails
          to load. Operators can still hand-edit the form fields. */}
      <div>
        <Label className="text-xs">Location On Map</Label>
        {/* Fixed height (380px) — earlier `lg:h-full` made the map grow
            to match the left pane and overflowed below the form's Next
            button on smaller screens, blocking pointer events. A fixed
            height keeps the map well within the section's vertical
            footprint regardless of how many address fields render. */}
        <div className="relative h-[380px] rounded border overflow-hidden bg-slate-50">
          {mapsError ? (
            <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground p-4 text-center">
              <div>
                <div className="font-medium">Map unavailable</div>
                <div className="mt-1">{mapsError}</div>
                <div className="mt-2 text-[10px]">Address fields on the left still work — operators can hand-edit values.</div>
              </div>
            </div>
          ) : (
            <div ref={mapRef} className="w-full h-full" />
          )}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          Drag the marker (or click anywhere on the map) to drop a new pin.
          Address, PIN and City update automatically.
        </p>
      </div>
    </div>
  );
}
