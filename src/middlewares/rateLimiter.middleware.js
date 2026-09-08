import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { getRedis } from '../config/redis.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

/**
 * Rate limiters (spec §9, §15).
 *
 * Counters live in Redis so the limit is shared across app instances — an
 * in-memory store would let an attacker get N times the allowance behind a load
 * balancer. When Redis is unreachable the limiter falls back to memory:
 * degraded limiting beats an outage.
 *
 * Two details here exist because getting them wrong takes the whole API down,
 * which is what happened the first time this shipped:
 *
 *  1. The store is chosen on the first request, not at import time.
 *     `new RedisStore()` loads a Lua script in its constructor, and against a
 *     client with `enableOfflineQueue: false` that command throws immediately.
 *     At import time there is nothing to catch it, so the process died on boot
 *     whenever Redis was not already up.
 *
 *  2. The choice is made from the client's actual connection status rather than
 *     by calling `connect()`. A `connect()` on a dead Redis retries on a
 *     schedule and can outlive the request that triggered it.
 */
function createStore(prefix) {
  try {
    const client = getRedis();

    // Not connected: `server.js` connects Redis before it listens, so a client
    // that is not ready by the first request means Redis is genuinely absent.
    if (client.status !== 'ready') {
      logger.warn('Redis is not connected; rate limiting falls back to in-memory counters', {
        prefix,
        status: client.status,
      });
      return undefined;
    }

    return new RedisStore({ prefix, sendCommand: (...args) => client.call(...args) });
  } catch (error) {
    logger.warn('Rate limiter falling back to in-memory counters', {
      prefix,
      error: error.message,
    });
    return undefined;
  }
}

/**
 * Builds the limiter on first use and reuses it thereafter.
 *
 * If the store itself fails mid-flight — a Redis blip after a healthy start —
 * the request is allowed through rather than 500ing. A rate limiter exists to
 * shed abuse, and failing open degrades that protection; failing closed would
 * take down every endpoint it guards, which is strictly worse.
 */
function buildLimiter({ prefix, windowMs, limit, message, keyGenerator }) {
  let limiter = null;

  return function rateLimitMiddleware(req, res, next) {
    limiter ??= rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: createStore(prefix),
      keyGenerator,
      handler: (_req, _res, done) => done(new ApiError(429, message)),
    });

    return limiter(req, res, (error) => {
      // A 429 from our own handler is the limiter working; anything else came
      // from the store and must not be allowed to fail the request.
      if (error && !(error instanceof ApiError)) {
        logger.error('Rate limiter store failed; allowing the request through', {
          prefix,
          error: error.message,
        });
        return next();
      }
      return next(error);
    });
  };
}

/** Applied to the whole API surface. */
export const globalLimiter = buildLimiter({
  prefix: 'rl:global:',
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  message: 'Too many requests, please try again later',
});

/**
 * Login / forgot-password. Keyed on IP *and* the submitted email so one attacker
 * cannot lock every user out of a shared NAT, and so credential stuffing across
 * many accounts from one IP still trips the limit.
 */
export const authLimiter = buildLimiter({
  prefix: 'rl:auth:',
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  message: 'Too many authentication attempts, please try again later',
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'anonymous';
    return `${req.ip}:${email}`;
  },
});

export default globalLimiter;
