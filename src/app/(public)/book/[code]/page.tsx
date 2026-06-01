/*
 * Public short-link resolver — `/book/<code>`.
 *
 * WHY THIS PAGE EXISTS
 *   The WhatsApp magic-link message carries a short URL on the CUSTOMER-
 *   facing origin, e.g. https://qa.crm.easyfix.in/book/aB7xK2pQ. That
 *   origin is THIS Next.js app, not the backend — so without a route
 *   here the customer gets a Next.js 404 (exactly the bug this fixes).
 *   The code→long-URL mapping lives in tbl_url_shortener on the backend,
 *   so we resolve it server-side via GET /api/public/book/:code (which
 *   rides the existing /api/* → backend proxy from next.config.mjs), then
 *   issue a server-side redirect to the real /job-completion/<token> page.
 *
 * WHY A SERVER COMPONENT (not 'use client')
 *   Resolving + redirecting on the server means the customer never sees a
 *   loading flash or a client-side fetch waterfall — they tap the link and
 *   land on the form (or the expired card) directly. `redirect()` from
 *   next/navigation issues a real HTTP redirect.
 *
 * STATES
 *   found + !expired → redirect to longUrl (the signed magic-link page)
 *   found + expired  → friendly "link expired" card
 *   not found / error → friendly "invalid link" card
 *   The destination itself still enforces JWT auth, so resolving a code
 *   here grants nothing beyond knowing the (already-customer-owned) URL.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

// Always resolve live — a short code's state (expired / consumed) can
// change between sends, so this must never be statically cached.
export const dynamic = 'force-dynamic';

type ResolveResult = { found: boolean; expired: boolean; longUrl: string | null };

/*
 * Pick the base the server component uses to reach the backend resolver.
 *   - Prefer NEXT_PUBLIC_API_URL when it's an absolute http(s) URL — hits
 *     the backend directly, no extra proxy hop.
 *   - Otherwise fall back to the SAME origin the customer hit + `/api`,
 *     which the next.config.mjs `/api/*` rewrite forwards to the backend.
 *     (Server components can't fetch relative URLs, hence the host build.)
 */
function resolveApiBase(h: Headers): string {
  const env = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (env && /^https?:\/\//.test(env)) return env.replace(/\/+$/, '');
  const host = h.get('host') ?? '';
  const proto = h.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}/api`;
}

async function resolveCode(code: string): Promise<ResolveResult> {
  try {
    const h = await headers();
    const base = resolveApiBase(h);
    const res = await fetch(`${base}/public/book/${encodeURIComponent(code)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return { found: false, expired: false, longUrl: null };
    const body = await res.json();
    // Backend uses the modern envelope { success, data }; tolerate either.
    const data = (body && typeof body === 'object' && 'data' in body ? body.data : body) as ResolveResult;
    return {
      found: !!data?.found,
      expired: !!data?.expired,
      longUrl: data?.longUrl ?? null,
    };
  } catch {
    return { found: false, expired: false, longUrl: null };
  }
}

function Card({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-xl border bg-white shadow-sm px-7 py-8 text-center mt-12">
      <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{message}</p>
    </div>
  );
}

export default async function BookRedirectPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const result = await resolveCode(code);

  // NOTE: redirect() throws NEXT_REDIRECT internally, so it MUST be called
  // outside any try/catch — resolveCode() already encapsulates the fetch
  // try/catch and returns a plain result, keeping this path clean.
  if (result.found && !result.expired && result.longUrl) {
    redirect(result.longUrl);
  }

  if (result.found && result.expired) {
    return (
      <Card
        title="This Link Has Expired"
        message="The link you followed is no longer active. Please contact EasyFix support if you still need to update your order details."
      />
    );
  }

  return (
    <Card
      title="Invalid Link"
      message="This link is invalid or has expired. Please check the link in your message, or contact EasyFix support for help."
    />
  );
}
