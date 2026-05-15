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
      return [];
    }
    const trimmed = String(apiUrl).trim();
    const validDest = trimmed.startsWith('/') || /^https?:\/\//.test(trimmed);
    if (!validDest) {
      console.warn(
        `[next.config] NEXT_PUBLIC_API_URL=${JSON.stringify(trimmed)} is not a valid rewrite destination ` +
        '(must start with "/", "http://", or "https://"). /api/* rewrite disabled.',
      );
      return [];
    }
    return [
      {
        source: '/api/:path*',
        destination: `${trimmed}/:path*`,
      },
    ];
  },
};

export default nextConfig;
