# Glance Companion — iOS (App Store)

Two ways onto iOS. The PWA itself already runs on iOS **without** the App Store: Safari →
Share → *Add to Home Screen* gives a full-screen app, and on **iOS 16.4+** background Web
Push works for that installed PWA (already wired). The App Store wrapper below is for
discoverability and a native shell.

> **Important Web Push caveat.** A wrapped App Store build runs your PWA inside a
> `WKWebView`, and **Web Push does _not_ fire inside a WKWebView** — only in a
> home-screen Safari PWA. So the App Store build delivers push via **native APNs**, not
> Web Push. Our server already has the seam for this: `PushProvider` accepts an `apns`
> platform (it currently logs); the native step is registering the device for APNs in the
> app and adding a real APNs sender behind that seam. The home-screen PWA keeps using Web
> Push. Plan for one of these two push paths per install type.

## Prerequisites

- macOS with **Xcode 15+**, and an **Apple Developer Program** membership ($99/yr).
- The companion deployed over HTTPS (same host as the PWA).
- Node 18+.

## Option A — PWABuilder (fastest)

Go to [pwabuilder.com](https://www.pwabuilder.com), enter your companion URL, and download
the **iOS** package. It produces an Xcode project wrapping the PWA. Open it in Xcode, set
your team/signing, build to a device or TestFlight. Good when you want the store listing
with minimal native code.

## Option B — Capacitor (more control, native push)

Capacitor gives a real native project you can extend (APNs push, native share, etc.).

```bash
cd apps/companion
pnpm add -D @capacitor/core @capacitor/cli @capacitor/ios
npx cap init Glance app.glance.companion --web-dir dist
# copy the provided config (edit the host + appId first):
cp ios/capacitor.config.json ./capacitor.config.json
pnpm build                      # produce dist/ (used as the local fallback)
npx cap add ios
npx cap open ios                # opens Xcode
```

`server.url` in `capacitor.config.json` points the shell at the **live deployed PWA** (so
web updates ship instantly, like the Android TWA); `webDir` is the bundled fallback. In
Xcode: set your signing team, bump the bundle id to match `appId`, then Product → Archive →
distribute to TestFlight / App Store.

### Native push (APNs)

```bash
pnpm add @capacitor/push-notifications
```

Register for notifications on launch, send the APNs device token to
`POST /api/push/subscribe` with `{ "platform": "apns", "endpoint": "<device-token>" }`
(the store already accepts `apns`). Then implement an APNs sender behind the server's
`PushProvider` seam (`apps/server/src/push.ts`) using your APNs key. Enable the *Push
Notifications* capability in Xcode and upload an APNs auth key in the Apple Developer
portal.

### Native haptics

```bash
pnpm add @capacitor/haptics
npx cap sync ios
```

That's the whole step — the companion **auto-detects** the Capacitor Haptics bridge at
runtime (`apps/companion/src/haptics.ts`) and routes per-category feedback through it
(donations → success, moderation → warning, channel events → a heavy tap, questions/mentions
→ a medium tap). This is what makes haptics work on iOS, where the Web Vibration API is
unavailable inside a `WKWebView`. The home-screen PWA and the Android TWA keep using the Web
Vibration API automatically; no code change is needed for either path, and the per-category
feedback is gated by the **routing matrix** ("feel" column) like every other output channel.

## App Store review notes

Apple guideline **4.2 (minimum functionality)** can flag thin web wrappers. The native
push, installable experience, and the audio/voice features give it native value; describe
those in the review notes. Keep the bundle id, name, and colors (`#0a0a0f`) consistent
with the PWA manifest.
