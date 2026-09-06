import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { getRedis } from '../config/redis.js';
import logger from '../config/logger.js';

/**
 * Cache-aside helpers over Redis (spec §14).
 *
 * The governing rule is that the cache is an optimisation, never a dependency:
 * every operation swallows its own errors and reports a miss, so a Redis outage
 * degrades response times rather than taking the API down with it.
 */
let client = null;

function redis() {
  // An injected client wins, so a test can exercise these paths with caching
  // switched off everywhere else.
  if (client) return client;
  if (!env.CACHE_ENABLED) return null;

  client = getRedis();
  return client;
}

/**
 * Builds a namespaced key. Object parts are hashed rather than serialised
 * inline, so a long filter query cannot produce an unbounded key.
 */
export function buildKey(namespace, parts = {}) {
  const canonical = JSON.stringify(parts, Object.keys(parts).sort());
  const digest = crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16);
  return `${namespace}:${digest}`;
}

export async function cacheGet(key) {
  const connection = redis();
  if (!connection) return null;

  try {
    const raw = await connection.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logger.debug('Cache read failed', { key, error: error.message });
    return null;
  }
}

export async function cacheSet(key, value, ttlSeconds) {
  const connection = redis();
  if (!connection) return false;

  try {
    await connection.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    return true;
  } catch (error) {
    logger.debug('Cache write failed', { key, error: error.message });
    return false;
  }
}

export async function cacheDel(...keys) {
  const connection = redis();
  if (!connection || keys.length === 0) return 0;

  try {
    return await connection.del(...keys);
  } catch (error) {
    logger.debug('Cache delete failed', { keys, error: error.message });
    return 0;
  }
}

/**
 * Deletes every key matching a glob, e.g. `products:list:*` after a product
 * changes.
 *
 * Uses SCAN rather than KEYS: KEYS blocks the Redis event loop for the whole
 * keyspace, which is fine with ten keys and an outage with a million.
 */
export async function cacheDelPattern(pattern) {
  const connection = redis();
  if (!connection) return 0;

  try {
    let cursor = '0';
    let removed = 0;

    do {
      const [next, batch] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (batch.length) removed += await connection.del(...batch);
    } while (cursor !== '0');

    return removed;
  } catch (error) {
    logger.debug('Cache pattern delete failed', { pattern, error: error.message });
    return 0;
  }
}

/**
 * Read-through wrapper: return the cached value, or run `loader`, cache what it
 * produces, and return that. A loader returning null/undefined is not cached —
 * caching a miss would turn a transient failure into a five-minute one.
 */
export async function cacheAside(key, ttlSeconds, loader) {
  const hit = await cacheGet(key);
  if (hit !== null) return hit;

  const value = await loader();
  if (value !== null && value !== undefined) await cacheSet(key, value, ttlSeconds);

  return value;
}

/** Test hook: swap in a stub client, or pass null to reset. */
export function __setCacheClient(next) {
  client = next;
}
