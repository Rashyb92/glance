/**
 * Tenant sharding + work-staggering for the multi-worker fleet. A worker owns only the
 * tenants whose shard it is assigned, so 20k creators spread deterministically across
 * stateless workers (consistent hashing). Pure + unit-tested.
 */

/** FNV-1a 32-bit hash — fast, deterministic, well-distributed for short keys. */
export function hash32(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function shardFor(key: string, shards: number): number {
  if (shards <= 1) return 0;
  return hash32(key) % shards;
}

export function ownsShard(key: string, shardIndex: number, totalShards: number): boolean {
  return shardFor(key, totalShards) === shardIndex;
}

/**
 * Deterministic offset in [0, windowMs) used to stagger periodic work (e.g. YouTube
 * polls) so a worker's tenants don't all fire at the same instant.
 */
export function staggerOffset(key: string, windowMs: number): number {
  return windowMs > 0 ? hash32(key) % windowMs : 0;
}
