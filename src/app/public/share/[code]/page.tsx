import { resolveShortLink } from '../../_shortlink';

/*
 * Shared-job short-link resolver — `/public/share/<code>`.
 *
 * WhatsApp sends this when a technician delegates a job; resolves the code
 * and redirects to the `/public/shared-job/?t=<token>` web app. Shared logic
 * lives in _shortlink.tsx (also used by /public/book/<code> and
 * /public/profile/<code>).
 */
export const dynamic = 'force-dynamic';

export default async function ShareShortLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return resolveShortLink(code);
}
