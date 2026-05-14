'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './api';

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
  user: { user_id: number; user_name: string; official_email: string };
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
    clients:   { mode: 'all' | 'allow' | 'none'; ids: number[] };
    cities:    { mode: 'all' | 'allow' | 'none'; ids: number[] };
    states:    { mode: 'all' | 'allow' | 'none'; ids: number[] };
    verticals: { mode: 'all' | 'allow' | 'none'; ids: number[] };
  };
};

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
  const [me, setMe] = useState<Me | null>(cached);
  const [loading, setLoading] = useState(!cached);

  async function refresh() {
    try {
      const fresh = await fetchMeOnce();
      setMe(fresh);
      writeMeCache(fresh);
    } catch {
      clearMeCache();
      router.replace('/login');
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
