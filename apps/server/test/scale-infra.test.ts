import { describe, it, expect } from 'vitest';
import { hash32, ownsShard, shardFor, staggerOffset } from '../src/sharding';
import { ConnectionPool } from '../src/pool';

describe('sharding', () => {
  it('is deterministic', () => {
    expect(hash32('acme')).toBe(hash32('acme'));
    expect(shardFor('acme', 8)).toBe(shardFor('acme', 8));
  });

  it('keeps shards in range and distributes across them', () => {
    const counts = new Array<number>(8).fill(0);
    for (let i = 0; i < 4000; i++) {
      const s = shardFor(`tenant-${i}`, 8);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(8);
      counts[s] = (counts[s] ?? 0) + 1;
    }
    // Each of 8 shards should get a non-trivial slice of 4000 (rough balance).
    for (const c of counts) expect(c).toBeGreaterThan(4000 / 8 / 3);
  });

  it('ownsShard agrees with shardFor', () => {
    const s = shardFor('bob', 4);
    expect(ownsShard('bob', s, 4)).toBe(true);
    expect(ownsShard('bob', (s + 1) % 4, 4)).toBe(false);
  });

  it('staggerOffset stays within the window and is deterministic', () => {
    expect(staggerOffset('acme', 5000)).toBe(staggerOffset('acme', 5000));
    expect(staggerOffset('acme', 5000)).toBeLessThan(5000);
    expect(staggerOffset('acme', 0)).toBe(0);
  });
});

describe('ConnectionPool', () => {
  it('reuses, caps, and releases', () => {
    const pool = new ConnectionPool<{ id: string }>(2);
    let made = 0;
    const factory = (id: string) => (): { id: string } => {
      made += 1;
      return { id };
    };

    const a = pool.ensure('a', factory('a'));
    const a2 = pool.ensure('a', factory('a')); // reuse — no new connection
    expect(a).toBe(a2);
    expect(made).toBe(1);

    pool.ensure('b', factory('b'));
    expect(pool.atCapacity()).toBe(true);
    expect(pool.ensure('c', factory('c'))).toBeNull(); // refused at capacity
    expect(pool.size()).toBe(2);

    pool.release('a');
    expect(pool.has('a')).toBe(false);
    expect(pool.ensure('c', factory('c'))).not.toBeNull(); // room again
  });
});
