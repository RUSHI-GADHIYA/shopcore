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

/**
 * Closes every client.
 *
 * `quit()` sends a command and waits for the server to acknowledge it, so on a
 * client that never connected — or whose Redis has gone away — it simply never
 * settles, and the reconnect timer keeps the process alive. Anything not
 * actually connected is therefore torn down directly, and even a healthy quit
 * is bounded, so shutdown cannot hang on an unresponsive server.
 */
export async function disconnectRedis() {
  const clients = [cacheClient, queueClient].filter(Boolean);

  await Promise.all(
    clients.map(async (client) => {
      if (client.status !== 'ready') return client.disconnect();

      try {
        await Promise.race([
          client.quit(),
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('quit timed out')), 2_000).unref?.()
          ),
        ]);
      } catch {
        client.disconnect();
      }
      return undefined;
    })
  );

  cacheClient = null;
  queueClient = null;
}

export default getRedis;
