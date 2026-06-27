# Deploying Glance

Glance has four deployable pieces:

| Piece | What it is | Where it runs |
| --- | --- | --- |
| **Server** (`apps/server`) | Stateful WebSocket + REST gateway and the Hub. Holds live sessions in memory and long-lived socket connections. | Long-running containers (not serverless). |
| **Front-ends** (`apps/hud`, `apps/dashboard`, `apps/companion`) | Static React/Vite SPAs. | Static host / CDN over HTTPS. |
| **Postgres** | Durable shared state (settings, tokens, teams, entitlements, sessions, push devices). | Managed Postgres. |
| **Redis** | Cross-instance pub/sub bus, rate limiter and AI usage meter (the scale primitives in `apps/server/src/redis.ts`). | Managed Redis. |

The **server is stateful**, which drives everything: scale it horizontally with multiple long-running instances and **tenant-sticky routing** (a creator's session + sockets must stay on one instance — that is what the sharding helpers in `apps/server/src/sharding.ts` are for). Redis bridges broadcasts and limits across instances; Postgres is the source of truth each instance hydrates from.

## Recommended stack (managed-simple)

Cheapest to start, fastest to ship, and the same codebase scales to the 20k-creator target with no rewrite — everything is env-driven behind clean seams.

| Concern | Service | Notes |
| --- | --- | --- |
| Server | **Fly.io** | First-class WebSockets, global regions, per-second billing. |
| Postgres | **Neon** | Serverless, scale-to-zero free tier; `DATABASE_URL`. |
| Redis | **Upstash** | Serverless, pay-per-use free tier; `REDIS_URL`. |
| Static apps | **Cloudflare Pages** | Free, global, HTTPS (required for the companion PWA + push). |
| Secrets | Fly secrets / Doppler | Never commit secrets. |
| Metrics | Grafana Cloud / Datadog | Scrape `/metrics`; probe `/health`, `/ready`. |

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
  TWITCH_CLIENT_ID="..."  TWITCH_CLIENT_SECRET="..." \
  STRIPE_SECRET_KEY="sk_live_..."  STRIPE_WEBHOOK_SECRET="whsec_..."

fly deploy
```

`GLANCE_AUTH_SECRET` is **required in production** — the server refuses to boot without it (otherwise every client collapses onto the `default` tenant). `GLANCE_TOKEN_KEY` encrypts stored OAuth tokens at rest.

Point your OAuth app redirect URIs at `https://<your-app>.fly.dev/api/oauth/<provider>/callback`, and the Stripe webhook at `https://<your-app>.fly.dev/api/stripe/webhook`.

## 2 · Front-ends on Cloudflare Pages

Each app is a separate Pages project. Build command `pnpm install && pnpm --filter @glance/<app> build`, output `apps/<app>/dist`. Set per-project build env so the SPA talks to the server:

```
VITE_GLANCE_WS_URL = wss://<your-app>.fly.dev      # hud + companion (WebSocket)
VITE_GLANCE_API_URL = https://<your-app>.fly.dev   # dashboard + companion (REST)
VITE_GLANCE_TOKEN = <a signed tenant token>        # selects the tenant in prod
VITE_VAPID_PUBLIC_KEY = <VAPID public key>         # companion only — enables background Web Push
```

Mint a tenant token with `signToken(tenant, GLANCE_AUTH_SECRET)` (see `apps/server/src/auth.ts`); team members use their own per-member tokens from the dashboard Team card. The companion **must** be served over HTTPS for the service worker + Web Push to work.

## 3 · Postgres (Neon)

Create a Neon project, copy the connection string into `fly secrets set DATABASE_URL="postgres://..."`, and create the KV table:

```sql
CREATE TABLE IF NOT EXISTS glance_kv (key text PRIMARY KEY, value text NOT NULL);
```

`PgKvStore` (`apps/server/src/kv.ts`) already targets this table. Wiring the per-tenant stores onto it is the one remaining code change (see **What's left to wire**).

## 4 · Redis (Upstash)

Create an Upstash Redis database, then `fly secrets set REDIS_URL="rediss://..."`. The `RedisBus`, `RedisRateLimiter` and `RedisUsageMeter` adapters target it; swapping the in-process bus for `RedisBus` in `main.ts` is what lets broadcasts and limits span multiple instances.

---

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `GLANCE_AUTH_SECRET` | **prod** | Signs tenant + per-member tokens. Server refuses to boot without it in production. |
| `GLANCE_TOKEN_KEY` | if linking | Encrypts stored OAuth tokens at rest. |
| `ANTHROPIC_API_KEY` | recommended | Claude summaries + priority re-ranking. Falls back to the deterministic rules provider if unset. |
| `GLANCE_AI_MODEL` | no | Override the Claude model. |
| `GLANCE_WS_PORT` | no | Server port (default `8787`). |
| `GLANCE_PUBLIC_URL` | if OAuth | Public server base URL (OAuth redirect base). |
| `GLANCE_DASHBOARD_URL` | if billing | Dashboard URL for Stripe success/cancel redirects. |
| `GLANCE_ALLOWED_ORIGINS` | **prod** | Comma list of allowed browser origins (your front-end URLs). |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | per integration | Twitch EventSub chat + clip creation. |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` | per integration | YouTube live-chat reading. |
| `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` | per integration | Kick chat reading. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | if billing | Subscriptions + plan enforcement. |
| `DATABASE_URL` | multi-instance | Managed Postgres (Neon). |
| `REDIS_URL` | multi-instance | Managed Redis (Upstash). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | if Web Push | Background push to the companion / wearables. |

Generate a VAPID keypair for Web Push:

```bash
node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'});const pub=publicKey.export({type:'spki',format:'der'}).subarray(-65);const prv=privateKey.export({type:'pkcs8',format:'der'}).subarray(36,68);console.log('VAPID_PUBLIC_KEY=',pub.toString('base64url'));console.log('VAPID_PRIVATE_KEY=',prv.toString('base64url'))"
```

---

## Scaling: single → multi-instance

1. **Start (single instance):** keep the Fly volume; the file stores under `/app/.data` are durable across redeploys. Good for a pilot.
2. **Grow (multi-instance):** point the per-tenant stores at Postgres (drop the volume), set `REDIS_URL` and swap the in-process bus for `RedisBus`, then `fly scale count 3`. Put tenant-sticky routing in front so each creator's session + sockets land on one instance (consistent-hash on the token; the shard helpers compute ownership). Autoscale on connection count.
3. **Global:** add Fly regions close to your creators; Redis + Postgres stay regional (or use read replicas).

## Cost ballpark (early)

Neon free → ~$19/mo · Upstash free → pay-per-use · Fly ~$2–5/mo per small machine · Cloudflare Pages free. **~$0–25/mo to start**, scaling with usage — versus $100–300+/mo of baseline for the AWS-enterprise equivalent.

## What's left to wire

- **Async Postgres stores.** The session/settings stores are synchronous (file-backed); backing them with async Postgres needs an async refactor of the store interfaces + the Hub. `PgKvStore` and the SQL client already exist — this is the switch that flips file → Postgres for true horizontal durability.
- **Web Push delivery.** The `PushProvider` seam + device registry are in place; a `WebPushProvider` (VAPID + RFC 8291 payload encryption) plus a `push` handler in the companion service worker turns the documented push path into real background delivery.
- **Native push (later).** APNs/FCM for a native iOS/Android shell, behind the same `PushProvider` seam.
