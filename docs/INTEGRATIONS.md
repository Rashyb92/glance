# Integrations: OAuth & Billing — ready to link

The OAuth and billing **pipelines are built and unit-tested** as self-contained
modules under `apps/server/src/integrations/`. They are intentionally **not yet
mounted** on the HTTP gateway — mounting + live testing needs real credentials and
is the step we do together (you said: "when I'm back we will run the relevant
tests"). This guide is everything needed to go live.

Nothing here adds an npm dependency: token exchange and Stripe calls use the native
`fetch`; all crypto uses `node:crypto`. Official SDKs can be swapped in later behind
the same module surfaces.

---

## 1. Streaming OAuth (Twitch / YouTube / Kick)

### What's built
| File | Responsibility |
|------|----------------|
| `integrations/oauth-providers.ts` | Endpoints + scopes per provider (Twitch, YouTube, Kick) |
| `integrations/oauth-crypto.ts` | AES-256-GCM token sealing + PKCE (S256) |
| `integrations/oauth-service.ts` | `buildAuthorize` / `exchangeCode` / `refresh` |
| `integrations/oauth-token-store.ts` | Per-(tenant, provider) **encrypted-at-rest** token store |

### Environment
```
GLANCE_TOKEN_KEY=<random 32+ char secret>     # seals provider tokens at rest (required)
TWITCH_CLIENT_ID=...      TWITCH_CLIENT_SECRET=...
YOUTUBE_CLIENT_ID=...     YOUTUBE_CLIENT_SECRET=...
KICK_CLIENT_ID=...        KICK_CLIENT_SECRET=...
GLANCE_PUBLIC_URL=https://app.glance.gg        # base for OAuth redirect URIs
```

### Routes to mount (in `gateway.ts`, tenant-scoped block)
```
GET  /api/oauth/:provider/start      -> svc.buildAuthorize(provider, state); persist {state->verifier,tenant}; 302 to url
GET  /api/oauth/:provider/callback   -> verify state; svc.exchangeCode(provider, code, verifier); tokenStore.save(tenant, provider, tokens); 302 back to dashboard
```
Construct once in `main.ts`: `new OAuthService(`${GLANCE_PUBLIC_URL}`)` and
`new TokenStore(resolve(repoRoot,'.data','tokens'))`. Keep the `state→verifier`
map short-lived (in-proc Map or the Bus for multi-instance).

### Chat ingestion per provider (the live read path)
- **Twitch** — `user:read:chat` scope, then EventSub WebSocket subscription
  `channel.chat.message`. This replaces anonymous IRC (already implemented in
  `@glance/platforms` as `TwitchAdapter`); add a `TwitchEventSubAdapter` that uses
  the stored user token. Same `PlatformAdapter` seam, so the engine is unchanged.
- **YouTube** — `youtube.readonly`; resolve the active `liveChatId` from the
  broadcast, then poll `liveChatMessages.list` (honor `pollingIntervalMillis`) or use
  the streaming variant. New `YouTubeAdapter implements PlatformAdapter`.
- **Kick** — OAuth 2.1 + PKCE (handled); subscribe to chat events via the official
  API/webhooks. New `KickAdapter implements PlatformAdapter`.

Because every provider lands behind the existing `PlatformAdapter` interface, the
salience engine, recorder, stats and routing all work unchanged — this is the payoff
of the adapter seam.

---

## 2. Subscriptions & billing (Stripe)

### What's built
| File | Responsibility |
|------|----------------|
| `@glance/core` `plans.ts` | Plan/entitlement model + `applyPlanLimits` (tenant can't exceed its tier) |
| `integrations/billing.ts` | Checkout Session + Customer Portal via Stripe REST (pinned API version) |
| `integrations/stripe-webhook.ts` | **Signature verification** (constant-time, replay-protected) + event→plan mapping |
| `integrations/entitlement-store.ts` | Per-tenant plan record (webhook-first provisioning) |

### Plans
| Plan | $/mo | Retention cap | AI priorities | Audio routing | Multi-platform | Seats |
|------|-----:|---------------|:-------------:|:-------------:|:--------------:|:-----:|
| Free | 0 | 7 days | – | – | – | 1 |
| Creator | 12 | 90 days | ✓ | ✓ | – | 1 |
| Pro | 39 | 365 days | ✓ | ✓ | ✓ | 5 |

### Environment
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_CREATOR=price_...
STRIPE_PRICE_PRO=price_...
```

### Routes to mount
```
POST /api/billing/checkout   -> billing.createCheckoutSession(tenant, plan); return { url }
POST /api/billing/portal     -> billing.createPortalSession(entitlements.customerId(tenant), returnUrl)
POST /api/stripe/webhook     -> verifyStripeSignature(rawBody, sig, WEBHOOK_SECRET) MUST pass;
                                then planChangeFromEvent(event) -> entitlements.setPlan(tenant, plan)
```
**The webhook needs the raw body** (not the JSON-parsed object) for signature
verification — read the raw bytes before `JSON.parse`. Listen to `invoice.paid` as
the primary provisioning event, plus `customer.subscription.*`.

### Enforcing entitlements
In the Hub, resolve the tenant's plan from `EntitlementStore` and pass settings
through `applyPlanLimits(settings, plan)` on load and on every settings update.
A downgraded tenant keeps working — gated features simply switch off; retention is
capped. (Unit-tested in `packages/core/test/plans.test.ts`.)

---

## 3. Test plan (when credentials are in)
1. `pnpm verify` — unit tests for all of the above are already green.
2. Twitch: run the `/start`→`/callback` round-trip against a test app; confirm an
   encrypted token file appears under `.data/tokens/`.
3. Stripe: `stripe listen --forward-to localhost:8787/api/stripe/webhook`, run a test
   checkout, confirm the tenant's plan flips in `.data/entitlements/`.
4. Negative test: tamper a webhook body → verify it's rejected (already unit-tested).
