'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from './api';
import { setLookupIdentity } from './use-lookup';

/*
 * Single source of truth for the logged-in user + role. Before this, Sidebar
 * and Navbar each called `api.get('/auth/me')` independently, producing two
 * identical HTTP requests + two DB user lookups on every page load. On hard
 * reload that added two connections to an already-burstful open — enough to
 * push the pool into queue-saturation on the first 500ms.
 *
 * Hard-fail (401) from /auth/me still redirects to /login, matching the old
 * Navbar behaviour — but it happens once, not twice.
 */

export type Me = {
  // `mobile_no` carries the operator's profile mobile number — already
  // returned by GET /auth/me via findUserById (services/auth.service.js
  // SELECTs it). Surfaced in the type so click-to-call's QA-mode dialog
  // can pre-fill the Call From field; safe to read elsewhere too.
  /*
   * These are the columns findUserById already SELECTs (services/auth.service.js)
   * and /auth/me already returns verbatim as `user` — the type simply declared
   * four of them and stayed silent about the rest. Widened for the My Profile
   * page; purely additive, so no existing reader changes.
   *
   * NOT declared, because they are NOT in the payload and never have been:
   * a profile image and bank details. tbl_user has no such columns — those
   * belong to TECHNICIANS on tbl_easyfixer. Adding optional fields here for
   * them would invite a reader to render undefined forever.
   */
  user: {
    user_id: number;
    user_name: string;
    official_email: string;
    mobile_no?: string | null;
    user_code?: string | null;
    alternate_no?: string | null;
    user_status?: number | null;
    /*
     * Short-TTL presigned URL for the header avatar, or null when the user has
     * no photo — which is also what a misconfigured object store returns, on
     * purpose. Both mean "render the initials monogram", so nothing downstream
     * needs a separate degraded branch. It is never a placeholder image URL: a
     * broken <img> and "no photo set" must not be indistinguishable to the UI.
     *
     * TTL matters: this is resolved when /auth/me is fetched, so it expires on
     * a session left open for hours. The <img> falls back to initials via its
     * onError, rather than showing a broken-image glyph in the header.
     */
    photo_url?: string | null;
  };
  role?: { role_id: number; role_name: string; group: string };
  /*
   * Effective permissions resolved server-side from tbl_role.menu_ids +
   * role_menu_action. Mirrors the legacy session map (LoginAction.java).
   *
   *   menuIds            : sidebar/menu allowlist. A menu is visible iff
   *                        its menu_id appears in this array.
   *   actionPermissions  : button/action-permission keys. Use hasAction()
   *                        from lib/permissions.ts to check.
   *
   * Both are empty arrays when the user has no role, an inactive role, or
   * a role with no permissions configured. The frontend treats empty as
   * "no UI surface" — same as the legacy login (blank sidebar, all-false
   * action map).
   */
  permissions?: { menuIds: number[]; actionPermissions: string[] };
  /*
   * Row-level RBAC scope — parsed from tbl_user.manage_clients /
   * manage_cities / manage_states / manage_verticals. Each dimension
   * has a mode:
   *   'all'   → wildcard (legacy CSV "0"); user sees every row
   *   'allow' → only ids in `ids[]`
   *   'none'  → no access in this dimension; queries return zero rows
   * Admin and Finance roles bypass scope server-side and receive
   * mode='all' across the board.
   *
   * Frontend doesn't usually need to consult `scope` directly — the
   * backend already row-filters list endpoints. It's exposed mainly so
   * the UI can pre-narrow lookups (e.g. only show the SPOC's allowed
   * clients in the New-Job picker) and show "no access" hints.
   */
  scope?: {
    clients:   { mode: 'all' | 'allow' | 'none'; ids: number[]; placeholders?: string };
    cities:    { mode: 'all' | 'allow' | 'none'; ids: number[]; placeholders?: string };
    states:    { mode: 'all' | 'allow' | 'none'; ids: number[]; placeholders?: string };
    verticals: { mode: 'all' | 'allow' | 'none'; ids: number[]; placeholders?: string };
  };
  /*
   * Hierarchy roll-up — the count of direct reports and the full
   * descendant set under this user in the manager tree. Surfaced in
   * the Navbar's "Effective Access" panel so ops can self-diagnose
   * "why am I seeing X downstream user's jobs?" without filing a
   * ticket. The backend resolves this from tbl_user.manager_user_id.
   */
  hierarchy?: { directReportsCount: number; descendantsCount: number };
  /*
   * scheduledJobsAccess (2026-06-06): true when the operator's
   * official_email is present in the `scheduled.jobs.visible.emails`
   * easyfix_properties row. Drives a single hardcoded sidebar entry
   * ("Settings → Scheduled Jobs") that doesn't go through the normal
   * menu/role pipeline. The BE returns 403 from
   * /admin/scheduled-jobs/* for off-allowlist users regardless of the
   * FE flag — this is purely a UI affordance.
   */
  scheduledJobsAccess?: boolean;
  /*
   * canManageJobCharges (2026-07-28): true when the operator may view and
   * mutate the job "Billing & Charges" workspace tab (Travel / Incentive /
   * Penalty line items, advance requests, Job Sheet / Purchase Order
   * documents, and per-service client-approval toggles). Resolved
   * server-side on /auth/me — same one-off boolean shape as
   * `scheduledJobsAccess` / the admin-actions feature flags, sitting
   * OUTSIDE the normal menu/role permission pipeline.
   *
   * Fail-closed: the Billing & Charges tab (and every mutating control
   * inside it) is hidden entirely when this is falsy. The BE additionally
   * enforces the same gate on /admin/jobs/:id/charges/* regardless of the
   * FE flag — this is purely a UI affordance.
   */
  canManageJobCharges?: boolean;
  /*
   * allowedStages (Job Stage Access) — the per-user restriction of which job
   * lifecycle STAGES the operator may see + act on. Resolved server-side on
   * /auth/me from tbl_user_allowed_stages.
   *   mode 'all'  → unrestricted (the default — nobody has stage rows until an
   *                 admin grants some). Every tab / row / transition button
   *                 shows. NOTE: unlike scope, Admin/Finance do NOT bypass
   *                 this; a grant applies to whoever it was set on.
   *   mode 'list' → restricted to `stages` (STAGE_KEYS from lib/job-stages.ts).
   *                 An EMPTY `stages` is a real grant meaning NO access, not
   *                 a synonym for 'all'.
   *
   * The FE uses this for UX + defense-in-depth (tab clamping, hiding
   * transition buttons the server would reject). The server LIST endpoint
   * remains authoritative and row-filters regardless of this flag. Helpers:
   * transitionAllowed / stageVisible / filterTabsForStages in lib/job-stages.
   */
  allowedStages?: { mode: 'all' | 'list'; stages: string[] };
};

// Scope dimension shape — exported so the My Profile page's Effective Access
// table can type its row renderer without redeclaring the union locally.
// (It lived in the Navbar until that dropdown became the profile page.)
export type ScopeDimension = { mode: 'all' | 'allow' | 'none'; ids: number[]; placeholders?: string };

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => Promise<void> }>({
  me: null, loading: true, refresh: async () => {},
});

/*
 * Module-level in-flight promise. React StrictMode (Next.js dev default)
 * runs every effect twice on mount, so without this dedup the first paint
 * triggers TWO identical `/auth/me` requests. Multiple consumers calling
 * refresh() in parallel collapse to one in-flight request via this ref;
 * each awaiter receives the same resolution.
 */
let mePromise: Promise<Me> | null = null;
function fetchMeOnce(): Promise<Me> {
  if (mePromise) return mePromise;
  mePromise = api.get<Me>('/auth/me').finally(() => { mePromise = null; });
  return mePromise;
}

/*
 * Per-tab sessionStorage cache. Same-session navigations that remount
 * AuthProvider (login → dashboard, or a tab dupe) hydrate from cache
 * instantly while a background refresh runs to catch role changes.
 * 60s TTL is short enough that an admin role flip in another tab
 * propagates within a minute on focus, long enough to absorb the
 * normal mount + StrictMode double-fire + sidebar/navbar re-reads.
 *
 * Cleared on logout / 401 redirect so the login screen never sees a
 * stale `me` for a different user (handled by `clearMeCache()`).
 */
const ME_CACHE_KEY = 'crm_me_cache_v1';
const ME_CACHE_TTL_MS = 60_000;

function readMeCache(): Me | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(ME_CACHE_KEY);
    if (!raw) return null;
    const { data, at } = JSON.parse(raw) as { data: Me; at: number };
    if (Date.now() - at > ME_CACHE_TTL_MS) return null;
    return data;
  } catch { return null; }
}
function writeMeCache(data: Me) {
  if (typeof window === 'undefined') return;
  try { sessionStorage.setItem(ME_CACHE_KEY, JSON.stringify({ data, at: Date.now() })); } catch { /* quota or disabled */ }
}
export function clearMeCache() {
  if (typeof window === 'undefined') return;
  try { sessionStorage.removeItem(ME_CACHE_KEY); } catch { /* ignore */ }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // Hydrate state synchronously from cache so the first paint already has
  // role/permissions — eliminates the "loading flicker" on every internal
  // navigation that remounts the layout.
  const cached = typeof window !== 'undefined' ? readMeCache() : null;
  /*
   * Bind the lookup caches to this identity BEFORE anything can read them.
   * use-lookup namespaces its sessionStorage and in-memory entries by user
   * because several lookups are RBAC-SCOPED server-side — /shared/lookup/clients
   * returns only the caller's assigned clients. sessionStorage outlives a
   * sign-out (it dies with the TAB, not the session) and nothing cleared it, so
   * an Admin's warm `clients` entry was served to the next user who signed in on
   * the same tab: reported on a real account with 10 clients mapped and every
   * client in the dropdown.
   *
   * Called during render rather than in a useEffect on purpose — an effect runs
   * AFTER the first render, and a lookup fired during that render would already
   * have read the previous identity's cache. setLookupIdentity is a no-op when
   * the id has not changed, so this is safe to run on every render.
   */
  setLookupIdentity(cached?.user?.user_id ?? null);
  const [me, setMe] = useState<Me | null>(cached);
  const [loading, setLoading] = useState(!cached);

  async function refresh() {
    try {
      const fresh = await fetchMeOnce();
      // The identity may have CHANGED — sign out, sign in as someone else, same
      // tab. That drops the previous user's cached lookups; unchanged is a no-op.
      setLookupIdentity(fresh?.user?.user_id ?? null);
      setMe(fresh);
      writeMeCache(fresh);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        clearMeCache();
        setLookupIdentity(null); // signed out — drop this user's cached lookups
        router.replace('/login');
      }
      // Transient failure (network blip, 5xx, backend restart): keep the
      // cached `me` — the cookie/JWT is still valid. Next focus-refresh
      // (>=30s) or navigation retries automatically.
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // If we hydrated from cache, refresh silently in the background
    // (no loading flicker) so a stale-by-up-to-60s `me` is corrected
    // before the user notices. Otherwise fall through to the standard
    // blocking refresh.
    if (cached) {
      void refresh();
    } else {
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch on window focus so role/scope updates made in another tab
  // (or by an admin while the user is logged in) propagate without
  // requiring a hard refresh. Throttle to once per 30s to avoid
  // hammering /auth/me when a user flips between tabs rapidly.
  // (The in-flight dedup above is a second safety net.)
  useEffect(() => {
    let lastAt = Date.now();
    function onFocus() {
      if (Date.now() - lastAt < 30_000) return;
      lastAt = Date.now();
      void refresh();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Ctx.Provider value={{ me, loading, refresh }}>{children}</Ctx.Provider>;
}

export function useMe() { return useContext(Ctx); }
