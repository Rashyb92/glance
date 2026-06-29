# Integrations: HTTP/REST surface, auth, OAuth & billing

This is the integration guide for external clients: the **auth model**, the full
**HTTP/REST endpoint map**, and the OAuth + billing flows. The auth, OAuth and billing
**pipelines are built, unit-tested, and mounted on the gateway**
(`apps/server/src/integrations/`, delegated from `gateway.ts` via
`handleIntegrationRoutes`). Every credentialed route **fails soft** with a clear error
until its keys are configured, so the platform runs today and goes live the moment you
add credentials.

Nothing here adds an npm dependency: token exchange and Stripe calls use the native
`fetch`; all crypto uses `node:crypto`. Official SDKs can be swapped in later behind
the same module surfaces.

---

## 0. Auth model & token surface

Glance authenticates with **HMAC-signed tokens** — no baked-in API keys. There are two
token kinds:

- **Owner SESSION tokens** (7-day; carry a per-login `sessionId` + issued-at) are minted
  by `POST /api/auth/signup`, `/login`, and `/refresh`.
- **Team MEMBER tokens** (30-day; carry a `role` of `admin` or `member`) are minted by
  `POST /api/team/:id/login`.

Both ride in `Authorization: Bearer <token>` on REST calls. Browser **WebSocket** clients
can't set that header, so they fetch a short-lived ticket from
`POST /api/auth/ws-ticket` (valid ~30s) and pass it as `?token=<ticket>` in the WS URL —
the long-lived token never appears in a WS URL or proxy log.

**Revocation** is first-class: `logout` kills one session, `revoke-all` kills every
session for the account (the stolen-token kill switch), and member removal or force-logout
invalidates a member token. With `REDIS_URL` set, revocations propagate across every
instance instantly.

`GLANCE_AUTH_SECRET` is **required in production** (the server refuses to boot without it
outside local `NODE_ENV`). `VITE_GLANCE_TOKEN` is a **dev-only** fallback — never bake a
token into a production build; users authenticate at runtime via signup/login.

---

## 1. Endpoint map

All routes are served on `GLANCE_WS_PORT` (default `8787`). Data-plane routes are
tenant-scoped and require a Bearer token; admin routes live in a **separate trust domain**
gated by the operator token(s). Endpoints that need third-party keys fail soft until
configured.

### Ops (unauthenticated infra)

| Method · Path  | Purpose                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| `GET /health`  | Liveness — `{"ok":true}` once the process is up.                                       |
| `GET /ready`   | Readiness — `503` until Postgres is reachable and `glance_kv` auto-migrated.           |
| `GET /metrics` | Prometheus exposition; gated by `GLANCE_METRICS_TOKEN` (bearer or `?token=`) when set. |
| `GET /admin`   | Operator console UI (gated by the admin token — see §4).                               |

### Auth (self-serve; mint runtime tokens — no baked tokens)

| Method · Path                  | Purpose                                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| `POST /api/auth/signup`        | Create an account + owner session token.                                  |
| `POST /api/auth/login`         | Exchange credentials → owner session token.                               |
| `POST /api/auth/refresh`       | Roll a fresh 7-day session token.                                         |
| `POST /api/auth/logout`        | Revoke the current session.                                               |
| `POST /api/auth/revoke-all`    | Sign out everywhere — revoke all of the account's sessions.               |
| `POST /api/auth/ws-ticket`     | Mint a ~30s ticket so the long-lived token never rides in a WS URL.       |
| `POST /api/auth/pair`          | Issue a single-use device-pairing code.                                   |
| `POST /api/auth/pair/exchange` | Exchange a pairing code → device session token.                           |
| `DELETE /api/auth/account`     | **DSAR** — re-auth with password, then wipe everything + revoke sessions. |

### OAuth (providers: `twitch`, `youtube`, `kick`)

| Method · Path                       | Purpose                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| `GET /api/oauth/:provider/start`    | Build authorize URL; persist `{state→verifier, tenant}`; 302. |
| `GET /api/oauth/:provider/callback` | Verify state; exchange code; save encrypted tokens; 302 back. |

### Billing (Stripe)

| Method · Path                | Purpose                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `POST /api/billing/checkout` | Create a Checkout Session → `{ url }`.                                    |
| `POST /api/billing/portal`   | Open the Customer Portal for the tenant's customer.                       |
| `POST /api/stripe/webhook`   | Signature-verified, **idempotent** (event-id dedupe + out-of-order drop). |

### Data plane (tenant-scoped; Bearer token required)

| Method · Path                   | Purpose                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `GET/POST/DELETE /api/session`  | Read / start-update / end the active session.                                 |
| `GET/POST /api/settings`        | Read / update engine settings (plan-clamped on load and write).               |
| `POST /api/mark`                | Clip the moment ("clip that"); per-tenant cooldown `GLANCE_CLIP_COOLDOWN_MS`. |
| `GET /api/export`               | Export the tenant's data.                                                     |
| `GET /api/analytics`            | Per-tenant cross-session analytics (plan-gated — `advancedAnalytics`).        |
| `GET/POST /api/team`            | List / invite team members (enforces the plan's `seats`).                     |
| `POST /api/team/:id/login`      | Mint a 30-day member token for a team member.                                 |
| `POST /api/team/:id/revoke`     | Revoke a member's sessions.                                                   |
| `DELETE /api/team/:id`          | Remove a team member.                                                         |
| `GET /api/push`                 | List push subscriptions.                                                      |
| `POST /api/push/subscribe`      | Register a Web Push subscription.                                             |
| `DELETE /api/push/:id`          | Remove a push subscription.                                                   |
| `GET /api/sessions`             | List recorded sessions (Replay).                                              |
| `GET/DELETE /api/sessions/:id`  | Fetch / delete one recorded session.                                          |
| `DELETE /api/sessions?all=1`    | Erase all recorded history.                                                   |
| `DELETE /api/sessions?channel=` | Erase recorded history for one channel.                                       |
| `DELETE /api/author/:id`        | **DSAR** — scrub a chatter's attributed content.                              |

The admin (operator) API is documented separately in §4.

---

## 2. Streaming OAuth (Twitch / YouTube / Kick)

### What's built

| File                                | Responsibility                                           |
| ----------------------------------- | -------------------------------------------------------- |
| `integrations/oauth-providers.ts`   | Endpoints + scopes per provider (Twitch, YouTube, Kick)  |
| `integrations/oauth-crypto.ts`      | AES-256-GCM token sealing + PKCE (S256)                  |
| `integrations/oauth-service.ts`     | `buildAuthorize` / `exchangeCode` / `refresh`            |
| `integrations/oauth-token-store.ts` | Per-(tenant, provider) **encrypted-at-rest** token store |

### Environment

```
GLANCE_TOKEN_KEY=<random 32+ char secret>     # seals provider tokens at rest (required)
TWITCH_CLIENT_ID=...      TWITCH_CLIENT_SECRET=...
YOUTUBE_CLIENT_ID=...     YOUTUBE_CLIENT_SECRET=...
KICK_CLIENT_ID=...        KICK_CLIENT_SECRET=...
GLANCE_PUBLIC_URL=https://app.glance.gg        # base for OAuth redirect URIs
```

### Routes (live, in `gateway.ts`, tenant-scoped block)

```
GET  /api/oauth/:provider/start      -> svc.buildAuthorize(provider, state); persist {state->verifier,tenant}; 302 to url
GET  /api/oauth/:provider/callback   -> verify state; svc.exchangeCode(provider, code, verifier); tokenStore.save(tenant, provider, tokens); 302 back to dashboard
```

Constructed once in `main.ts`: `new OAuthService(`${GLANCE_PUBLIC_URL}`)` and
`new TokenStore(resolve(repoRoot,'.data','tokens'))`. Keep the `state→verifier`
map short-lived (in-proc Map or the Bus for multi-instance).

### Chat ingestion per provider (the live read path)

- **Twitch** — `user:read:chat` scope, then EventSub WebSocket subscription
  `channel.chat.message`. **Built**: `TwitchEventSubAdapter` in `@glance/platforms`.
  The server (`Hub.twitchLink`) auto-selects it for any tenant that has a stored token
  (refreshing near expiry); tenants without a token transparently use the IRC reader.
  Set `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` and complete the OAuth flow to activate.
- **YouTube** — `youtube.readonly`; resolve the active `liveChatId` from the
  broadcast, then poll `liveChatMessages.list` (honor `pollingIntervalMillis`) or use
  the streaming variant. New `YouTubeAdapter implements PlatformAdapter`.
- **Kick** — OAuth 2.1 + PKCE (handled); subscribe to chat events via the official
  API/webhooks. New `KickAdapter implements PlatformAdapter`.

Because every provider lands behind the existing `PlatformAdapter` interface, the
salience engine, recorder, stats and routing all work unchanged — this is the payoff
of the adapter seam.

---

## 3. Subscriptions & billing (Stripe)

### What's built

| File                                | Responsibility                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `@glance/core` `plans.ts`           | Plan/entitlement model + `applyPlanLimits` (tenant can't exceed its tier)         |
| `integrations/billing.ts`           | Checkout Session + Customer Portal via Stripe REST (pinned API version)           |
| `integrations/stripe-webhook.ts`    | **Signature verification** (constant-time, replay-protected) + event→plan mapping |
| `integrations/entitlement-store.ts` | Per-tenant plan record (webhook-first provisioning)                               |

### Plans

Tiers map to the blueprint as Free → Free, Creator → "Pro", Pro → "Elite". The
primary lever is **AI calls/day** (metered Claude usage: summaries + priority
re-ranking + recaps); the top tier adds the Elite features.

| Plan    | $/mo | AI calls/day | Retention | AI priorities | Audio | Multi-platform | Mod. actions | Adv. analytics | Branded | Teams | Seats |
| ------- | ---: | -----------: | --------- | :-----------: | :---: | :------------: | :----------: | :------------: | :-----: | :---: | :---: |
| Free    |    0 |          500 | 7 days    |       –       |   –   |       –        |      –       |       –        |    –    |   –   |   1   |
| Creator |   18 |       10,000 | 90 days   |       ✓       |   ✓   |       ✓        |      –       |       –        |    –    |   –   |   1   |
| Pro     |   49 |      200,000 | 365 days  |       ✓       |   ✓   |       ✓        |      ✓       |       ✓        |    ✓    |   ✓   |   5   |

The Elite feature _flags_ (`moderationActions`, `advancedAnalytics`, `brandedOverlays`,
`teamManagement`) are defined and gated now; the features themselves are roadmap
milestones. "Priority support" is operational, not code.

### Environment

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_CREATOR=price_...
STRIPE_PRICE_PRO=price_...
```

### Routes (live)

```
POST /api/billing/checkout   -> billing.createCheckoutSession(tenant, plan); return { url }
POST /api/billing/portal     -> billing.createPortalSession(entitlements.customerId(tenant), returnUrl)
POST /api/stripe/webhook     -> verifyStripeSignature(rawBody, sig, WEBHOOK_SECRET) MUST pass;
                                then planChangeFromEvent(event) -> entitlements.setPlan(tenant, plan)
```

**The webhook needs the raw body** (not the JSON-parsed object) for signature
verification — read the raw bytes before `JSON.parse`. It is **idempotent**: events are
de-duped by event-id and out-of-order deliveries are dropped, so retries are safe. Listen
to `invoice.paid` as the primary provisioning event, plus `customer.subscription.*`.

### Enforcing entitlements

The Hub clamps settings with `applyPlanLimits` on load and on every update, so clients
only ever see plan-clamped effective settings. AI usage is metered per tenant against
`aiCallsPerDay` (the `AiUsageMeter`); once the daily budget is spent, summaries/priority
re-ranking/recaps are skipped until the next UTC day and the pipeline falls back to its
deterministic output. A downgraded tenant keeps working — gated features simply switch off.

Wire real plans by passing `entitlements: new EntitlementStore(...)` into the Hub. Without
it (self-host / dev), the Hub defaults every tenant to **Pro** (ungated). Unit-tested in
`packages/core/test/plans.test.ts` and `apps/server/test/ai-usage.test.ts`.

---

## 4. Admin API (operator-gated — separate trust domain)

The operator console and its API are a **separate trust domain** from tenant auth: they
authenticate with `GLANCE_ADMIN_TOKEN` or, for per-operator attribution, the
comma-separated `name:token` pairs in `GLANCE_ADMIN_TOKENS`. With neither set the admin
API is **disabled (fail closed)**. Operator actions are written to a durable, capped audit
log. Tenant snapshots are deliberately **content-free** — operators see shape and counts,
never chat content.

| Method · Path                                   | Purpose                                                    |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `GET /api/admin/tenant/:id`                     | Read-only, content-free snapshot of a tenant.              |
| `POST /api/admin/tenant/:id/logout`             | Force-revoke all of a tenant's sessions.                   |
| `POST /api/admin/tenant/:id/member/:mid/revoke` | Revoke one team member's sessions.                         |
| `DELETE /api/admin/tenant/:id`                  | Erase a tenant's data — requires `confirm === id` in body. |
| `POST /api/admin/account/delete`                | GDPR delete by email — body `{ email, confirm }`.          |
| `GET /api/admin/audit`                          | Recent operator actions (the audit log).                   |
| `GET /api/admin/analytics`                      | Funnel report (signup → activated → engaged → subscribed). |

---

## 5. Plan-gated platform features (shipped)

These are built now and gated by plan entitlements in the Hub (Free/Creator → 403; Pro →
feature). All are unit-tested.

| Feature                 | Surface                       | Entitlement         |
| ----------------------- | ----------------------------- | ------------------- |
| Cross-session analytics | `GET /api/analytics`          | `advancedAnalytics` |
| Team management         | `GET/POST/DELETE /api/team`   | `teamManagement`    |
| Branded overlays        | `branding` in engine settings | `brandedOverlays`   |
| AI usage                | metered per tenant            | `aiCallsPerDay`     |

Team invites enforce the plan's `seats` limit and validate email/role. Branding is
sanitized (https-only logo, hex color) before it reaches the overlay. AI calls
(summaries, priority re-ranking, recaps) are metered by the `AiUsageMeter`; over the
daily cap the pipeline falls back to deterministic output. Per-member login (mapping a
team member to a signed 30-day token) ships via `POST /api/team/:id/login`.

## 6. Test plan (when credentials are in)

1. `pnpm verify` — unit tests for all of the above are already green.
2. Twitch: run the `/start`→`/callback` round-trip against a test app; confirm an
   encrypted token file appears under `.data/tokens/`.
3. Stripe: `stripe listen --forward-to localhost:8787/api/stripe/webhook`, run a test
   checkout, confirm the tenant's plan flips in `.data/entitlements/`.
4. Negative test: tamper a webhook body → verify it's rejected (already unit-tested).
