# Companion & wearables architecture

Glance is render-agnostic: the server scores chat and streams one protocol; any device
that can hold a connection or receive a push is a render target. This doc covers the
**phone companion** and **Apple Watch**, and the **push seam that's built today**.

## The principle

The salience engine already decides _what matters_. A wrist or a lock screen doesn't
want the firehose — it wants the few moments worth an interruption. That filtering is
the product, and it's device-independent. So the same intelligence reaches:

- **Browser HUD** — live overlay (built).
- **Audio / earbud** — spoken callouts + chimes (built; see the HUD's Earbud mode).
- **Phone companion** — second screen + audio + push registration (PWA built; Capacitor iOS/Android shells scaffolded).
- **Apple Watch** — haptic alerts, a glance view, a complication (native, planned).

## What's built: the push seam

| Piece                          | Where                    | Status                                                                                                        |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `pushNotificationFor(message)` | `@glance/core` `push.ts` | Built + tested — shapes the top priority callout and channel events into a notification; ignores the firehose |
| `PushStore`                    | `apps/server`            | Built + tested — per-tenant device registry (apns / fcm / webhook), validated + capped                        |
| `Notifier`                     | `apps/server`            | Built + tested — watches the Bus, pushes high-signal moments with dedup + per-tenant rate limit               |
| `DefaultPushProvider`          | `apps/server`            | Built — delivers `webhook` devices via HTTPS POST; the fallback when no real provider is configured           |
| `WebPushProvider` (VAPID)      | `apps/server`            | Built + tested — real background Web Push (RFC 8291) to the PWA/companion when `VAPID_*` keys are set         |
| `ApnsProvider` / `FcmProvider` | `apps/server`            | Built — native iOS (APNs) + Android (FCM) delivery when keys are set; send-time DNS-SSRF guard on endpoints   |
| Registration API               | gateway                  | Built — `GET/POST /api/push…`, `DELETE /api/push/:id`                                                         |

Flow: `engine → controller → Bus.publish(tenant, msg)` → the `Notifier` (a Bus subscriber
alongside the WebSocket fan-out) → `pushNotificationFor` → for each registered device,
`provider.send`. Webhook devices receive a JSON POST **right now** — which is enough to
drive an iOS Shortcut, an [ntfy](https://ntfy.sh) topic, or your own push backend without
any native code.

### Register a device

```
POST /api/push/subscribe   { "platform": "webhook", "endpoint": "https://…" }
GET  /api/push             -> [ { id, platform, endpoint, createdAt } ]
DELETE /api/push/:id
```

## Phone companion (PWA built; native shell later)

**Built**: `apps/companion` — an installable PWA (Vite + React) that consumes the same feed
protocol and renders the audio-first Earbud experience (Listening orb, volume, last-heard)
plus a viewer/chatter glance and the top priority callout. Add-to-Home-Screen installs it
(web manifest + service worker); run it at `http://localhost:5175` (`pnpm dev`). It's
token-aware like the other clients, so it pairs to the creator's tenant.

This is the **always-on client** the watch pairs with. Background push (screen off / app
closed) is now built: a `WebPushProvider` (VAPID / RFC 8291) delivers to the PWA when the
`VAPID_*` keys are set, and **Capacitor** iOS/Android shells (native APNs/FCM + haptics) are
scaffolded for the app stores. Foreground audio + glance + local notifications work today.

## Apple Watch (native, planned — satellite of the phone)

watchOS won't hold a persistent background stream, so the watch is **push + glance**, not a
live overlay — which fits the salience thesis perfectly:

- **Haptic alerts** — high-salience moments arrive as notifications; the wrist taps. (This
  is exactly what `Notifier` emits.)
- **Glance view** — raise-to-wake shows the current top priority + viewer count.
- **Complication** — a periodic pulse (viewers / "N waiting") within watchOS refresh budgets.
- **Audio** — to paired AirPods, driven by the phone.

Architecture: the **phone companion holds the connection and relays** to the watch via
WatchConnectivity, and APNs delivers the wrist taps. The watch app is small; it rides on
the companion rather than connecting directly.

## Build order

1. ~~APNs / FCM / Web Push providers behind `PushProvider`~~ ✓ (built + tested).
2. ~~Phone companion (PWA)~~ ✓ — Capacitor iOS/Android shells scaffolded for the stores.
3. Apple Watch app as the companion's satellite (haptics, glance, complication).

Everything server-side and the PWA are complete and tested; the remaining work is the
native store shells (step 2 polish) and the watch app (step 3).
