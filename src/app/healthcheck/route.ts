import { NextResponse } from 'next/server';

/*
 * GET /healthcheck — liveness probe for the Next.js process itself.
 *
 * Path choice: `/healthcheck` (NOT `/api/health`) because next.config.mjs
 * rewrites `/api/:path*` → the backend on :5100. A `/api/health` route
 * here would silently proxy to the BE and never hit this handler,
 * making the UI's own liveness invisible to monitoring.
 *
 * Contract:
 *   200 OK  { status: "ok", service: "easyfix-crm-ui", timestamp, uptime }
 *
 * Intentionally minimal — no upstream pings (BE, lookups, etc.). This
 * endpoint answers ONE question: "is the Next.js server process alive
 * and serving requests?". A failing BE is the BE's own healthcheck's
 * problem; coupling them here would cause a transient BE blip to
 * cascade into the UI being marked unhealthy by the orchestrator, which
 * would then kill + restart it — masking the real issue and adding a
 * cold-start delay every time the BE flaps.
 *
 * If you ever need a "readiness" check (deeper — confirms BE
 * reachability), add it as a SEPARATE route (e.g. `/readiness`) so
 * orchestrator liveness and readiness probes can target the right one.
 *
 * `Cache-Control: no-store` so a CDN/edge layer never serves a stale
 * "ok" while the server is actually down. Healthchecks must reflect
 * the current state, not a 30-second-old snapshot.
 *
 * `dynamic = 'force-dynamic'` opts out of Next.js's static-prerender
 * pass at build time — without it, Next would try to evaluate this
 * route during `next build` and embed a static response.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      service: 'easyfix-crm-ui',
      timestamp: new Date().toISOString(),
      // process.uptime() is the seconds since the Node process started.
      // Useful for ops to spot a server that restarted unexpectedly
      // (uptime resets) without needing log access.
      uptime: typeof process !== 'undefined' && process.uptime
        ? Math.round(process.uptime())
        : null,
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
