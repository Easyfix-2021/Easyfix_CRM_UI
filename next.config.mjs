import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // `standalone` output produces a self-contained .next/standalone/ tree
  // (server.js + a pruned node_modules) which the production Docker image
  // copies as-is. This shrinks the runtime image from ~900 MB → ~180 MB
  // and removes the need for `npm` / `next` to be present at runtime.
  // See Dockerfile for the multi-stage that consumes this output.
  output: 'standalone',

  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  async rewrites() {
    /*
     * Read-only technician-app mirror → its static entry point.
     *
     * public/technician-mirror/<version>/ holds an Expo static web export.
     * Expo Router resolves its route from location.pathname minus the export's
     * baseUrl, so the frame has to sit at the export ROOT: ask for
     * .../index.html and the router is handed "/index.html", which matches no
     * route and renders "Unmatched Route" — the app never boots.
     *
     * Next serves files out of public/ but does not do directory indexes, and
     * with the default trailingSlash:false the ".../3.0.0/" form is 308'd away
     * before it reaches one. This rewrite is what closes that gap: the URL the
     * iframe holds stays at the export root while the bytes come from
     * index.html.
     *
     * Declared OUTSIDE the /api/* block on purpose — that block returns early
     * when NEXT_PUBLIC_API_URL is unset, and the mirror must not disappear
     * from a build just because the API proxy was skipped.
     */
    const mirrorRewrite = {
      source: '/technician-mirror/:version',
      destination: '/technician-mirror/:version/index.html',
    };

    /*
     * Shared-job web bundle → its static entry point, same reasoning as
     * mirrorRewrite above (Expo Router needs to be handed the export ROOT).
     * See Dockerfile's `shared-job` stage: unpacked, UNVERSIONED, at
     * public/public/shared-job/ — i.e. served at /public/shared-job/... so it
     * clears the production ALB's allowlist (/public/*, /_next/*,
     * /api/public/* pass without VPN; everything else needs it).
     *
     * Three rules, not one:
     *   - the bare path and its trailing-slash form both need to resolve to
     *     index.html (no directory-index support in `public/`);
     *   - any DEEPER path (`/public/shared-job/order/123`) also needs to fall
     *     back to index.html so a reload boots the SPA on a client-side
     *     route, rather than 404ing.
     * This still lets real exported files (`/public/shared-job/_expo/static/
     * ...`) through untouched: Next applies an array returned from rewrites()
     * only AFTER checking the filesystem (pages + files under `public/`), so
     * a request that matches an actual file on disk is served directly and
     * never reaches these rules at all — same reason mirrorRewrite above
     * never has to special-case the mirror's own static assets.
     */
    const sharedJobBase = '/public/shared-job';
    const sharedJobRewrites = [
      { source: sharedJobBase, destination: `${sharedJobBase}/index.html` },
      { source: `${sharedJobBase}/`, destination: `${sharedJobBase}/index.html` },
      { source: `${sharedJobBase}/:path*`, destination: `${sharedJobBase}/index.html` },
    ];

    /*
     * /api/:path* → backend proxy.
     *
     * Skipped entirely when `NEXT_PUBLIC_API_URL` is unset OR doesn't
     * start with `/`, `http://`, or `https://` — Next.js's rewrite
     * validator rejects any destination without one of those prefixes
     * and would FAIL THE BUILD. We log a warning and skip the rewrite
     * instead so Docker / CI builds without the env var baked in still
     * compile. At runtime the frontend will then need to call the
     * backend at an absolute URL (or be served from the same origin
     * that handles /api/*).
     *
     * Note: `process.env.NEXT_PUBLIC_API_URL` is evaluated at BUILD
     * time, not runtime, for any usage inside this config. So either
     * the env var is set when `next build` runs, or the rewrite is
     * absent from the build output forever — no way to inject later.
     */
    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!apiUrl) {
      console.warn('[next.config] NEXT_PUBLIC_API_URL is unset — /api/* rewrite is disabled in this build.');
      return [mirrorRewrite, ...sharedJobRewrites];
    }
    const trimmed = String(apiUrl).trim();
    const validDest = trimmed.startsWith('/') || /^https?:\/\//.test(trimmed);
    if (!validDest) {
      console.warn(
        `[next.config] NEXT_PUBLIC_API_URL=${JSON.stringify(trimmed)} is not a valid rewrite destination ` +
        '(must start with "/", "http://", or "https://"). /api/* rewrite disabled.',
      );
      return [mirrorRewrite, ...sharedJobRewrites];
    }
    return [
      mirrorRewrite,
      ...sharedJobRewrites,
      {
        source: '/api/:path*',
        destination: `${trimmed}/:path*`,
      },
    ];
  },

  async redirects() {
    /*
     * Back-compat for magic-link short URLs already sent in the wild BEFORE the
     * public flows moved under /public/*. Keeps every old WhatsApp link alive:
     *   /book/<code>          → /public/book/<code>          (short-link resolver)
     *   /job-completion/<jwt> → /public/job-completion/<jwt> (old long_url target)
     *   /profile-update/<jwt> → /public/profile-update/<jwt> (old long_url target)
     * permanent:false (307) so these one-time links aren't cached aggressively
     * by browsers / the WhatsApp in-app webview.
     */
    return [
      { source: '/book/:code', destination: '/public/book/:code', permanent: false },
      { source: '/job-completion/:token', destination: '/public/job-completion/:token', permanent: false },
      { source: '/profile-update/:token', destination: '/public/profile-update/:token', permanent: false },
    ];
  },
};

export default nextConfig;
