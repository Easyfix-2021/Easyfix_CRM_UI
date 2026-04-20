# AWS Deployment Guide — Easyfix_CRM_UI (Next.js Frontend)

This guide walks through deploying the **CRM frontend** (`Easyfix_CRM_UI`, Next.js 15 App Router) to AWS using **EC2 + Nginx + PM2**, with **GitHub Actions** auto-deploying on `QA` and `Production` branch merges.

> **Companion guide:** the backend (`EasyFix_Backend`, Node.js/Express) has its own [AWS_DEPLOYMENT_GUIDE.md](../../EasyFix_Backend/docs/AWS_DEPLOYMENT_GUIDE.md) — set up in parallel; this frontend proxies `/api/*` to it via Nginx.

---

## Architecture overview

```
                 ┌────────────────────────────────────────────┐
                 │  Route 53  →  qa.crm.easyfix.in            │
                 │            →  prod.crm.easyfix.in          │
                 └────────────────┬───────────────────────────┘
                                  │
                       ┌──────────▼──────────┐
                       │   EC2 (QA / Prod)   │
                       │   t3.small / medium │
                       │                     │
                       │   Nginx :443  ───┐  │
                       │                  ▼  │
                       │   PM2 → Next 5180 │  │
                       │                  │  │
                       │   /api/* ─────► backend EC2 :5100
                       └─────────────────────┘
```

Two EC2 instances total — one for **QA** (deploys from the `QA` branch), one for **Production** (deploys from the `Production` branch). Same image, same Nginx config, different domain + secrets.

---

## Phase 1 — Create the QA EC2 instance (AWS Console)

### 1.1  Sign in & open EC2

1. Open the [AWS Console](https://console.aws.amazon.com/).
2. Top-right region picker → **Asia Pacific (Mumbai) `ap-south-1`** (closest to existing infra).
3. Search bar → **EC2** → **Instances** → **Launch instances**.

### 1.2  Configure the instance

| Field | Value |
|---|---|
| Name and tags | `easyfix-crm-ui-qa` |
| Application and OS Images (AMI) | **Ubuntu Server 22.04 LTS** (HVM, free tier eligible) |
| Architecture | `64-bit (x86)` |
| Instance type | `t3.small` (2 vCPU, 2 GiB RAM) — bump to `t3.medium` if Next builds OOM |
| Key pair (login) | Click **Create new key pair** → name `easyfix-crm-ui-qa` → type `RSA` → format `.pem` → **Create key pair** (save the file securely; you cannot re-download it) |
| Network settings | Click **Edit** |
| → VPC | Default (or your existing VPC) |
| → Subnet | Any public subnet in `ap-south-1a` |
| → Auto-assign public IP | **Enable** |
| → Firewall (security groups) | **Create security group** |
| → → Name | `easyfix-crm-ui-sg` |
| → → Description | `CRM frontend public access` |
| → → Inbound rules | Add the 3 rules below |
| Configure storage | `20 GiB`, `gp3` |

**Inbound rules:**

| Type | Protocol | Port range | Source | Description |
|---|---|---|---|---|
| SSH | TCP | 22 | My IP | dev access |
| HTTP | TCP | 80 | Anywhere (0.0.0.0/0) | Let's Encrypt + redirect to HTTPS |
| HTTPS | TCP | 443 | Anywhere (0.0.0.0/0) | public traffic |

Click **Launch instance**. After ~30 seconds, instance state → **Running**.

### 1.3  Allocate an Elastic IP (so the IP doesn't change on reboot)

1. EC2 left sidebar → **Elastic IPs** → **Allocate Elastic IP address** → leave defaults → **Allocate**.
2. Select the new EIP → **Actions** → **Associate Elastic IP address** → choose your `easyfix-crm-ui-qa` instance → **Associate**.
3. Note the EIP — you'll point DNS at it next.

### 1.4  Point DNS at the EIP (Route 53)

1. Console search → **Route 53** → **Hosted zones** → click your domain (e.g. `easyfix.in`).
2. **Create record** → record name `qa.crm`, record type `A`, value = the EIP from 1.3, TTL `300` → **Create records**.
3. Wait 1-2 min, then verify: `dig qa.crm.easyfix.in` (or use [dnschecker.org](https://dnschecker.org)).

If you don't have a hosted zone yet: **Hosted zones** → **Create hosted zone** → fill in your domain → AWS gives you 4 nameservers. Set those nameservers at your domain registrar (e.g. GoDaddy → DNS → Nameservers → Custom). Wait for propagation (up to 24 h, usually < 1 h).

---

## Phase 2 — Configure the EC2 instance (one-time bootstrap)

SSH in (the only CLI step in this guide; everything else is pure UI):

```bash
chmod 400 easyfix-crm-ui-qa.pem
ssh -i easyfix-crm-ui-qa.pem ubuntu@<EIP>
```

Then on the instance, run the bootstrap script (one-time):

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential nginx git certbot python3-certbot-nginx

# PM2 (process manager + auto-restart on reboot)
sudo npm install -g pm2
pm2 startup systemd -u ubuntu --hp /home/ubuntu
# Copy the printed sudo command and run it

# Clone the repo
git clone https://github.com/<YourOrg>/Easyfix_CRM_UI.git ~/Easyfix_CRM_UI
cd ~/Easyfix_CRM_UI
git checkout QA   # or Production on the other instance

# .env.local — copy from .env.example and fill values
cp .env.example .env.local
nano .env.local   # set NEXT_PUBLIC_API_URL etc.
```

Sample `.env.local` for QA:
```env
NEXT_PUBLIC_API_URL=https://qa.api.easyfix.in/api
NEXT_PUBLIC_APP_ENV=qa
PORT=5180
```

Build and start:
```bash
npm ci
npm run build
pm2 start "npm run start" --name easyfix-crm-ui --update-env
pm2 save
```

### 2.1  Configure Nginx (UI-light, but config is text — easiest in editor)

Create `/etc/nginx/sites-available/easyfix-crm-ui`:

```nginx
server {
    listen 80;
    server_name qa.crm.easyfix.in;

    # Let's Encrypt rewrites this once HTTPS is set up
    location / {
        proxy_pass http://127.0.0.1:5180;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable + reload:
```bash
sudo ln -s /etc/nginx/sites-available/easyfix-crm-ui /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 2.2  HTTPS via Let's Encrypt (zero-cost cert, auto-renews)

```bash
sudo certbot --nginx -d qa.crm.easyfix.in
# Pick "redirect HTTP → HTTPS" when asked
```

Verify renewal cron is in place (Ubuntu sets it up automatically):
```bash
sudo systemctl status certbot.timer
```

Done — visit `https://qa.crm.easyfix.in`. The site should load and you should be logged out (clean browser session).

---

## Phase 3 — Repeat for Production

Repeat **Phase 1** and **Phase 2** with these substitutions:

| QA value | Production value |
|---|---|
| Instance name `easyfix-crm-ui-qa` | `easyfix-crm-ui-prod` |
| Instance type `t3.small` | `t3.medium` (more headroom for real traffic) |
| Key pair `easyfix-crm-ui-qa` | `easyfix-crm-ui-prod` |
| DNS record `qa.crm.easyfix.in` | `prod.crm.easyfix.in` (or `crm.easyfix.in`) |
| Branch `QA` | `Production` |
| `.env.local` `NEXT_PUBLIC_API_URL=https://qa.api.easyfix.in/api` | `https://api.easyfix.in/api` |

> **Cost-saving option:** if QA traffic is light, you can put both instances behind one Application Load Balancer with host-header routing. Simpler is two independent EC2s — start there.

---

## Phase 4 — GitHub Actions auto-deploy

The included [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) deploys on push to `QA` (→ QA EC2) or `Production` (→ Prod EC2). It SSH-es into the right instance, pulls the latest code, runs `npm ci && npm run build`, and reloads PM2.

### 4.1  Create the deploy SSH key (UI: GitHub Settings)

We use a **deploy key** rather than embedding the EC2 admin key — least-privilege.

On your local machine:
```bash
ssh-keygen -t ed25519 -f easyfix-crm-ui-deploy -N "" -C "github-actions-deploy"
# produces easyfix-crm-ui-deploy (private) + easyfix-crm-ui-deploy.pub
```

Add the **public** key to each EC2's `~/.ssh/authorized_keys`:
```bash
# On the EC2 instance:
echo "<paste the .pub file contents>" >> ~/.ssh/authorized_keys
```

### 4.2  Add GitHub repo secrets (UI walkthrough)

1. Go to your repo on GitHub → **Settings** (top tab) → **Secrets and variables** → **Actions** → **New repository secret**.
2. Add these secrets — one per row:

| Name | Value |
|---|---|
| `QA_HOST` | the QA EC2 EIP (e.g. `13.234.56.78`) |
| `QA_USER` | `ubuntu` |
| `QA_SSH_KEY` | full contents of `easyfix-crm-ui-deploy` (the **private** key file) |
| `PROD_HOST` | the Production EC2 EIP |
| `PROD_USER` | `ubuntu` |
| `PROD_SSH_KEY` | full contents of `easyfix-crm-ui-deploy` (same key, since both EC2s trust it) |

Optional but recommended:

| Name | Value |
|---|---|
| `SLACK_WEBHOOK_URL` | for deploy notifications (works with any incoming webhook) |

### 4.3  Create the QA and Production branches

In GitHub UI:
1. **Branches** (next to the branch dropdown) → **New branch** → name `QA`, source `main` → **Create**.
2. Same for `Production`.

### 4.4  (Strongly recommended) Branch protection

GitHub UI: **Settings** → **Branches** → **Add classic branch protection rule**:

- Branch name pattern: `Production`
- ☑ Require a pull request before merging (1 approval minimum)
- ☑ Require status checks to pass before merging → select the `build` check from `deploy.yml`
- ☑ Require branches to be up to date before merging
- ☑ Restrict who can push to matching branches → leave empty (only PR merges, no direct push)

Repeat for `QA` with looser rules (no required reviewers).

### 4.5  Test the pipeline

1. Make a trivial change on `main` → push.
2. Open a PR `main` → `QA` → merge.
3. GitHub UI → **Actions** tab → watch the `deploy-qa` job. Should finish in 4-6 min.
4. Visit `https://qa.crm.easyfix.in` — change should be live.
5. Repeat: PR `QA` → `Production` → merge → watch `deploy-prod` job → visit `https://crm.easyfix.in`.

---

## Phase 5 — Day-2 operations (UI)

### Logs
1. EC2 Console → select instance → **Connect** → **EC2 Instance Connect** (browser-based SSH, no key needed) → **Connect**.
2. `pm2 logs easyfix-crm-ui` for app logs.
3. `sudo tail -f /var/log/nginx/access.log` for traffic, `error.log` for proxy errors.

### Restart the app (without rebuilding)
- EC2 Instance Connect → `pm2 restart easyfix-crm-ui`.

### Force a fresh deploy
- GitHub UI → **Actions** tab → pick `deploy.yml` → **Run workflow** → choose branch.

### Roll back
- GitHub UI → **Actions** → find the previous successful run for that branch → **Re-run all jobs**. PM2 will swap the build atomically (`pm2 reload` is zero-downtime).
- If the bad deploy is wedged, EC2 Instance Connect → `cd ~/Easyfix_CRM_UI && git reset --hard <last-good-sha> && npm ci && npm run build && pm2 reload easyfix-crm-ui`.

### Scale up
- EC2 Console → select instance → **Instance state** → **Stop** → wait for stopped → **Actions** → **Instance settings** → **Change instance type** → pick larger type → **Apply** → **Instance state** → **Start**. Downtime ~ 1 minute. Elastic IP and EBS volume persist.

### Cost watch
- Console → **Billing and Cost Management** → set a budget alert at e.g. **$50/mo** for `Service = EC2 + Route 53 + Data Transfer`. Frontend EC2 + ELB-less setup is typically $20-40/mo per instance.

---

## Troubleshooting

| Symptom | First thing to check |
|---|---|
| GitHub Action fails with "Permission denied (publickey)" | The `*_SSH_KEY` secret has stray whitespace, or the public key isn't in `~/.ssh/authorized_keys` on the EC2 |
| `pm2 restart` succeeds but site shows old code | PM2 didn't pick up the new build — try `pm2 reload easyfix-crm-ui` (atomic restart) instead of `restart` |
| 502 Bad Gateway on the site | Next.js process crashed on boot — `pm2 logs` to see the stacktrace; usually a missing env var |
| Cert renewal failed | `sudo certbot renew --dry-run` — usually a DNS A-record drift; re-point the record |
| OOM during `npm run build` | Bump instance type from `t3.small` → `t3.medium`; or set `NODE_OPTIONS=--max-old-space-size=1536` in the pm2 env |
| `/api/*` calls 502 | Backend EC2 is down or reachable on a different security group — check the backend instance + that the frontend security group can reach the backend on `:5100` |

---

## Security checklist before going live

- ☑ `~/.ssh/authorized_keys` on each EC2 contains only the deploy key + one admin key
- ☑ EC2 security group port 22 source is **My IP** (not `0.0.0.0/0`) for all admin keys
- ☑ HTTPS forced (Certbot's redirect rule was applied)
- ☑ `.env.local` permissions: `chmod 600 .env.local`
- ☑ GitHub branch protection on `Production` requires PR review
- ☑ AWS root account has MFA on; day-to-day work uses an IAM user with restricted policies
- ☑ CloudWatch alarms: CPU > 80% for 10 min → email; status check failure → email
