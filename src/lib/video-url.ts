/*
 * Training-video URL helpers, shared by the LMS pages and the preview player.
 *
 * Two kinds of link live in this system and both must play in the CRM:
 *
 *   YouTube  — everything written since 2026-08-13. The backend only accepts
 *              YouTube on write and stores a canonical watch URL.
 *   Direct   — legacy .mp4 files on the Dropwizard static host, predating that
 *              rule. The backend repairs their scheme and host on the way out
 *              (lms.service.js::normalizeVideoUrl), so what arrives here is
 *              already https and already resolvable.
 *
 * The distinction matters because they need different players: a YouTube watch
 * URL is a PAGE, not a media file, so <video src> renders nothing for it — it
 * has to go through an iframe embed. Everything that is not YouTube is assumed
 * to be a direct media source.
 *
 * `youTubeId` is the single source of truth: `isYouTubeUrl` is just "did we get
 * an id", so the two can never disagree about what counts as YouTube.
 */

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com']);
/* /embed/<id>, /shorts/<id>, /live/<id> and /v/<id> all put the id first. */
const PATH_PREFIXES = new Set(['embed', 'shorts', 'live', 'v']);

/*
 * Extract the 11-character video id, or null when this is not a YouTube link.
 * Mirrors lms.service.js::parseYouTubeUrl on the backend — that copy is the
 * authority and re-validates every write; this one decides which player to
 * render and where the operator sees a complaint about a bad link.
 */
export function youTubeId(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let id: string | null = null;

  if (host === 'youtu.be') {
    id = parsed.pathname.slice(1).split('/')[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (parsed.pathname === '/watch') {
      id = parsed.searchParams.get('v');
    } else {
      const [, prefix, candidate] = parsed.pathname.split('/');
      if (PATH_PREFIXES.has(prefix ?? '')) id = candidate ?? null;
    }
  }

  return id && YOUTUBE_ID.test(id) ? id : null;
}

export function isYouTubeUrl(value: string | null | undefined): boolean {
  return youTubeId(value) !== null;
}

/*
 * The privacy-preserving embed host. youtube-nocookie.com serves the same
 * player without setting tracking cookies until playback starts — the right
 * default for an internal tool where staff are previewing training content,
 * not browsing YouTube.
 *
 * `rel=0` keeps the end-of-video suggestions within the same channel rather
 * than throwing unrelated recommendations at an operator mid-review.
 *
 * `autoplay=1` because this player only ever opens from an explicit Play
 * click — the operator has already said "play this", and making them press a
 * second button inside the frame is a step that communicates nothing.
 *
 * NOTE the URL parameter is only half of it: an iframe cannot autoplay unless
 * the embedding page also grants the permission via `allow="autoplay"`. With
 * one and not the other the video silently sits paused, which is exactly the
 * behaviour this replaces.
 */
export function youTubeEmbedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?rel=0&autoplay=1`;
}
