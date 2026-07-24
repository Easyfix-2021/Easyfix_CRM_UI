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
 *   - The Map INSTANCE (not just the JS script) is reused across mounts —
 *     see the `sharedMapCore` docblock below. This component is mounted and
 *     unmounted a lot (JobModal's Dialog unmounts on close; its collapsible
 *     Section unmounts on collapse), and Google bills per `new
 *     google.maps.Map()` call, so we build it once per page and re-parent
 *     its container div into whichever mount is currently showing.
 *
 * Both panes are bound to the same `value` object via `onChange` so
 * the caller doesn't have to wire each field individually.
 */

import * as React from 'react';
import { useUiFlags } from '@/lib/hooks';
import { Input } from './input';
import { Label } from './label';
import { CitySelect } from './city-select';
import { AddressAutocomplete } from './address-autocomplete';
import { api, ApiError } from '@/lib/api';
import { showToast } from './toast';

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
  /*
   * OPT-IN: when true AND the PIN field reaches a valid 6 digits, the picker
   * SILENTLY (debounced ~600ms) calls POST /admin/pincodes/ensure { pincode }
   * to idempotently add the pincode to the system. On success it back-fills
   * city_id from the response IF the picker's city is still empty, and shows a
   * tiny inline note ("Pincode added to system" / spinner). A 400 (non-India /
   * ungeocodable) surfaces a small inline warning but NEVER blocks the form —
   * this is a customer address, not master-data entry.
   *
   * Scoped to CRM-admin call sites (Book New Call + Confirm & Schedule). Left
   * off (default false) everywhere else so it never fires in read-only views,
   * the address-edit dialog, or any Client/public surface.
   */
  autoCreatePincode?: boolean;
  /*
   * tbl_address column-role remap (2026-07-14, Confirm & Schedule). When true:
   *   - `address` (the ACTUAL service address, populated by the booking flows)
   *     is NON-EDITABLE here — the operator never overwrites it. It's shown as
   *     the read-only "Service Address" (rendered by the modal just above this
   *     picker), so this component hides its own Complete-Address field.
   *   - `building` is REPURPOSED as the Google-Map SEARCH box, used ONLY to
   *     derive GPS coordinates: picking a suggestion (or dragging the pin)
   *     writes gps_location (+ pin/city) and stores the searched text in
   *     `building`, but NEVER touches `address`.
   * When false (Book New Call / edit dialog) the picker is unchanged: `address`
   * is the editable Complete-Address autocomplete, `building` is Building/Floor.
   */
  serviceAddressReadOnly?: boolean;
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
/*
 * Resolve the Google Maps JS API key. Next.js bakes
 * NEXT_PUBLIC_* env vars at BUILD time — so a QA deploy that shipped
 * before the key was provisioned can't pick it up via a runtime env
 * change. Fall back to `/admin/maps/config` (BE-owned) which reads
 * GOOGLE_MAPS_API_KEY_PUBLIC || GOOGLE_MAPS_API_KEY at request time.
 * This lets ops fix QA without a FE rebuild.
 *
 * Cache the resolved key on the module so the API call only happens
 * once per page load even if multiple AddressPickerWithMap instances
 * mount (Book New Call + Confirm & Schedule on the same operator
 * session).
 */
let _cachedRuntimeKey: string | null | undefined = undefined;
async function resolveApiKey(): Promise<string | null> {
  const baked = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (baked) return baked;
  if (_cachedRuntimeKey !== undefined) return _cachedRuntimeKey;
  try {
    const r = await api.get<{ apiKey: string | null }>('/admin/maps/config');
    _cachedRuntimeKey = r.apiKey || null;
  } catch {
    _cachedRuntimeKey = null;
  }
  return _cachedRuntimeKey;
}
function loadGoogleMaps(): Promise<GMaps> {
  if (mapsLoader) return mapsLoader;
  mapsLoader = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') { reject(new Error('No window')); return; }
    const w = window as unknown as GMapsWindow;
    if (w.google?.maps) { resolve(w.google.maps); return; }
    resolveApiKey().then((key) => {
      if (!key) { reject(new Error('Google Maps API key not configured (set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY at build, or GOOGLE_MAPS_API_KEY on the backend for the /admin/maps/config fallback)')); return; }
      const script = document.createElement('script');
      // No &libraries=places — autocomplete is backend-proxied (see AddressAutocomplete), so the client never needs the Places JS library.
      script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&v=weekly`;
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
  });
  return mapsLoader;
}

/*
 * Module-level singleton for the MAP INSTANCE itself — a sibling to
 * `mapsLoader` above, which only singleton-izes the *script*. Google bills
 * Dynamic Maps per `new google.maps.Map()` call, and every mount of this
 * component used to pay that cost again. That's expensive here specifically
 * because AddressPickerWithMap mounts inside JobModal's Radix <Dialog>
 * (unmounts its content on close) and inside a collapsible <Section>
 * (unmounts its children on collapse) — so opening Book New Call / Confirm &
 * Schedule, or just toggling the address Section open/closed, was minting a
 * brand-new Map every time.
 *
 * Fix: build the Map + Marker pair ONCE per page load, in a standalone
 * `containerEl` div that outlives any single mount. On mount we RE-PARENT
 * that div into `mapRef.current` (the standard "move the live DOM node"
 * trick — the map keeps its tile/WebGL state, only its parent changes) and
 * recenter/re-mark for whichever job is showing now, instead of rebuilding.
 * `ownerId` marks which live mount currently holds the div; it's set back to
 * null (not destroyed) on unmount so the NEXT mount can reclaim the exact
 * same instance. If a second AddressPickerWithMap needs a map while the
 * first is still mounted (both visible at once — not how today's three call
 * sites behave, but not structurally impossible), it falls back to building
 * its own private, one-off map rather than stealing the div out from under a
 * currently-visible instance.
 */
type SharedMapCore = {
  containerEl: HTMLDivElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  marker: any;
  ownerId: symbol | null;
};
let sharedMapCore: SharedMapCore | null = null;

export function AddressPickerWithMap({ value, onChange, cities, editable = true, autoCreatePincode = false, serviceAddressReadOnly = false }: Props) {
  const mapRef = React.useRef<HTMLDivElement | null>(null);
  // The map + marker types are minimal at the call site — we only
  // need .panTo / .setZoom on the map and .setPosition on the marker.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstance = React.useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markerInstance = React.useRef<any>(null);
  const [mapsError, setMapsError] = React.useState<string | null>(null);

  // Global map-clickability flag. Effective interactivity = caller allows
  // editing AND the flag is on. When the flag forces the map read-only we
  // still render it — the marker just can't be dragged and clicks are inert.
  const { mapClickable, loaded: flagsLoaded } = useUiFlags();
  const interactive = editable && mapClickable;
  const mapBuiltRef = React.useRef(false);
  // Identifies THIS mount as the current owner of `sharedMapCore` (or not).
  // A fresh Symbol per mount — remounts (dialog reopen, Section re-expand)
  // get a new id, so a stale unmounted instance can never mistakenly think
  // it still owns the shared map.
  const instanceIdRef = React.useRef<symbol>(Symbol('address-picker-map'));

  /*
   * Inline status for the OPT-IN silent pincode ensure (see `autoCreatePincode`
   * prop docblock). `pinEnsureState` drives the tiny note under the PIN field:
   *   - 'validating' → spinner + "Validating pincode…"
   *   - 'added'      → "Pincode added to system"
   *   - 'present'    → (no note — already in system, nothing to announce)
   *   - 'warn'       → small amber warning (non-India / ungeocodable); does NOT
   *                    block the form.
   * `pinEnsureMsg` carries the BE-returned message for the warn case.
   */
  const [pinEnsureState, setPinEnsureState] =
    React.useState<'idle' | 'validating' | 'added' | 'present' | 'warn'>('idle');
  const [pinEnsureMsg, setPinEnsureMsg] = React.useState<string>('');
  // The last 6-digit pincode we already ensured (any outcome) — dedupes so the
  // debounced effect doesn't re-POST the same pincode on unrelated re-renders.
  const lastEnsuredPinRef = React.useRef<string>('');
  // Mirror of the latest city_id so the debounced ensure callback can read the
  // CURRENT city (to decide whether to back-fill) without being a dep of the
  // effect — depending on value.city_id would re-arm the timer on every city
  // change and risk re-firing the ensure.
  const cityIdRef = React.useRef<string | number>(value.city_id);
  React.useEffect(() => { cityIdRef.current = value.city_id; }, [value.city_id]);

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

  /*
   * `lastGeocodedAddrRef` records the address string we most recently
   * reconciled with the map (via reverse-geocode, autocomplete pick,
   * or successful forward-geocode). The debounced typed-address watcher
   * below skips work when `value.address` matches this ref so we don't:
   *   (a) re-fire a forward-geocode right after a pick already
   *       supplied lat/lng, OR
   *   (b) re-fire after a reverse-geocode supplied the address.
   * Updated by `reverseGeocode`, `onPick`, and the debounced effect
   * itself on a successful response.
   */
  const lastGeocodedAddrRef = React.useRef<string>(String(value.address || ''));

  /*
   * `lastReverseGeocodedGpsRef` records the lat,lng string we most
   * recently reverse-geocoded — drag, click, autocomplete pick, or
   * manual GPS-input edit. The manual-GPS watcher below skips work
   * when the field's current value matches this ref, preventing an
   * infinite loop: reverseGeocode patches gps_location → that
   * re-triggers the watcher → watcher re-fires reverseGeocode → loop.
   * Stored normalized to .toFixed(6) on both sides for stable string
   * compare (Google occasionally returns 5-decimal lat/lng; we always
   * persist 6 — without normalising, strings would differ harmlessly
   * but the watcher would still re-fire).
   */
  // SEEDED from the incoming coords (2026-06-30) — mirrors lastGeocodedAddrRef
  // (seeded from value.address). Without a baseline, the manual-GPS watcher's
  // dedupe guard (`norm === lastReverseGeocodedGpsRef.current`) missed on every
  // (re)mount and fired a spurious reverse-geocode for coords already in props.
  // That blanked city_id whenever Google's city wasn't in the EasyFix master
  // list — so collapsing/reopening the Customer Details section (which unmounts
  // + remounts this picker) erased the operator's city pick and disabled Next.
  // Parsing mirrors the watcher's normalize exactly so the guard now matches.
  const lastReverseGeocodedGpsRef = React.useRef<string>((() => {
    const parts = String(value.gps_location || '').trim().split(',').map((s) => Number(s.trim()));
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return '';
    const [lat, lng] = parts;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return '';
    return `${lat.toFixed(6)},${lng.toFixed(6)}`;
  })());

  // Reverse-geocode the marker position and patch dependent fields.
  // Called from the marker's `dragend` handler. Errors are logged but
  // non-fatal — the marker still moves even if reverse-geocode fails.
  async function reverseGeocode(lat: number, lng: number) {
    // Stamp the canonical lat,lng we're about to reverse-geocode so
    // the manual-GPS watcher doesn't re-trigger when patch() writes
    // gps_location back through onChange. Stamped BEFORE the await so
    // even a slow API response can't lose the race against a re-render.
    lastReverseGeocodedGpsRef.current = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    try {
      const r = await api.get<{
        formatted_address?: string;
        address_components?: { postal_code?: string; city?: string };
      }>('/admin/maps/geocode', { latlng: `${lat},${lng}` });
      const next: Partial<AddressValue> = {
        gps_location: `${lat.toFixed(6)},${lng.toFixed(6)}`,
      };
      if (r.formatted_address) {
        if (serviceAddressReadOnly) {
          // `building` is the map-search field; reflect the pinned location
          // there. NEVER overwrite the read-only Service Address (`address`).
          next.building = r.formatted_address;
        } else {
          next.address = r.formatted_address;
          // Reverse-geocoded address is now the canonical "synced" one;
          // record so the typed-address debounce doesn't immediately
          // re-fire a forward-geocode for the same string.
          lastGeocodedAddrRef.current = r.formatted_address;
        }
      }
      const comps = r.address_components || {};
      if (comps.postal_code) next.pin_code = comps.postal_code;
      if (comps.city) {
        const match = cityByName.get(comps.city.toLowerCase());
        // Blank out city_id when the geocoded city isn't in the EasyFix
        // master list — same invariant as the forward-geocode debounce
        // and autocomplete onPick paths. (Previously: `if (match)` kept
        // the stale previous city_id, silently misclassifying jobs.)
        next.city_id = match || '';
      }
      patch(next);
    } catch (e) {
      // Reverse-geocode failed (out of quota, no result, missing
      // Geocoding API enablement on the key, etc.). Keep the marker
      // where it is and only update GPS — the operator can still
      // hand-correct address / city / PIN.
      //
      // Surface a one-shot toast so the operator understands why the
      // address didn't auto-fill on the drag. The BE returns an
      // actionable message for REQUEST_DENIED (e.g. "enable Geocoding
      // API on the GCP key") — pass it through verbatim.
      patch({ gps_location: `${lat.toFixed(6)},${lng.toFixed(6)}` });
      const msg = e instanceof ApiError && e.message
        ? e.message
        : 'Address auto-fill failed — keep dragging the pin or hand-edit the address field.';
      showToast({ variant: 'error', message: msg });
    }
  }

  /*
   * Typed-address → forward-geocode debounce REMOVED (2026-06-30).
   *
   * It geocoded the half-typed address on EVERY keystroke and patched
   * gps_location + pin_code (+ city) back into the form. That gps_location
   * write then re-armed the manual-GPS watcher below, whose reverseGeocode()
   * set next.address = formatted_address and patched it — OVERWRITING the
   * address text the operator was typing (and rewriting the PIN) under the
   * cursor on key-up. The address must NEVER auto-change from typing.
   *
   * Address (and PIN) now change ONLY from explicit operator gestures:
   *   - picking an autocomplete suggestion (onPick), or
   *   - dragging / clicking the map marker (reverseGeocode).
   * Plain typing flows purely through AddressAutocomplete onChange →
   * patch({ address }), which never touches gps_location / pin_code / address.
   * (`lastGeocodedAddrRef` is now vestigial — still stamped by reverseGeocode/
   * onPick but no longer read; left in place to avoid touching those paths.)
   */

  /*
   * Manual-GPS → reverse-geocode debounce (2026-06-03).
   *
   * Operators occasionally paste a known-good "lat,lng" pair into the
   * GPS Coordinates input (the BE supports this — see the input
   * comment block below). Without this watcher, the GPS string updated
   * but PIN + city + address stayed stale, silently misclassifying the
   * job. Now: 800ms after the operator stops typing in the field, we
   * reverse-geocode and patch all four dependent fields.
   *
   * Bounds + format guards (defensive — bad pastes shouldn't crash):
   *   - exactly two CSV components
   *   - both parse as finite numbers
   *   - lat in [-90, 90], lng in [-180, 180]
   * Anything else is silently ignored — the operator's input stays in
   * the field, the reverse-geocode just doesn't fire.
   *
   * Dedupes against `lastReverseGeocodedGpsRef` (normalized to
   * .toFixed(6)) so the patch reverseGeocode itself emits doesn't
   * re-trigger this watcher — the loop guard described in that ref's
   * docblock.
   *
   * Marker + map view re-centre via the existing `initialLatLng`
   * useEffect — no extra wiring needed here.
   */
  React.useEffect(() => {
    if (!editable) return;
    const csv = String(value.gps_location || '').trim();
    if (!csv) return;
    const parts = csv.split(',').map((s) => Number(s.trim()));
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return;
    const [lat, lng] = parts;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    // Normalize for dedupe — same shape we always persist to state.
    const norm = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    if (norm === lastReverseGeocodedGpsRef.current) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      void reverseGeocode(lat, lng);
    }, 800);
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.gps_location, editable]);

  /*
   * OPT-IN silent pincode ensure (2026-06-18).
   *
   * Gated on the `autoCreatePincode` prop — only the CRM-admin JobModal call
   * sites (Book New Call + Confirm & Schedule) pass it. When the PIN field
   * reaches a valid 6 digits we debounce ~600ms then POST
   * /admin/pincodes/ensure { pincode } so the customer's pincode is registered
   * in the system before the job is booked.
   *
   * Behaviour:
   *   - idempotent on the BE: an already-present pincode returns created:false
   *     with no write — we render no note for that case.
   *   - on a freshly-created pincode (created:true) we show "Pincode added to
   *     system" AND, IF the picker's city is still empty, back-fill city_id
   *     from the response so the new pincode's city is reflected. We never
   *     overwrite a city the operator (or geocode) already chose.
   *   - a 400 (non-India / ungeocodable) shows a small amber inline warning but
   *     DOES NOT block the form — this is a customer address, not master data.
   *
   * Deduped via `lastEnsuredPinRef` so the same pincode isn't re-POSTed on
   * unrelated re-renders. Stale-response guarded via the cleanup `cancelled`
   * flag so a slow response for an old pincode can't clobber a newer one.
   */
  React.useEffect(() => {
    if (!autoCreatePincode || !editable) return;
    const pin = String(value.pin_code || '').trim();
    if (!/^\d{6}$/.test(pin)) { setPinEnsureState('idle'); setPinEnsureMsg(''); return; }
    if (pin === lastEnsuredPinRef.current) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      lastEnsuredPinRef.current = pin;
      setPinEnsureState('validating');
      setPinEnsureMsg('');
      try {
        const r = await api.post<{
          pincode_id: number;
          pincode: string;
          city_id: number | null;
          city_name: string | null;
          created: boolean;
        }>('/admin/pincodes/ensure', { pincode: pin });
        if (cancelled) return;
        // Back-fill city ONLY when the picker has no city yet — never stomp a
        // city the operator or a geocode already resolved.
        const hasCity = String(cityIdRef.current || '').trim() !== '';
        if (r.city_id != null && !hasCity) {
          patch({ city_id: String(r.city_id) });
        }
        setPinEnsureState(r.created ? 'added' : 'present');
      } catch (e) {
        if (cancelled) return;
        // 400 (non-India / ungeocodable) → inline warn, never block. Any other
        // failure (network, 5xx) is treated the same way silently — the
        // operator can still book the job; the pincode just isn't auto-added.
        // Allow a retry by clearing the dedupe ref so editing+re-entering the
        // same value can re-attempt.
        lastEnsuredPinRef.current = '';
        setPinEnsureState('warn');
        setPinEnsureMsg(
          e instanceof ApiError && e.status === 400 && e.message
            ? e.message
            : 'Could not auto-add this pincode — you can still book the call.'
        );
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.pin_code, autoCreatePincode, editable]);

  // Binds the dragend/click handlers for THIS mount's `reverseGeocode` +
  // `interactive` closure onto a (possibly reused) map/marker pair. Split out
  // of the bootstrap effect below so both the "build fresh" and "reuse
  // shared instance" branches can share it verbatim.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bindMapListeners(map: any, marker: any) {
    marker.addListener('dragend', () => {
      const pos = marker.getPosition();
      if (!pos) return;
      void reverseGeocode(pos.lat(), pos.lng());
    });
    // Operators can also click anywhere on the map to drop the pin
    // — saves a drag if the destination is far from the default. Gated on
    // `interactive` too so a "non-clickable" map really is inert.
    if (interactive) {
      map.addListener('click', (e: { latLng?: { lat: () => number; lng: () => number } }) => {
        if (!e.latLng) return;
        marker.setPosition(e.latLng as unknown);
        void reverseGeocode(e.latLng.lat(), e.latLng.lng());
      });
    }
  }

  // Map bootstrap — on first mount that finds `sharedMapCore` free, RE-PARENTS
  // its container div here and recenters/re-marks for this job instead of
  // calling `new maps.Map` again (see the `sharedMapCore` docblock above).
  // Only builds a fresh Map/Marker pair when no reusable instance exists yet.
  React.useEffect(() => {
    // Wait for the ui.map.clickable flag before building — otherwise a map
    // meant to be read-only could mount interactive for a frame. Build once.
    if (mapBuiltRef.current || !flagsLoaded) return;
    mapBuiltRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const maps = await loadGoogleMaps();
        if (cancelled || !mapRef.current) return;
        // Default to Delhi if no GPS — operators almost always pan
        // anyway, but it stops the map staring at the Pacific Ocean.
        const center = initialLatLng || { lat: 28.6139, lng: 77.2090 };
        const zoom = initialLatLng ? 16 : 11;

        if (sharedMapCore && sharedMapCore.ownerId === null) {
          // REUSE — claim the existing instance instead of paying for a new
          // `new maps.Map()`. Re-parent its container div, refresh center /
          // zoom / interactivity options for THIS job, and rebind the
          // dragend/click listeners onto THIS mount's closures (clearing the
          // previous owner's listeners first — otherwise they'd keep firing
          // against an unmounted instance's stale `reverseGeocode`/`patch`).
          const { map, marker } = sharedMapCore;
          sharedMapCore.ownerId = instanceIdRef.current;
          mapRef.current.appendChild(sharedMapCore.containerEl);
          mapInstance.current = map;
          markerInstance.current = marker;
          map.setCenter(center);
          map.setZoom(zoom);
          map.setOptions({
            disableDefaultUI: !mapClickable,
            gestureHandling: mapClickable ? 'auto' : 'none',
            clickableIcons: mapClickable,
          });
          marker.setPosition(center);
          marker.setDraggable(interactive);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (maps as any).event.clearInstanceListeners(marker);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (maps as any).event.clearInstanceListeners(map);
          bindMapListeners(map, marker);
          return;
        }

        // No reusable instance available yet — either the very first mount on
        // this page, or `sharedMapCore` is still claimed by another live mount
        // (not expected from today's call sites, but handled defensively: we
        // never rip the div out from under a currently-visible instance).
        // Build inside a standalone container div so it CAN be detached (not
        // destroyed) and reclaimed by a later mount.
        const containerEl = document.createElement('div');
        containerEl.style.width = '100%';
        containerEl.style.height = '100%';
        mapRef.current.appendChild(containerEl);
        const map = new maps.Map(containerEl, {
          center,
          zoom,
          // Flag off → strip zoom/UI + block pan/zoom gestures so the map is a
          // static preview; flag on → unchanged from before.
          disableDefaultUI: !mapClickable,
          gestureHandling: mapClickable ? 'auto' : 'none',
          clickableIcons: mapClickable,
          mapTypeControl: false,
          streetViewControl: false,
        });
        mapInstance.current = map;
        const marker = new maps.Marker({
          position: center,
          map,
          draggable: interactive,
        });
        markerInstance.current = marker;
        bindMapListeners(map, marker);
        // Only the first-ever build becomes the page's reusable instance. If
        // we're here because a prior instance was still claimed, this one-off
        // map is intentionally NOT stored back — it stays private to this
        // mount and is discarded (GC'd) on unmount, same as before this change.
        if (!sharedMapCore) {
          sharedMapCore = { containerEl, map, marker, ownerId: instanceIdRef.current };
        }
      } catch (e) {
        if (!cancelled) setMapsError(e instanceof Error ? e.message : 'Map load failed');
      }
    })();
    return () => {
      cancelled = true;
      // Release ownership (don't destroy) so the next mount — dialog reopen,
      // Section re-expand, whatever triggered this unmount — can reclaim this
      // exact instance instead of paying for another `new maps.Map()`.
      if (sharedMapCore && sharedMapCore.ownerId === instanceIdRef.current) {
        sharedMapCore.ownerId = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagsLoaded]);

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
        {/* Complete-Address autocomplete — hidden in serviceAddressReadOnly mode
            (Confirm & Schedule), where `address` is the non-editable Service
            Address shown by the modal above and the Google search moves to the
            `building` field below. Shown in Book New Call / edit dialog. */}
        {!serviceAddressReadOnly && (
        <div>
          <Label className="text-xs">Complete Address *</Label>
          <AddressAutocomplete
            value={value.address}
            onChange={(v) => patch({ address: v })}
            onPick={(p) => {
              const pickedAddress = p.formatted_address || p.description;
              const next: Partial<AddressValue> = { address: pickedAddress };
              if (p.lat != null && p.lng != null) {
                next.gps_location = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
              }
              if (p.components.postal_code) next.pin_code = p.components.postal_code;
              if (p.components.city) {
                const match = cityByName.get(p.components.city.toLowerCase());
                // Blank out city_id when the picked place's city isn't
                // in the EasyFix master list — operator sees an empty
                // dropdown and picks manually rather than the stale
                // previous selection silently carrying over. Same
                // invariant as reverseGeocode / forward-geocode paths.
                next.city_id = match || '';
              }
              // Pick already supplied lat/lng — record so the typed-
              // address debounce skips this exact string and we don't
              // burn a redundant /geocode call.
              lastGeocodedAddrRef.current = pickedAddress;
              patch(next);
            }}
            placeholder="Start typing — Google will suggest matches"
            required
            disabled={!editable}
          />
        </div>
        )}
        {serviceAddressReadOnly ? (
          <>
            {/* Google-Map SEARCH — the repurposed `building` field. Used ONLY to
                set the GPS pin: picking a suggestion writes gps_location (+ pin/
                city) and stores the searched text in `building`; it never touches
                the read-only Service Address (`address`). */}
            <div>
              <Label className="text-xs">Search Location On Map</Label>
              <AddressAutocomplete
                value={value.building || ''}
                onChange={(v) => patch({ building: v })}
                onPick={(p) => {
                  const picked = p.formatted_address || p.description;
                  const next: Partial<AddressValue> = { building: picked };
                  if (p.lat != null && p.lng != null) {
                    next.gps_location = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
                  }
                  if (p.components.postal_code) next.pin_code = p.components.postal_code;
                  if (p.components.city) {
                    const match = cityByName.get(p.components.city.toLowerCase());
                    next.city_id = match || '';
                  }
                  patch(next);
                }}
                placeholder="Search a place to drop the map pin & capture GPS"
                disabled={!editable}
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Used only to set the GPS pin — it does not change the Service Address.
              </p>
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
          </>
        ) : (
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
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">City *</Label>
            {/* Server-side typeahead (CitySelect) — searches the ~11k city
                master via ?q= instead of preloading it. The `cities` prop is
                still used below for reverse-geocode name→id matching. */}
            <CitySelect
              value={value.city_id}
              onChange={(id) => patch({ city_id: id })}
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
            {/* OPT-IN silent ensure status (autoCreatePincode call sites only).
                Unobtrusive single-line note; never blocks the form. */}
            {autoCreatePincode && pinEnsureState === 'validating' && (
              <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />
                Validating pincode…
              </p>
            )}
            {autoCreatePincode && pinEnsureState === 'added' && (
              <p className="text-[10px] text-emerald-600 mt-1">Pincode added to system</p>
            )}
            {autoCreatePincode && pinEnsureState === 'warn' && (
              <p className="text-[10px] text-amber-600 mt-1">{pinEnsureMsg}</p>
            )}
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
            rows={3}
            disabled={!editable}
            maxLength={500}
            className="flex w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 resize-y disabled:opacity-50"
            placeholder="Optional — landing notes for the technician. e.g. &#10;• Visit between 9am–1pm; no Sundays&#10;• Back gate open after 9pm; ring 2nd-floor bell&#10;• Avoid weekends; ground-floor access only"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            Mention visit windows, access notes, or day restrictions — anything the technician should know before arriving. Max 500 characters.
          </p>
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
                <div className="font-medium">Map Unavailable</div>
                <div className="mt-1">{mapsError}</div>
                {/* Explicit reassurance (2026-05-28): operators were
                    blocking on Book New Call because the missing map
                    visually suggested the address step couldn't be
                    completed. The form does NOT require GPS — picking
                    a saved address or typing fields manually is
                    sufficient to enable Next + Book Call. */}
                <div className="mt-2 text-[10px] leading-snug">
                  You can still proceed — pick a saved address or hand-edit
                  the fields on the left. GPS is optional; Book Call works
                  without it.
                </div>
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
