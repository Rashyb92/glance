# Deploying Glance

Glance has four deployable pieces:

| Piece                                                           | What it is                                                                                                                      | Where it runs                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Server** (`apps/server`)                                      | Stateful WebSocket + REST gateway and the Hub. Holds live sessions in memory and long-lived socket connections.                 | Long-running containers (not serverless). |
| **Front-ends** (`apps/hud`, `apps/dashboard`, `apps/companion`) | Static React/Vite SPAs.                                                                                                         | Static host / CDN over HTTPS.             |
| **Postgres**                                                    | Durable shared state (settings, sessions, tokens, teams, entitlements, push devices, accounts, analytics).                      | Managed Postgres.                         |
| **Redis**                                                       | Cross-instance pub/sub bus, AI usage meter and revocation control channel (the scale primitives in `apps/server/src/redis.ts`). | Managed Redis.                            |

The **server is stateful**, which drives everything: scale it horizontally with multiple long-running instances and **tenant-sticky routing** (a creator's session + sockets must stay on one instance — that is what the sharding helpers in `apps/server/src/sharding.ts` are for). Redis bridges broadcasts, the AI usage meter, and token revocation across instances; Postgres is the source of truth each instance hydrates from.

## Recommended stack (managed-simple)

Cheapest to start, fastest to ship, and the same codebase scales to the 20k-creator target with no rewrite — everything is env-driven behind clean seams.

| Concern     | Service                 | Notes                                                        |
| ----------- | ----------------------- | ------------------------------------------------------------ |
| Server      | **Fly.io**              | First-class WebSockets, global regions, per-second billing.  |
| Postgres    | **Neon**                | Serverless, scale-to-zero free tier; `DATABASE_URL`.         |
| Redis       | **Upstash**             | Serverless, pay-per-use free tier; `REDIS_URL`.              |
| Static apps | **Cloudflare Pages**    | Free, global, HTTPS (required for the companion PWA + push). |
| Secrets     | Fly secrets / Doppler   | Never commit secrets.                                        |
| Metrics     | Grafana Cloud / Datadog | Scrape `/metrics`; probe `/health` **and** `/ready`.         |

Enterprise equivalent (if you ever need VPC/procurement): ECS-Fargate or EKS + RDS/Aurora + ElastiCache + CloudFront. The application code does not change — only the URLs behind `DATABASE_URL` / `REDIS_URL`.

---

## 1 · Server on Fly.io

```bash
# from the repo root
fly launch --no-deploy          # detects Dockerfile + fly.toml; pick an app name + region
fly volumes create glance_data --size 1   # durable disk for the file stores (single instance)
```

Set the secrets (only the ones you use — each integration fails soft until its keys exist):

```bash
fly secrets set \
  GLANCE_AUTH_SECRET="$(openssl rand -base64 48)" \
  GLANCE_TOKEN_KEY="$(openssl rand -base64 48)" \
  ANTHROPIC_API_KEY="sk-ant-..." \
  GLANCE_PUBLIC_URL="https://<your-app>.fly.dev" \
  GLANCE_DASHBOARD_URL="https://dashboard.<your-domain>" \
  GLANCE_ALLOWED_ORIGINS="https://hud.<your-domain>,https://dashboard.<your-domain>,https://app.<your-domain>" \
  GLANCE_TRUST_PROXY="1" \
  GLANCE_METRICS_TOKEN="$(openssl rand -base64 24)" \
  GLANCE_ADMIN_TOKENS="alice:$(openssl rand -base64 24)" \
  TWITCH_CLIENT_ID="..."  TWITCH_CLIENT_SECRET="..." \
  STRIPE_SECRET_KEY="sk_live_..."  STRIPE_WEBHOOK_SECRET="whsec_..."

fly deploy
```

`GLANCE_AUTH_SECRET` is **required in production** — the server refuses to boot without it whenever `NODE_ENV` is set to anything but `development`/`test` (otherwise every client collapses onto the `default` tenant). `GLANCE_TOKEN_KEY` encrypts stored OAuth tokens at rest (AES-256-GCM) and is required once any provider is linked. Set `GLANCE_TRUST_PROXY=1` so `X-Forwarded-For` is trusted behind Fly's edge, gate `/metrics` with `GLANCE_METRICS_TOKEN`, and set `GLANCE_ADMIN_TOKEN`/`GLANCE_ADMIN_TOKENS` to unlock the operator console (fail-closed when unset). Each integration fails soft until its keys exist.

Point your OAuth app redirect URIs at `https://<your-app>.fly.dev/api/oauth/<provider>/callback`, and the Stripe webhook at `https://<your-app>.fly.dev/api/stripe/webhook`.

## 2 · Front-ends on Cloudflare Pages

Each app is a separate Pages project. Build command `pnpm install && pnpm --filter @glance/<app> build`, output `apps/<app>/dist`. Set per-project build env so the SPA talks to the server:

```
VITE_GLANCE_WS_URL = wss://<your-app>.fly.dev      # hud + companion (WebSocket)
VITE_GLANCE_API_URL = https://<your-app>.fly.dev   # dashboard + companion (REST)
VITE_VAPID_PUBLIC_KEY = <VAPID public key>         # companion only — enables background Web Push
```

**Do not bake `VITE_GLANCE_TOKEN` into a production build** — it is a dev-only fallback. In production, users authenticate at runtime via signup/login: the server mints a 7-day owner session token (and 30-day per-member tokens for the dashboard Team card). The companion **must** be served over HTTPS for the service worker + Web Push to work.

## 3 · Postgres (Neon)

Create a Neon project, copy the connection string into `fly secrets set DATABASE_URL="postgres://..."`, and create the KV table:

```sql
CREATE TABLE IF NOT EXISTS glance_kv (key text PRIMARY KEY, value text NOT NULL);
```

Add the driver with `pnpm add pg`, set `DATABASE_URL`, and **every per-tenant store is read/written through Postgres** automatically: settings, session archives, OAuth tokens, teams, push devices, entitlements, accounts, and analytics all share one `glance_kv` table behind a synchronous write-through cache warmed on tenant load (`KvCache` / `KvStorage` / `KvSettingsStore`). The table is also **auto-created on boot**, so the `CREATE TABLE` above is optional. `pg` is an **optional** dependency: without `DATABASE_URL` the local file stores are used, and a missing driver falls back with a warning.

## 4 · Redis (Upstash)

Create an Upstash Redis database, then `fly secrets set REDIS_URL="rediss://..."`. With it set, three primitives go fleet-wide: the `RedisBus` (cross-instance broadcasts), the `RedisUsageMeter` (fleet-wide AI cap), and the **revocation control channel** — logout / revoke-all / member-revoke are published on the `glance:control` channel so every instance applies them instantly, even without sticky routing. `redis` is an **optional** dependency, loaded only when configured; rate limiting stays per-instance by design.

## 5 · Ops endpoints & health checks

The server exposes four operational endpoints:

| Endpoint   | Purpose                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `/health`  | Liveness — always returns `200` once the process is up.                                                |
| `/ready`   | Readiness — `503` until Postgres is reachable **and** the `glance_kv` table has auto-migrated on boot. |
| `/metrics` | Prometheus scrape (gated by `GLANCE_METRICS_TOKEN` when set).                                          |
| `/admin`   | Operator console UI (gated by `GLANCE_ADMIN_TOKEN` / `GLANCE_ADMIN_TOKENS`).                           |

Point your Fly/k8s health checks at **both** `/health` and `/ready`: liveness restarts a wedged process, readiness keeps an instance out of rotation until its datastore is up (so deploys don't route traffic to an instance that can't reach Postgres). Scrape `/metrics` for the standard counters plus the `glance_funnel_*_total` activation-funnel series.

---

## Environment variables

| Variable                                                   | Required        | Purpose                                                                                                                   |
| ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GLANCE_AUTH_SECRET`                                       | **prod**        | Signs owner-session + per-member tokens. Server refuses to boot without it in production.                                 |
| `GLANCE_TOKEN_KEY`                                         | if linking      | Encrypts stored OAuth provider tokens at rest (AES-256-GCM). Required once any provider is linked.                        |
| `ANTHROPIC_API_KEY`                                        | recommended     | Claude summaries + priority re-ranking. Falls back to the deterministic rules provider if unset.                          |
| `GLANCE_AI_MODEL`                                          | no              | Override the Claude model.                                                                                                |
| `GLANCE_SUMMARY_MS`                                        | no              | AI summary/recap cadence in ms (default `8000`).                                                                          |
| `GLANCE_WS_PORT`                                           | no              | Server port (default `8787`).                                                                                             |
| `GLANCE_PUBLIC_URL`                                        | if OAuth        | Public server base URL (OAuth redirect base).                                                                             |
| `GLANCE_DASHBOARD_URL`                                     | if billing      | Dashboard URL for Stripe success/cancel redirects.                                                                        |
| `GLANCE_ALLOWED_ORIGINS`                                   | **prod**        | Comma list of allowed browser origins (your front-end URLs).                                                              |
| `GLANCE_TRUST_PROXY`                                       | behind LB       | Set `1` only behind a trusted load balancer so `X-Forwarded-For` is trusted.                                              |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`                | per integration | Twitch EventSub chat + clip creation.                                                                                     |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`              | per integration | YouTube live-chat reading.                                                                                                |
| `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET`                    | per integration | Kick chat reading (also gate with `GLANCE_ENABLE_KICK=1`).                                                                |
| `GLANCE_ENABLE_KICK`                                       | no              | Set `1` to enable the experimental Kick adapter + viewers.                                                                |
| `GLANCE_CLIP_COOLDOWN_MS`                                  | no              | Per-tenant cooldown on "clip that" / mark (default `15000`).                                                              |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`              | if billing      | Subscriptions + plan enforcement.                                                                                         |
| `STRIPE_PRICE_CREATOR` / `STRIPE_PRICE_PRO`                | if billing      | Stripe price IDs for the Creator / Pro plans.                                                                             |
| `DATABASE_URL`                                             | multi-instance  | Managed Postgres (Neon). Durable per-tenant stores; `/ready` is 503 until it's reachable.                                 |
| `REDIS_URL`                                                | multi-instance  | Managed Redis (Upstash). Pub/sub bus, AI usage meter, revocation control channel.                                         |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | if Web Push     | Background push to the companion / wearables.                                                                             |
| `APNS_*` / `FCM_*`                                         | if native push  | Apple (iOS) / Firebase (Android) native push credentials.                                                                 |
| `GLANCE_ADMIN_TOKEN` / `GLANCE_ADMIN_TOKENS`               | if admin        | Operator auth for `/admin` + `/api/admin/*`; fail-closed when unset. `TOKENS` = `name:token` pairs for audit attribution. |
| `GLANCE_METRICS_TOKEN`                                     | recommended     | Bearer token (or `?token=`) required to scrape `/metrics` on a public deploy.                                             |
| `GLANCE_ANALYTICS_DISABLED`                                | no              | Set `1` to disable the content-free activation funnel (on by default).                                                    |

Generate a VAPID keypair for Web Push:

```bash
node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'});const pub=publicKey.export({type:'spki',format:'der'}).subarray(-65);const prv=privateKey.export({type:'pkcs8',format:'der'}).subarray(36,68);console.log('VAPID_PUBLIC_KEY=',pub.toString('base64url'));console.log('VAPID_PRIVATE_KEY=',prv.toString('base64url'))"
```

---

## Scaling: single → multi-instance

1. **Start (single instance):** keep the Fly volume; the file stores under `/app/.data` are durable across redeploys. Good for a pilot.
2. **Grow (multi-instance):** set `DATABASE_URL` (all per-tenant stores move to Postgres — drop the volume) and `REDIS_URL` (the bus, AI usage meter, and revocation control channel switch to Redis automatically), then `fly scale count 3`. Put tenant-sticky routing in front so each creator's session + sockets land on one instance (consistent-hash on the token; the shard helpers compute ownership). Autoscale on connection count.
3. **Global:** add Fly regions close to your creators; Redis + Postgres stay regional (or use read replicas).

## Cost ballpark (early)

Neon free → ~$19/mo · Upstash free → pay-per-use · Fly ~$2–5/mo per small machine · Cloudflare Pages free. **~$0–25/mo to start**, scaling with usage — versus $100–300+/mo of baseline for the AWS-enterprise equivalent.

## Wiring status

All durable + multi-instance paths are now wired (each gated on config; without it, the local/in-process fallback is used):

- **Postgres-backed stores (done).** _All_ per-tenant state — settings, session archives, OAuth tokens, teams, push devices, entitlements, accounts, and analytics — is durable in Postgres when `DATABASE_URL` + `pg` are configured, via one `glance_kv` table (auto-created on boot) behind a synchronous write-through cache (`KvCache` / `KvStorage`) warmed on tenant load. On tenant load a fresh instance eagerly warms the plan, roster, OAuth tokens, push devices, and the member-revocation list, closing the cold-start gaps (a paid tenant clamped to free limits, an empty roster overwriting a real one on invite, an authenticated reader falling back to IRC, a forgotten force-logout). Member revocations persist with a 30-day TTL so a force-logout survives an instance restart, and write-through failures are logged rather than silently dropped.
- **Multi-instance bus + AI usage meter + revocation channel (done).** When `REDIS_URL` is set, the broadcast bus, the fleet-wide AI cost meter, and the revocation control channel (`glance:control` — logout / revoke-all / member-revoke) all switch to Redis (optional `redis` driver); the per-IP rate limiter stays per-instance by design.
- **Web Push delivery (done).** `WebPushProvider` (VAPID + RFC 8291 payload encryption) + a `push` handler in the companion service worker — real background delivery to the phone companion / wearables.
- **Native push (done).** APNs (HTTP/2 + ES256) and FCM v1 (service-account) behind the same `PushProvider` seam, config-gated on `APNS_*` / `FCM_*`, composed by a `RoutingPushProvider`.
- **Remaining (deploy config, not code):** tenant-sticky routing at the load balancer so each creator's session + sockets land on one instance (the shard helpers in `apps/server/src/sharding.ts` compute ownership).

### Known limits (documented; safe under tenant-sticky routing)

- **Revocation across _non-sticky_ instances (handled).** Revocations persist to Postgres and re-hydrate on tenant load, so they survive restarts/migration; with `REDIS_URL` set they also publish on the `glance:control` channel, so every instance revokes instantly even under a non-sticky LB. Single-instance, it's a harmless no-op.
- **Idle-tenant eviction (handled).** The Hub evicts idle, disconnected, non-default tenants on a timer; they lazily re-hydrate from the durable store on next touch, so one instance fanning in many tenants no longer grows unbounded.
- **Push SSRF is literal-IP only.** `isSafePushEndpoint` blocks private/loopback/metadata literals; a hostname that _resolves_ to a private IP isn't blocked — use an egress allowlist/proxy in production for the webhook/webpush sender.
- **Per-tenant session cap.** Resident (and persisted) archives are capped at 1000/tenant (`MAX_RESIDENT_SESSIONS`) on top of age-based retention — far above any real tenant; raise it if needed.
