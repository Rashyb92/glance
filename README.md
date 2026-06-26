# Glance

**The calm, AI-curated heads-up layer for live creators.**

Glance reads a streamer's live chat in real time, decides what actually matters
(a donation, a raid, a real question, a trend — not the 400 emotes around it), and
surfaces it as a calm, peripheral overlay. This repo is the **core loop**, running
end-to-end on your machine:

```
  Twitch IRC ──┐
  (anonymous)  │     ┌───────────┐     ┌───────────────┐    ws://     ┌────────────┐
  Demo feed ───┼───▶ │ Platform  │ ──▶ │ Glance Engine │ ─────────▶  │   HUD      │
               │     │ Adapter   │     │  salience +   │  HudItem     │  (browser, │
  Kick / YT ───┘     └───────────┘     │  AI summary   │  stream      │   later    │
  (future)                              └──────┬────────┘              │   glasses) │
                                               │ summarize()           └────────────┘
                                        ┌──────▼───────┐
                                        │  AI Provider │   Claude · rule-based fallback
                                        └──────────────┘
```

No API keys, OAuth, or hardware are required to see it work — Twitch chat is read
anonymously, and a built-in demo feed keeps the HUD alive even on a quiet channel.

---

## Prerequisites

- **Node.js 20.12+** (Node 22 LTS recommended) — <https://nodejs.org>
- **pnpm 9** — comes bundled with Node via Corepack (enabled below)

Check Node:

```powershell
node --version
```

---

## Setup (Windows / PowerShell)

From the project folder (`C:\Users\Rashe\Desktop\Glance Code`):

```powershell
# 1. Enable pnpm (ships with Node, no install needed)
corepack enable

# 2. Install all workspace dependencies
pnpm install
```

> If `corepack enable` is blocked, install pnpm directly: `npm install -g pnpm@9`.

That's it — no `.env` needed for the first run.

---

## Run

```powershell
pnpm dev
```

This starts **both** the server and the HUD together. Then open:

> **http://localhost:5173**

You'll see the Glance HUD come alive with a live demo feed: chatter flowing, the
occasional donation and raid breaking through, and AI summaries appearing on a
timer. Use the **Raw Flow / AI Assist / Hybrid** switch at the bottom to feel the
difference — Hybrid is the one to watch.

Run just one side if you prefer:

```powershell
pnpm server   # the pipeline only (ws://localhost:8787)
pnpm hud      # the interface only (http://localhost:5173)
```

---

## Point it at a real Twitch channel

The easy way: open the **Command Center** (http://localhost:5174), type a
currently-live channel into the **Connect** bar, and hit Connect. The server
switches instantly and both surfaces follow — no restart, no file editing.

To set the channel Glance auto-connects to on startup, create a `.env` (copy from
`.env.example`):

```ini
GLANCE_CHANNEL=somelivechannel   # auto-connect target on boot
GLANCE_DEMO=false                # synthetic feed off (real chat only)
```

Reading is anonymous — real messages, cheers and raids, scored live. Pick a
channel that is actually streaming, or chat will be quiet.

## Turn on Claude (optional)

Without a key, Glance uses its deterministic rule-based summariser. Add a key to
light up Claude-powered summaries in **AI Assist** and **Hybrid**:

```ini
ANTHROPIC_API_KEY=sk-ant-...
GLANCE_AI_MODEL=claude-haiku-4-5-20251001   # fast + cheap; override if you like
```

Glance falls back to the rule-based engine automatically if the key is missing or
a call fails — the HUD never goes dark.

---

## Tune it live

**In the Command Center** — server-owned, saved to `.data/settings.json`, applied
to the running session immediately and pushed to every client:

- **Surface threshold** — how high a message must score to break through in Hybrid.
- **AI summary frequency** — how often the AI speaks.
- **Keywords to boost** — streamer-specific terms that raise a message's salience.

**In the HUD** — press the **⚙** button (saved per browser): overlay **side**,
**size**, **opacity**, **density** and **motion**.

---

## Session Replay

Every time you Disconnect or switch channels, Glance archives the session to
`.data/sessions/` — durable best moments, a donation / raid / summary timeline,
headline stats and an AI-written recap. Open the **Replay** tab in the Command
Center to browse past streams and replay any one of them end to end.

---

## Scripts

| Command           | What it does                                              |
| ----------------- | -------------------------------------------------------- |
| `pnpm dev`        | Run the server + HUD together (the demo)                 |
| `pnpm server`     | Run just the pipeline / WebSocket gateway                |
| `pnpm hud`        | Run just the browser HUD                                 |
| `pnpm test`       | Run unit tests (the salience engine)                     |
| `pnpm typecheck`  | Type-check every package                                 |
| `pnpm lint`       | Lint the workspace                                       |
| `pnpm format`     | Format with Prettier                                     |
| `pnpm build`      | Production build of the HUD                              |

---

## Monorepo layout

```
glance/
├─ packages/
│  ├─ core/        @glance/core      Pure salience engine + shared types (no deps, fully tested)
│  ├─ platforms/   @glance/platforms PlatformAdapter seam + Twitch (anonymous) + Demo adapters
│  └─ ai/          @glance/ai        AIProvider seam + Claude provider + rule-based fallback
└─ apps/
   ├─ server/      @glance/server    Wires adapter → engine → AI, broadcasts over WebSocket
   └─ hud/         @glance/hud       React peripheral overlay (the "glasses" preview)
```

The three packages are independent and swappable by design — see
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for how Kick/YouTube, other AI models, and
real glasses slot in without touching the rest of the system.

---

## The three modes

- **Raw Flow** — every message flows, paced for readability. Low-salience lines dim.
- **AI Assist** — individual messages step back; only AI summaries of the room show.
- **Hybrid** *(the wedge)* — chat flows, but only what matters breaks through:
  donations, raids, real questions, trends. This is attention management for creators.

---

## Reads the room

Beyond raw scoring, Glance reads **sentiment** and **toxicity** on every message.
The Command Center shows live audience **mood** and a **flagged** count for
moderation, and a **Priority · act now** card (mirrored by a HUD priority callout)
where Claude re-ranks the few things you should act on this moment — with a
deterministic fallback when there's no API key.

---

## Troubleshooting

- **HUD says "offline"** — the server isn't up yet. With `pnpm dev` it reconnects
  automatically within a couple of seconds; give it a moment.
- **No real messages** — your `GLANCE_CHANNEL` isn't live, or `GLANCE_DEMO=false`
  on a quiet channel. Set a live channel or re-enable the demo feed.
- **`pnpm` not found** — run `corepack enable`, or `npm install -g pnpm@9`.
- **Port already in use** — change `GLANCE_WS_PORT` in `.env` (and `VITE_GLANCE_WS`
  in `apps/hud/.env` to match).
