import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

/*
 * Shared short-link resolver for the `/public/<flow>/<code>` routes.
 *
 * Every magic-link short URL (booking, profile-update, …) is an 8-char code
 * that maps to a stored long URL in tbl_url_shortener. The resolution itself is
 * purpose-AGNOSTIC — it resolves the code and server-redirects to the long URL,
 * or renders a friendly card for an expired / invalid code. The FLOW lives only
 * in the URL PREFIX (`/public/book/…` vs `/public/profile/…`) so the WhatsApp
 * link reads relevantly; both prefixes share this one resolver.
 */

type ResolveResult = { found: boolean; expired: boolean; longUrl: string | null };

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
    const res = await fetch(`${base}/public/book/${encodeURIComponent(code)}`, { cache: 'no-store' });
    if (!res.ok) return { found: false, expired: false, longUrl: null };
    const body = await res.json();
    // Backend uses the modern envelope { success, data }; tolerate either.
    const data = (body && typeof body === 'object' && 'data' in body ? body.data : body) as ResolveResult;
    return { found: !!data?.found, expired: !!data?.expired, longUrl: data?.longUrl ?? null };
  } catch {
    return { found: false, expired: false, longUrl: null };
  }
}

function Card({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-xl border bg-card shadow-sm px-7 py-8 text-center mt-12">
      <h1 className="text-lg font-semibold text-ink-900">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-700">{message}</p>
    </div>
  );
}

/*
 * Resolve `code` and either server-redirect to the long URL or return an
 * expired/invalid card. redirect() throws NEXT_REDIRECT internally, so it must
 * be called outside any try/catch — resolveCode() encapsulates its own fetch
 * try/catch and returns a plain result, keeping this path clean.
 */
export async function resolveShortLink(code: string) {
  const result = await resolveCode(code);

  if (result.found && !result.expired && result.longUrl) {
    redirect(result.longUrl);
  }
  if (result.found && result.expired) {
    return (
      <Card
        title="This Link Has Expired"
        message="The link you followed is no longer active. Please contact EasyFix support if you still need to update your details."
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
