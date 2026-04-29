# Adding / updating environment variables (CRM-UI)

The CRM-UI's env-var story is **simpler than the backend's**: there's
exactly one variable today (`NEXT_PUBLIC_API_URL`), it's read at **build
time**, not runtime, and it lives next to the backend's env files in
`/opt/easyfix/.env` on the EC2.

This doc covers (a) why that's so, (b) how to change it, (c) what to do
when adding a new one.

## The build-time vs runtime split (Next.js gotcha)

Next.js inlines every env var prefixed with `NEXT_PUBLIC_*` into the
**static JS chunks** at `next build` time. That means:

- **Browsers loading the bundle** see whatever value was set when
  `docker compose build crm-ui` ran on the EC2.
- **Changing the value at runtime does nothing** — the container has
  no idea what the bundle was built with. You MUST rebuild + restart.

Vars without the `NEXT_PUBLIC_` prefix are server-side only — read at
`next start` time. The CRM-UI is a thin client today (no server actions,
no RSC fetches), so we don't have any of those.

## Where each var lives

| Variable | Where | When read | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | **GitHub Environment "Organisation Level Secrets" → secret `QA_API_URL`** | At CI Docker build time, passed as `--build-arg` to `docker buildx build` | Baked into `.next/static/chunks/*.js`. Changing requires re-running the workflow. |
| (future) `NEXT_PUBLIC_*` flags | Add as new GitHub secrets, plumb through the workflow + Dockerfile + compose | Same | See "Adding a new build-arg" below. |
| (future) Runtime server-side vars | Would need `/opt/easyfix/crm-ui.env` + `env_file:` in compose | At `next start` | Don't exist yet. |

**Notably NOT in the CRM-UI's runtime:**
- DB credentials (UI never touches the DB directly — calls the backend API)
- JWT secret (UI verifies tokens via `/api/auth/me`, not by decoding locally)
- Third-party API keys (UI never calls them directly)

If you find yourself wanting to put a secret in the UI bundle, **stop** —
it'll end up in the JS sent to every browser. Move it to the backend
and call `/api/...` instead.

## Updating `NEXT_PUBLIC_API_URL`

The build now happens in CI (not on the EC2), so the value lives in
**GitHub Secrets** under the QA environment as `QA_API_URL`. Workflow
passes it to `docker buildx build` as `--build-arg`, which the
Dockerfile inlines into the static JS chunks.

To change it (e.g. when DNS moves from raw IP to a hostname):

1. **GitHub → Repo → Settings → Environments → QA → Update `QA_API_URL`**
   to the new value (e.g. `https://crm-api.qa.easyfix.in/api`).
2. **Re-run the CRM-UI workflow** — either commit + push to `QA`, or
   GitHub → Actions → Deploy CRM_UI → Run workflow → pick QA.
3. Workflow rebuilds the image with the new URL baked in, pushes to
   ECR, SSMs the EC2 to `docker compose pull crm-ui` + `up -d`.

End-to-end: ~3 minutes (Next build is the slow step).

**The bootstrap-env.sh script on the EC2 will REFUSE to set this
var** — it now lives in CI, not on the box. Editing it locally has no
effect because the bundle is already baked.

The backend container is **not touched** by a CRM-UI redeploy.

## Adding a new build-arg

When the UI grows another `NEXT_PUBLIC_*` var (a feature flag, a
public Stripe key, etc.):

1. **Reference it in code:** `process.env.NEXT_PUBLIC_FOO` — Next handles
   the inlining at build time, no extra config needed.
2. **Declare it in the Dockerfile** so docker build accepts it as an arg
   and exposes it to the build stage:
   ```dockerfile
   ARG NEXT_PUBLIC_FOO
   ENV NEXT_PUBLIC_FOO=$NEXT_PUBLIC_FOO
   ```
3. **Pass it from compose** in `docker-compose.yml`:
   ```yaml
   crm-ui:
     build:
       args:
         NEXT_PUBLIC_FOO: ${NEXT_PUBLIC_FOO}
   ```
4. **Set the value on the EC2** via the script:
   ```bash
   sudo bash /opt/easyfix/repos/EasyFix_Backend/deploy/bootstrap-env.sh
   # KEY: NEXT_PUBLIC_FOO
   # File: 1 (.env)
   # Value: <the value>
   # Proceed: y
   # Apply refreshes: y
   ```

Steps 1–3 are committed to git. Step 4 happens once on the EC2 and any
time the value changes.

## Adding a server-side runtime var (rare)

If you ever need a CRM-UI env var that ISN'T baked into the bundle —
say, a secret that should only be readable by the Node process during
SSR — the path is:

1. Use a name **without** the `NEXT_PUBLIC_` prefix (e.g. `CRM_UI_FOO`).
2. Add a new file `/opt/easyfix/crm-ui.env` (chmod 600).
3. Reference it in compose:
   ```yaml
   crm-ui:
     env_file:
       - /opt/easyfix/crm-ui.env
   ```
4. The bootstrap-env.sh script doesn't manage this file today (only
   `.env` and `backend.env`). Either extend the script or edit by hand.

We don't have any such vars today and likely never will — the CRM-UI is
designed to be a thin client. Mentioning the path for completeness.

## Quick reference

| Action | Command |
|---|---|
| Change `NEXT_PUBLIC_API_URL` | Run the script, pick `.env`, enter new value, apply refresh |
| Manually rebuild crm-ui | `cd /opt/easyfix && docker compose build crm-ui && docker compose up -d --force-recreate crm-ui` |
| Tail crm-ui logs | `docker logs -f easyfix-crm-ui` |
| See what's baked into the running bundle | `docker exec easyfix-crm-ui grep -roh 'http[s]*://[^"]*' /app/.next/static/ \| sort -u \| head` |
| Force-revert to a previous bundle | Set the URL back, rebuild, restart. (Or roll back the docker image — backend repo's docs cover that path.) |

## Why the script lives in the backend repo

A single script that knows about both `.env` (CRM-UI build args) and
`backend.env` (backend runtime secrets) is simpler than two scripts
that each cover half the picture. The backend repo owns the deploy
artefacts (compose file, env-manager script) by convention. The CRM-UI
repo only owns its Dockerfile + source.
