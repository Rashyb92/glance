# Companion & wearables architecture

Glance is render-agnostic: the server scores chat and streams one protocol; any device
that can hold a connection or receive a push is a render target. This doc covers the
**phone companion** and **Apple Watch**, and the **push seam that's built today**.

## The principle

The salience engine already decides *what matters*. A wrist or a lock screen doesn't
want the firehose — it wants the few moments worth an interruption. That filtering is
the product, and it's device-independent. So the same intelligence reaches:

- **Browser HUD** — live overlay (built).
- **Audio / earbud** — spoken callouts + chimes (built; see the HUD's Earbud mode).
- **Phone companion** — second screen + audio + push registration (native, planned).
- **Apple Watch** — haptic alerts, a glance view, a complication (native, planned).

## What's built: the push seam

| Piece | Where | Status |
|-------|-------|--------|
| `pushNotificationFor(message)` | `@glance/core` `push.ts` | Built + tested — shapes the top priority callout and channel events into a notification; ignores the firehose |
| `PushStore` | `apps/server` | Built + tested — per-tenant device registry (apns / fcm / webhook), validated + capped |
| `Notifier` | `apps/server` | Built + tested — watches the Bus, pushes high-signal moments with dedup + per-tenant rate limit |
| `DefaultPushProvider` | `apps/server` | Built — delivers `webhook` devices via HTTPS POST today; APNs/FCM log until wired |
| Registration API | gateway | Built — `GET/POST /api/push…`, `DELETE /api/push/:id` |

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

This is the **always-on client** the watch pairs with. What's left to extend it: true
*background* push (screen off / app closed) needs Web Push (VAPID + a `WebPushProvider`
behind the existing `PushProvider` interface) or the native shell with APNs/FCM. The
foreground audio + glance + local notifications work today.

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

1. APNs/FCM providers behind `PushProvider` (server — small, the seam exists).
2. Phone companion shell (consumes the WS feed + the Earbud audio; registers for push).
3. Apple Watch app as the companion's satellite (haptics, glance, complication).

Steps 2–3 are native work; step 1 and everything server-side is complete and tested.
