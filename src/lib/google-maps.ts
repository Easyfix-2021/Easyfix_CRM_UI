/*
 * Google Maps JS API loader — the ONE place the CRM loads the Maps script and
 * resolves its API key.
 *
 * Extracted (2026-08-25) from src/components/ui/address-picker-with-map.tsx,
 * where both functions were module-private. A second consumer arrived
 * (LiveLocationPopover, which draws the technician's last-known position), and
 * copying the loader would have meant TWO script tags and TWO key lookups on a
 * page that shows both. The memoisation below is module-level precisely so
 * every consumer shares one script load and one key resolution.
 *
 * The functions themselves are unchanged from their original home.
 */

import { api } from '@/lib/api';
import { palette } from '@/brand/palette';

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
export type GMaps = {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => unknown;
  Marker: new (opts: Record<string, unknown>) => {
    setPosition: (latLng: { lat: number; lng: number } | unknown) => void;
    getPosition: () => { lat: () => number; lng: () => number } | null;
    addListener: (event: string, cb: () => void) => unknown;
  };
  /*
   * Added with the second consumer (LiveLocationPopover draws the GPS accuracy
   * ring around the technician). Same minimal-surface rule as the two above:
   * declare only the members a call site actually uses, so this stays a
   * hand-written stub rather than creeping toward @types/google.maps.
   */
  Circle: new (opts: Record<string, unknown>) => {
    setCenter: (latLng: { lat: number; lng: number } | unknown) => void;
    setRadius: (metres: number) => void;
    setOptions: (opts: Record<string, unknown>) => void;
    setMap: (map: unknown) => void;
  };
  /* Breadcrumb trail for a job (LiveLocationPopover). Same minimal surface. */
  Polyline: new (opts: Record<string, unknown>) => {
    setPath: (path: Array<{ lat: number; lng: number }>) => void;
    setOptions: (opts: Record<string, unknown>) => void;
    setMap: (map: unknown) => void;
  };
  /* Needed to frame a whole trail — see fitToTrail in LiveLocationPopover. */
  LatLngBounds: new () => {
    extend: (latLng: { lat: number; lng: number }) => unknown;
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
export async function resolveApiKey(): Promise<string | null> {
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
export function loadGoogleMaps(): Promise<GMaps> {
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
 * Dark-mode map styling.
 *
 * Google's default tiles are near-white. Dropped into the CRM's dark theme
 * they are a lit rectangle in a dark page — the single brightest thing on
 * screen, and the operator is looking at it during a phone call.
 *
 * Every colour is a palette token rather than one of Google's published dark
 * presets. A preset would be a second palette nobody reviewed, living outside
 * the rebrand seam; `npm run check:brand` would reject the hex literals it
 * needs, and it would be right to. The map is a surface of the product, so it
 * uses the product's surfaces: ink900 for ground, ink700 for roads, blue900
 * for water (already the identity's deep-blue block), ink300 for label text.
 *
 * Light mode gets NO styles array — Google's default light tiles already sit
 * correctly in the light theme, and restyling them would mean maintaining two
 * bespoke map skins to fix a problem that only exists in one of them.
 */
export const darkMapStyles: Array<Record<string, unknown>> = [
  { elementType: 'geometry', stylers: [{ color: palette.ink900 }] },
  { elementType: 'labels.text.fill', stylers: [{ color: palette.ink300 }] },
  // A stroke in the ground colour, so labels stay legible over roads and water
  // without a halo that reads as a second colour.
  { elementType: 'labels.text.stroke', stylers: [{ color: palette.ink900 }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: palette.ink500 }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: palette.ink700 }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: palette.ink700 }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: palette.ink900 }] },
  // Highways one step lighter than surface roads — the only hierarchy cue left
  // once every road is a neutral.
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: palette.ink500 }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: palette.ink700 }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: palette.blue900 }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: palette.blue500 }] },
];
