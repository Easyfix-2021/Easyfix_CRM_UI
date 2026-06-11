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
 * Caching (2026-06-04 — fixed log-spam): a module-scope `Map` keyed by
 * cookie hash holds the resolved hidden-paths set for 60 seconds. Without
 * this, Edge middleware re-fetches the BE on every navigation (twice per
 * navigation due to Next's prefetch behaviour), which floods the BE log
 * and adds latency to every page. `next: { revalidate }` is unreliable in
 * Edge middleware — the in-memory Map is the dependable fallback.
 *
 * Guest short-circuit: when no auth cookie is present we skip the BE call
 * entirely. Hitting `/api/shared/...` without auth returns 401 (logged as
 * "guest · authentication required"); doing that on every navigation
 * before login was the visible log-spam in `13:31:54  🔒  401 GET …`
 * the operator flagged. Returning an empty set is the right behaviour for
 * guests anyway — there's nothing for the modal to redirect away from.
 *
 * The /coming-soon page itself, /login, /api/* (BE-proxied), and Next.js
 * internals are excluded from the matcher so we never loop and don't add
 * latency to static-asset / API requests.
 */

interface VisibilityPayload {
  enabled: boolean;
  hiddenLegacyUrls: string[];
}

const BE_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5100/api';

// Module-scope cache. Keyed by cookie header so different users (different
// JWT in the cookie) get their own slot — important if scope-aware menus
// ever land. Per-isolate; Edge spawns fresh isolates which reset state, so
// the cache is best-effort, not authoritative. 60s TTL keeps the stale
// window short while killing the spam.
const cache = new Map<string, { value: Set<string>; expires: number }>();
const TTL_OK_MS = 60_000;
// Briefer TTL on auth-rejected / network-error responses so a transient
// 401 (e.g. just-logged-out tab) doesn't lock out menus for a full minute,
// but we still don't re-hit the BE on every navigation in the meantime.
const TTL_ERR_MS = 10_000;

async function fetchHiddenPaths(cookieHeader: string | null): Promise<Set<string>> {
  // Guest short-circuit — no auth cookie means we'd just get 401. Skip
  // the round-trip + log entry entirely. The user will see /login and the
  // protected-route guard there will redirect appropriately.
  if (!cookieHeader) return new Set();

  const now = Date.now();
  const hit = cache.get(cookieHeader);
  if (hit && hit.expires > now) return hit.value;

  try {
    const res = await fetch(`${BE_BASE}/shared/lookup/menu-visibility`, {
      headers: { cookie: cookieHeader },
    });
    if (!res.ok) {
      // Cache the empty set briefly so a 401 / 500 doesn't get re-fetched
      // on every navigation. Logs stay clean; cache TTL is short enough
      // that recovery from a transient error is automatic.
      const empty = new Set<string>();
      cache.set(cookieHeader, { value: empty, expires: now + TTL_ERR_MS });
      return empty;
    }
    const body = (await res.json()) as { data?: VisibilityPayload };
    const payload = body?.data;
    if (!payload?.enabled) {
      const empty = new Set<string>();
      cache.set(cookieHeader, { value: empty, expires: now + TTL_OK_MS });
      return empty;
    }
    const paths = new Set<string>();
    for (const legacy of payload.hiddenLegacyUrls) {
      const next = legacyUrlToNextPath(legacy);
      if (next) paths.add(next);
    }
    cache.set(cookieHeader, { value: paths, expires: now + TTL_OK_MS });
    return paths;
  } catch {
    // Network blip or BE down → fail open (no redirects). Cache an empty
    // set briefly so the failed fetch doesn't repeat on the next request.
    const empty = new Set<string>();
    cache.set(cookieHeader, { value: empty, expires: now + TTL_ERR_MS });
    return empty;
  }
}

export async function middleware(req: NextRequest) {
  // Public Magic-Link Profile Update form (technician-facing, JWT-in-URL
  // auth model — same envelope as /job-completion). The page lives under
  // `app/(public)/profile-update/[token]` and CANNOT be guarded by the
  // staff-CRM menu-visibility check (which requires a logged-in operator
  // cookie). Early-return so the middleware is a no-op for these paths.
  // The `/job-completion` route is excluded at the matcher level for the
  // same reason; we keep this one in-body to avoid touching the matcher
  // regex.
  if (req.nextUrl.pathname.startsWith('/profile-update/')) {
    return NextResponse.next();
  }

  const hidden = await fetchHiddenPaths(req.headers.get('cookie'));
  if (hidden.has(req.nextUrl.pathname)) {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = '/coming-soon';
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
