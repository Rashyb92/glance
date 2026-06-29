---
title: 'Glance — Go-Live Runbook'
subtitle: 'Sequenced launch checklist'
date: 'June 2026'
---

# Glance — Go-Live Runbook

A start-to-finish checklist to take Glance from green tests to live, on the managed-simple
stack (Fly + Neon + Upstash + Cloudflare). Detailed reference: `docs/DEPLOY.md`. Work top to
bottom; each phase ends with a verification.

## 0 · Prerequisites (accounts + tools)

- [ ] Accounts: **Fly.io**, **Neon**, **Upstash**, **Cloudflare** (Pages), **Stripe**, **Twitch** (and YouTube/Kick if launching those), a **domain**.
- [ ] Local tools: `flyctl`, `node 22`, `pnpm 9.15`, `openssl`, `git`. (`@bubblewrap/cli` + Android SDK and Xcode only when you do the store builds.)
- [ ] `pnpm verify` (typecheck · lint · format:check · test · build · coverage) is green on `main`.
- [ ] CI passes on `main`: **verify**, the **Security** workflow (gitleaks secret scan, Trivy image scan, `pnpm audit`), and the **Playwright E2E** smoke. `CODEOWNERS` is in place for review.

## 1 · Provision infrastructure

- [ ] **Postgres (Neon):** create a project; copy the connection string. Create the KV table:
      `CREATE TABLE IF NOT EXISTS glance_kv (key text PRIMARY KEY, value text NOT NULL);`
- [ ] **Redis (Upstash):** create a database; copy the `rediss://` URL.
- [ ] **Fly app:** from the repo root, `fly launch --no-deploy` (detects `Dockerfile` + `fly.toml`); `fly volumes create glance_data --size 1`.
- [ ] **Domain/DNS:** decide hosts — e.g. `api.glance.app` (server), `app.glance.app` (companion), `dash.glance.app` (dashboard), `hud.glance.app` (HUD).

## 2 · Secrets & configuration

Generate the secrets:

```bash
openssl rand -base64 48      # GLANCE_AUTH_SECRET (token signing)
openssl rand -base64 48      # GLANCE_TOKEN_KEY   (OAuth token encryption at rest)
# VAPID keypair for Web Push:
node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'});console.log('VAPID_PUBLIC_KEY=',publicKey.export({type:'spki',format:'der'}).subarray(-65).toString('base64url'));console.log('VAPID_PRIVATE_KEY=',privateKey.export({type:'pkcs8',format:'der'}).subarray(36,68).toString('base64url'))"
```

- [ ] **OAuth apps:** register Twitch (and YouTube/Kick) apps; set redirect URIs to `https://<api-host>/api/oauth/<provider>/callback`; add the **`clips:edit`** scope to Twitch.
- [ ] **Stripe:** create the products/prices for Creator and Pro; create a webhook to `https://<api-host>/api/stripe/webhook`; copy the signing secret. Put `tenant` + `plan` in subscription metadata so the webhook can map them.
- [ ] **Admin console:** mint operator token(s) for `/admin` and `/api/admin/*` (a **separate trust domain** from tenant auth). Set `GLANCE_ADMIN_TOKENS` as comma-separated `name:token` pairs (e.g. `alice:s3cret,bob:hunter2`) so operator actions are attributable in the audit log; `GLANCE_ADMIN_TOKEN` (single token) is the minimum. With **neither** set the admin API is disabled (fail-closed), so set at least one before launch.
- [ ] **Metrics:** set `GLANCE_METRICS_TOKEN` if `/metrics` is reachable off your private network — otherwise scraping is open (see Phase 7).
- [ ] **Set Fly secrets** (only what you use):

```bash
fly secrets set \
  GLANCE_AUTH_SECRET="..." GLANCE_TOKEN_KEY="..." \
  ANTHROPIC_API_KEY="sk-ant-..." \
  DATABASE_URL="postgres://..." REDIS_URL="rediss://..." \
  GLANCE_PUBLIC_URL="https://api.glance.app" \
  GLANCE_DASHBOARD_URL="https://dash.glance.app" \
  GLANCE_ALLOWED_ORIGINS="https://hud.glance.app,https://dash.glance.app,https://app.glance.app" \
  TWITCH_CLIENT_ID="..." TWITCH_CLIENT_SECRET="..." \
  STRIPE_SECRET_KEY="sk_live_..." STRIPE_WEBHOOK_SECRET="whsec_..." \
  VAPID_PUBLIC_KEY="..." VAPID_PRIVATE_KEY="..." VAPID_SUBJECT="mailto:ops@glance.app" \
  GLANCE_ADMIN_TOKENS="alice:..." GLANCE_METRICS_TOKEN="..."
```

> The server **refuses to boot** in any non-local `NODE_ENV` without `GLANCE_AUTH_SECRET` — this is intentional (fail-closed). `fly.toml` sets `NODE_ENV=production`.

**Privacy defaults (verify, don't change unless you mean to):** chat text is **not** stored
(`storeMessageText=false`) and retention is **7 days** (`retentionDays=7`) out of the box;
OAuth provider tokens are encrypted at rest under `GLANCE_TOKEN_KEY`. Kick is experimental
and stays **off** until you set `GLANCE_ENABLE_KICK=1`. The content-free product-analytics
funnel is **on** by default — set `GLANCE_ANALYTICS_DISABLED=1` to turn it off.

## 3 · Deploy the server

- [ ] `pnpm add pg` (committed) so the Postgres-backed settings store activates. _(Optional but recommended for multi-instance.)_
- [ ] `fly deploy`.
- [ ] Verify liveness: `curl https://<api-host>/health` → `{"ok":true}`.
- [ ] Verify readiness: `curl https://<api-host>/ready` → `{"ready":true}`. With `DATABASE_URL` set, `/ready` stays **503 until Postgres is reachable and `glance_kv` is auto-migrated** — so a green `/ready` confirms the DB is wired and the table exists.
- [ ] Confirm `/admin` answers with an operator token (e.g. `curl -H "Authorization: Bearer <admin-token>" https://<api-host>/api/admin/audit`) and rejects without one.
- [ ] Confirm logs show `settings store: Postgres (multi-instance)` (if `DATABASE_URL` set) and `auth: token (multi-tenant)`.

## 4 · Deploy the front-ends (Cloudflare Pages)

For each app (`hud`, `dashboard`, `companion`): create a Pages project, build command
`pnpm install && pnpm --filter @glance/<app> build`, output `apps/<app>/dist`, with env:

- [ ] `VITE_GLANCE_WS_URL = wss://<api-host>` (hud, companion)
- [ ] `VITE_GLANCE_API_URL = https://<api-host>` (dashboard, companion)
- [ ] **Do _not_ set `VITE_GLANCE_TOKEN` in a production build** — users authenticate at runtime via signup/login, and browser WS clients fetch a short-lived ticket from `/api/auth/ws-ticket`. `VITE_GLANCE_TOKEN` is a **dev-only** fallback.
- [ ] `VITE_VAPID_PUBLIC_KEY = <vapid public>` (companion only)
- [ ] Add a **512×512 PNG** at `apps/companion/public/icon-512.png` before building (store icon).

## 5 · Smoke tests (production)

- [ ] HUD/dashboard load over HTTPS; WS connects (status shows "live").
- [ ] Connect a demo session → priorities/stats stream; connect a real Twitch channel → live chat reads.
- [ ] Multi-channel: add Twitch + YouTube; one merged feed with source badges; summed viewers.
- [ ] OAuth: "Link your channel" → Twitch consent → returns linked; viewer count populates.
- [ ] Companion: install PWA, "Enable alerts", trigger a donation event → background push arrives.
- [ ] Billing: run a Stripe **test** checkout → webhook flips the plan; customer portal opens. Re-send the same webhook event → it's de-duped (idempotent), plan unchanged.
- [ ] Voice: "any donations?", "clip that" → a real Twitch clip URL appears in Replay.
- [ ] Auth: sign up + log in mint runtime tokens; `revoke-all` signs out everywhere (a previously-issued token is rejected on its next call).
- [ ] Admin: load `/admin` with an operator token → a content-free tenant snapshot renders; the action lands in `GET /api/admin/audit`. Without a token the console + API are refused.
- [ ] Privacy: confirm chat text is not persisted (`storeMessageText=false`) and the analytics funnel advances (signup → activated → engaged) in the admin console.

## 6 · Mobile store builds (when ready)

- [ ] **Android (TWA):** follow `apps/companion/twa/README.md` — `bubblewrap init/build`, put the signing SHA-256 into `apps/companion/public/.well-known/assetlinks.json`, redeploy, upload the `.aab` to Play Console.
- [ ] **iOS:** follow `apps/companion/ios/README.md` — PWABuilder or Capacitor; wire APNs for store-build push.

## 7 · Monitoring, backups, rollback

- [ ] Point Grafana Cloud / Datadog at `https://<api-host>/metrics` (gate it by network policy or `GLANCE_METRICS_TOKEN` if public — pass the token as a bearer or `?token=`). Alert on `/health`, error rate, `glance_ws_clients`, AI usage.
- [ ] Track the content-free activation funnel via the `glance_funnel_*_total` metrics (also visible in the admin console) to watch signup → activated → engaged → subscribed.
- [ ] Enable Neon point-in-time backups; confirm the Fly volume is attached.
- [ ] **Rollback:** `fly releases` → `fly deploy --image <previous>` (or `fly releases rollback`). Front-ends roll back via Cloudflare Pages deployments. Keep secrets unchanged across rollbacks.

## 8 · Launch day

- [ ] Final `pnpm verify` green; tag the release (`git tag vX.Y.Z`).
- [ ] Status page / "we're live" note ready; support inbox + Discord staffed.
- [ ] Product Hunt + Indie Hackers posts scheduled (weekend), demo video uploaded, supporter community pinged for the first-3-hours push (see the Business Plan → Marketing).
- [ ] Watch `/metrics` + logs for the first hours; have the rollback command ready.

---

**Definition of done:** server healthy on Fly, front-ends live on Cloudflare, a real channel reads chat, push + billing + voice verified end-to-end, monitoring alerting, and a tested rollback path.
