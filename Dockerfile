# Easyfix_CRM_UI — multi-stage production image
#
# Stage 1 (deps):    Install ALL deps (incl. devDeps — Tailwind, TS, Next).
# Stage 2 (builder): Run `next build` with NEXT_PUBLIC_API_URL baked in.
#                    Produces .next/standalone/ thanks to output: 'standalone'
#                    in next.config.mjs.
# Stage 3 (runner):  Copy ONLY the standalone output + static assets +
#                    public/. No node_modules (standalone bundles its own
#                    minimal copy), no source, no devDeps.
#
# Image size: ~180 MB (vs ~900 MB if we shipped the full node_modules).
#
# CRITICAL: NEXT_PUBLIC_API_URL is read AT BUILD TIME and baked into the
# static JS chunks. Every browser that loads the bundle hits whatever URL
# was set when `next build` ran. The GitHub workflow passes this as a
# `--build-arg` so each environment (QA / Production) gets the right URL.
# The build-arg is reflected in the image tag too, so we never accidentally
# deploy a QA-baked image to production.

# ── Stage 1: Dependencies ────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
# Copying lockfile separately so the deps layer survives source edits.
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Builder ─────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Build-time arg from the GitHub workflow. NO default — leaving it
# empty here forces the sanity check below to fail loud when someone
# runs `docker build` without --build-arg. Silently baking a wrong /
# placeholder URL would produce a working-looking image that 404s on
# every API call once deployed, which is far worse than a build error.
ARG NEXT_PUBLIC_API_URL=
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

# QuickSight bridge URLs. Same build-time mechanic as the API URL —
# `process.env.NEXT_PUBLIC_QA_QUICKSIGHT_URL` is read inside the navbar's
# openQuickSight() and Next inlines whatever was set when `next build`
# ran. Defaults are the canonical UAT + prod hosts so a build without
# explicit --build-args still works against the legacy QuickSight
# servers; CI passes them explicitly so the choice is auditable in the
# workflow log.
ARG NEXT_PUBLIC_QA_QUICKSIGHT_URL=https://uat.easyfix.in
ENV NEXT_PUBLIC_QA_QUICKSIGHT_URL=${NEXT_PUBLIC_QA_QUICKSIGHT_URL}
ARG NEXT_PUBLIC_PROD_QUICKSIGHT_URL=https://corporates.core.easyfix.in
ENV NEXT_PUBLIC_PROD_QUICKSIGHT_URL=${NEXT_PUBLIC_PROD_QUICKSIGHT_URL}

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Sanity-check the bake BEFORE building so we don't waste 30s+ on a
# Next.js build that produces an unusable image. Three guarantees:
#   1. Non-empty — caller passed --build-arg NEXT_PUBLIC_API_URL=…
#   2. Not localhost / not a placeholder — we'd never ship a bundle
#      that talks to localhost in prod.
#   3. Ends with `/api` — `src/lib/api.ts` constructs requests as
#      `${NEXT_PUBLIC_API_URL}${path}` where path is `/admin/…`
#      (no `/api` prefix). The backend serves at `/api/admin/…`, so
#      the bundle MUST be baked with a base ending in `/api`. The
#      previous version of this check rejected the CORRECT URL by
#      mistake — fixed 2026-05-15.
RUN if [ -z "$NEXT_PUBLIC_API_URL" ]; then \
      echo "✗ NEXT_PUBLIC_API_URL not provided to docker build."; \
      echo "  Pass --build-arg NEXT_PUBLIC_API_URL=<https://your-api/api>"; \
      exit 1; \
    fi; \
    case "$NEXT_PUBLIC_API_URL" in \
      *localhost*|*placeholder*) \
        echo "✗ Refusing to bake a localhost/placeholder URL into the bundle: $NEXT_PUBLIC_API_URL"; \
        exit 1 ;; \
    esac; \
    case "$NEXT_PUBLIC_API_URL" in \
      */api|*/api/) ;; \
      *) \
        echo "✗ NEXT_PUBLIC_API_URL must end with '/api' (got: $NEXT_PUBLIC_API_URL)"; \
        echo "  The frontend builds request URLs as <NEXT_PUBLIC_API_URL>/<path>"; \
        echo "  where <path> starts with /admin, /auth, /shared, etc. — NOT with /api."; \
        echo "  The backend serves at /api/admin/…, so the base MUST include /api."; \
        exit 1 ;; \
    esac; \
    echo "✓ NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL"

# Telemetry off — we don't want Next phoning home from CI.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: Runner ──────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Non-root runtime user. node:20-alpine ships uid 1000 = `node`.
RUN apk add --no-cache wget tini \
    && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=5180 \
    HOSTNAME=0.0.0.0

# Standalone bundle — server.js + pruned node_modules. Tiny.
COPY --from=builder --chown=node:node /app/.next/standalone ./
# Static assets (chunks + Tailwind output) — Next won't generate these
# automatically inside standalone; copy from .next/static.
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
# Public assets (favicon, fonts cached by next/font, etc.)
COPY --from=builder --chown=node:node /app/public ./public

EXPOSE 5180

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD wget -qO- http://127.0.0.1:5180/login -O /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# server.js comes from the standalone output. It's the production server
# entry point — equivalent to `next start` but without npm/next on PATH.
CMD ["node", "server.js"]
