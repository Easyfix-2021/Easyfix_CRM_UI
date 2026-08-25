/*
 * Browser-storage seed for the READ-ONLY technician-app mirror.
 *
 * The technician app is served to the CRM as a static web bundle from
 * `public/technician-mirror/<version>/` and mounted in a same-origin
 * iframe. It boots from `localStorage` exactly as it does on a phone, so
 * the CRM has to lay down the session the app expects BEFORE the frame
 * mounts. That is all this module does.
 *
 * ── The six keys are ALL-OR-NOTHING ─────────────────────────────────────
 * The key names below are not guesses — they are `STORAGE_KEYS` in
 * Easyfix_Technician_Mobile_Application/src/lib/constants.ts, and
 * `easyfix.storage.scope.version` must equal `STORAGE_SCOPE_VERSION`
 * ("1") in that repo's src/lib/sessionScope.ts. Seed five of six and the
 * app does not fail loudly:
 *
 *   - miss `easyfix.storage.owner` / `.scope.version` and the app decides
 *     the persisted store belongs to somebody else and wipes it mid-boot;
 *   - ⚠️ miss `easyfix.tour.seen` and you do NOT get a broken tour — you
 *     get the guided coach-mark OVERLAY, which mounts a full-screen
 *     pressable spotlight above the app. It swallows every tap that
 *     reaches it, so navigation stops working and each subsequent screen
 *     looks silently broken with no error anywhere. That failure costs an
 *     hour to diagnose from the symptom, which is why the caller asserts
 *     on the returned list instead of trusting the writes.
 *
 * So `seedMirrorStorage` returns the keys that did NOT land; the page
 * refuses to mount the iframe unless that list is empty.
 *
 * ── The token is a security property, not a placeholder ─────────────────
 * `easyfix.token` is deliberately the NON-JWT sentinel
 * `mirror.invalid.<efrId>.token`. The app will happily send it as a
 * Bearer token, and EasyFix_Backend's middleware/tech-auth.js runs
 * `jwt.verify` on it, which throws on a value that is not even three
 * dot-separated base64 segments — so every direct call the mirrored app
 * makes to the real mobile API is rejected at the gate. Reads only work
 * because they are rewritten to the CRM's own read-only proxy at
 * /api/admin/easyfixers/:id/mirror/*, which is GET-only (405 otherwise).
 * A total client-side failure of this page therefore still cannot mutate
 * a technician's data. Do not "fix" this by minting a real token.
 *
 * ── Why a bare `easyfix.` prefix sweep is safe ──────────────────────────
 * clearMirrorStorage() removes EVERY localStorage key starting with
 * `easyfix.`. The CRM's own keys are `crm_auth_token` and the
 * `*-help-collapsed` flags — neither carries the prefix, so the sweep
 * collides with nothing the CRM owns. It has to be a prefix sweep rather
 * than a six-key delete because the app writes account-scoped data of its
 * own under `easyfix.user.<efrId>.*` and `easyfix.cache.*` while the
 * operator browses; leaving those behind would bleed one technician's
 * cached screens into the next technician the operator opens.
 */

/** Every key the technician app persists lives under this prefix. */
const EASYFIX_PREFIX = 'easyfix.';

/** Value of `easyfix.storage.scope.version` — must match STORAGE_SCOPE_VERSION in the app. */
const STORAGE_SCOPE_VERSION = '1';

/**
 * The six keys the app needs to boot into a signed-in state. Exported so
 * the caller can name the missing one in its error, and so a reader can
 * see the whole contract in one place.
 */
export const MIRROR_SEED_KEYS = [
  'easyfix.token',
  'easyfix.technician',
  'easyfix.storage.owner',
  'easyfix.storage.scope.version',
  'easyfix.language',
  'easyfix.tour.seen',
] as const;

export type MirrorSnapshot = {
  /** tbl_easyfixer.efr_id — scopes the store and the sentinel token. */
  efrId: number;
  /** The technician object straight from the mirror-session endpoint. */
  technician: unknown;
  /** The technician's UI language; falls back to 'en'. */
  language?: string | null;
};

/** The deliberately-invalid Bearer sentinel. See the header. */
export function mirrorSentinelToken(efrId: number): string {
  return `mirror.invalid.${efrId}.token`;
}

/**
 * Drop every `easyfix.`-prefixed key. Safe to call when nothing is
 * seeded; safe on the server (no-op). Called on mount AND unmount so one
 * operator session can never leak into the next.
 */
export function clearMirrorStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    // Object.keys snapshots, so removing while iterating is fine.
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(EASYFIX_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // localStorage throws in an opaque origin or with storage disabled.
    // Nothing to clear in that case, and the seed below will report the
    // same failure as missing keys.
  }
}

/**
 * Seed the six keys. Returns the keys that are NOT readable back
 * afterwards — an empty array means the session is complete and the
 * iframe may mount. Never throws.
 */
export function seedMirrorStorage(snapshot: MirrorSnapshot): string[] {
  if (typeof window === 'undefined') return [...MIRROR_SEED_KEYS];

  const values: Record<(typeof MIRROR_SEED_KEYS)[number], string> = {
    'easyfix.token': mirrorSentinelToken(snapshot.efrId),
    // The app reads this back with JSON.parse (SessionProvider stores it
    // with JSON.stringify), so it must be stringified here too.
    'easyfix.technician': JSON.stringify(snapshot.technician ?? {}),
    'easyfix.storage.owner': String(snapshot.efrId),
    'easyfix.storage.scope.version': STORAGE_SCOPE_VERSION,
    'easyfix.language': snapshot.language || 'en',
    // See the ⚠️ in the header — this one is the expensive omission.
    'easyfix.tour.seen': '1',
  };

  for (const key of MIRROR_SEED_KEYS) {
    try {
      window.localStorage.setItem(key, values[key]);
    } catch {
      // Quota or a blocked store — the read-back below reports it.
    }
  }

  // Verify by READING BACK rather than trusting setItem: a quota error,
  // a blocked store, or an opaque origin all fail silently enough that a
  // write-only check would report success on a session that never landed.
  return MIRROR_SEED_KEYS.filter((key) => {
    try {
      return window.localStorage.getItem(key) == null;
    } catch {
      return true;
    }
  });
}
