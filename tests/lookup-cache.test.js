const { test } = require('node:test');
const assert = require('node:assert/strict');

/*
 * The lookup cache is namespaced BY USER, and this file exists because that is
 * a security property with no test behind it.
 *
 * What happened (ade3724 fixed it, nothing proved it stayed fixed): several
 * /shared/lookup/* payloads are RBAC-scoped server-side — `clients` above all.
 * The cache key was the bare lookup name, `efx-lookup:v2:clients`, and
 * sessionStorage is cleared when the TAB closes, not when the session ends. An
 * Admin signed in first and warmed that key with EVERY client; a Project
 * Manager signed in afterwards in the same tab and read it. Reported on a real
 * account: 10 clients mapped, every client in the dropdown, backend correct.
 *
 * So every test below is written from the same angle: can identity B observe
 * anything identity A put in? The cache-hit tests are the other half — a
 * namespace that never hits is "secure" and useless, and would have thrown
 * away the request de-duplication these caches exist for.
 *
 * ─── HOW STATE IS RESET ────────────────────────────────────────────────────
 * The caches are module-level (one Map per tier, one IDENTITY string), which is
 * the point — they are shared across every hook mount. So each test re-requires
 * the module through a cleared require cache and installs its own fake storage,
 * rather than reaching in to reset anything the module does not expose.
 */
const MODULE = require.resolve('../.test-build/lookup-cache');

// A fake sessionStorage. Web Storage semantics, the two that matter here:
// key(i) indexes insertion order (so a mid-loop removeItem would reindex), and
// every value is coerced to a string.
function fakeStorage(initial) {
  const map = new Map(initial || []);
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
    // test-only window onto the raw contents
    _keys() { return [...map.keys()]; },
  };
}

function fresh(storage) {
  delete require.cache[MODULE];
  globalThis.sessionStorage = storage;
  return require(MODULE);
}

// A loader that counts its calls: the ONLY honest way to tell a cache hit from
// a cache miss from outside the module. `calls === 1` after two fetches means
// it hit; `calls === 2` means it missed and refetched.
function countingLoader(value) {
  const fn = () => { fn.calls++; return Promise.resolve(value); };
  fn.calls = 0;
  return fn;
}

const ADMIN_CLIENTS = [{ client_id: 1 }, { client_id: 2 }, { client_id: 3 }];
const PM_CLIENTS = [{ client_id: 1 }];

// ─── the leak itself ─────────────────────────────────────────────────

test('an entry written by identity A is not readable by identity B', async () => {
  const ss = fakeStorage();
  const cache = fresh(ss);

  cache.setLookupIdentity(101);                       // Admin signs in
  const adminLoad = countingLoader(ADMIN_CLIENTS);
  await cache.fetchOnce('clients', adminLoad);

  cache.setLookupIdentity(202);                       // PM signs in, same tab
  const pmLoad = countingLoader(PM_CLIENTS);
  const seen = await cache.fetchOnce('clients', pmLoad);

  assert.equal(pmLoad.calls, 1,
    'the PM must reach the server for its own scoped list, not read the Admin entry');
  assert.deepEqual(seen, PM_CLIENTS, 'this is the reported bug: the PM saw all 3 clients');
});

test('a lookup read before the session resolves cannot see the previous user, either', async () => {
  /*
   * This is the half that the NAMESPACE alone defends, and it is why the fix is
   * a namespace rather than a clear-on-sign-out.
   *
   * Measured while writing this file: with ns() stripped to `return key`, the
   * test above still passed — setLookupIdentity() clears on the way in, so B
   * missed for the wrong reason. Every guarantee needs a path where the other
   * mechanism is not standing in front of it. This is that path: a page RELOAD
   * resets IDENTITY to '' (module state) while sessionStorage survives (tab
   * state), and any dropdown that mounts before the auth provider resolves the
   * session reads with no identity set. Nothing has cleared anything.
   */
  const ss = fakeStorage();
  const first = fresh(ss);
  first.setLookupIdentity(101);                       // Admin
  await first.fetchOnce('clients', countingLoader(ADMIN_CLIENTS));

  const afterReload = fresh(ss);                      // module state reset, storage kept
  const load = countingLoader(PM_CLIENTS);
  const seen = await afterReload.fetchOnce('clients', load);   // identity not resolved yet

  assert.equal(load.calls, 1, 'a read with no identity must not fall into the last user\'s entry');
  assert.deepEqual(seen, PM_CLIENTS);
});

test("switching identity drops the previous identity's entries from both tiers", async () => {
  const ss = fakeStorage();
  const cache = fresh(ss);

  cache.setLookupIdentity(101);
  await cache.fetchOnce('clients', countingLoader(ADMIN_CLIENTS));
  assert.deepEqual(ss._keys(), ['efx-lookup:v2:101:clients'], 'warmed, and namespaced');

  cache.setLookupIdentity(202);
  assert.deepEqual(ss._keys(), [],
    "sign-in as someone else wipes the previous user's sessionStorage entries — "
    + 'a shared machine leaves nothing behind');

  // ...and the in-memory tier too, which outlives a client-side sign-out
  // because that does not reload the page. Proven by refetching AS 101 again:
  // if MEM_CACHE still held it, the loader would not be called.
  cache.setLookupIdentity(101);
  const reload = countingLoader(ADMIN_CLIENTS);
  await cache.fetchOnce('clients', reload);
  assert.equal(reload.calls, 1, 'the in-memory entry was dropped as well, not just the storage one');
});

test('switching back to A does not resurrect what A had cached', async () => {
  const ss = fakeStorage();
  const cache = fresh(ss);

  cache.setLookupIdentity(101);
  await cache.fetchOnce('clients', countingLoader(ADMIN_CLIENTS));
  cache.setLookupIdentity(202);
  await cache.fetchOnce('clients', countingLoader(PM_CLIENTS));
  cache.setLookupIdentity(101);

  const reload = countingLoader(ADMIN_CLIENTS);
  await cache.fetchOnce('clients', reload);
  assert.equal(reload.calls, 1,
    'A → B → A must refetch. Namespacing alone would leave A\'s entry sitting under '
    + 'its own key for the switch back to find; the clear on every change is what stops it');
  assert.deepEqual(ss._keys(), ['efx-lookup:v2:101:clients'], 'and B\'s entry is gone too');
});

// ─── the other half: it still has to be a cache ──────────────────────

test('resolving the same identity twice is a no-op — the cache stays warm', async () => {
  const cache = fresh(fakeStorage());

  cache.setLookupIdentity(101);
  const load = countingLoader(ADMIN_CLIENTS);
  await cache.fetchOnce('clients', load);

  // The auth provider re-resolves the session on every mount and calls this
  // each time. If that cleared, every navigation would refire all 14 lookups —
  // the request saturation fetchOnce exists to prevent.
  cache.setLookupIdentity(101);
  cache.setLookupIdentity('101');   // same id, arriving as a string
  await cache.fetchOnce('clients', load);

  assert.equal(load.calls, 1, 'still one fetch: an unchanged identity must not clear anything');
});

test('signed out namespaces distinctly from any signed-in user, and still clears', async () => {
  const ss = fakeStorage();
  const cache = fresh(ss);

  cache.setLookupIdentity(101);
  await cache.fetchOnce('clients', countingLoader(ADMIN_CLIENTS));

  cache.setLookupIdentity(null);                        // sign-out
  assert.deepEqual(ss._keys(), [], 'sign-out clears, even though there is no new user');

  const anon = countingLoader(PM_CLIENTS);
  await cache.fetchOnce('clients', anon);
  assert.equal(anon.calls, 1);
  assert.deepEqual(ss._keys(), ['efx-lookup:v2:clients'],
    'signed out writes under the un-namespaced key — which is exactly why the next '
    + 'sign-in must clear rather than trust the namespace alone');

  cache.setLookupIdentity(202);
  const pm = countingLoader(PM_CLIENTS);
  await cache.fetchOnce('clients', pm);
  assert.equal(pm.calls, 1, 'and the signed-out entry is not readable by the user who signs in next');

  // undefined is the same signed-out state as null — the auth provider passes
  // whichever it has while the session is unresolved, and the two must not be
  // two different namespaces.
  cache.setLookupIdentity(undefined);
  assert.deepEqual(ss._keys(), [], 'undefined signs out and clears just like null');
  await cache.fetchOnce('clients', countingLoader(ADMIN_CLIENTS));
  assert.deepEqual(ss._keys(), ['efx-lookup:v2:clients']);
});

// ─── TTL ─────────────────────────────────────────────────────────────

/*
 * Seed a storage entry for the CURRENT identity at a chosen age, then read it
 * back through a cold in-memory tier.
 *
 * The seeding happens after setLookupIdentity() on purpose, and the ordering is
 * not cosmetic: setLookupIdentity('' → 101) clears storage, so anything planted
 * before the identity resolves is wiped before the read. (That is also why tier
 * 2 does not in fact survive a page reload today — see the note at the bottom
 * of this file.) The in-memory tier is emptied with invalidateLookup so the
 * fetch has to go through readSession and hit the TTL branch, which is the
 * thing under test.
 */
function seedAged(cache, ss, ageMs, data) {
  ss.setItem('efx-lookup:v2:101:clients', JSON.stringify({ t: Date.now() - ageMs, d: data }));
}

test('a sessionStorage entry older than the 30-minute TTL is not served', async () => {
  const ss = fakeStorage();
  const cache = fresh(ss);
  cache.setLookupIdentity(101);

  // An aged `t` rather than a faked clock: the TTL is computed from the stored
  // timestamp, so this is exactly the input a 31-minute-old tab presents.
  seedAged(cache, ss, cache.SS_TTL_MS + 60_000, ADMIN_CLIENTS);
  const load = countingLoader(PM_CLIENTS);
  assert.deepEqual(await cache.fetchOnce('clients', load), PM_CLIENTS);
  assert.equal(load.calls, 1, 'expired entries refetch — a long-lived tab must not pin a stale dropdown');

  // The same entry one minute INSIDE the window is still served. Without this
  // half the TTL test would pass just as well against a cache that never
  // reads storage at all.
  cache.invalidateLookup('clients');
  seedAged(cache, ss, cache.SS_TTL_MS - 60_000, ADMIN_CLIENTS);
  const unused = countingLoader(PM_CLIENTS);
  assert.deepEqual(await cache.fetchOnce('clients', unused), ADMIN_CLIENTS);
  assert.equal(unused.calls, 0, 'a fresh entry is served from storage without a fetch');
});

// ─── targeted invalidation ───────────────────────────────────────────

test('invalidateLookup drops only the current identity\'s entry for that key', async () => {
  const ss = fakeStorage();
  const cache = fresh(ss);

  cache.setLookupIdentity(101);
  await cache.fetchOnce('svcType', countingLoader([{ id: 1 }]));
  await cache.fetchOnce('clients', countingLoader(ADMIN_CLIENTS));

  // Another identity's entry, planted directly — invalidation must not be a
  // cross-user purge; clearLookupCache() is the tool for that.
  ss.setItem('efx-lookup:v2:202:svcType', JSON.stringify({ t: Date.now(), d: [{ id: 9 }] }));

  cache.invalidateLookup('svcType');

  const svc = countingLoader([{ id: 2 }]);
  await cache.fetchOnce('svcType', svc);
  assert.equal(svc.calls, 1, 'deactivating a service type must refetch svcType, not serve the 30-min cache');

  const clients = countingLoader(PM_CLIENTS);
  await cache.fetchOnce('clients', clients);
  assert.equal(clients.calls, 0, 'unrelated lookups stay warm — that is the point over clearLookupCache()');

  assert.ok(ss._keys().includes('efx-lookup:v2:202:svcType'),
    "another identity's entry of the same key is untouched");
});

// ─── storage that refuses to work ────────────────────────────────────

test('a storage that throws on every call degrades to memory, it does not break the caller', async () => {
  // Private mode / blocked site data: the getters themselves throw, not just
  // the writes, and the property access can throw before you even reach a method.
  const hostile = {
    get length() { throw new Error('SecurityError'); },
    key() { throw new Error('SecurityError'); },
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  const cache = fresh(hostile);

  cache.setLookupIdentity(101);                    // clears — must survive length/key throwing
  const load = countingLoader(ADMIN_CLIENTS);
  assert.deepEqual(await cache.fetchOnce('clients', load), ADMIN_CLIENTS);

  // The memory tier still works, so the de-duplication survives even with no
  // persistence at all.
  await cache.fetchOnce('clients', load);
  assert.equal(load.calls, 1, 'served from memory; a cache that cannot persist must still serve');

  cache.invalidateLookup('clients');
  cache.setLookupIdentity(202);
  assert.doesNotThrow(() => cache.clearLookupCache());
});

test('no sessionStorage at all (SSR) is a miss, not a crash', async () => {
  const cache = fresh(undefined);
  cache.setLookupIdentity(101);
  const load = countingLoader(ADMIN_CLIENTS);
  assert.deepEqual(await cache.fetchOnce('clients', load), ADMIN_CLIENTS);
  cache.clearLookupCache();
  cache.invalidateLookup('clients');
});

// ─── the async door into the same bug ────────────────────────────────

test('a fetch still in flight when identity changes lands under the identity it STARTED with', async () => {
  const ss = fakeStorage();
  const cache = fresh(ss);

  let release;
  const slow = new Promise((r) => { release = r; });

  cache.setLookupIdentity(101);
  const pending = cache.fetchOnce('clients', () => slow);   // Admin's request leaves

  cache.setLookupIdentity(202);                              // PM signs in mid-flight
  release(ADMIN_CLIENTS);                                    // Admin's response lands
  await pending;

  assert.deepEqual(ss._keys(), ['efx-lookup:v2:101:clients'],
    'the write namespaces at call time, not at resolve time — re-deriving it on '
    + 'resolve would stamp the Admin payload into the PM namespace, which is the '
    + 'original bug re-entering through the async door');

  const pm = countingLoader(PM_CLIENTS);
  assert.deepEqual(await cache.fetchOnce('clients', pm), PM_CLIENTS);
  assert.equal(pm.calls, 1, 'and the PM neither reads it nor is handed the in-flight promise');
});

/*
 * ─── FOUND WHILE WRITING THESE, NOT FIXED HERE ─────────────────────────────
 *
 * Tier 2 no longer survives a page reload for a signed-in user, which is the
 * one thing it exists for. IDENTITY is module state, so a reload resets it to
 * '', the auth provider then resolves the session and calls
 * setLookupIdentity(101), that is a CHANGE, and the change clears storage —
 * including the entry the same user wrote thirty seconds earlier. Measured:
 * the first draft of the TTL test above seeded storage before resolving the
 * identity and the seed was gone by the time fetchOnce read it.
 *
 * Not repaired in this pass because the clear is doing real work: namespacing
 * stops another identity's entry being READ, but only the clear stops it being
 * left on a shared machine. Skipping the clear when the previous identity is ''
 * would restore the reload cache and keep the cross-user guard, at the cost of
 * leaving the signed-out namespace's entries behind. That is a call for whoever
 * owns the auth provider, and it needs its own test.
 */
