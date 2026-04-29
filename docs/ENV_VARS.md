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

| Variable | File on EC2 | When read | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | `/opt/easyfix/.env` (chmod 644) | At `docker compose build crm-ui` | Baked into `.next/static/chunks/*.js`. Changing requires rebuild. |
| (future) `NEXT_PUBLIC_*` flags | Same file | Same | |
| (future) Runtime server-side vars | Add to `/opt/easyfix/crm-ui.env` and `env_file:` in compose | At `next start` | Don't exist yet. |

**Notably NOT in the CRM-UI's runtime:**
- DB credentials (UI never touches the DB directly — calls the backend API)
- JWT secret (UI verifies tokens via `/api/auth/me`, not by decoding locally)
- Third-party API keys (UI never calls them directly)

If you find yourself wanting to put a secret in the UI bundle, **stop** —
it'll end up in the JS sent to every browser. Move it to the backend
and call `/api/...` instead.

## Updating `NEXT_PUBLIC_API_URL` (or any other CRM-UI build-arg)

Use the shared script that lives in the **backend repo** under `deploy/`.
It manages env vars for both apps:

```bash
sudo bash /opt/easyfix/repos/EasyFix_Backend/deploy/bootstrap-env.sh
```

Walk-through for changing the API URL (e.g. when DNS lands):

```
EasyFix env-var manager (batch mode)

  ● compose / build-args (.env)         /opt/easyfix/.env  (1 keys)
  ● backend runtime secrets (backend.env)  /opt/easyfix/backend.env  (12 keys)

Env var KEY (or blank to finish): NEXT_PUBLIC_API_URL

'NEXT_PUBLIC_API_URL' currently exists in:
  • /opt/easyfix/.env       value: http://10.30.2.30:5100/api

What do you want to do?
  1) Update value in .env
  9) Cancel this round
Choice [1]: 1

New value for NEXT_PUBLIC_API_URL: https://crm-api.qa.easyfix.in/api

About to update:
  Key:   NEXT_PUBLIC_API_URL
  File:  /opt/easyfix/.env
  Value: https://crm-api.qa.easyfix.in/api
Proceed? [y/N] y
✓ Wrote NEXT_PUBLIC_API_URL to /opt/easyfix/.env

Add/update another var? [y/N] n

Pending refreshes:
  • crm-ui → rebuild + recreate (NEXT_PUBLIC_* baked at build time)

Apply refreshes now? [y/N] y
▶ Rebuilding + recreating crm-ui
[+] Building 187.4s (16/16) FINISHED
[+] Running 1/1
 ✔ Container easyfix-crm-ui  Started
✓ All affected containers refreshed
```

The script knows that `NEXT_PUBLIC_*` requires a **rebuild** (not just
a restart) and triggers `docker compose build crm-ui` + `up -d
--force-recreate crm-ui` automatically.

End-to-end ~3 minutes — most of it is the Next build. The backend
container is **not touched**.

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
