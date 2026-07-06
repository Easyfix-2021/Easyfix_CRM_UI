/*
 * Standard fetch / debounce hooks for CRM_UI.
 *
 * MANDATORY pattern (per memory `feedback_crm_ui_fetch_hooks`):
 *   - Don't write `useEffect + api.get` directly in components — use
 *     `useFetch` / `useFetchOnce` here so the dedup + cleanup + Strict
 *     Mode race guards live in one place.
 *   - Don't write your own setTimeout debounce — use `useDebouncedValue`.
 *
 * These mirror the patterns established in `Easyfix_client_UI/src/lib/hooks.ts`
 * (see the cross-app memory note). One source of truth keeps the two
 * apps' fetch behavior consistent.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';

/*
 * Module-level in-flight + last-result caches keyed by request URL.
 * The in-flight Map dedupes concurrent calls (React Strict Mode mounts
 * effects twice in dev; without dedup that's two real HTTP requests).
 * The result Map is a tiny LRU-ish memoization so a back-button revisit
 * within the TTL doesn't refire — caller can opt out with a fresh key.
 */
const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, { at: number; data: unknown }>();
const CACHE_TTL_MS = 30_000;

/*
 * Internal — execute the request, deduping concurrent hits on the same
 * key and memoising the result for CACHE_TTL_MS. The cache is a
 * convenience for "open modal twice in a row" patterns; callers that
 * need fresh data on every call should pass a key that includes a
 * version/timestamp.
 */
function dedupedGet<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return Promise.resolve(cached.data as T);
  }
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  // Guard both writes on identity: if this entry was evicted (invalidate /
  // refetch) while the request was in flight, the orphaned promise must not
  // write a pre-mutation snapshot back into the caches.
  const p: Promise<T> = fetcher()
    .then((data) => {
      if (inflight.get(key) === p) cache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/*
 * Force-evict cached entries whose key matches a predicate. Used by
 * mutation handlers to invalidate stale list/detail caches after a save.
 *
 *   invalidateFetch((k) => k.startsWith('/admin/users'));
 */
export function invalidateFetch(predicate: (key: string) => boolean) {
  for (const k of Array.from(cache.keys())) if (predicate(k)) cache.delete(k);
  for (const k of Array.from(inflight.keys())) if (predicate(k)) inflight.delete(k);
}

/*
 * Drop EVERY cached entry — useful on logout / global state resets.
 */
export function clearFetchCache() {
  cache.clear();
  inflight.clear();
}

type FetchState<T> = { data: T | null; loading: boolean; error: string | null };

/*
 * useFetch — generic fetch hook keyed by a stable string. Re-runs only
 * when the key changes; in-flight + result caching handled module-side.
 *
 *   const { data, loading, error } = useFetch<UsersResponse>(
 *     `/admin/users?limit=10&offset=${page*10}`,
 *   );
 *
 * Pass `enabled: false` to defer the fetch (e.g. until a parent value
 * is ready). The hook returns `{ data: null, loading: false }` until
 * `enabled` flips true.
 */
export function useFetch<T>(
  key: string | null,
  options: { enabled?: boolean } = {},
): FetchState<T> & { refetch: () => void } {
  const enabled = options.enabled !== false && key != null;
  const [state, setState] = useState<FetchState<T>>({
    data: null, loading: enabled, error: null,
  });
  // Bump this counter to force a refetch — used by the returned
  // `refetch` callback. The counter is included in the effect's
  // dependencies so the next fire bypasses the module cache check
  // (it doesn't, actually — see the note on cache-busting).
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !key) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    dedupedGet<T>(key, () => api.get<T>(key))
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((e) => {
        if (!cancelled) setState({
          data: null, loading: false,
          error: e instanceof ApiError ? e.message : 'Failed to load',
        });
      });
    return () => { cancelled = true; };
  }, [key, enabled, tick]);

  return {
    ...state,
    refetch: () => {
      // Drop cached entry for this key, then bump the tick. The next
      // effect run will see no cache hit and fire a real request.
      if (key) { cache.delete(key); inflight.delete(key); }
      setTick((t) => t + 1);
    },
  };
}

/*
 * useFetchOnce — fires once on mount with the given key. Equivalent to
 * `useFetch(key)` but explicit about intent and useful for static
 * lookups (lookups never change during a page session).
 */
export function useFetchOnce<T>(key: string): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({
    data: null, loading: true, error: null,
  });
  // Ref-guarded so a second Strict-Mode invocation in dev doesn't
  // overwrite state mid-flight (the deduped request already returns
  // the cached promise, but the cleanup path could otherwise drop
  // a setState that should have landed).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    dedupedGet<T>(key, () => api.get<T>(key))
      .then((data) => { if (mounted.current) setState({ data, loading: false, error: null }); })
      .catch((e) => {
        if (mounted.current) setState({
          data: null, loading: false,
          error: e instanceof ApiError ? e.message : 'Failed to load',
        });
      });
    return () => { mounted.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/*
 * useUiFlags — global (non-per-user) runtime UI toggles the backend exposes at
 * GET /admin/config/ui-flags (backed by easyfix_properties, DB-flipped). One
 * cached fetch per session via useFetchOnce. Defaults preserve the historical
 * behaviour until the value lands: customer numbers MASKED, map CLICKABLE.
 *
 *   const { customerNumberVisible, mapClickable, loaded } = useUiFlags();
 */
export function useUiFlags(): {
  customerNumberVisible: boolean;
  mapClickable: boolean;
  loaded: boolean;
} {
  const { data, loading } = useFetchOnce<{ customerNumberVisible: boolean; mapClickable: boolean }>(
    '/admin/config/ui-flags',
  );
  // Defensive: useFetchOnce has no request timeout, so a HUNG endpoint (socket
  // open, no response) would leave `loading` true forever — and any consumer
  // that gates rendering on `loaded` (the address-picker map) would never
  // render. Fall back to "settled with safe defaults" after 5s so a slow/hung
  // config fetch can never permanently break the UI.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setTimedOut(true), 5000);
    return () => clearTimeout(t);
  }, [loading]);
  return {
    customerNumberVisible: data?.customerNumberVisible === true,
    mapClickable: data?.mapClickable !== false, // default clickable until known
    // "Settled" = success, error, OR the 5s timeout above. Consumers gating on
    // this must NOT block forever — on error/timeout `data` is null so the safe
    // defaults apply (numbers masked, map clickable).
    loaded: !loading || timedOut,
  };
}

/*
 * useDebouncedValue — returns the input value debounced by `delayMs`.
 * Use this for search inputs etc. — emits the trailing value, no
 * leading-edge fire, no setTimeout cleanup boilerplate at call sites.
 *
 *   const dq = useDebouncedValue(q, 300);
 *   const { data } = useFetch(dq ? `/admin/users?q=${dq}` : null);
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/* ════════════════════════════════════════════════════════════════════════
 * usePostFetch — POST sibling of the GET-only useFetch.
 *
 * Report pages POST a Joi-validated filter body to /api/admin/quicksight/*
 * endpoints; useFetch can only GET. This hook carries the same guarantees:
 *   - module-level in-flight dedupe (Strict-Mode double-mount → one request);
 *   - stale-response cancellation guard (a slow earlier request can't clobber
 *     newer state when url/body change mid-flight);
 *   - loading / error / data + refetch, plus `status` so callers can detect a
 *     403 the same way they read `error` (matches the error-shape convention
 *     of useFetch — ApiError.message → error, ApiError.status → status).
 *
 * NOTE: unlike useFetch there is NO result-cache TTL here. POST bodies are
 * filter queries; re-firing on a changed body must always hit the server.
 * Dedupe is purely in-flight (kills the dev double-fire) and self-evicts.
 * ════════════════════════════════════════════════════════════════════════ */

/* JSON-serializable request body. Loose by design — the BE Joi schema is the
 * real contract; the hook only needs it to be stable-stringifiable for keying.
 */
export type PostBody = Record<string, unknown>;

/* In-flight POSTs keyed by `${url}\n${serializedBody}`. Separate from the GET
 * caches so a GET and POST to the same path never collide on a bare path key.
 */
const inflightPost = new Map<string, Promise<unknown>>();

function dedupedPost<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflightPost.get(key);
  if (existing) return existing as Promise<T>;
  const p: Promise<T> = fetcher().finally(() => {
    if (inflightPost.get(key) === p) inflightPost.delete(key);
  });
  inflightPost.set(key, p);
  return p;
}

type PostFetchState<T> = FetchState<T> & { status: number | null };

/*
 * usePostFetch — fetch via api.post, re-firing whenever `url` or the serialized
 * `body` changes. Pass `url: null` (or `enabled: false`) to defer the call.
 *
 *   const { data, loading, error, status } = usePostFetch<SummaryRow[]>(
 *     canView ? '/admin/quicksight/open-orders/summary' : null,
 *     appliedFilters,
 *     { enabled: canView },
 *   );
 *   const is403 = status === 403;
 */
export function usePostFetch<T>(
  url: string | null,
  body: PostBody,
  options: { enabled?: boolean } = {},
): PostFetchState<T> & { refetch: () => void } {
  const enabled = options.enabled !== false && url != null;

  // Serialize the body once per render so the effect re-runs on a value change
  // (not on a new object identity). This is the POST analogue of useFetch's
  // string key — url + serialized body together identify the request.
  const serializedBody = useMemo(() => JSON.stringify(body ?? {}), [body]);
  const key = url == null ? null : `${url}\n${serializedBody}`;

  const [state, setState] = useState<PostFetchState<T>>({
    data: null, loading: enabled, error: null, status: null,
  });
  // Bump to force a refetch (drops the in-flight entry then re-runs the effect).
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || url == null || key == null) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null, status: null }));
    dedupedPost<T>(key, () => api.post<T>(url, body))
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null, status: 200 });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({
          data: null,
          loading: false,
          error: e instanceof ApiError ? e.message : 'Failed to load',
          status: e instanceof ApiError ? e.status : 0,
        });
      });
    return () => { cancelled = true; };
    // `body` is captured through `key` (serialized); re-running on `key`/`tick`
    // covers every value change without depending on object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, tick]);

  return {
    ...state,
    refetch: () => {
      if (key) inflightPost.delete(key);
      setTick((t) => t + 1);
    },
  };
}
