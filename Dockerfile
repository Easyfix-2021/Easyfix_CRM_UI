# Easyfix_CRM_UI — multi-stage production image
#
# Stage 1 (deps):    Install ALL deps (incl. devDeps — Tailwind, TS, Next).
# Stage 1b (mirror): Unpack the technician-app web export into a
#                    version-pinned public/technician-mirror/<version>/.
#                    Degrades to a placeholder page when the export is
#                    not in the build context — never fails the build.
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

# ── Stage 1b: Technician-app mirror bundle ───────────────────────────
# Unpacks the technician app's static web export into a version-pinned
# directory that the builder folds into public/. The CRM serves it
# same-origin at /technician-mirror/<version>/ and frames it on
# /easyfixers/:id/app-view.
#
# The bundle arrives as a COMMITTED tarball at
# mirror-app/technician-mirror-<version>.tar.gz. An earlier version of this
# comment said it must never be committed, on two grounds that turned out not
# to hold: this repo has no size check, and the export is 4.2 MB gzipped rather
# than the ~40 MB assumed. Weighed against that, committing it is what lets a
# deploy build a working mirror with no cross-repo token, no PAT for an org
# owner to approve, and no CI in a repo that has never had any.
#
# deploy.yml asserts the tarball is present and derives MIRROR_APP_VERSION from
# its filename before `docker build` — necessary because this stage is
# deliberately fail-soft (below) and would otherwise ship a placeholder with a
# green check.
#
# When it is absent the build MUST still succeed: an operator seeing
# "mirror bundle not installed" inside the phone frame is a working image
# with one feature dark, whereas a failed build takes every other CRM
# change down with it. That is why the fallback writes a placeholder
# index.html instead of exiting non-zero.
FROM node:20-alpine AS mirror
ARG MIRROR_APP_VERSION=3.0.0
WORKDIR /mirror

# Optional-source trick: `COPY mirror-app*/ …` on its own fails the build
# with "no source files were specified" when nothing matches. Pairing the
# glob with a path that always exists makes it genuinely optional.
COPY package.json mirror-app*/ ./incoming/

# Two hand-over shapes are accepted, because both are obvious ways for CI
# to publish a static export and picking only one turns the other into a
# silent placeholder — a bundle that IS present but renders "not
# installed" is the single most confusing outcome this stage can produce:
#   - a tarball (*.tar.gz / *.tgz), packed flat OR under one wrapper dir;
#   - the already-unpacked export tree, dropped in as-is.
# Both are normalised to "index.html sits at $dest/index.html", so the URL
# the page requests never depends on how the export happened to be rolled.
RUN set -eu; \
    dest="/mirror/technician-mirror/${MIRROR_APP_VERSION}"; \
    mkdir -p "$dest"; \
    tarball="$(find /mirror/incoming -maxdepth 1 \( -name '*.tar.gz' -o -name '*.tgz' \) | head -n1)"; \
    if [ -n "$tarball" ]; then \
      echo "-> unpacking mirror bundle: $tarball"; \
      tar -xzf "$tarball" -C "$dest"; \
    else \
      src="$(find /mirror/incoming -maxdepth 3 -name index.html | head -n1)"; \
      if [ -n "$src" ]; then \
        echo "-> copying unpacked mirror export: $(dirname "$src")"; \
        cp -R "$(dirname "$src")"/. "$dest"/; \
      fi; \
    fi; \
    idx="$(find "$dest" -maxdepth 3 -name index.html | head -n1)"; \
    if [ -n "$idx" ] && [ "$(dirname "$idx")" != "$dest" ]; then \
      wrapper="$(dirname "$idx")"; \
      mv "$wrapper"/* "$dest"/; \
      rm -rf "$wrapper"; \
    fi; \
    if [ ! -f "$dest/index.html" ]; then \
      echo "!! no mirror bundle in the build context - installing the placeholder"; \
      printf '%s' '<!doctype html><meta charset="utf-8"><title>Mirror bundle not installed</title><body style="margin:0;display:grid;place-items:center;height:100vh;font:14px system-ui,sans-serif;text-align:center;padding:24px"><p>Mirror bundle not installed.<br><small>No technician-app web export was present when this image was built.</small></p></body>' > "$dest/index.html"; \
    fi; \
    rm -rf /mirror/incoming; \
    ls -la "$dest" | head -n 20

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

# Same value the mirror stage unpacked under. ONE arg names both the
# directory on disk and the path the page requests, so the two cannot
# drift; the page reads it as NEXT_PUBLIC_MIRROR_APP_VERSION and it must
# therefore be set before `npm run build` inlines it into the bundle.
ARG MIRROR_APP_VERSION=3.0.0
ENV NEXT_PUBLIC_MIRROR_APP_VERSION=${MIRROR_APP_VERSION}

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Fold the mirror bundle into public/ — stage 3 already does
# `COPY --from=builder /app/public ./public`, so anything landing here
# ships without touching the runner stage.
COPY --from=mirror /mirror/technician-mirror ./public/technician-mirror

# Drop every mirror directory that is not the pinned version. Two things
# this catches: an older bundle left behind by a cached layer, and a
# bundle someone committed to the repo (which `COPY . .` above would have
# just copied in). Without it the image accumulates a full app export per
# release and nothing ever removes them.
RUN set -eu; \
    for dir in ./public/technician-mirror/*/; do \
      [ -d "$dir" ] || continue; \
      name="$(basename "$dir")"; \
      if [ "$name" != "${MIRROR_APP_VERSION}" ]; then \
        echo "→ removing stale mirror bundle: $name"; \
        rm -rf "$dir"; \
      fi; \
    done; \
    echo "✓ mirror bundles kept:"; ls -1 ./public/technician-mirror

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
