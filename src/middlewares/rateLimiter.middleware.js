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
 * The timing of construction matters more than it looks, and there is exactly
 * one moment that works:
 *
 *  - Not at import. `new RedisStore()` loads a Lua script in its constructor,
 *    and against a client with `enableOfflineQueue: false` that throws
 *    immediately. At import there is nothing to catch it, so the process died
 *    on boot whenever Redis was not already up.
 *  - Not inside a request. express-rate-limit refuses to be built in a request
 *    handler (ERR_ERL_CREATED_IN_REQUEST_HANDLER), which would leave every
 *    request erroring and the limit silently unenforced.
 *
 * So they are built by `initRateLimiters()`, which `createApp()` calls — after
 * `server.js` has connected Redis, and before the first request. The exported
 * middleware delegates to whatever is current, defaulting to a memory-backed
 * limiter built at import (safe, because it touches no I/O).
 */
function createStore(prefix) {
  try {
    const client = getRedis();

    // `server.js` connects Redis before it listens, so a client that is not
    // ready by now means Redis is genuinely absent. Checking status rather than
    // calling connect() matters: connect() on a dead Redis retries on a
    // schedule and would stall startup.
    if (client.status !== 'ready') {
      logger.warn('Redis is not connected; rate limiting uses in-memory counters', {
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

const DEFINITIONS = {
  global: {
    prefix: 'rl:global:',
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    message: 'Too many requests, please try again later',
  },
  /**
   * Login / forgot-password. Keyed on IP *and* the submitted email so one
   * attacker cannot lock every user out of a shared NAT, and so credential
   * stuffing across many accounts from one IP still trips the limit.
   */
  auth: {
    prefix: 'rl:auth:',
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.AUTH_RATE_LIMIT_MAX,
    message: 'Too many authentication attempts, please try again later',
    keyGenerator: (req) => {
      const email =
        typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'anonymous';
      return `${req.ip}:${email}`;
    },
  },
};

function build({ windowMs, limit, message, keyGenerator }, store) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store,
    keyGenerator,
    handler: (_req, _res, next) => next(new ApiError(429, message)),
  });
}

// Memory-backed to begin with. Building these is pure bookkeeping, so it is
// safe at import and guarantees the exported middleware is always callable.
const limiters = {
  global: build(DEFINITIONS.global, undefined),
  auth: build(DEFINITIONS.auth, undefined),
};

/**
 * Rebuilds the limiters against Redis when it is available. Called by
 * `createApp()`; safe to call more than once.
 */
export function initRateLimiters() {
  for (const [name, definition] of Object.entries(DEFINITIONS)) {
    const store = createStore(definition.prefix);
    if (store) limiters[name] = build(definition, store);
  }

  return limiters;
}

/**
 * Delegates to the current limiter. A failure from the store itself lets the
 * request through rather than 500ing: a rate limiter exists to shed abuse, and
 * failing open degrades that protection, while failing closed would take down
 * every endpoint it guards.
 */
function delegate(name) {
  return function rateLimitMiddleware(req, res, next) {
    return limiters[name](req, res, (error) => {
      if (error && !(error instanceof ApiError)) {
        logger.error('Rate limiter failed; allowing the request through', {
          limiter: name,
          error: error.message,
        });
        return next();
      }
      return next(error);
    });
  };
}

/** Applied to the whole API surface. */
export const globalLimiter = delegate('global');

export const authLimiter = delegate('auth');

export default globalLimiter;
