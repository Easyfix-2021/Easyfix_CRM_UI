'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { Navbar } from '@/components/layout/Navbar';
import { AuthProvider } from '@/lib/auth-context';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';

/*
 * Client-side auth gate.
 *
 * Why this layout is a client component:
 *   Next.js server-rendered layouts can't read localStorage (where the JWT
 *   lives — see lib/api.ts). Without a gate here, a logged-out visitor to
 *   /dashboard would see the dashboard shell flash onscreen while its API
 *   calls returned 401s, and only then Navbar's /auth/me catch would push
 *   them to /login. That flash leaks the shape of the app and sometimes
 *   even prior-user data that React cached.
 *
 * We gate on "is a token present" — a cheap sync check. We don't verify
 * the token here; Navbar's /auth/me still runs and will kick out stale
 * tokens. This gate just prevents the unauthenticated flash.
 */

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  // Start as null (unknown) to avoid SSR/CSR mismatch. Read on mount.
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('crm_auth_token') : null;
    if (!token) {
      router.replace('/login');
      setHasToken(false);
      return;
    }
    setHasToken(true);
  }, [router]);

  if (hasToken !== true) {
    // Render a blank shell (not the real children) while we decide. This
    // avoids the "dashboard flash" the user reported and avoids firing
    // any API calls that would come back 401.
    return <div className="h-screen bg-background" />;
  }

  return (
    <AuthProvider>
      <ConfirmDialogProvider>
        <div className="flex h-screen bg-background">
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0">
            <Navbar />
            {/* Horizontal 16px (px-4) gives content breathing room from the sidebar
                border without looking sparse; vertical 12px (py-3) keeps the page
                density tight. Previous p-2 (8px) was flush against the sidebar and
                felt cramped; p-5 (20px) gave too much whitespace. */}
            <main className="flex-1 overflow-y-auto px-4 py-3">{children}</main>
          </div>
        </div>
      </ConfirmDialogProvider>
    </AuthProvider>
  );
}
