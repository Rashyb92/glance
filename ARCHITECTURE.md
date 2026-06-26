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

- **Today:** `TwitchAdapter` (anonymous IRC-over-WebSocket) and `DemoAdapter`.
- **Add Kick / YouTube:** create `kick.ts` / `youtube.ts` implementing the same
  interface, emit normalised messages, and register it in `apps/server/src/main.ts`.
  Nothing else changes. `DemoAdapter` is the reference template.
- **Production note:** swap the Twitch IRC client for EventSub behind the same
  interface when you need scale and official guarantees — the rest of the system is
  untouched.

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
- **Where the moat grows:** today the salience *scoring* is rule-based in
  `@glance/core` and the AI only *summarises*. The natural next step is a learned
  salience model that re-ranks messages — it slots in behind this same interface.

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
  rename) today; M3 swaps in a DB-backed store without touching callers — and
  broadcast to every client as a `settings` message.
- **Overlay settings** (HUD `OverlaySettings`) — device-local: placement, scale,
  opacity, density, motion. Persisted in `localStorage`, never sent to the server.

This mirrors the product split: the server owns *what matters*; each device owns
*how it looks*.

## Package responsibilities

| Package             | Owns                                                                 | Depends on            |
| ------------------- | ------------------------------------------------------------------- | --------------------- |
| `@glance/core`      | Types, salience scoring, trend detection, mode policy               | nothing               |
| `@glance/platforms` | `PlatformAdapter`, Twitch + Demo adapters, IRC parsing              | `core`, `ws`          |
| `@glance/ai`        | `AIProvider`, Claude provider, rule-based provider, factory          | `core`, Anthropic SDK |
| `@glance/server`    | Config, the engine pipeline, the WebSocket gateway, wiring          | all three packages    |
| `@glance/hud`       | The peripheral overlay; consumes the feed (types only from `core`)  | `core` (types), React |

Note the HUD depends on `@glance/core` for **types only** — it carries no runtime
coupling to the engine, which keeps the render layer truly swappable.

## How a scored message is built

`@glance/core` `scoreMessage()` combines independent signals — money (bits),
direct address, keywords, questions, trend repetition, role, and a noise penalty —
with a soft-OR aggregation that saturates at 1.0. It returns the score, the
dominant category, and the **reasons** each signal fired (for explainability in a
future dashboard). It is deterministic, so it is trivially testable: see
`packages/core/test/salience.test.ts`.

## Mapping to the product roadmap

| Blueprint phase            | In this codebase                                                  |
| -------------------------- | ----------------------------------------------------------------- |
| Phase 1 — Creator overlays | The whole core loop here: Twitch + Hybrid mode + peripheral HUD    |
| Phase 2 — AI copilot       | `AIProvider` seam → swap rules for a learned salience model        |
| Phase 4 — Creator OS       | `RenderTarget` seam → ship the HUD as a Meta Web App when the store opens |

## What changes for production (not in scope here)

- **Twitch:** IRC → EventSub (`channel.chat.message`) with app auth + Conduits.
- **Persistence & multi-tenant:** today the engine is in-memory and single-channel;
  production adds per-creator sessions, storage, and horizontal scaling of the gateway.
- **AuthN/Z & secrets:** real key management, per-creator OAuth, rate limiting.
- **Observability:** structured logging, metrics, and tracing around the pipeline.
