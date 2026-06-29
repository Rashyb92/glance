# The moat: measuring salience quality

Glance's defensible core is the **salience model** — the deterministic engine that decides
what's worth a creator's attention. It's pure, fast (microseconds per message), and runs with
zero external calls; the AI layer augments it but never replaces it. Because the entire
business rests on this being _good_ ("attractive if, and only if, the salience model is good
enough to be worth paying for"), we **measure** it rather than assert it.

## How we measure it

`evaluateSalience(scenario)` (`@glance/core`, `src/eval.ts`) runs a scripted chat scenario
through the real engine — driving a live `TrendTracker` so spam waves and copypasta score
realistically — and reports:

- **Precision** — of what surfaced, how much was actually worth it (low ⇒ a noisy overlay).
- **Recall** — of the moments that mattered, how many surfaced (low ⇒ missed the donation).
- **Category accuracy** — was the donation / question / trend / moderation labeled correctly.

The scenarios live in `packages/core/test/eval.test.ts` and encode the product's quality bar as
executable, adversarial cases — so they're also regression protection: change a salience weight
and they immediately tell you whether quality moved.

## Current results

On three realistic scenarios — a donation, a genuine question, and a toxic message buried in
emote noise; a copypasta line that should only surface once it becomes a trend; and an @mention
amid ordinary substantive chat — the engine scores **precision 1.0, recall 1.0, category
accuracy 100%**: it surfaces every moment that matters, ignores the noise, and labels each one
correctly.

## How the moat compounds

To tune, add scenarios drawn from real streams (the session recorder already captures the top
moments of every stream), run the harness, and adjust the weights in `salience.ts` until
precision/recall hold across the whole suite. Every real stream that surprises us becomes a
permanent test — so the model only gets harder to beat over time.
