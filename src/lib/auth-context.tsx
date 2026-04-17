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

  return <Ctx.Provider value={{ me, loading, refresh }}>{children}</Ctx.Provider>;
}

export function useMe() { return useContext(Ctx); }
