import { NextResponse, type NextRequest } from 'next/server';
import { legacyUrlToNextPath } from '@/lib/legacy-url-map';

/*
 * Server-side route guard for new-CRM flows that are still in progress.
 *
 * The sidebar already hides their entries (filtered by the BE's
 * NEW_CRM_VISIBLE_MENU_IDS allowlist — see EasyFix_Backend
 * services/lookup.service.js), but a user could still reach the
 * underlying page via bookmark, browser history, an emailed link, or
 * pasting a URL. This middleware redirects those direct navigations to
 * /coming-soon BEFORE the protected page renders, so half-built flows
 * can't be reached even by accident.
 *
 * Source of truth: BE's GET /api/shared/lookup/menu-visibility, which
 * returns the legacy URL slugs of currently-hidden menus. We reverse-map
 * those slugs to Next.js base paths via URL_MAP (shared with Sidebar) and
 * test req.nextUrl.pathname against the resulting set.
 *
 * Caching: `next: { revalidate: 60 }` lets Next.js dedupe + cache the
 * fetch for 60 seconds across all middleware invocations within a worker.
 * Most requests hit the cache → near-zero overhead. We also fail OPEN on
 * any network blip: if the BE is unreachable, the user sees the page
 * (preferable to a redirect loop or a hard error on every request).
 *
 * The /coming-soon page itself, /login, /api/* (BE-proxied), and Next.js
 * internals are excluded from the matcher so we never loop and don't add
 * latency to static-asset / API requests.
 */

interface VisibilityPayload {
  enabled: boolean;
  hiddenLegacyUrls: string[];
}

// NEXT_PUBLIC_API_URL is the same env var the FE client uses to reach the BE
// (default http://localhost:5100/api). It's available in middleware because
// NEXT_PUBLIC_* are inlined at build time everywhere.
const BE_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5100/api';

async function fetchHiddenPaths(cookieHeader: string | null): Promise<Set<string>> {
  try {
    const res = await fetch(`${BE_BASE}/shared/lookup/menu-visibility`, {
      // Pass the user's session cookie through so the BE's JWT middleware
      // accepts the call (the endpoint is mounted under /shared/* which is
      // JWT-gated). Without a cookie this just returns 401 → caught → fail
      // open. That's correct: middleware should not block unauthenticated
      // traffic — /login handles that flow.
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      next: { revalidate: 60, tags: ['menu-visibility'] },
    });
    if (!res.ok) return new Set();
    const body = (await res.json()) as { data?: VisibilityPayload };
    const payload = body?.data;
    if (!payload?.enabled) return new Set();
    const paths = new Set<string>();
    for (const legacy of payload.hiddenLegacyUrls) {
      const next = legacyUrlToNextPath(legacy);
      if (next) paths.add(next);
    }
    return paths;
  } catch {
    // Network blip or BE down → fail open. Better to show the page than to
    // hard-fail every request when the visibility lookup is unreachable.
    return new Set();
  }
}

export async function middleware(req: NextRequest) {
  const hidden = await fetchHiddenPaths(req.headers.get('cookie'));
  if (hidden.has(req.nextUrl.pathname)) {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = '/coming-soon';
    // Preserve the legacy-path hint so the /coming-soon page can surface
    // "this is the path you were trying to reach" — matches the breadcrumb
    // shape Sidebar uses for normal coming-soon links.
    redirectUrl.search = '';
    redirectUrl.searchParams.set('title', 'Not yet available');
    redirectUrl.searchParams.set('legacyPath', req.nextUrl.pathname);
    return NextResponse.redirect(redirectUrl);
  }
  return NextResponse.next();
}

// Skip Next.js internals, static assets, the BE-proxied /api/* paths, login
// (no session = nothing to guard), the coming-soon page itself (avoid
// redirect loops), and the public job-completion magic-link page (different
// auth model, has its own token gate).
export const config = {
  matcher: ['/((?!_next|api|favicon\\.ico|login|coming-soon|job-completion).*)'],
};
