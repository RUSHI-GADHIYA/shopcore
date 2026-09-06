import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env, isTest } from '../config/env.js';
import { getRedis } from '../config/redis.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

/**
 * Rate limiters (spec §9, §15).
 *
 * Counters live in Redis so the limit is shared across app instances — an
 * in-memory store would let an attacker get N times the allowance behind a load
 * balancer. If Redis is unavailable the store falls back to memory rather than
 * failing the request: degraded limiting beats an outage.
 */
function createStore(prefix) {
  if (isTest) return undefined;

  try {
    const client = getRedis();
    return new RedisStore({
      prefix,
      sendCommand: (...args) => client.call(...args),
    });
  } catch (error) {
    logger.warn('Rate limiter falling back to in-memory store', { error: error.message });
    return undefined;
  }
}

function buildLimiter({ prefix, windowMs, limit, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: createStore(prefix),
    keyGenerator,
    handler: (_req, _res, next) => next(new ApiError(429, message)),
  });
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
