import { resolveShortLink } from '../../_shortlink';

/*
 * Booking short-link resolver — `/public/book/<code>`.
 *
 * The WhatsApp unconfirmed-booking message links here; resolves the code and
 * redirects to the `/public/job-completion/<token>` form. Shared logic lives in
 * _shortlink.tsx (also used by the /public/profile/<code> profile resolver).
 *
 * Back-compat: the legacy `/book/<code>` URL (already sent in the wild) is
 * permanently redirected here by next.config.mjs, so old links keep working.
 */
export const dynamic = 'force-dynamic';

export default async function BookRedirectPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return resolveShortLink(code);
}
