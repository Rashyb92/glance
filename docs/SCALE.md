# Scaling Glance (toward 20k creators)

## The load is smaller than it looks

Viewers never connect to Glance — only the **creator's** render targets do (HUD,
dashboard, phone/watch, a teammate): ~1–5 sockets per creator. "Thousands of viewers
per stream" is irrelevant to Glance's connection count. The real load at 20k creators is:

1. **Ingest** — ~20k upstream chat connections (Twitch EventSub/IRC, YouTube polling, Kick Pusher).
2. **Scoring** — the aggregate message rate, scored by the deterministic engine (microseconds/msg).
3. **Fan-out** — ~60k small creator-side sockets.

The realtime path (chat → scored → creator's HUD) is **deterministic and cheap**, so it's
~150–300 ms end-to-end. **AI is off the critical path**: Claude only runs the periodic
summary/priority passes, async, best-effort, and metered by the per-plan daily cap — so
latency never depends on Claude, and AI cost scales with *paying creators × cadence*, not
message volume.

## Tenants are the unit of sharding

The multi-tenant `Hub` keeps every creator's pipeline independent, so you shard tenants
across stateless workers (consistent hashing `tenant → worker`), ~500–1000 creators each.
The seams that make this a swap, not a rewrite:

| Seam | In-process default | Multi-instance (built, tested) |
|------|--------------------|-------------------------------|
| `Bus` | `InProcessBus` | **`RedisBus`** (Redis pub/sub) |
| AI usage meter | `AiUsageMeter` | **`RedisUsageMeter`** (atomic INCR + TTL) |
| Rate limiter | `RateLimiter` | **`RedisRateLimiter`** (fixed window) |
| `Storage` / settings / tokens / teams / push | file-backed | Postgres (interfaces already abstract this) |

`RedisBus`, `RedisUsageMeter`, and `RedisRateLimiter` are implemented and unit-tested
(`apps/server/test/redis.test.ts`) against a minimal injected `RedisClient` interface, so
no `redis` dependency is needed until you deploy multi-instance.

## Wiring Redis (the adapter)

Add `redis` to `apps/server` deps, then a tiny adapter satisfying the interfaces in
`src/redis.ts` (node-redis v4 already matches them):

```ts
// apps/server/src/redis-client.ts
import { createClient } from 'redis';
import type { RedisCounters, RedisPubSub } from './redis';

export async function connectRedis(url: string): Promise<{
  publisher: RedisPubSub;
  subscriber: RedisPubSub;
  counters: RedisCounters;
}> {
  const client = createClient({ url });
  await client.connect();
  const subscriber = client.duplicate(); // a subscribed conn can't publish
  await subscriber.connect();
  return { publisher: client, subscriber, counters: client };
}
```

Then in `main.ts`, select by `REDIS_URL`:

```ts
let bus: Bus = new InProcessBus();
let usage: UsageMeter | undefined;
if (process.env['REDIS_URL']) {
  const { publisher, subscriber, counters } = await connectRedis(process.env['REDIS_URL']);
  bus = new RedisBus(publisher, subscriber);   // multi-instance fan-out
  usage = new RedisUsageMeter(counters);        // fleet-wide AI cap
}
// startGateway(port, hub, bus);  new Hub({ ..., usage });
```

The `Hub` already accepts an injected `usage` meter, and `canUseAi` is async-tolerant, so
the in-memory and Redis meters are interchangeable with no other change.

**Gateway rate limiting:** the gateway uses the in-memory `RateLimiter` (sync). With
sticky load balancing, per-instance limiting is usually fine. For fleet-wide limits, wire
`RedisRateLimiter` and make the two checks in `gateway.ts` (`handleHttp` and the WS
connection handler) `await` — a small, scoped change to the one hardened file.

## Capacity sketch

- **~20–40 worker nodes** (ingest + scoring), sharded by tenant. Scoring is embarrassingly parallel.
- **~5–10 gateway nodes** for the ~60k creator sockets (heartbeat + backpressure already in place).
- **Redis cluster** for the Bus + counters.
- **Postgres** (with read replicas) for durable state, behind the existing storage interfaces.

## What's left for true 20k scale

1. **Redis wiring** — adapter above (small; the primitives are built + tested). ✅ primitives done.
2. **Postgres implementations** behind `Storage` / `SettingsStore` / `TokenStore` / `PushStore` / etc.
3. **Connection pooling & sharding** for the 20k upstream readers — Twitch EventSub subscription
   pooling, YouTube poll staggering + idle backoff, Kick Pusher pooling. This is the real ops effort.
4. **Gateway async rate-limit** wiring (above) if you need fleet-wide limits.

Nothing here is exotic — it's standard horizontal infra, and the expensive/risky parts
(AI cost, tail latency) are already bounded by design.
