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

import { useEffect, useRef, useState } from 'react';
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
  const p = fetcher()
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      inflight.delete(key);
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
}

/*
 * Drop EVERY cached entry — useful on logout / global state resets.
 */
export function clearFetchCache() {
  cache.clear();
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
      if (key) cache.delete(key);
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
