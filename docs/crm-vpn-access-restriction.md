# Restrict `crm.easyfix.in` to VPN — except the public WhatsApp-link pages

**Goal:** require VPN (or office network) to reach the **staff CRM**, while every
**outsider-facing** page — the WhatsApp magic-links for **booking** and
**profile-update** — stays reachable **without** VPN. All public surfaces now live
under a single **`/public/*`** prefix, so the allowlist is small, stable, and
identical no matter which proxy/edge you run.

> **Why this doc is platform-agnostic.** IT has confirmed the edge is **not nginx**
> but hasn't yet said what it *is*. So this doc gives the **same allowlist** expressed
> for every platform `crm.easyfix.in` could plausibly be fronted by. Find your
> platform in the table of contents, apply that one section, ignore the rest.
> Every recipe enforces the **exact same rule**:
>
> > **Block a request only when it is _not_ from the VPN/office network _and_ is _not_ on the public allowlist. Allow everything else.**

---

## Table of contents

1. [First: identify what you're actually running](#1-identify-what-youre-running)
2. [The canonical allowlist (single source of truth)](#2-the-canonical-allowlist)
3. Platform recipes — **apply ONE**:
   - [HAProxy](#3a-haproxy) — *likely (a HAProxy box exists in EasyFix infra)*
   - [Apache httpd 2.4](#3b-apache-httpd-24) — *likely (EC2 + reverse proxy)*
   - [Caddy v2](#3c-caddy-v2) — *likely (EC2, auto-HTTPS)*
   - [AWS Application Load Balancer (listener rules)](#3d-aws-alb-listener-rules)
   - [AWS WAF (on ALB or CloudFront)](#3e-aws-waf) — *recommended if any AWS edge*
   - [Amazon CloudFront + WAF](#3f-cloudfront--waf)
   - [Cloudflare (WAF custom rule / Zero Trust)](#3g-cloudflare)
   - [Traefik v3](#3h-traefik-v3)
   - [Azure Front Door / Application Gateway WAF](#3i-azure-front-door--application-gateway)
   - [Azure Container Apps ingress — *cannot do this alone*](#3j-azure-container-apps)
   - [App-level fallback: Next.js middleware](#3k-app-level-fallback-nextjs-middleware)
   - [Appendix: nginx (ruled out, kept for reference)](#appendix-nginx)
4. [Transitional legacy paths + ~30-day cleanup](#4-transitional-legacy-paths)
5. [Universal test checklist](#5-test-checklist)

---

## 1. Identify what you're running

Run these to find the real edge before picking a section.

**From anywhere (what answers on the public DNS name):**
```bash
# The Server header often names the proxy/CDN outright.
curl -sI https://crm.easyfix.in | grep -i '^server:'
#   server: nginx            → nginx          (IT says NOT this)
#   server: Apache           → Apache httpd   → §3b
#   server: Caddy            → Caddy          → §3c
#   server: cloudflare       → Cloudflare     → §3g
#   server: awselb/2.0       → AWS ALB        → §3d / §3e
#   server: AmazonS3 / "Via: ... cloudfront" → CloudFront → §3f
#   (HAProxy/Traefik usually pass the upstream's Server header through)

# Where does the name resolve? The CNAME/owner reveals the edge.
dig +short crm.easyfix.in
#   *.elb.amazonaws.com      → AWS ALB
#   *.cloudfront.net         → CloudFront
#   Cloudflare IP ranges     → Cloudflare
#   a bare Elastic IP        → the proxy runs ON the EC2 box (HAProxy/Apache/Caddy/Traefik)
```

**On the EC2 box itself (if the proxy is on-host):**
```bash
# Which process owns :443?
sudo ss -ltnp | grep ':443'
# Which proxy service is installed/running?
systemctl list-units --type=service --state=running | grep -Ei 'nginx|apache2|httpd|caddy|haproxy|traefik'
```

> Per `docs/AWS_DEPLOYMENT_GUIDE.md` the CRM is **EC2 + reverse-proxy + PM2**, app on
> `127.0.0.1:5180`, with `/api/*` proxied **inside Next.js** to the backend. So the
> edge sees a **single upstream (`:5180`)** and every recipe below gates purely by
> **URL path** — including the `/api/public/*` and `/api/auth/*` paths, which arrive
> on the same host. (If your backend is *also* fronted by its own separate proxy,
> mirror the `/api/public/*` + OTP-login rules there too.)

---

## 2. The canonical allowlist

These paths must stay reachable **WITHOUT** VPN. Everything not in this list is VPN-only.

| # | Category | Match | Pattern |
|---|---|---|---|
| 1 | **Public pages** (permanent) | prefix | `/public/` |
| 2 | Next.js runtime (JS/CSS/font chunks) | prefix | `/_next/` |
| 3 | Public backend APIs | prefix | `/api/public/` |
| 4 | OTP login (SPOC / estimate / profile flows) | exact | `/api/auth/login-otp`, `/api/auth/verify-otp`, `/api/auth/me` |
| 5 | Health probe | exact | `/healthcheck` |
| 6 | Favicon | exact | `/favicon.ico` |
| 7 | Static assets (logos, images, fonts, sourcemaps) | suffix | `*.png .jpg .jpeg .gif .svg .ico .css .js .mjs .map .woff .woff2 .ttf .eot` |
| 8 | **LEGACY links — TRANSITIONAL, remove ~30 days after cutover** | prefix | `/book/`, `/job-completion/`, `/profile-update/` |

**Everything else is VPN-only**, including: all staff CRM pages (`/`, `/jobs`,
`/easyfixers`, `/admin-actions`, …), `/api/admin/*`, `/api/client/*`, `/api/mobile/*`,
`/api/shared/*`, `/api/webhook/*`, `/api/integration/*`, **`/login`**, and all other
`/api/auth/*` (e.g. token refresh, logout).

> ⚠️ **Completeness is the #1 failure mode.** A public page that loads but renders
> **blank/unstyled off-VPN** means an asset prefix is missing from the allowlist —
> almost always **row 2 (`/_next/`)** or **row 7 (static-extension catch-all)**. The
> page HTML came through; its JS/CSS chunks got 403'd. Always allow rows 1, 2, **and** 7
> together.

**"VPN" definition** is whatever your platform uses to recognise the office/VPN network:
- On-host & cloud-LB recipes: a **source-IP CIDR** (e.g. your VPN concentrator's egress range). Replace the placeholder `10.30.0.0/16` everywhere.
- Cloudflare / Azure / AWS WAF: an **IP set / IP list** object holding those CIDRs.
- Cloudflare Zero Trust / Azure AD: optionally gate by **identity (SSO)** instead of IP — see §3g.

> 🔎 **Real-client-IP caveat (applies to every recipe).** Source-IP matching only works
> if the proxy sees the **true client IP**, not the IP of an upstream load balancer/CDN.
> If anything sits *in front* of the component you're configuring (e.g. CloudFront →
> ALB, or another LB → HAProxy), enable that platform's "real IP / forwarded-for"
> handling, or do the gating at the **outermost** layer that still sees the eyeball IP.
> Each recipe notes how.

---

## 3a. HAProxy

> Likely candidate — EasyFix infra already runs a HAProxy box. HAProxy ACLs that share
> a name are **OR-ed together**, which maps cleanly onto the allowlist.

```haproxy
frontend https_in
    bind :443 ssl crt /etc/haproxy/certs/crm.easyfix.in.pem
    mode http

    # 1) VPN / office source networks — REPLACE with real CIDR(s).
    acl is_vpn     src 10.30.0.0/16 203.0.113.10/32

    # 2) Public allowlist (same-named ACLs are OR-ed).
    acl is_public  path_beg /public/ /_next/ /api/public/
    acl is_public  path     /healthcheck /favicon.ico
    acl is_public  path     /api/auth/login-otp /api/auth/verify-otp /api/auth/me
    acl is_public  path_end .png .jpg .jpeg .gif .svg .ico .css .js .mjs .map .woff .woff2 .ttf .eot
    # --- LEGACY: remove after ~30 days (§4) ---
    acl is_public  path_beg /book/ /job-completion/ /profile-update/

    # 3) Block only when NOT on VPN AND NOT public.
    http-request deny deny_status 403 if !is_vpn !is_public

    default_backend crm_ui

backend crm_ui
    mode http
    server crm1 127.0.0.1:5180 check
```

- `path_beg` = prefix, `path` = exact, `path_end` = suffix.
- **Real client IP:** if this HAProxy sits behind another LB, `src` will be the LB's IP.
  Either accept PROXY protocol on the bind (`bind :443 ... accept-proxy`) so `src` is the
  real client, or match the forwarded header instead:
  `acl is_vpn src -f /dev/stdin` won't help — use
  `http-request set-src hdr(X-Forwarded-For)` (with `option forwardfor` upstream and a
  trusted upstream) **before** the ACLs so `src` becomes the true client.

---

## 3b. Apache httpd 2.4

> Likely if the EC2 reverse proxy is Apache. The `<If>` operator `-R 'CIDR'` matches the
> remote IP against a CIDR **natively** — no fragile IP-regex needed.

```apache
<VirtualHost *:443>
    ServerName crm.easyfix.in
    # ... SSLEngine on / SSLCertificateFile / SSLCertificateKeyFile ...

    # If behind a LB/CDN, uncomment so %{REMOTE_ADDR} is the real client:
    # RemoteIPHeader X-Forwarded-For
    # RemoteIPTrustedProxy 10.0.0.0/8   # the LB's CIDR

    # Block when NOT public AND NOT from VPN. -R matches remote IP vs CIDR.
    <If "!( %{REQUEST_URI} =~ m#^/(public|_next|api/public)/# \
        || %{REQUEST_URI} =~ m#^/(healthcheck|favicon\.ico)$# \
        || %{REQUEST_URI} =~ m#^/api/auth/(login-otp|verify-otp|me)$# \
        || %{REQUEST_URI} =~ m#\.(png|jpe?g|gif|svg|ico|css|js|mjs|map|woff2?|ttf|eot)$# \
        || %{REQUEST_URI} =~ m#^/(book|job-completion|profile-update)/# ) \
        && !( -R '10.30.0.0/16' )">
        Require all denied
    </If>

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:5180/
    ProxyPassReverse / http://127.0.0.1:5180/
</VirtualHost>
```

- Needs `mod_proxy`, `mod_proxy_http`, and (for the LB case) `mod_remoteip` enabled.
- The `^/(book|job-completion|profile-update)/` clause is the **LEGACY** line — delete it
  after ~30 days (§4).
- `Require all denied` returns **403**, exactly the intent.

---

## 3c. Caddy v2

> Likely if the EC2 uses Caddy (auto-HTTPS, no certbot). A named matcher AND-s its inner
> directives; `not` negates — so "blocked = not-VPN **and** not-public" is one matcher.

```caddyfile
crm.easyfix.in {
    @blocked {
        not client_ip 10.30.0.0/16           # REPLACE: VPN CIDR(s), space-separated
        not path /public/* /_next/* /api/public/* \
                 /healthcheck /favicon.ico \
                 /api/auth/login-otp /api/auth/verify-otp /api/auth/me \
                 /book/* /job-completion/* /profile-update/* \
                 *.png *.jpg *.jpeg *.gif *.svg *.ico *.css *.js *.mjs *.map *.woff *.woff2 *.ttf *.eot
        # the /book/ /job-completion/ /profile-update/ line above is LEGACY (§4). It is
        # deliberately NOT the last line — delete just that one line at cleanup and the
        # trailing "\" continuation chain stays intact (no dangling backslash).
    }
    respond @blocked "Forbidden" 403

    reverse_proxy 127.0.0.1:5180
}
```

- `client_ip` (Caddy ≥ 2.5) matches the real client. If Caddy is behind another proxy,
  set `trusted_proxies` in the **global options block** at the very top of the Caddyfile —
  `{ servers { trusted_proxies static 10.0.0.0/8 } }` (the LB's CIDR) — **not** inside the
  site block. A bare site-level `trusted_proxies` is invalid, and without the global setting
  `client_ip` silently falls back to the upstream proxy's IP, so the VPN gate misfires.
  (Older Caddy: use the `remote_ip` matcher instead of `client_ip`.)
- One `path` directive with all patterns = OR; wrapping it in `not` = "matches none of
  them" — i.e. not public.

---

## 3d. AWS ALB (listener rules)

> ALB conditions **cannot express NOT**, so use **allowlist rules + default-deny**.
> Workable, but see the WAF option (§3e) which is cleaner for this many paths.

> ✅ **THIS IS EASYFIX'S LIVE SETUP (confirmed 2026-06-26).** `crm.easyfix.in` is fronted by
> the shared **`core-alb`** (ap-south-1), which forwards to target group **`easyfix-crm-ui-tg`**
> → instance `EasyFix-Appsrv-Frontend` **:5180**. A listener rule **already** VPN-gates it:
> `Host = crm.easyfix.in AND Path = /* AND Source IP ∈ {10.30.0.0/16, 182.71.127.178/32,
> 49.36.185.223/32} → forward easyfix-crm-ui-tg`. **The bug is `Path = /*`** — it gates the
> public pages too. **The fix is NOT to rebuild this; just add higher-priority bypass rules**
> (lower priority number = evaluated first) that forward the public paths to the **same**
> `easyfix-crm-ui-tg` with **no Source-IP condition**:
> - **Rule A** — `Host = crm.easyfix.in AND Path = /public/*, /_next/*, /api/public/*` → forward `easyfix-crm-ui-tg`
> - **Rule B** — `Host = crm.easyfix.in AND Path = /book/*, /job-completion/*, /profile-update/*, /favicon.ico` → forward `easyfix-crm-ui-tg`  *(legacy + root favicon; §4)*
>
> Both rules MUST sit **above** the existing Source-IP rule. Public path (any IP) → matched
> first → allowed. Staff path on VPN → falls to the Source-IP rule → allowed. Staff path
> off-VPN → matches neither → default action → blocked. Revert = delete the 2 rules. Keep
> each rule ≤4 path values (the `Host` value + 4 paths = the 5-value-per-rule cap). No WAF
> needed for EasyFix. The generic recipe below is for a *dedicated* ALB; EasyFix's is shared,
> so it uses **per-host rules**, not a listener default-deny.

On the **HTTPS:443 listener** (generic, dedicated-ALB form):

1. **Default action → Return fixed response `403`.** (This is the deny-by-default.)
2. **Rule, priority 10** — *Source IP* `is` `10.30.0.0/16` (+ more) → **Forward** to the CRM target group. *(VPN bypass.)*
3. **Rule(s), priority 20+** — *Path* `is` one of the public patterns → **Forward** to the CRM target group:
   `/public/*`, `/_next/*`, `/api/public/*`, `/healthcheck`, `/favicon.ico`,
   `/api/auth/login-otp`, `/api/auth/verify-otp`, `/api/auth/me`,
   `*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.svg`, `*.ico`, `*.css`, `*.js`, `*.mjs`,
   `*.map`, `*.woff`, `*.woff2`, `*.ttf`, `*.eot`,
   **LEGACY:** `/book/*`, `/job-completion/*`, `/profile-update/*`.

**ALB gotchas:**
- Three **non-adjustable** per-rule limits bind here (none can be raised via Service Quotas
  or a support case): **Condition Values per Rule = 5**, **Match Evaluations per Rule = 5**,
  **Condition Wildcards per Rule = 6**. Almost every pattern here is a wildcard (`/public/*`,
  `/_next/*`, `/api/public/*`, the 3 legacy prefixes, and all 14 `*.ext` suffixes ≈ 20
  wildcards), so they will **not** fit in one rule. **Spread the ~25 patterns across ~5
  forward rules of ≤5 patterns each** (priority 20, 21, 22…). The lever that *is* adjustable
  is **Rules per ALB** (default 100), which gives you room for the extra rules. Verify
  current limits with `aws elbv2 describe-account-limits`.
- ALB **path patterns are case-sensitive** (unlike the regex-based recipes). The lowercase
  `*.png`/`*.css` list won't match `/LOGO.PNG`. That's fine here because Next.js `/_next/*`
  chunks and app-served assets are all lowercase — just don't rely on it for user-supplied
  uppercase asset paths.
- The **Source IP** condition matches the **TCP source IP** — *not* `X-Forwarded-For`. If
  CloudFront or another proxy is in front of the ALB, the ALB sees *its* IPs, so the VPN
  rule won't match real clients. In that case gate at the **front** layer (CloudFront/WAF
  §3e–§3f) instead.

---

## 3e. AWS WAF

> **Recommended for any AWS edge.** Attach one Web ACL to your **ALB** (regional, same
> region as the ALB) **or** your **CloudFront** distribution (scope `CLOUDFRONT`, created
> in **us-east-1**). Allow-rules short-circuit; default action **Block**.

1. **IP set** `vpn-allowlist` = your VPN/office CIDR(s).
2. **Rule 1** *(priority 0, Action **Allow**)* — statement: *Originates from an IP set* → `vpn-allowlist`.
3. **Rule 2** *(priority 1, Action **Allow**)* — statement: **OR** of:
   - URI path **starts-with** `/public/`
   - URI path **starts-with** `/_next/`
   - URI path **starts-with** `/api/public/`
   - URI path **exactly** `/healthcheck`
   - URI path **exactly** `/favicon.ico`
   - URI path **exactly** `/api/auth/login-otp` (and `…/verify-otp`, `…/me`)
   - URI path **regex-match** `\.(png|jpe?g|gif|svg|ico|css|js|mjs|map|woff2?|ttf|eot)$`
   - **LEGACY:** starts-with `/book/`, `/job-completion/`, `/profile-update/`
4. **Default action → Block** (returns 403).

- **Real client IP:** on **CloudFront** the Web ACL automatically evaluates the true
  viewer IP — perfect for the VPN IP set. On an **ALB behind CloudFront**, the ALB-level
  WAF sees CloudFront IPs, so put the Web ACL on **CloudFront**, not the ALB.
- As JSON-rules, this is ~30 lines; the AWS Console "Rule builder" expresses the same with
  AND/OR groups.

---

## 3f. CloudFront + WAF

If `crm.easyfix.in` is a CloudFront distribution (`dig` shows `*.cloudfront.net`):

1. Build the **Web ACL exactly as in §3e**, scope **`CLOUDFRONT`** (region **us-east-1**).
2. CloudFront → distribution → **Security / WAF** → associate the Web ACL.
3. Ensure the **default cache behavior** forwards every path to the origin (the ALB/EC2).
   No path needs special caching for this to work; WAF runs **before** the cache.
4. CloudFront passes the real **viewer IP** to WAF, so the `vpn-allowlist` IP set matches
   real clients with no extra config.

> Don't try to do this with CloudFront **behaviors + signed/geo** alone — WAF is the right
> tool because it can combine the IP allowlist OR the path allowlist in one decision.

---

## 3g. Cloudflare

If DNS shows Cloudflare IPs (orange-cloud proxied):

**Option A — WAF custom rule (IP-based, mirrors the other recipes).**
Security → WAF → **Custom rules** → Create. Set field "If incoming requests match… **Block**":

```
(not ip.src in $vpn_ips)
and not starts_with(http.request.uri.path, "/public/")
and not starts_with(http.request.uri.path, "/_next/")
and not starts_with(http.request.uri.path, "/api/public/")
and not (http.request.uri.path in {"/healthcheck" "/favicon.ico" "/api/auth/login-otp" "/api/auth/verify-otp" "/api/auth/me"})
and not (http.request.uri.path matches "\.(png|jpe?g|gif|svg|ico|css|js|mjs|map|woff2?|ttf|eot)$")
and not starts_with(http.request.uri.path, "/book/")
and not starts_with(http.request.uri.path, "/job-completion/")
and not starts_with(http.request.uri.path, "/profile-update/")
```
- `$vpn_ips` = a Cloudflare **IP List** holding your VPN/office CIDRs.
- Action **Block**. Cloudflare evaluates the real eyeball IP (`ip.src`) automatically.
- The last three `starts_with` lines are **LEGACY** (§4).
- ⚠️ The `matches` (regex) operator requires a **Business or Enterprise** plan; on **Free/Pro**
  it's rejected by the expression editor. On Free/Pro, replace that one line with
  per-extension `ends_with` (available on all plans):
  `and not (ends_with(http.request.uri.path, ".png") or ends_with(http.request.uri.path, ".jpg") or … or ends_with(http.request.uri.path, ".eot"))`
  — keep the whole OR-group in parentheses and negate it. Don't skip this line: it's the
  static-asset catch-all, whose omission is the #1 cause of public pages rendering blank off-VPN.

**Option B — Cloudflare Access / Zero Trust (identity, no VPN needed).**
Stronger and VPN-free: protect everything *except* the public allowlist with an Access
application that requires staff SSO (Google/Azure AD). Create an Access app for
`crm.easyfix.in/*` with an **Allow** policy for your staff IdP group, then add **Bypass**
policies for the §2 public paths (`/public/*`, `/_next/*`, `/api/public/*`, the OTP-login
endpoints, the static-asset paths, and the LEGACY paths). This removes the VPN dependency
entirely — staff authenticate with SSO from anywhere.

---

## 3h. Traefik v3

> If the app is containerised behind Traefik. Use **two routers on the same host**: a
> high-priority **public** router (no IP middleware) and a low-priority **catch-all**
> router carrying an `ipAllowList` middleware.

```yaml
http:
  routers:
    crm-public:                      # public paths bypass the IP check
      rule: |
        Host(`crm.easyfix.in`) && (
          PathPrefix(`/public/`) || PathPrefix(`/_next/`) || PathPrefix(`/api/public/`)
          || Path(`/healthcheck`) || Path(`/favicon.ico`)
          || Path(`/api/auth/login-otp`) || Path(`/api/auth/verify-otp`) || Path(`/api/auth/me`)
          || PathRegexp(`\.(png|jpe?g|gif|svg|ico|css|js|mjs|map|woff2?|ttf|eot)$`)
          || PathPrefix(`/book/`) || PathPrefix(`/job-completion/`) || PathPrefix(`/profile-update/`)
        )
      priority: 100
      service: crm
      tls: {}
    crm-vpn:                         # everything else → VPN-only
      rule: "Host(`crm.easyfix.in`)"
      priority: 1
      service: crm
      middlewares: [vpn-only]
      tls: {}

  middlewares:
    vpn-only:
      ipAllowList:
        sourceRange: ["10.30.0.0/16"]          # REPLACE: VPN CIDR(s)
        # If behind another LB, peel it off the XFF chain:
        # ipStrategy: { depth: 1 }

  services:
    crm:
      loadBalancer:
        servers: [{ url: "http://127.0.0.1:5180" }]
```

- **Trailing slashes are required** on every `PathPrefix` above. Traefik's `PathPrefix` is a
  raw string-prefix with **no segment boundary**, so a bare `` PathPrefix(`/book`) `` would
  also match `/booking` and `` PathPrefix(`/public`) `` would match `/publicXYZ`. Since this
  router carries **no IP middleware**, that would expose staff paths off-VPN. The `/…/` suffix
  pins each to a segment boundary, matching the other recipes.
- `PathRegexp` is a **v3-only** standalone matcher. On v2, express a path regex via named
  capture groups inside `Path`/`PathPrefix` (e.g. `` PathPrefix(`/{ext:.*\.(png|jpg|css)}`) ``),
  or drop the regex and rely on `/_next/` plus explicit suffixes.
- The higher-priority `crm-public` router wins for allowlisted paths and has **no**
  middleware → open to all. Everything else falls through to `crm-vpn` → `ipAllowList`
  returns **403** for non-VPN clients.
- `` PathPrefix(`/book/`) `` etc. are the **LEGACY** clauses (§4).

---

## 3i. Azure Front Door / Application Gateway

> EasyFix appears **AWS-hosted**, so Azure is unlikely here — included because the wider
> org uses Azure. Both Front Door **and** Application Gateway WAFv2 use the same
> **custom-rule** model (match conditions AND-ed, each can be negated).

**WAF custom rule** — Action **Block**, e.g. priority 100, conditions all AND-ed:

| # | Match variable | Operator | Negate | Value |
|---|---|---|---|---|
| 1 | **`SocketAddr`** (Front Door) / `RemoteAddr` (App Gateway *as the edge*) | `IPMatch` | ✅ Yes | VPN CIDR(s) |
| 2 | `RequestUri` | `BeginsWith` | ✅ Yes | `/public/` |
| 3 | `RequestUri` | `BeginsWith` | ✅ Yes | `/_next/` |
| 4 | `RequestUri` | `BeginsWith` | ✅ Yes | `/api/public/` |
| 5 | `RequestUri` | `BeginsWith` | ✅ Yes | `/api/auth/login-otp`, `/api/auth/verify-otp`, `/api/auth/me`, `/healthcheck`, `/favicon.ico` |
| 6 | `RequestUri` | `Regex` (+ `Lowercase` transform) | ✅ Yes | `\.(png\|jpe?g\|gif\|svg\|ico\|css\|js\|mjs\|map\|woff2?\|ttf\|eot)(\?.*)?$` |
| 7 | `RequestUri` | `BeginsWith` | ✅ Yes | `/book/`, `/job-completion/`, `/profile-update/` *(LEGACY)* |

Reads as: **block when** (not from VPN) **and** (not `/public/`) **and** (not `/_next/`) …
i.e. block only off-VPN non-public requests.

- 🔒 **Use `SocketAddr`, NOT `RemoteAddr`, for the VPN check on Front Door.** `RemoteAddr`
  derives the IP from the client-supplied `X-Forwarded-For` header, so an off-VPN attacker
  can send `X-Forwarded-For: <a VPN IP>` to make condition 1 evaluate false and walk straight
  past the block. `SocketAddr` is the real TCP source the WAF sees and is **not** spoofable;
  Front Door is the eyeball edge, so `SocketAddr` == true client. Only **Application Gateway
  acting as the true edge** may use `RemoteAddr` safely. If either product sits behind another
  proxy, gate at the **outermost** edge and strip inbound `X-Forwarded-For` there.
- Row 6 uses `Regex` (not `EndsWith`) on purpose: Azure's `RequestUri` **includes the query
  string**, so a cache-busted asset like `/logo.png?v=2` ends in `2`, not `.png`. The
  `(\?.*)?$` tail tolerates the query; the `Lowercase` transform also matches uppercase
  extensions.
- Rows 5/7 use `BeginsWith` because Azure has no clean exact-path operator (`Equal` on
  `RequestUri` demands the full scheme+host+query and won't match). `BeginsWith` slightly
  over-allows (e.g. `/healthcheck-internal`), which only ever *loosens* the public set, never
  blocks a public page — acceptable here.

---

## 3j. Azure Container Apps

> **ACA ingress alone cannot do this.** Container Apps ingress supports only
> `ipSecurityRestrictions` — **allow/deny by IP, with no path matching**. There is no way
> to say "block by IP *except* `/public/*`" at the ACA ingress layer: an IP deny rule would
> block the public WhatsApp pages too.
>
> If the CRM ever runs on ACA, put **Azure Front Door** (or Application Gateway) in front
> and apply the §3i WAF custom rule there, then lock ACA ingress to *only* accept traffic
> from that Front Door instance (service tag / header check). Do **not** attempt the
> VPN-except-public split on ACA ingress itself.

---

## 3k. App-level fallback: Next.js middleware

> **Last resort / defense-in-depth — NOT a substitute for edge gating.** The app is the
> *last* hop; it can only trust the client IP if the proxy in front overwrites
> `X-Forwarded-For`, and it can't protect a backend that's reachable by another route.
> Prefer any of §3a–§3i. Use this only if you truly have no controllable proxy/edge.
>
> **⚠️ Do NOT simply fold this into the repo's existing `src/middleware.ts`.** Its current
> `config.matcher` deliberately **excludes** `/api`, `/login`, `/_next`, `/coming-soon`,
> `/job-completion`, and `/public`, so Next.js never even runs the middleware for those
> paths. An IP gate added to that body would **never execute on `/api/admin/*`,
> `/api/client/*`, `/api/mobile/*`, the non-public `/api/auth/*`, or `/login`** — i.e. it
> would leave exactly the must-block surfaces **open off-VPN** (a fail-open, contradicting the
> §5 test that `/login` and `/api/admin/...` return 403). The gate needs its **own widened
> matcher** (below) plus a guard so the existing menu-visibility logic still no-ops on the
> paths it used to be excluded from. **Test hard** — a bug here locks out staff *and*
> customers, since one process serves both.

```ts
// src/middleware.ts — the IP gate must run on the must-block paths, so it needs a WIDER
// matcher than the repo's existing one. Run on everything except pure static internals;
// let the in-body isPublic allowlist re-open the public surfaces.
import { NextResponse, type NextRequest } from 'next/server'

const VPN_CIDRS = ['10.30.0.0/16']                 // REPLACE
const PUBLIC_PREFIXES = ['/public/', '/_next/', '/api/public/',
                         '/book/', '/job-completion/', '/profile-update/'] // last 3 = LEGACY
const PUBLIC_EXACT = new Set(['/healthcheck', '/favicon.ico',
                              '/api/auth/login-otp', '/api/auth/verify-otp', '/api/auth/me'])
const ASSET_RE = /\.(png|jpe?g|gif|svg|ico|css|js|mjs|map|woff2?|ttf|eot)$/

function ipToLong(ip: string) { return ip.split('.').reduce((a, o) => (a << 8) + (+o), 0) >>> 0 }
function inCidr(ip: string, cidr: string) {
  const [base, bitsStr] = cidr.split('/'); const bits = +bitsStr
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false   // non-IPv4 (incl. IPv6) → not matched → blocked
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipToLong(ip) & mask) === (ipToLong(base) & mask)
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // 1) VPN GATE — runs first, on every path the (widened) matcher lets through.
  const isPublic = PUBLIC_PREFIXES.some(p => pathname.startsWith(p))
    || PUBLIC_EXACT.has(pathname) || ASSET_RE.test(pathname)
  if (!isPublic) {
    // Trust X-Forwarded-For ONLY if the upstream proxy OVERWRITES it (not appends).
    const clientIp = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    const onVpn = VPN_CIDRS.some(c => inCidr(clientIp, c))
    if (!onVpn) return new NextResponse('Forbidden', { status: 403 })
  }

  // 2) Existing menu-visibility logic assumed /api, /login, /_next were matcher-excluded.
  //    Now that the matcher is wider, early-return for those so it doesn't fire spurious
  //    BE calls or redirect loops:
  if (pathname.startsWith('/api') || pathname.startsWith('/_next')
      || pathname === '/login' || pathname.startsWith('/public')
      || pathname.startsWith('/coming-soon')) {
    return NextResponse.next()
  }
  // ... existing menu-visibility / coming-soon redirect logic unchanged below ...

  return NextResponse.next()
}

// WIDER than the repo's existing matcher — the gate MUST see /api/* and /login.
export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
}
```

- **Matcher, not just body:** the gate is only as strong as `config.matcher`. This sketch runs
  on all paths except `/_next/static` + `/_next/image`; everything else — including `/api/*`
  and `/login` — reaches the gate, and the in-body `isPublic` allowlist re-opens the public
  subset. Reusing the repo's narrow matcher would silently leave the API/login surface open.
- **XFF parse:** the leftmost `X-Forwarded-For` entry is client-controlled — safe only if the
  immediately-upstream proxy **overwrites** the header with the single real client IP. If the
  proxy **appends**, take the rightmost-untrusted entry instead.
- **IPv6:** this `inCidr` is IPv4-only — IPv6 office/VPN clients are treated as not-on-VPN and
  **actively 403'd** until you add an IPv6 branch. Fine if your VPN egress is IPv4.
- **Spoofing:** if any path lets a client set `X-Forwarded-For` reaching the app, the gate is
  bypassable. Only the network edge enforces VPN-only securely — hence "fallback".

---

## Appendix: nginx

> **IT has confirmed the edge is NOT nginx**, so this is here only for reference / in case
> that finding reverses. (Heads-up: `docs/AWS_DEPLOYMENT_GUIDE.md` still describes an
> nginx + PM2 edge — that guide predates IT's confirmation, so treat **§1 Step 1** as the
> source of truth for what's actually running, not the deployment guide.) The pattern: `geo`
> flags VPN CIDRs, `map` flags public paths, a second `map` combines them, and a single `if`
> denies.

```nginx
geo $is_vpn { default 0; 10.30.0.0/16 1; }          # REPLACE: VPN CIDR(s)
map $uri $is_public {
    default 0;
    ~^/public/                              1;
    ~^/_next/                               1;
    ~^/api/public/                          1;
    ~^/api/auth/(login-otp|verify-otp|me)$  1;
    = /healthcheck                          1;
    = /favicon.ico                          1;
    ~*\.(?:png|jpe?g|gif|svg|ico|css|js|mjs|map|woff2?|ttf|eot)$  1;
    ~^/book/                                1;   # LEGACY (§4)
    ~^/job-completion/                      1;   # LEGACY (§4)
    ~^/profile-update/                      1;   # LEGACY (§4)
}
map "$is_vpn:$is_public" $block_non_vpn { default 0; "0:0" 1; }
server {
    # listen 443 ssl; server_name crm.easyfix.in; ssl_* ...
    location / {
        if ($block_non_vpn) { return 403; }
        proxy_pass http://127.0.0.1:5180;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

- **Real client IP (same caveat as every other recipe):** `geo $is_vpn` matches `$remote_addr`,
  the *immediate* TCP peer. If nginx sits behind any LB/CDN that's the LB's IP (never in your
  VPN CIDR), so **all** staff get silently 403'd off-VPN. Load the realip module and add,
  before the `geo` block: `set_real_ip_from <LB_CIDR>;` `real_ip_header X-Forwarded-For;`
  `real_ip_recursive on;` so `$remote_addr` becomes the true client IP. If nginx is the direct
  edge (its own Elastic IP), no change needed.

---

## 4. Transitional legacy paths

Magic-links **already sent** before the `/public/*` cutover use the old root paths
`/book/<code>`, `/job-completion/<token>`, `/profile-update/<token>`. The app
**307-redirects** these to `/public/*`, but the redirect only fires if the request
**reaches the app** — so the edge must allow the old paths too, until those links expire.

- **JWT magic-link TTL is ~30 days** → after **~2026-07-26** no valid old links remain.
- A DB migration (`EasyFix_Backend/migrations/2026-06-24-shortlink-longurl-to-public.sql`)
  repoints already-stored `tbl_url_shortener.long_url` values to `/public/*` so short codes
  land directly on `/public` (no redirect hop). The WhatsApp **message text** already
  delivered can't be edited, which is why the edge allowlist still needs the legacy paths
  for the transition window.

**~30-day cleanup (≈ 2026-07-26), do all three together:**
1. Remove the **3 LEGACY lines** (`/book`, `/job-completion`, `/profile-update`) from
   whichever recipe you applied above.
2. Remove the **3 back-compat `redirects()`** in `Easyfix_CRM_UI/next.config.mjs`.
3. Leave a pure `/public/*` public surface.

> Skipping step 1 isn't a security hole (the old paths only ever served redirects), just
> dead config. Do **not** remove them *before* old links expire or in-flight customer links
> break.

---

## 5. Test checklist

Do **both halves**, on a phone (mobile data = off-VPN) or with a VPN toggle.

**Off VPN — these must WORK (HTTP 200, page renders _fully_, not blank):**
- `https://crm.easyfix.in/public/book/<code>` → redirects to the job-completion form
- `https://crm.easyfix.in/public/profile/<code>` → redirects to the profile-update form
- Full booking **and** profile-update flows end-to-end (submit, OTP, photo upload)
- A legacy link `https://crm.easyfix.in/book/<code>` → 307 → `/public/...` → works

**Off VPN — these must be BLOCKED (HTTP 403):**
- `https://crm.easyfix.in/` (dashboard), `/jobs`, `/easyfixers`, `/admin-actions`, `/login`
- `https://crm.easyfix.in/api/admin/...`

**On VPN — everything works exactly as today** (no staff regression).

> If a public page loads but is **blank/unstyled off-VPN**, an asset prefix is missing —
> re-check **row 2 (`/_next/`)** and **row 7 (static-extension catch-all)** in §2. The
> page HTML got through but its chunks were 403'd.
