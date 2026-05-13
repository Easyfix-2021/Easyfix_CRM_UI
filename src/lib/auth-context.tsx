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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try { setMe(await api.get<Me>('/auth/me')); }
    catch { router.replace('/login'); }
    finally { setLoading(false); }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Re-fetch on window focus so role/scope updates made in another tab
  // (or by an admin while the user is logged in) propagate without
  // requiring a hard refresh. Throttle to once per 30s to avoid
  // hammering /auth/me when a user flips between tabs rapidly.
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
