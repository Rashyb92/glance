---
title: "Glance — Business Plan & Go-to-Market Strategy"
subtitle: "AI-curated heads-up chat for live creators · a UK company · all figures in GBP (£)"
date: "June 2026"
---

> The polished, formatted version is **`Glance_Business_Plan.docx`** (cover page, contents,
> financial tables, page numbers). This markdown is the editable source. All figures in **GBP**;
> source market reports are USD-denominated, converted at **£1 ≈ $1.32** (June 2026).

# 1. Executive Summary

**Glance is the calm, AI-curated heads-up layer for live creators.** It reads a streamer's chat in real time, decides what actually matters — donations, questions, raids, rising topics, the moment to step in — and surfaces just those, on a glanceable overlay, in an earbud, on a phone companion, or on smart glasses. Instead of a firehose the creator can't read, Glance delivers a quiet stream of "what matters right now," hands-free.

The product is built and launch-ready: a multi-tenant platform with a salience engine (the moat), live adapters for Twitch, YouTube and Kick, **unified multi-channel chat**, voice commands, real Twitch clip creation, a phone-companion app with background push, team seats with per-member logins, Stripe billing, and an independently audited backend. It deploys on a managed stack for **£0–20/month** to start.

We are **bootstrapping — no external funding required.** Fixed costs are low, gross margins are ~70–75%, and break-even is roughly **5–10 paying creators**.

# 2. The Product

Glance is **not** another overlay/alert/chatbot tool. It is an **attention layer** — a salience engine that scores every message and event, then routes only the high-signal moments to whatever surface the creator is using: a **HUD overlay**, an **audio/earbud mode**, a **phone-companion PWA** (the no-glasses path), **background push** to phones/wearables, and smart glasses as the flagship surface. Plus **unified multi-channel chat** (Twitch + YouTube + Kick merged into one ranked feed), **voice ("Ask Glance")** including "clip that" (real Twitch clips), and **teams** with revocable per-member logins.

# 3. The Problem (validated)

Streamers "struggle to keep up with chat, resulting in missed messages, awkward pauses, and viewers feeling ignored," and the top-recommended upgrade for a new streamer is *a second monitor just to see chat*; text-to-speech reading everything "can get overwhelming" ([StreamScheme](https://www.streamscheme.com/how-to-view-twitch-chat-while-streaming/), [Murf](https://murf.ai/blog/twitch-text-to-speech)). Structurally, **55%+ of streamers broadcast to fewer than five concurrent viewers while the top 1% dominate** ([ElectroIQ](https://electroiq.com/stats/twitch-statistics/)). Glance serves both ends — *everything that matters* for the small creator, *only what matters* for the large one.

# 4. Market Opportunity

The creator economy is ~**£190bn (~$250bn) in 2025**, rising to **~£235–245bn in 2026**, with long-run forecasts of **£1.0–1.6tn by 2033–35** (CAGR ~23–30%) ([Grand View](https://www.grandviewresearch.com/industry-analysis/creator-economy-market-report), [Precedence](https://www.precedenceresearch.com/creator-economy-market)). The live-streaming **software** market is ~**£9.4bn (2025) → ~£35bn by 2032** (~20.6% CAGR) ([Business Research Insights](https://www.businessresearchinsights.com/market-reports/live-stream-software-market-100418)); the four major platforms logged **30bn+ hours in Q4 2025** ([Streams Charts](https://streamscharts.com/news/q4-2025-global-livestreaming-landscape)).

| Platform | 2025 position | Scale signal |
|---|---|---|
| YouTube Live | #1, ~50% of watch hours | ~56bn hours in 2025 |
| TikTok Live | #2, 27–31% | 8bn+ hrs/quarter; passed Twitch Q1 2025 |
| Twitch | #3 (~16%), gaming/esports | 11.4m monthly streamers, ~2.1m concurrent |
| Kick | Fastest-growing, ~11% | 4.5bn hrs (+131% YoY) |

**Glasses tailwind:** Meta sold **7m+ AI glasses in 2025 (tripled YoY, ~73% share)**; Ray-Ban Display launched at **~£605 ($799)** ([Counterpoint](https://counterpointresearch.com/en/insights/post-insight-research-briefs-blogs-global-smart-glasses-shipments-soared-110-yoy-in-h1-2025-with-meta-capturing-over-70-share), [CNBC](https://www.cnbc.com/2026/02/11/ray-ban-maker-essilorluxottica-triples-sales-of-meta-ai-glasses.html)). At ~£20/mo blended paid ARPU, **50,000 paying creators ≈ £12m ARR; 250,000 ≈ £60m ARR.**

# 5. Competitive Landscape

| Capability | **Glance** | StreamElements | Streamlabs |
|---|---|---|---|
| Category | AI attention layer | Overlays/marketplace | Overlays (OBS app) |
| Multi-platform merge | **Yes** | Per-platform | Per-platform |
| Audio / earbud / glasses | **Yes** | No | No |
| AI salience/priority | **Yes (moat)** | No | Limited |
| Pricing | £0 / £15 / £39 | Free (marketplace cut) | Free + ~£20/mo Ultra |

Incumbents add pixels to a screen the creator can't watch; Glance removes the screen and says what matters. Their threat is distribution (StreamElements 1.1m+ creators) and "free"; we counter with a generous free tier, an unserved wedge, and a product that demos itself in a clip.

# 6. Business Model & Pricing

| Feature | **Free £0** | **Creator £15/mo** | **Pro £39/mo** |
|---|---|---|---|
| Salience engine, 1 platform | ✓ | ✓ | ✓ |
| AI calls/day | 500 (rules-first) | 10,000 | 200,000 |
| Audio / voice / "Ask Glance" | — | ✓ | ✓ |
| Multi-platform merge | — | ✓ | ✓ |
| Moderation, analytics, branding | — | — | ✓ |
| Team seats / concurrent channels | 1 / 1 | 1 / 1 | 5 / 3 |

Annual billing = two months free (prepay, lower churn). Cap-based gating means a free user costs pennies and a Pro user pays for their own AI.

# 7. Financial Plan

The dominant variable cost is the Claude API; everything else is small and largely fixed. The **free tier defaults to the rules engine** (near-zero marginal AI cost), and per-tier caps bound paid-plan worst cases.

**Per-user unit economics (monthly):**

| Tier | Price | AI COGS | Payments | Infra | Gross profit | Margin |
|---|---|---|---|---|---|---|
| Free | £0.00 | £0.10 | — | £0.05 | −£0.15 | loss-leader |
| Creator | £15.00 | £3.00 | £0.70 | £0.30 | £11.00 | 73% |
| Pro | £39.00 | £10.00 | £1.40 | £0.50 | £27.10 | 70% |

Blended paid ARPU (80/20 Creator/Pro) = **£19.80/mo at ~72% gross margin** (~£14 gross profit per paying creator).

**Key assumptions:** ~4% free→paid; 80/20 Creator/Pro; ~6% monthly churn (~17-month lifetime); 70–75% blended margin; rules-first free tier; annual prepay.

**Three-year P&L (illustrative, GBP — projections, not promises):**

| Line item | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| Free users (EOY) | 5,000 | 30,000 | 100,000 |
| Paying creators (EOY) | 200 | 1,500 | 5,000 |
| End-of-year MRR | £3,960 | £29,700 | £99,000 |
| Revenue (in-year) | £22,000 | £200,000 | £770,000 |
| COGS (AI, infra, payments) | (£6,600) | (£56,000) | (£200,000) |
| **Gross profit** | **£15,400** | **£144,000** | **£570,000** |
| Marketing & creator partnerships | (£6,000) | (£45,000) | (£160,000) |
| Salaries & contractors | (£2,000) | (£45,000) | (£200,000) |
| Tools, infra & overhead | (£1,200) | (£6,000) | (£18,000) |
| Other / contingency | — | (£12,000) | (£45,000) |
| **Operating profit (net)** | **£6,200** | **£36,000** | **£147,000** |

**Break-even** is ~5–10 paying creators (vs ~£50–100/mo fixed infra), reached in the private beta — so Glance is cash-flow positive from early Year 1 and self-funds its first hires.

**Customer economics:** gross-profit LTV ~**£235** (~£14/mo × ~17 months); target **CAC < £70** (affiliate/organic-led); **LTV:CAC > 3:1**, payback **< 5 months**.

**Sensitivity:** at 2% conversion (half base), Year-2 revenue ~£100k and still profitable; a 2× Claude price rise trims margin ~8–10 points (still positive); −1pt churn adds ~£40 LTV.

# 8. Go-to-Market Strategy

**Positioning:** *"Never miss what matters in your chat — hands-free."* **Beachhead:** serious solo Twitch/Kick streamers (1k–50k followers). **Motion:** Land (free + no-glasses companion) → Convert (Creator £15, audio/voice/multi-platform) → Expand (Pro £39, teams/simulcast/branding). **Sequence:** private beta → Product Hunt/Indie Hackers launch → creator-partner flywheel → platform & glasses.

# 9. Marketing Strategy (research-backed)

Other creators are the highest-ROI channel — dedicated tutorials convert **4–8× a mention** ([getSaral](https://www.getsaral.com/academy/b2c-saas-influencer-marketing-playbook)).

1. **Creator partnerships (primary)** — micro/nano streamers on a hybrid (flat + per-signup) model for dedicated "how I never miss chat" content; track signups/link, trial→paid, CPL.
2. **Community (Discord)** — owned server + sponsorships of creator-tool servers ([Digiday](https://digiday.com/media/brands-turn-to-discord-servers-as-a-means-to-reach-niche-influencer-channels-in-their-own-communities/)).
3. **Launch moment** — weekend Product Hunt with a strong demo video, pre-built community, first-3-hours push ([RocketDevs](https://rocketdevs.com/blog/how-to-launch-on-product-hunt)); build-in-public on X/IH.
4. **Content & SEO** — own "how to read Twitch chat while streaming," "stop missing donations"; short-form "clip that" clips drive discovery.
5. **Coordinated multiplatform** — Discord + partner streams + TikTok + X on one calendar.

**Bootstrapped budget:** affiliate/performance + organic + community first; CAC payback < 90 days.

# 10. Operations & Team

Managed-simple infra (Fly/Neon/Upstash/Cloudflare); community-first support; signed-token auth + AES-256-GCM at rest + GDPR-style controls + audited backend (no criticals). Lean, founder-led; first hires (revenue-funded) are a creator-partnerships/dev-advocate lead and part-time support.

# 11. Roadmap

- **Now:** salience engine, Twitch/YouTube/Kick, multi-channel, voice, real clips, companion + push, teams, billing, hardened/audited backend, deploy + store scaffolds.
- **0–3 mo:** Android (TWA) + iOS (Capacitor) store builds; APNs push; token denylist; Postgres-back push/team stores.
- **3–6 mo:** native Apple Watch app; deeper analytics; moderation auto-actions; Spanish localisation.
- **6–12 mo:** native smart-glasses targets; SDK/partner programme; agency console.

# 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| AI cost spikes | Per-tier caps; Haiku; £0 rules fallback (the cap is the price lever). |
| Incumbent "AI" features | Salience + multi-surface depth; ship faster; own the audio/heads-up niche. |
| Platform API/policy change | Adapter seam; multi-platform spreads risk; fail-soft. |
| Slow glasses adoption | Works today on phone/earbud/overlay — glasses are upside. |
| Free-tier abuse/cost | Rules-first free tier; caps; rate limits; SSRF guards (audited). |
| Single-founder bandwidth | Bootstrapped, low-ops stack; revenue-funded hires. |

# 13. Conclusion

Large, growing market; real, validated problem; incumbents don't solve attention; product built, audited and launch-ready; capital-efficient model that needs no funding. The path to a profitable business runs through creators showing other creators a product that quietly does the one thing they all struggle with: never miss what matters.

---

## Sources

[Grand View Research](https://www.grandviewresearch.com/industry-analysis/creator-economy-market-report) · [Precedence Research](https://www.precedenceresearch.com/creator-economy-market) · [Market.us](https://market.us/report/creator-economy-market/) · [Business Research Insights](https://www.businessresearchinsights.com/market-reports/live-stream-software-market-100418) · [Streams Charts Q4 2025](https://streamscharts.com/news/q4-2025-global-livestreaming-landscape) · [ElectroIQ — Twitch](https://electroiq.com/stats/twitch-statistics/) · [NetInfluencer — Kick](https://www.netinfluencer.com/livestreaming-sees-shift-as-kick-joins-big-four-in-q2-2025/) · [Counterpoint — smart glasses](https://counterpointresearch.com/en/insights/post-insight-research-briefs-blogs-global-smart-glasses-shipments-soared-110-yoy-in-h1-2025-with-meta-capturing-over-70-share) · [CNBC/EssilorLuxottica](https://www.cnbc.com/2026/02/11/ray-ban-maker-essilorluxottica-triples-sales-of-meta-ai-glasses.html) · [StreamElements](https://streamelements.com/) · [Streamlabs pricing](https://checkthat.ai/brands/streamlabs/pricing) · [StreamScheme](https://www.streamscheme.com/how-to-view-twitch-chat-while-streaming/) · [Murf](https://murf.ai/blog/twitch-text-to-speech) · [getSaral](https://www.getsaral.com/academy/b2c-saas-influencer-marketing-playbook) · [RocketDevs](https://rocketdevs.com/blog/how-to-launch-on-product-hunt) · [Digiday](https://digiday.com/media/brands-turn-to-discord-servers-as-a-means-to-reach-niche-influencer-channels-in-their-own-communities/) · FX £1≈$1.32 ([exchangerates.org.uk](https://www.exchangerates.org.uk/GBP-USD-spot-exchange-rates-history-2026.html))
