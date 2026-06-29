# Glance — Product Roadmap & Moat

Companion to `AUDIT.md` (engineering) and the Product Blueprint (vision). This
captures the **product moat** direction: feature gaps, the companion-app
architecture, and the cross-platform plan.

> **Shipped since this was written:** the engineering hardening (see `AUDIT.md`
> status banner), self-serve accounts + auth with token revocation, the
> OAuth/EventSub pipelines (Twitch/YouTube/Kick), the phone **companion** (an
> installable PWA + Capacitor wrappers), **haptics** as a fourth output channel,
> two-way **voice commands** ("Ask Glance", "clip that" → real Twitch clips), an
> admin/support console, and a content-free analytics funnel. The audio/TTS output
> layer, routing-rules engine, catch-up digest, moderation quick-actions, and VIP
> memory remain the open moat work.

## The reframed moat: route attention, not just display it

Glance's defensible core is the **salience engine** — deciding what deserves a
creator's attention. The output side should mirror that: a **routing matrix** that
sends each salience category to the channel the creator chooses.

| Category            | On-lens | Spoken (TTS) | Earcon | Haptic | Phone push |
| ------------------- | ------- | ------------ | ------ | ------ | ---------- |
| Donation            | ○       | ●            | ●      | ○      | ○          |
| Raid / event        | ●       | ●            | ●      | ○      | ○          |
| Question            | ●       | ○            | ○      | ○      | ○          |
| Mention / keyword   | ●       | ○            | ○      | ●      | ○          |
| Mod flag (toxicity) | ●       | ○            | ○      | ●      | ●          |
| Trend               | ●       | ○            | ○      | ○      | ○          |
| Chatter             | dim     | ○            | ○      | ○      | ○          |

This is "choose what you see **and** hear." It is per-creator, sticky, and it is
the existing engine made actionable. Crucially, the **audio path unlocks the
display-less glasses majority** (Ray-Ban Meta, Oakley Meta, earbuds) — Meta's
Device Access Toolkit already exposes the glasses' speaker + mic to third-party
phone apps, so the audio layer is buildable on today's hardware.

## Feature gaps (prioritized)

Software on existing seams (build first):

1. **Audio/voice output + earcons** — a new `RenderTarget` (TTS + distinct sounds). Unlocks display-less wearables. Highest leverage.
2. **Routing rules engine** — category + threshold → output channel(s); generalizes keywords into the sticky config above.
3. **Catch-up digest** — "while you were away"; reuses the session recorder's best-moments to surface a live catch-up.

Layer on after auth / hardware: 4. **Two-way voice commands** — hands-free queries + actions ("thank the last donor", "mark a clip"). Blueprint Phase 3 (adds STT + intent). 5. **Moderation quick-actions** — toxicity flag → one-tap timeout/delete (needs EventSub write + OAuth). 6. **Supporter / VIP memory** — recognize returning top supporters with context; a compounding data moat. 7. **Live translation** — translate + TTS foreign chat for global creators.

## Companion app architecture

**Glance never touches the broadcast.** The creator streams however they already
do (OBS/PC, Twitch app, IRL backpack, or glasses POV). Glance is a separate,
**read-only** layer over chat + events — so it is broadcast-method-agnostic.

```
   Twitch chat/events ──▶ Glance server (ingest + salience + AI; keys server-side)
                                   │  WebSocket (scored feed) — same protocol as HUD/dashboard
                                   ▼
                          Phone companion (hub)
                          ┌──────────┴──────────┐
                  display glasses          audio glasses / earbuds
                  (render to lens,         (TTS + earcons to the
                   Meta Web App)            Bluetooth / toolkit speaker)
```

The phone is **compute + bridge**; the wearable is **I/O**. Production auth
(**shipped**): the creator OAuths Twitch/YouTube/Kick once → reliable EventSub
reads and, for Twitch, real clip creation; provider tokens are encrypted at rest.
Write-actions (timeouts) remain the next OAuth-scoped step.

## Cross-platform plan

- **Today:** HUD + dashboard are web (React/Vite) → already run on any OS/browser; server is Node → any cloud. Cross-platform now.
- **Companion (shipped):** an installable **PWA** (`apps/companion`) plus **Capacitor** wrappers for **iOS + Android** native — reusing `@glance/core` types and the gateway protocol, with native push (APNs/FCM) and haptics. (The original plan was React Native + Expo; a PWA + Capacitor delivered the same cross-platform reach without a second UI codebase. BLE + background audio remain for the audio-glasses path.)
- **Additive, not a rearchitecture:** every client speaks the same `ServerMessage` protocol, so new clients (RN app, Meta Web App, Brilliant Labs companion) plug into the existing gateway.
- **Caveats:** iOS background-audio + BLE entitlements; APNs vs FCM; app-store review.

## Mapping to existing seams

- **Output channels** = new `RenderTarget`s (audio/earcon/haptic/push) alongside the browser HUD — the feed hook is already presentation-free.
- **Routing matrix** = an extension of `EngineSettings` (per-category → channel), validated through the same `normalizeEngineSettings` boundary.
- **Platforms** = the `PlatformAdapter` seam (Twitch → Kick/YouTube).
- **AI** = the `AIProvider` seam (summarize/prioritize → voice intents later).

> Build order: ~~engineering hardening (AUDIT.md)~~ ✓ → ~~companion app + OAuth/EventSub~~ ✓
> → ~~voice commands~~ ✓ → **audio/TTS + routing layer (1–3, next)** → moderation
> quick-actions / VIP memory / translation (5–7).
