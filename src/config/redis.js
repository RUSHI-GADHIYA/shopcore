/**
 * Redis clients.
 *
 * Two are exported because BullMQ requires a connection with
 * maxRetriesPerRequest set to null, while the cache/rate-limit client wants the
 * opposite: fail fast so a Redis hiccup degrades caching rather than hanging
 * an HTTP request.
 */
import Redis from 'ioredis';
import { env } from './env.js';
import logger from './logger.js';

let cacheClient = null;
let queueClient = null;

function createClient(name, overrides = {}) {
  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    ...overrides,
  });

  client.on('connect', () => logger.info(`Redis connected (${name})`));
  client.on('error', (error) => logger.error(`Redis error (${name})`, { error: error.message }));
  client.on('close', () => logger.warn(`Redis connection closed (${name})`));

  return client;
}

export function getRedis() {
  if (!cacheClient) cacheClient = createClient('cache');
  return cacheClient;
}

/** BullMQ needs blocking commands, so retries must be unlimited and offline queueing on. */
export function getQueueRedis() {
  if (!queueClient) {
    queueClient = createClient('queue', {
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
  }
  return queueClient;
}

export async function connectRedis() {
  const client = getRedis();
  if (client.status === 'wait') await client.connect();
  return client;
}

export async function disconnectRedis() {
  await Promise.all(
    [cacheClient, queueClient]
      .filter(Boolean)
      .map((client) => client.quit().catch(() => client.disconnect()))
  );
  cacheClient = null;
  queueClient = null;
}

export default getRedis;
