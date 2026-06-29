# Glance — Architecture

This document explains how Glance is put together and, more importantly, **how it
is built to absorb the future** — new platforms, new AI models, and real glasses —
without rewrites. That future-readiness is a deliberate design goal, not an
accident.

## Principles

1. **The engine is pure and deterministic.** `@glance/core` has zero dependencies,
   makes no network calls, and is fully unit-tested. It is the floor of quality and
   the defensible asset. Everything else is replaceable plumbing.
2. **AI augments, never gates.** The product works with no API key. Claude makes it
   smarter; it is never a hard dependency. Every AI path degrades gracefully.
3. **Hardware-agnostic.** The overlay is a stream of `HudItem`s over a transport.
   A browser renders it today; a Meta Ray-Ban Display web app or a Brilliant Labs
   companion renders it tomorrow — from the same feed.
4. **One language, clear seams.** TypeScript end to end, with three explicit
   interfaces (below) that are the only places new technology plugs in.

## Data flow

```
PlatformAdapter ──onMessage──▶ GlanceEngine ──score()──▶ HudItem ──▶ Gateway ──ws──▶ RenderTarget
       │           onEvent            │                                              (browser HUD)
   Twitch / Demo                      └──summarize()──▶ AIProvider (Claude · rules)
   Kick / YouTube                                         every N seconds
   (future)
```

A message is scored the instant it arrives (trend-aware, via a sliding window).
On a timer, the recent window is summarised by the AI provider. Both scored
messages and summaries are emitted as `HudItem`s and broadcast to every connected
render target.

## The three seams

### 1. `PlatformAdapter` — where chat comes from

`packages/platforms/src/adapter.ts`

```ts
interface PlatformAdapter {
  readonly platform: Platform;
  readonly channel: string;
  start(handlers: AdapterHandlers): void | Promise<void>;
  stop(): void | Promise<void>;
}
```

Every source normalises to `ChatMessage` / `ChannelEvent`. The engine never knows
or cares where a message originated.

- **Today:** Twitch (anonymous IRC-over-WebSocket _and_ EventSub for linked
  creators), YouTube and Kick adapters, plus `DemoAdapter` — every source behind the
  one interface.
- **Add another source:** create e.g. `tiktok.ts` implementing the same interface,
  emit normalised messages, and register it in the Hub's adapter wiring. Nothing else
  changes. `DemoAdapter` is the reference template.
- **Scale note:** the Twitch reader already swaps IRC for EventSub
  (`channel.chat.message`) behind this interface once a creator links their account —
  the rest of the system is untouched.

### 2. `AIProvider` — the brain

`packages/ai/src/provider.ts`

```ts
interface AIProvider {
  readonly name: string;
  summarize(input: SummarizeInput): Promise<ChatSummary>;
}
```

- **Today:** `AnthropicProvider` (Claude) with a `RulesProvider` fallback baked in,
  selected by `createAIProvider()` based on whether `ANTHROPIC_API_KEY` is present.
- **Add OpenAI / a local model / a fine-tuned salience model:** implement
  `AIProvider` and return it from the factory. The engine calls `summarize()` and
  never branches on which provider it got.
- **Where the moat grows:** the deterministic engine now also reads **sentiment**
  and **toxicity** (pure, tested), and the `AIProvider` exposes **`prioritize()`** —
  Claude re-ranks recent candidates into the few things to act on right now, with
  a rule-based fallback. A learned salience model slots in behind the same
  interface next.

### 3. `RenderTarget` — where it's shown

Transport: `apps/server/src/gateway.ts` → the browser HUD (`apps/hud`).

The server emits a typed `HudItem` stream; the HUD is a pure consumer of it. The
feed logic (`apps/hud/src/useGlanceFeed.ts`) is deliberately separated from
presentation (`App.tsx`), so a different render target reuses the feed and only
re-skins the output.

- **Today:** a browser peripheral overlay (also the dev/demo surface).
- **Meta Ray-Ban Display:** Meta's display apps are HTML/CSS/JS — the HUD ports
  directly, consuming the same `HudItem` stream.
- **Brilliant Labs / Even Realities:** a thin companion subscribes to the same
  gateway and draws text via the device SDK. The contract (`HudItem`) is identical.

## Settings & persistence

Two independent layers, split by ownership:

- **Engine settings** (`@glance/core` `EngineSettings`) — server-owned: surface
  threshold, keywords, AI frequency. All external input passes through
  `normalizeEngineSettings`, the single validation boundary, so the rest of the
  system can trust the value is well-formed and in-bounds. Persisted behind a
  `SettingsStore` interface — `FileSettingsStore` writes atomically (temp-then-
  rename) for local/self-host; `KvSettingsStore` persists to Postgres at multi-tenant
  scale, the swap proving out the seam without touching callers — and broadcast to
  every client as a `settings` message.
- **Overlay settings** (HUD `OverlaySettings`) — device-local: placement, scale,
  opacity, density, motion. Persisted in `localStorage`, never sent to the server.

This mirrors the product split: the server owns _what matters_; each device owns
_how it looks_.

**Session archives** follow the same pattern. A finished stream is captured by the
pure `SessionRecorder` (in `@glance/core`, unit-tested) — best moments, timeline,
counts — and persisted behind a `Storage` interface. `FileStorage` writes one
atomic JSON document per session for local/self-host; `KvStorage` keeps every tenant's
archives in the shared Postgres KV table at scale, neither touching callers. Replays
are served over REST (`/api/sessions`), not the live socket.

## Package responsibilities

| Package             | Owns                                                                                                                               | Depends on            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `@glance/core`      | Types, salience scoring, trend detection, mode policy, sentiment/toxicity, plans                                                   | nothing               |
| `@glance/platforms` | `PlatformAdapter`, Twitch (IRC + EventSub), YouTube, Kick, Demo adapters                                                           | `core`, `ws`          |
| `@glance/ai`        | `AIProvider`, Claude provider, rule-based provider, factory                                                                        | `core`, Anthropic SDK |
| `@glance/server`    | Engine pipeline, WS/REST gateway, multi-tenant Hub, accounts/auth + revocation, OAuth, Stripe, push, admin console, durable stores | all three packages    |
| `@glance/hud`       | The peripheral overlay; consumes the feed (types only from `core`)                                                                 | `core` (types), React |

Note the HUD depends on `@glance/core` for **types only** — it carries no runtime
coupling to the engine, which keeps the render layer truly swappable.

## How a scored message is built

`@glance/core` `scoreMessage()` combines independent signals — money (bits),
direct address, keywords, questions, trend repetition, role, emotional charge
(sentiment), a moderation flag (toxicity), and a noise penalty — with a soft-OR
aggregation that saturates at 1.0. It returns the score, the
dominant category, and the **reasons** each signal fired (for explainability in a
future dashboard). It is deterministic, so it is trivially testable: see
`packages/core/test/salience.test.ts`.

## Mapping to the product roadmap

| Blueprint phase            | In this codebase                                                          |
| -------------------------- | ------------------------------------------------------------------------- |
| Phase 1 — Creator overlays | The whole core loop here: Twitch + Hybrid mode + peripheral HUD           |
| Phase 2 — AI copilot       | `AIProvider` seam → swap rules for a learned salience model               |
| Phase 4 — Creator OS       | `RenderTarget` seam → ship the HUD as a Meta Web App when the store opens |

## Multi-tenant, auth & revocation

The single-channel demo became a multi-tenant service without disturbing the seams.
The **`Hub`** owns every tenant; each gets its own isolated pipeline (controller +
settings + storage), and broadcasts are published to a `Bus` keyed by tenant. The
in-memory tenant map can't grow without bound — `sweepIdleTenants` evicts idle,
disconnected, non-`default` tenants on a timer, and an evicted tenant lazily
re-hydrates from the durable store on next access.

**Auth** is HMAC-signed tokens, resolved at the edge (`auth.ts`). A 7-day owner
**session** token carries a per-login `sessionId` + issued-at; 30-day **member**
tokens carry a role. `GLANCE_AUTH_SECRET` is required in production — the server
refuses to boot when `NODE_ENV` is set without it, because absent a secret every
client resolves to the shared `default` tenant. (Dev keeps that fallback on purpose.)

Stateless tokens can't be recalled, so a **`SessionStore`** adds the kill switch: a
per-session logout list plus a per-tenant "revoke-all" epoch (sign-out-everywhere /
stolen-token). It's KV-persisted and re-hydrated on tenant load so revocations
survive restarts, and the gateway enforces it (`sessionActive`) on both WebSocket
connect and REST. Member tokens are revoked by removing the member from the roster or
an explicit force-logout (a `MemberDenylist`, likewise persisted). On a non-sticky
fleet a single instance's revocation would otherwise be invisible to the others, so
when `REDIS_URL` is set every logout / revoke-all / member-revoke is published on a
control channel (`glance:control`) and each instance applies it instantly
(`Hub.applyRemoteControl`) — idempotent, and a no-op single-instance.

Two seams keep the long-lived token out of harm's way. Clients exchange the token for
a short-lived (30s) **WS ticket** (`POST /api/auth/ws-ticket`) so it never appears in
a WebSocket URL, and a device **pairs** from a single-use code
(`?pair=<code>` → `POST /api/auth/pair/exchange`) that mints the device its own
session token.

## Privacy & data-subject rights

Archiving is private by default: `storeMessageText=false` and `retentionDays=7`, so a
deployment that does nothing still keeps no raw text and ages data out within a week.
The data-subject controls are first-class routes against the same `Storage` seam:
scrub one chatter's attributed content by author id (`DELETE /api/author/:id`), erase
a tenant's whole replay history (`DELETE /api/sessions?all=1`), and full account
deletion (`DELETE /api/auth/account`) — which re-authenticates with a password, then
wipes archives, roster, push devices, OAuth tokens, plan and the account record, and
revokes the tenant's sessions. (Kick remains experimental, gated behind
`GLANCE_ENABLE_KICK=1`.)

## Admin / support console

Operators get their own surface in a **separate trust domain** from tenant auth: a
self-contained UI at `GET /admin` and an operator-gated API under `/api/admin/*` —
a read-only, content-free tenant snapshot, force log-out, member revoke, erase a
tenant (typed confirmation), delete an account by email (GDPR), the audit log, and the
funnel report. Operator auth is `GLANCE_ADMIN_TOKEN` (one shared) or
`GLANCE_ADMIN_TOKENS` (`name:token` pairs, for per-operator attribution), and it
**fails closed** when unset. Every operator action is appended to a durable, capped
audit log.

## Product analytics

A content-free activation **funnel** — signup → activated (first connect) → engaged
(first surfaced moment) → subscribed — records only `{tenant, stage}`, where `tenant`
is a pseudonymous UUID. No message text, no chatter identities, no email. The
authoritative funnel is derived on demand from the durable per-tenant records
(distinct-tenant accurate and restart-safe, so there's no aggregate counter to race);
per-stage volume also feeds Prometheus counters (`glance_funnel_*_total`). Disable
with `GLANCE_ANALYTICS_DISABLED=1`.

## Observability & ops

- **`GET /health`** — liveness, always 200.
- **`GET /ready`** — 503 until Postgres is reachable and the `glance_kv` table has
  auto-migrated, so an instance is held out of rotation until it can actually serve.
- **`GET /metrics`** — Prometheus exposition, gated by `GLANCE_METRICS_TOKEN` when set.
- The **Stripe webhook** is idempotent: events are de-duped by id and out-of-order
  deliveries are dropped.

## What changes for true scale (not in scope here)

- **Twitch:** the production path is already EventSub (`channel.chat.message`) per
  linked creator; app auth + Conduits land when fan-out demands it.
- **Tracing:** structured logging and Prometheus metrics are in place; distributed
  tracing across the pipeline is the next observability step.
