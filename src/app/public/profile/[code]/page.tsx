import { resolveShortLink } from '../../_shortlink';

/*
 * Profile-update short-link resolver — `/public/profile/<code>`.
 *
 * The WhatsApp "Complete your Easyfix Profile" reminder links here; the
 * flow-relevant `/public/profile/` prefix makes the link read as a profile
 * link (not the old generic `/book/`). Resolves the code and redirects to the
 * `/public/profile-update/<token>` form. Shared logic in _shortlink.tsx.
 */
export const dynamic = 'force-dynamic';

export default async function ProfileShortLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return resolveShortLink(code);
}
