# Glance Companion — Android (Play Store) via TWA

The companion PWA ships to the Play Store as a **Trusted Web Activity (TWA)** — a thin
native shell that opens the deployed PWA full-screen (no browser chrome) and forwards
Web Push to the Android notification tray. There is no separate UI to maintain: the TWA
_is_ the PWA.

## Prerequisites

- The companion deployed over **HTTPS** at a stable host (e.g. Cloudflare Pages), with a
  valid `manifest.webmanifest` and a **512×512 PNG** icon at `/icon-512.png`
  (the in-app icon is an SVG; the Android launcher needs a raster — add
  `apps/companion/public/icon-512.png`, maskable, on the brand background `#0a0a0f`).
- Node 18+, a JDK 17, and the Android SDK (Bubblewrap installs/uses these).
- `npm i -g @bubblewrap/cli`.

## 1 · Configure

Edit `twa-manifest.json` in this folder and replace every `companion.glance.example`
with your real host, and `app.glance.companion` with your reverse-domain package id
(e.g. domain `glance.app` → `app.glance.companion`). Keep colors in sync with the PWA
manifest (`#0a0a0f`).

## 2 · Build the app bundle

```bash
cd apps/companion/twa
bubblewrap init --manifest ./twa-manifest.json   # first time; generates the Android project
bubblewrap build                                  # produces app-release-bundle.aab (+ apk)
```

`bubblewrap init` creates a signing keystore (`android.keystore`, alias `glance`) — **back
it up; losing it means you can't update the app.** Print its SHA-256 fingerprint:

```bash
keytool -list -v -keystore android.keystore -alias glance | grep SHA256
```

## 3 · Verify domain ownership (removes the URL bar)

The TWA only runs full-screen if the site proves it owns the app. Put the fingerprint into
`apps/companion/public/.well-known/assetlinks.json` (replace
`REPLACE_WITH_PLAY_APP_SIGNING_SHA256_FINGERPRINT`) and redeploy the companion so it is
live at `https://<host>/.well-known/assetlinks.json`.

> If you enable **Play App Signing** (recommended), Google re-signs the app, so use the
> SHA-256 from Play Console → _Setup → App signing_ in `assetlinks.json`, not the local
> keystore's. You can list both fingerprints — the upload key and the Play signing key.

## 4 · Publish

Upload `app-release-bundle.aab` to the Play Console, complete the store listing, and roll
out. On first launch Android fetches `assetlinks.json`; if the fingerprint matches, the
app opens chrome-less. Background Web Push works once the user grants notifications (the
service worker + VAPID path is already wired in the PWA).

## Notes

- iOS App Store is a separate wrapper (PWABuilder or Capacitor) — same PWA, different shell.
- Updating the web app updates the Android app instantly (it loads live); you only rebuild
  the `.aab` to change native shell config (name, icon, package, permissions).
