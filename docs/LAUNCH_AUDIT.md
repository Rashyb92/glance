# Glance — Pre-Launch Backend Audit

An independent security & reliability review of `apps/server` ahead of launch. No critical
launch-blockers were found; the core spine — multi-tenant isolation, signed-token auth,
at-rest encryption, parameterized SQL, and DoS hardening — is genuinely solid. Two HIGH and
several MEDIUM/LOW items were identified; the table records each with its disposition.

## Findings & disposition

| ID | Sev | Finding | Status |
| --- | --- | --- | --- |
| H1 | High | Member login tokens were non-revocable (no TTL) — a removed teammate kept access. | **Fixed** — tokens carry a 30-day TTL and every member request/connection is checked against the live roster (`Hub.memberActive`), so removal revokes immediately. |
| H2 | High | The push/webhook endpoint was server-fetched with no host checks → SSRF (cloud metadata, internal IPs). | **Fixed** — `isSafePushEndpoint` allows only public `https` and blocks loopback/private/CGNAT/link-local/metadata + IPv6 ULA (unit-tested). |
| M1 | Med | `Notifier` per-tenant dedup/rate maps grew unbounded (slow leak). | **Fixed** — `Notifier.sweep()` evicts idle entries hourly. |
| M2 | Med | Dev-open auth (no secret) gated only on `NODE_ENV==='production'`; a staging deploy could be wide open. | **Fixed** — fails closed unless `GLANCE_AUTH_SECRET` is set in any non-local `NODE_ENV`. |
| M3 | Med | Stripe webhook never stored the customer id → the billing portal always failed. | **Fixed** — `planChangeFromEvent` captures `customer`; passed through `setPlan` (tested). |
| M4 | Med | `parseChannels` built an unbounded intermediate array (bounded only by the 256 KB body). | **Fixed** — capped to 50 source channels. |
| L1 | Low | `X-Forwarded-For` (when `GLANCE_TRUST_PROXY=1`) uses the left-most hop. | **Accepted** — documented: use behind exactly one trusted proxy. |
| L2 | Low | `/metrics` is unauthenticated. | **Accepted** — acceptable when exposed only on the internal network; gate by network policy or a bearer token if public. |
| L3 | Low | `pace` entitlement relies on `applyPlanLimits` always being called on read. | **Accepted** — holds today (Hub always clamps); defense-in-depth note. |

## What's solid (verified)

- **Tenant isolation** is structural: every operation is keyed by the token-resolved tenant,
  and all file paths sanitize the tenant/id segment (`[^a-zA-Z0-9_-]` stripped) — no path
  traversal. Broadcasts are per-tenant rooms.
- **Auth**: HMAC-SHA256 tokens, constant-time compare with length pre-check, strict
  part/role validation, expiry enforced; Stripe signatures verified constant-time with
  replay tolerance.
- **Secrets**: OAuth tokens sealed with AES-256-GCM (random IV, tag verified); no secrets in
  logs.
- **SQL** fully parameterized with a fixed table-name constant.
- **DoS controls**: global + per-tenant connection caps, per-frame and body size caps,
  per-client backpressure, ping/pong reaping, slowloris timeouts, token-bucket rate limits
  with eviction, origin allow-list, security headers.
- **Input validation** centralized in `normalizeEngineSettings` (bounds/clamps, https-only
  URLs) with an explicit settings key allow-list that never spreads raw client input; plan
  limits clamp on top.
- **Error handling** is fail-soft throughout; no unhandled-rejection landmines found.

## Verdict

Cleared for launch on the security spine. The two HIGH items (revocable member access, push
SSRF) are fixed and tested; the remaining accepted items are operational notes, not blockers.
Scale follow-ups (not blockers): move the push device store and team roster to Postgres/Redis
with caching so the member-revocation check and notifier fan-out don't hit the filesystem per
request at high tenant counts.
