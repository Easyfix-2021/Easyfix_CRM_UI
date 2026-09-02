/*
 * The cache layer behind useLookup() — three tiers, keyed BY USER.
 *
 * Split out of use-lookup.ts on 2026-09-02 for one reason: this repo's unit
 * tests compile a fixed list of DEPENDENCY-FREE src/lib modules with plain
 * `tsc` (see the "test:build" script) and require the output out of
 * .test-build — no path aliases, no JSX, no React. use-lookup.ts imports
 * React and `@/lib/api`, so it cannot be compiled that way, and the identity
 * namespacing below — a security property, see the block comment on IDENTITY —
 * shipped in ade3724 with no test at all. This file imports NOTHING, which is
 * what makes it testable; use-lookup.ts keeps only the hook and re-exports
 * everything here so no call site changed.
 *
 * ─── THE THREE TIERS ───────────────────────────────────────────────────────
 *   1. in-memory Map     — zero-cost read for the rest of the session
 *   2. sessionStorage    — survives soft/hard browser reload; cleared on tab close
 *   3. in-flight Promise — de-dupes concurrent first-fetches (the real fix for
 *      the saturation bug: two modals mounting in parallel used to each fire
 *      all 10 lookup requests simultaneously, so 20 requests hit the backend
 *      in the same millisecond)
 *
 * A 30-minute TTL on sessionStorage entries keeps long-lived tabs from
 * permanently caching a stale dropdown.
 */
const MEM_CACHE = new Map<string, unknown>();
const INFLIGHT = new Map<string, Promise<unknown>>();

// Versioned prefix: bump the suffix whenever a lookup's SHAPE or CONTENT bounds
// change so already-cached sessionStorage payloads are ignored on next load.
// v2 (2026-07-07): cities lookup limit raised 1000→20000 (was truncating the
// dropdown mid-alphabet at ~"Balwada") + payload trimmed to id/name/state_id.
// Without this bump, a warm tab keeps serving the stale 1000-row list for 30min.
export const SS_PREFIX = 'efx-lookup:v2:';
export const SS_TTL_MS = 30 * 60 * 1000;

/*
 * THE CACHE IS NAMESPACED BY USER, and that is a security property, not tidiness.
 *
 * Several of these lookups are RBAC-SCOPED server-side — `clients` most of all:
 * /shared/lookup/clients filters `client_id IN (scope.clients.ids)` for a caller
 * with specific clients assigned. The cached payload is therefore that ONE
 * user's list, but the key was just `efx-lookup:v2:clients`.
 *
 * sessionStorage survives a logout — it is cleared when the TAB closes, not when
 * the session ends, and nothing called clearLookupCache() on sign-out. So an
 * Admin signing in first warmed `clients` with EVERY client, and a Project
 * Manager signing in afterwards in the same tab read that entry and saw all of
 * them, for up to the 30-minute TTL, while the job rows underneath stayed
 * correctly scoped. Reported on a real account: 10 clients mapped, every client
 * in the dropdown.
 *
 * Namespacing by user id makes it structurally impossible to read another
 * identity's entry, which is stronger than remembering to clear on the way out —
 * a missed clear is silent, a namespace mismatch simply misses the cache and
 * refetches. setLookupIdentity() below is called from the auth provider whenever
 * the session resolves, and it also drops the previous identity's entries so a
 * shared machine leaves nothing behind.
 */
let IDENTITY = '';
function ns(key: string) { return IDENTITY ? `${IDENTITY}:${key}` : key; }

/*
 * Storage is read off globalThis on EVERY access rather than captured once.
 *
 * Two reasons, both load-bearing. Under SSR there is no sessionStorage at all,
 * so a captured reference would be permanently undefined in a module that Next
 * evaluates on the server and then ships to the browser. And merely TOUCHING
 * the property throws — not just get/set — in a browser configured to block
 * site data, which is why the try/catch wraps the access itself and not only
 * the call. Everything below treats "no storage" and "storage threw" as the
 * same thing: a cache miss. A cache that cannot persist must still serve.
 */
function storage(): Storage | undefined {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}

/*
 * Both take the ALREADY-NAMESPACED key (`ns(key)`), not the bare lookup key.
 *
 * That is deliberate and it closes a race: the write half of fetchOnce runs
 * when the RESPONSE lands, which can be after the user has switched identity.
 * If the write re-derived the namespace at that moment it would stamp identity
 * A's RBAC-scoped payload into identity B's namespace — the original bug,
 * re-entering through the async door. Namespacing once, at call time, means
 * the key a fetch writes under is the key it started under.
 */
function readSession<T>(nsKey: string): T | null {
  try {
    const raw = storage()?.getItem(SS_PREFIX + nsKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t: number; d: T };
    if (Date.now() - parsed.t > SS_TTL_MS) return null;
    return parsed.d;
  } catch { return null; }
}

function writeSession<T>(nsKey: string, data: T) {
  try { storage()?.setItem(SS_PREFIX + nsKey, JSON.stringify({ t: Date.now(), d: data })); }
  catch { /* quota, or private mode — a cache that cannot persist still serves from memory */ }
}

export async function fetchOnce<T>(key: string, loader: () => Promise<T>): Promise<T> {
  // MEM_CACHE is namespaced too: it outlives a client-side sign-out, which does
  // not reload the page, so an un-namespaced in-memory hit would leak exactly
  // the same way sessionStorage did.
  const mk = ns(key);
  if (MEM_CACHE.has(mk)) return MEM_CACHE.get(mk) as T;
  const fromSession = readSession<T>(mk);
  if (fromSession != null) { MEM_CACHE.set(mk, fromSession); return fromSession; }
  if (INFLIGHT.has(mk)) return INFLIGHT.get(mk) as Promise<T>;
  const promise = loader().then((data) => {
    MEM_CACHE.set(mk, data);
    writeSession(mk, data);
    INFLIGHT.delete(mk);
    return data;
  }).catch((err) => { INFLIGHT.delete(mk); throw err; });
  INFLIGHT.set(mk, promise);
  return promise;
}

export function clearLookupCache() {
  MEM_CACHE.clear();
  // INFLIGHT too, matching invalidateLookup: a request the previous identity
  // started must not be handed to the next one as a warm de-dupe hit. Its own
  // .then() still resolves and still writes under the namespace it STARTED
  // with (see readSession/writeSession), so nothing crosses over.
  INFLIGHT.clear();
  const ss = storage();
  if (!ss) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < ss.length; i++) {
      const k = ss.key(i);
      if (k && k.startsWith(SS_PREFIX)) keys.push(k);
    }
    // Collected first, removed after: removeItem() reindexes, so removing
    // inside the loop skips every other entry.
    keys.forEach((k) => ss.removeItem(k));
  } catch { /* ignore */ }
}

/**
 * Drop ONE or more lookup caches by key (the same keys passed to fetchOnce —
 * e.g. 'svcType', 'svcCat'). Clears the in-memory, in-flight, AND sessionStorage
 * layers so the NEXT useLookup() mount refetches that lookup fresh. Use after a
 * mutation that changes a lookup's contents — e.g. deactivating a service type
 * must invalidate 'svcType', otherwise the active-only dropdowns (Manage Deep
 * Skills, Book New Call) keep serving it from the 30-min sessionStorage cache.
 * Prefer this over clearLookupCache() so unrelated lookups stay warm.
 *
 * Scoped to the CURRENT identity, like every other read and write here — it is
 * an invalidation of what this user has cached, not a cross-user purge.
 */
export function invalidateLookup(...keys: string[]) {
  for (const key of keys) {
    MEM_CACHE.delete(ns(key));
    INFLIGHT.delete(ns(key));
    try { storage()?.removeItem(SS_PREFIX + ns(key)); } catch { /* ignore */ }
  }
}

/**
 * Bind the lookup caches to a user. Called by the auth provider every time the
 * session resolves; a CHANGE of identity drops everything the previous one
 * cached. See the namespacing note on IDENTITY — the scoped lookups
 * (`clients` above all) are per-user payloads under what used to be a shared
 * key. Passing null/undefined (signed out) namespaces to '' and still clears.
 *
 * The same identity twice is a no-op ON PURPOSE: the auth provider re-resolves
 * the session on every mount, and clearing there would throw the warm cache
 * away on each navigation — the saturation bug fetchOnce exists to prevent.
 */
export function setLookupIdentity(userId: string | number | null | undefined) {
  const next = String(userId ?? '');
  if (next === IDENTITY) return;
  clearLookupCache();
  IDENTITY = next;
}
