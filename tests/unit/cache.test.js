import { jest } from '@jest/globals';
import {
  __setCacheClient,
  buildKey,
  cacheAside,
  cacheDel,
  cacheDelPattern,
  cacheGet,
  cacheSet,
} from '../../src/utils/cache.js';

/**
 * A minimal in-memory stand-in for the handful of Redis commands the cache
 * helpers use. `scan` walks the keyspace in small pages so the pattern-delete
 * loop is genuinely exercised rather than short-circuited.
 */
function createFakeRedis() {
  const store = new Map();
  // Redis guarantees a key present for the whole scan is returned at least
  // once, even as other keys are deleted underneath it. Snapshotting the
  // keyspace when the cursor resets reproduces that; iterating the live map
  // would skip entries as the caller deletes each page.
  let snapshot = [];

  return {
    store,
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
      return 'OK';
    },
    del: async (...keys) => {
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    },
    scan: async (cursor, _match, pattern, _count, size) => {
      if (cursor === '0') snapshot = [...store.keys()];

      const start = Number(cursor);
      const page = snapshot.slice(start, start + size).filter((key) => store.has(key));
      const next = start + size >= snapshot.length ? '0' : String(start + size);

      const regex = new RegExp(
        `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
      );
      return [next, page.filter((key) => regex.test(key))];
    },
  };
}

let redis;

beforeEach(() => {
  redis = createFakeRedis();
  __setCacheClient(redis);
});

afterEach(() => __setCacheClient(null));

describe('buildKey', () => {
  it('is stable regardless of property order', () => {
    expect(buildKey('products:list', { page: 1, sort: 'price' })).toBe(
      buildKey('products:list', { sort: 'price', page: 1 })
    );
  });

  it('distinguishes different filters', () => {
    expect(buildKey('products:list', { page: 1 })).not.toBe(buildKey('products:list', { page: 2 }));
  });

  it('keeps the key short no matter how long the query is', () => {
    const key = buildKey('products:list', { q: 'x'.repeat(5000) });

    expect(key.length).toBeLessThan(40);
    expect(key.startsWith('products:list:')).toBe(true);
  });
});

describe('get / set', () => {
  it('round-trips a structured value', async () => {
    await cacheSet('k', { items: [1, 2], meta: { total: 2 } }, 60);

    expect(await cacheGet('k')).toEqual({ items: [1, 2], meta: { total: 2 } });
  });

  it('reports a miss as null', async () => {
    expect(await cacheGet('absent')).toBeNull();
  });

  it('sets an expiry so nothing is cached forever', async () => {
    const spy = jest.spyOn(redis, 'set');

    await cacheSet('k', 'v', 300);

    expect(spy).toHaveBeenCalledWith('k', '"v"', 'EX', 300);
  });
});

describe('failure handling', () => {
  it('treats a read error as a miss rather than throwing', async () => {
    redis.get = async () => {
      throw new Error('connection refused');
    };

    await expect(cacheGet('k')).resolves.toBeNull();
  });

  it('treats a write error as a no-op rather than throwing', async () => {
    redis.set = async () => {
      throw new Error('connection refused');
    };

    await expect(cacheSet('k', 'v', 60)).resolves.toBe(false);
  });

  it('still serves data from the loader when the cache is down', async () => {
    redis.get = async () => {
      throw new Error('connection refused');
    };
    redis.set = async () => {
      throw new Error('connection refused');
    };

    await expect(cacheAside('k', 60, async () => 'fresh')).resolves.toBe('fresh');
  });
});

describe('cacheDelPattern', () => {
  it('removes only the matching namespace', async () => {
    await cacheSet('products:list:a', 1, 60);
    await cacheSet('products:list:b', 2, 60);
    await cacheSet('products:detail:x', 3, 60);
    await cacheSet('categories:tree', 4, 60);

    const removed = await cacheDelPattern('products:list:*');

    expect(removed).toBe(2);
    expect([...redis.store.keys()].sort()).toEqual(['categories:tree', 'products:detail:x']);
  });

  it('pages through a keyspace larger than one scan batch', async () => {
    for (let i = 0; i < 500; i += 1) await cacheSet(`products:list:${i}`, i, 60);

    expect(await cacheDelPattern('products:list:*')).toBe(500);
    expect(redis.store.size).toBe(0);
  });
});

describe('cacheAside', () => {
  it('runs the loader once and serves the second call from cache', async () => {
    const loader = jest.fn(async () => ({ value: 42 }));

    const first = await cacheAside('k', 60, loader);
    const second = await cacheAside('k', 60, loader);

    expect(first).toEqual({ value: 42 });
    expect(second).toEqual({ value: 42 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('does not cache a null result, so a miss is retried', async () => {
    const loader = jest.fn(async () => null);

    await cacheAside('k', 60, loader);
    await cacheAside('k', 60, loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('cacheDel', () => {
  it('is a no-op when given no keys', async () => {
    await cacheSet('k', 'v', 60);

    expect(await cacheDel()).toBe(0);
    expect(redis.store.size).toBe(1);
  });
});
