# GitHub Actions Secrets — Easyfix_CRM_UI

This document lists every secret the **CRM frontend** GitHub Actions workflow ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) needs, along with **what each value is** and **where to fetch it from**.

> **Reach this UI:** GitHub repo → **Settings** (top tab) → **Secrets and variables** → **Actions** → **New repository secret**.

---

## Required secrets

| Secret name | Purpose | Where to get the value |
|---|---|---|
| `QA_HOST` | Public IP (Elastic IP) of the **QA** EC2 frontend instance — the workflow SSHes here on push to `QA` branch. | AWS Console → **EC2** → **Elastic IPs** → row `easyfix-crm-ui-qa` → copy the **Allocated IPv4 address** (e.g. `13.234.56.78`). |
| `QA_USER` | Linux user the deploy SSH session connects as. | Always `ubuntu` for the Ubuntu 22.04 AMI used in the deployment guide. |
| `QA_SSH_KEY` | Private deploy SSH key whose **public** half is in `~/.ssh/authorized_keys` on the QA EC2. Lets GitHub Actions log in without a password. | Generated locally per the [AWS Deployment Guide §4.1](AWS_DEPLOYMENT_GUIDE.md#41--create-the-deploy-ssh-key-ui-github-settings) — the file `easyfix-crm-ui-deploy` (NOT the `.pub` version). Open the file in any text editor and paste the **entire** contents including the `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----` lines. |
| `PROD_HOST` | Public IP (Elastic IP) of the **Production** EC2 frontend instance. | AWS Console → **EC2** → **Elastic IPs** → row `easyfix-crm-ui-prod` → copy the **Allocated IPv4 address**. |
| `PROD_USER` | Linux user for SSH on Prod. | `ubuntu`. |
| `PROD_SSH_KEY` | Same deploy private key — the **public** half was added to BOTH instances' `authorized_keys`, so one key authenticates both. (You can use a separate key per environment if you prefer stricter blast-radius — just generate two key pairs and add the matching public key on each instance.) | Same file as `QA_SSH_KEY`. |
| `MAIL_USERNAME` | Gmail address that **sends** the failure-notification email. | Use the existing ops mailbox `ithelpdesk@easyfix.in` (matches the backend's `GMAIL_USER` already used by the email service). Or any Gmail account you control. |
| `MAIL_PASSWORD` | App password for that Gmail account (NOT the regular login password). | [Google Account → Security → 2-Step Verification → App passwords](https://myaccount.google.com/apppasswords). Generate one named `github-actions-easyfix` → copy the 16-char password (no spaces) → paste here. Requires 2-Step Verification enabled on the account. |

---

## How each secret is consumed

```
┌─────────────────────────────────┐
│   push to QA / Production       │
└───────────────┬─────────────────┘
                ▼
   ┌─────────── deploy job ───────────┐
   │                                  │
   │  Resolve target host             │
   │  ├─ branch=QA   → QA_HOST/USER/KEY
   │  └─ branch=Prod → PROD_HOST/USER/KEY
   │                                  │
   │  Set up SSH key                  │
   │  └─ writes <KEY> to ~/.ssh/deploy_key
   │                                  │
   │  Deploy via SSH                  │
   │  └─ ssh -i deploy_key  USER@HOST 'git pull && npm ci && npm run build && pm2 reload'
   │                                  │
   │  Verify health                   │
   │  └─ curl http://HOST:5180/       │  ← EIP, not domain
   │                                  │
   │  On failure: Email step          │
   │  └─ MAIL_USERNAME + MAIL_PASSWORD → smtp.gmail.com:465 → harshit@channelplay.in
   └──────────────────────────────────┘
```

---

## Step-by-step: add the secrets in the UI

1. Open the repo on GitHub → **Settings** → **Secrets and variables** → **Actions**.
2. Click **New repository secret** (top right, green button).
3. **Name** field: type the secret name from the table above (e.g. `QA_HOST`).
4. **Secret** field: paste the value.
5. Click **Add secret**.
6. Repeat for each row in the table. Once added, GitHub shows them as `••• Updated N seconds ago` — values are write-only after creation (you can rotate but not view).

---

## Rotating a secret

GitHub UI:
- Same place: **Settings** → **Secrets and variables** → **Actions** → click the secret name → **Update**.
- Paste the new value → **Update secret**.
- Next workflow run picks up the new value automatically; in-flight runs keep using the old one.

When to rotate:
- **`*_SSH_KEY`**: if the private key file leaks, or annually as policy. Generate a new key pair, replace the public key in `~/.ssh/authorized_keys` on both EC2s, then update this secret.
- **`MAIL_PASSWORD`**: if the Gmail App Password is revoked, or if the sending account changes. Re-generate via the Google App Passwords page.
- **`*_HOST`**: only if you reallocate the Elastic IP (rare — EIPs are sticky).

---

## Optional: environment-scoped secrets

For stricter prod control, you can scope `PROD_*` secrets to a [GitHub Environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) named `production` and require manual approval before the deploy job runs. UI walkthrough:

1. Repo → **Settings** → **Environments** → **New environment** → name `production` → **Configure environment**.
2. ☑ Required reviewers → add yourself + one teammate.
3. Move `PROD_HOST`, `PROD_USER`, `PROD_SSH_KEY` from repo-level secrets into this environment.
4. In `deploy.yml`, the deploy job for the `Production` branch needs `environment: production` added at the job level (current workflow doesn't gate; add if you want approvals).

The current workflow is intentionally simpler — push to `Production` → auto-deploys. Add the environment gate when team grows or compliance demands review trail.

---

## Verifying the secrets work end-to-end

After adding all secrets:
1. GitHub UI → **Actions** tab → pick `Deploy to AWS EC2` → **Run workflow** → choose `qa` from the dropdown → **Run workflow**.
2. Watch the run — `build` job runs first (~3 min), then `deploy` (~5 min).
3. If `Set up SSH key` step succeeds but `Deploy via SSH` fails with `Permission denied (publickey)`: the `*_SSH_KEY` value has stray whitespace or the matching public key isn't on the EC2. Re-paste the secret carefully (preserve the trailing newline).
4. If `Notify by email on failure` errors with `535 Authentication failed`: the `MAIL_PASSWORD` is wrong or 2-Step Verification isn't enabled on the Gmail account.

---

## What is NOT in this list

These are **not** GitHub secrets — they live elsewhere:

| Variable | Where it lives |
|---|---|
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_ENV`, `PORT` | `~/Easyfix_CRM_UI/.env.local` on each EC2 (see [AWS Deployment Guide §2](AWS_DEPLOYMENT_GUIDE.md#phase-2--configure-the-ec2-instance-one-time-bootstrap)). The build is triggered on the EC2 itself, so the build picks up `.env.local` automatically. |
| AWS account / IAM credentials | The deploy uses **SSH**, not the AWS API, so no AWS creds needed in GitHub. The EC2 instance is the only thing the workflow touches. |
| TLS certificate / private key | Managed by **Let's Encrypt + Certbot** on the EC2 itself; auto-renewal cron. Never pulled through GitHub. |

If you ever migrate to ECS Fargate / S3 / CloudFront, you'll add `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (or — better — OIDC role ARN) to this table.
