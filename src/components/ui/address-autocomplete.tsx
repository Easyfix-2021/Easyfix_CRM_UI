'use client';

/*
 * AddressAutocomplete — Google Places Autocomplete in a typeahead
 * input, debounced + backend-proxied so we never expose
 * GOOGLE_MAPS_API_KEY to the browser bundle.
 *
 * Cost control (every keystroke can be a paid Google API hit):
 *   - 1000ms debounce after keyup — operator's natural pause when
 *     they stop typing to look at suggestions. Increased from 350ms
 *     after ops reported every typed character triggering a call.
 *   - min 3 chars before firing
 *   - in-flight request abort on the next keystroke (no stale results)
 *   - results memoised by query string (same query within 60s = no
 *     refetch). Backend ALSO caches the query so concurrent operators
 *     typing the same prefix get one paid hit between them.
 *
 * When the operator picks a suggestion the component fires
 * `/admin/maps/geocode?place_id=…` to resolve the suggestion to
 * lat/lng + structured address components, then calls `onPick` with
 * the full payload. Caller uses the payload to pre-fill GPS + PIN
 * + city in its own form.
 *
 * Bypass path: free-typing a custom address that doesn't match any
 * suggestion still works — the input is fully editable; `onChange`
 * always fires on every keystroke so the parent form's address
 * field stays in sync.
 */

import * as React from 'react';
import { Input } from './input';
import { api, ApiError } from '@/lib/api';

export type AddressPickPayload = {
  description: string;
  lat: number | null;
  lng: number | null;
  formatted_address: string;
  components: {
    postal_code?: string;
    city?: string;
    state?: string;
    country?: string;
    route?: string;
    sublocality?: string;
  };
};

type Suggestion = {
  place_id: string;
  description: string;
  primary: string;
  secondary: string;
};

const RESULT_CACHE = new Map<string, { items: Suggestion[]; expires: number }>();
const RESULT_TTL_MS = 60 * 1000;

/*
 * Module-level "Places is failing right now" circuit breaker with
 * auto-reset. Tripped when the backend returns a hard failure
 * (Google REQUEST_DENIED → 502, missing API key → 503). Stops the
 * autocomplete from bombarding the backend; the address field stays
 * fully usable as a plain Input.
 *
 * Auto-reset: 2 minutes. Operator just updated the API key in env
 * and restarted the backend? The circuit breaker rearms on its own
 * so they don't have to hard-reload the SPA to retry. The 2-minute
 * window is long enough that we don't pound the API on a persistent
 * misconfig, short enough to give ops near-immediate feedback when
 * they fix it.
 */
const PLACES_COOLDOWN_MS = 2 * 60 * 1000;
let PLACES_DISABLED_UNTIL = 0;
function placesDisabled(): boolean {
  return Date.now() < PLACES_DISABLED_UNTIL;
}
function tripPlaces(): void {
  PLACES_DISABLED_UNTIL = Date.now() + PLACES_COOLDOWN_MS;
}

export function AddressAutocomplete({
  value,
  onChange,
  onPick,
  placeholder,
  required,
  className,
  disabled,
}: {
  /** Current input value — controlled by the parent form. */
  value: string;
  /** Fires on every keystroke so the parent form's address field
   *  stays in sync, INCLUDING when the operator types a custom
   *  address that doesn't match any Google suggestion. */
  onChange: (v: string) => void;
  /** Fires when the operator clicks a suggestion. Payload includes
   *  geocoded lat/lng + structured address components. */
  onPick: (payload: AddressPickPayload) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<Suggestion[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const abortRef = React.useRef<AbortController | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  // Debounced query effect. 350ms feels natural; <200ms wastes API
  // hits on every keystroke and >500ms makes the suggestion list
  // feel laggy.
  React.useEffect(() => {
    if (!value || value.length < 3 || disabled || placesDisabled()) {
      // Circuit-broken or below threshold: don't ping the backend.
      // Field stays fully usable as a plain Input.
      setItems([]);
      setLoading(false);
      return;
    }
    const cached = RESULT_CACHE.get(value.toLowerCase());
    if (cached && cached.expires > Date.now()) {
      setItems(cached.items);
      setLoading(false);
      return;
    }
    // 1000ms = "operator finished typing a word and is about to
    // look at suggestions" debounce. Anything shorter fires while
    // they're still typing → wasted API hits.
    const handle = setTimeout(async () => {
      // Cancel any in-flight request from the previous keystroke —
      // otherwise a slow earlier query can overwrite the latest
      // result and feel stale.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const r = await api.get<{ items: Suggestion[] }>('/admin/maps/autocomplete', { q: value });
        if (ctrl.signal.aborted) return;
        const rows = r.items || [];
        RESULT_CACHE.set(value.toLowerCase(), { items: rows, expires: Date.now() + RESULT_TTL_MS });
        setItems(rows);
        setOpen(true);
        setActiveIdx(0);
      } catch (e) {
        // ApiError 400 from min-length validation is benign; swallow.
        if (!(e instanceof ApiError && e.status === 400)) {
          // Hard failure (502 from Google REQUEST_DENIED, 503 missing
          // API key, network down). Trip the circuit breaker so we
          // don't burn more credits this session — the operator can
          // still type the address freely; we just stop suggesting.
          if (e instanceof ApiError && (e.status === 502 || e.status === 503)) {
            tripPlaces();
          }
          // eslint-disable-next-line no-console
          console.warn('autocomplete failed; switching to plain-input fallback', e);
        }
        setItems([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 1000);
    return () => clearTimeout(handle);
  }, [value, disabled]);

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function pick(s: Suggestion) {
    onChange(s.description);
    setOpen(false);
    try {
      // Fire geocode for lat/lng + components. If it fails, we still
      // populate the description so the operator can save the job —
      // GPS just stays empty.
      const r = await api.get<{
        lat: number | null;
        lng: number | null;
        formatted_address: string;
        address_components: AddressPickPayload['components'];
      }>('/admin/maps/geocode', { place_id: s.place_id });
      onPick({
        description: s.description,
        lat: r.lat,
        lng: r.lng,
        formatted_address: r.formatted_address,
        components: r.address_components || {},
      });
    } catch {
      onPick({
        description: s.description,
        lat: null,
        lng: null,
        formatted_address: s.description,
        components: {},
      });
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open || items.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter')   { e.preventDefault(); if (items[activeIdx]) pick(items[activeIdx]); }
    else if (e.key === 'Escape')  { setOpen(false); }
  }

  return (
    <div ref={wrapRef} className="relative">
      <Input
        value={value}
        onChange={(e) => { onChange(e.target.value); if (e.target.value.length >= 3) setOpen(true); }}
        onFocus={() => { if (items.length > 0) setOpen(true); }}
        onKeyDown={onKey}
        placeholder={placeholder}
        required={required}
        className={className}
        disabled={disabled}
        autoComplete="off"
      />
      {open && (loading || items.length > 0) && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-white shadow-lg max-h-64 overflow-y-auto">
          {loading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
          )}
          {!loading && items.map((s, i) => (
            <button
              type="button"
              key={s.place_id}
              onClick={() => pick(s)}
              onMouseEnter={() => setActiveIdx(i)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/60 ${i === activeIdx ? 'bg-muted/40' : ''}`}
            >
              <div className="font-medium truncate">{s.primary}</div>
              {s.secondary && (
                <div className="text-xs text-muted-foreground truncate">{s.secondary}</div>
              )}
            </button>
          ))}
          {!loading && items.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No matches.</div>
          )}
        </div>
      )}
    </div>
  );
}
