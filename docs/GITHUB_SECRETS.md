# GitHub Actions Secrets — Easyfix_CRM_UI

Every secret [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) reads,
what each value is, and where to fetch it.

> **Rewritten 2026-08-25.** The previous version of this file described an
> `ssh -i deploy_key USER@HOST 'git pull && npm ci && npm run build && pm2 reload'`
> deploy, and stated that *"the deploy uses SSH, not the AWS API, so no AWS creds
> needed in GitHub."* None of that has been true for some time — the pipeline
> builds a Docker image in CI, pushes it to **ECR**, and restarts the container
> over **SSM**. It needs AWS credentials and no SSH key at all. `QA_HOST`,
> `QA_USER`, `QA_SSH_KEY`, `PROD_HOST`, `PROD_USER` and `PROD_SSH_KEY` are read
> by nothing; if they still exist in repo settings you can delete them.

---

## ⚠️ Read this before adding anything

**Every job that reads these declares `environment: 'Organisation Level Secrets'`.**
The secrets live on a GitHub **Environment** of that exact name — spaces
included — not on the repository. A secret added as a plain repository secret is
invisible to those jobs, and the failure is not an error: the workflow falls
through to a hardcoded fallback (below) or deploys with an empty value.

**Reach the right UI:** GitHub repo → **Settings** → **Environments** →
**Organisation Level Secrets** → **Environment secrets** → **Add secret**.

---

## The secrets

| Secret | Purpose | Missing ⇒ | Where to get it |
|---|---|---|---|
| `AWS_ACCESS_KEY_ID` | IAM user for ECR push + SSM send-command. | **Hard fail** — every AWS step errors. | AWS Console → **IAM** → Users → the CI user → **Security credentials** → *Create access key*. Needs ECR push and `ssm:SendCommand` on the two instances. |
| `AWS_SECRET_ACCESS_KEY` | Pairs with the above. | **Hard fail.** | Shown once at key creation. Not retrievable later — rotate if lost. |
| `AWS_REGION` | Region for ECR and SSM. | Silent fallback → `ap-south-1`. | `ap-south-1`. Both ECR and the EC2 hosts live there. |
| `ECR_REGISTRY` | Registry host the image is pushed to. | Silent fallback → `902810393464.dkr.ecr.ap-south-1.amazonaws.com`. | AWS Console → **ECR** → **Repositories** → the *URI* column, up to the first `/`. |
| `ECR_REPOSITORY_CRM_UI` | Repository name inside that registry. | Silent fallback → `easyfix/crm-ui`. | Same screen, the part after the `/`. |
| `QA_API_URL` | Backend base URL **baked into the JS bundle** for QA. | Warning + fallback → `http://10.30.2.30:5100/api`. | `https://qa.backend.easyfix.in/api`. **Must end in `/api`** — see below. |
| `PROD_API_URL` | Same, for Production. | Warning + fallback → `http://10.30.2.40:5100/api`. | The production backend origin + `/api`. **Must end in `/api`.** |
| `QA_INSTANCE_ID` | EC2 instance SSM restarts the QA container on. | Silent fallback → `i-032aa9d2942305364`. | AWS Console → **EC2** → **Instances** → the shared QA box → **Instance ID**. |
| `PROD_FRONTEND_INSTANCE_ID` | EC2 instance for Production. **Note the `FRONTEND`** — the UI and backend split onto separate prod hosts on 2026-06-03, and the backend repo reads `PROD_BACKEND_INSTANCE_ID`. | **Deploy fails** — no fallback, by design. An empty value is refused rather than guessed. | AWS Console → **EC2** → **Instances** → the UI-only prod host (runs `crm-ui`, `client-ui`, `dozzle`) → **Instance ID**. |
| `MAIL_USERNAME` | *Optional.* Gmail address that sends the failure alert to `harshit@channelplay.in`. | Alert step is skipped; the deploy still fails normally. | The ops mailbox `ithelpdesk@easyfix.in`, or any Gmail you control. |
| `MAIL_PASSWORD` | *Optional.* Gmail **App Password** (not the login password). | SMTP auth fails; nothing else breaks. | [Google Account → Security → App passwords](https://myaccount.google.com/apppasswords). Requires 2-Step Verification. |

### The fallbacks are the thing to understand

Most values above have a hardcoded default, because an account id or a region is
public knowledge and a transient secret-access misconfiguration should not block
a deploy. The consequence is that **a missing secret usually looks like a
successful deploy**, not an error — it just quietly uses the default.

Only two things behave differently, and both on purpose:

- `PROD_FRONTEND_INSTANCE_ID` has **no** fallback. A wrong instance id on a live
  host is a much bigger blast radius than a failed deploy.
- `QA_API_URL` / `PROD_API_URL` emit a `::warning::` when they fall back, so the
  run is annotated rather than silent.

### Why `*_API_URL` must end with `/api`

`src/lib/api.ts` builds request URLs as `${NEXT_PUBLIC_API_URL}${path}` where
`path` is `/admin/…` with no `/api` prefix, and the backend serves at
`/api/admin/…`. Drop the suffix and every request 404s. The Dockerfile checks
this and fails the build, so a bad value is caught in CI rather than in the
browser — but it means a typo here breaks the build, not just the app.

The value is read at **build** time and baked into the static JS chunks. Changing
it requires a rebuild; editing anything on the server has no effect.

---

## What the pipeline actually does

```
push to QA / Production   (or Actions → Run workflow)
      │
      ├─ precheck            typecheck + lint on a github-hosted runner
      │
      ├─ build-and-push      runs-on: ubuntu-24.04-arm  (native arm64;
      │                      QEMU emulation crashed V8 during npm ci)
      │   ├─ resolve API URL for the branch
      │   ├─ log in to ECR                      AWS_ACCESS_KEY_ID / SECRET
      │   ├─ resolve the technician-app mirror bundle   ← no secret, see below
      │   └─ docker build --build-arg NEXT_PUBLIC_API_URL=…
      │                   --build-arg MIRROR_APP_VERSION=…
      │      push  <env>-<sha7>  and  <env>-latest      ECR_REGISTRY / _CRM_UI
      │
      └─ deploy
          ├─ resolve instance id for the branch    QA_INSTANCE_ID |
          │                                        PROD_FRONTEND_INSTANCE_ID
          ├─ (prod only) ship deploy/docker-compose.prod-frontend.yml
          ├─ SSM send-command on the instance:
          │     update CRM_UI_IMAGE in /opt/easyfix/.env
          │     docker compose pull crm-ui
          │     docker compose up -d --no-deps --force-recreate crm-ui
          │     wait for HEALTHY
          ├─ smoke-test  curl http://127.0.0.1:5180/login   (~70s budget)
          └─ on failure: email          MAIL_USERNAME / MAIL_PASSWORD
```

No SSH anywhere. The runner never opens a shell on the host — SSM runs the
commands through the AWS API, which is why the AWS credentials are the only
access the pipeline needs.

---

## Adding or rotating a secret

1. Repo → **Settings** → **Environments** → **Organisation Level Secrets**.
2. **Environment secrets** → **Add secret** (or click an existing name to update).
3. Name it **exactly** as in the table. `PROD_FRONTEND_INSTANCE_ID` is the one
   people get wrong — the header comment in `deploy.yml` said `PROD_INSTANCE_ID`
   until 2026-08-25, and that name is read by nothing.
4. Paste the value → **Add secret**.

Values are write-only after creation. The next run picks up a rotated value; runs
already in flight keep the old one.

**When to rotate:** the AWS keys if they leak or on policy schedule (rotate in IAM
first, then here — the pipeline breaks in between). `MAIL_PASSWORD` if the App
Password is revoked. The instance ids only if an instance is replaced.

---

## Verifying end to end

1. **Actions** tab → **Deploy CRM_UI (CI build → ECR → SSM pull)** → **Run
   workflow** → target `QA` → **Run workflow**.
2. `precheck` (~2 min) → `build-and-push` (~5 min) → `deploy` (~3 min).

Reading a failure:

| Symptom | Cause |
|---|---|
| AWS steps fail immediately | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` missing, or the job lost `environment: 'Organisation Level Secrets'`. |
| `::warning:: Secret for qa API URL is empty` | `QA_API_URL` is not set on the environment. The build continues on the fallback — the bundle points at an internal IP. |
| Build fails on the API URL sanity check | The value does not end in `/api`. |
| `No mirror bundle found at mirror-app/…` | The committed tarball is missing. See below. |
| Deploy fails with an empty instance id | `PROD_FRONTEND_INSTANCE_ID` is missing, or was added under the old `PROD_INSTANCE_ID` name. |
| Smoke test 000 for ~70s | The container came up unhealthy. Check `dozzle` on the host, or the SSM command output in the run log. |

---

## Not a secret: the technician-app mirror bundle

The App View feature serves a static web export of the technician app from
`public/technician-mirror/<version>/`. It reaches the image as a **committed
tarball** at `mirror-app/technician-mirror-<version>.tar.gz`, so it needs **no
secret and no cross-repo access**.

`deploy.yml` asserts the tarball is present and derives `MIRROR_APP_VERSION` from
its filename. To refresh it after an app release:

```bash
cd ../Easyfix_Technician_Mobile_Application && npm run export:mirror
tar -czf ../Easyfix_CRM_UI/mirror-app/technician-mirror-<version>.tar.gz -C dist-mirror .
```

Delete the old tarball in the same commit — two of them is a hard failure, because
the Dockerfile takes the first match and would otherwise silently pick one.

**Refresh it on app RELEASES, not on every app change.** A gzipped tarball is
opaque to git: it cannot be delta-compressed or deduplicated, so every refresh
adds a permanent ~4.1 MB to history, and the 3 MB of fonts and sounds inside it
are re-stored in full each time even though they never change. That cost is fine
once per release and expensive once per commit. It is also the right behaviour
for the feature: the mirror should render the version technicians are actually
running, not whatever is on the app repo's HEAD — which is why the version is
pinned and the CRM banner compares it against what each technician reports.

(An unpacked tree would cost ~1.1 MB per release instead, since Expo puts the
content hash in each asset filename and git would store unchanged assets once.
Weighed against a single self-describing file and kept as-is deliberately —
2026-08-25.)

---

## Not GitHub secrets at all

| Value | Where it lives |
|---|---|
| Runtime container env (`CRM_UI_IMAGE`, ports) | `/opt/easyfix/.env` on the EC2 host, rewritten by the SSM step each deploy. |
| `NEXT_PUBLIC_API_URL` | Baked into the bundle at build time from `QA_API_URL` / `PROD_API_URL`. Not read at runtime — editing it on the host does nothing. |
| Backend secrets (DB, JWT, S3, SMTP…) | The `EasyFix_Backend` repo's own environment. This repo holds none. |
| TLS certificates | Managed on the host. Never passed through GitHub. |
