import { Router } from 'express';
import mongoose from 'mongoose';
import { sendSuccess } from '../utils/ApiResponse.js';
import { getRedis } from '../config/redis.js';
import { env } from '../config/env.js';

const router = Router();

/**
 * How long a single dependency check may take before it is called degraded.
 *
 * A readiness probe that hangs is worse than one that reports a problem: the
 * orchestrator learns nothing and the request occupies a socket until it times
 * out. Whatever is wrong, this endpoint answers.
 */
const CHECK_TIMEOUT_MS = 2_000;

/** Liveness: the process is up. Deliberately dependency-free so a Mongo outage
 *  does not cause an orchestrator to restart a perfectly healthy container. */
router.get('/', (_req, res) =>
  sendSuccess(res, {
    data: { status: 'ok', uptime: Math.floor(process.uptime()), env: env.NODE_ENV },
  })
);

/** Readiness: the process can actually serve traffic. */
router.get('/ready', async (_req, res) => {
  const [mongo, redis] = await Promise.all([
    withTimeout(checkMongo(), 'mongo'),
    withTimeout(checkRedis(), 'redis'),
  ]);

  const ready = mongo.ok && redis.ok;

  return res.status(ready ? 200 : 503).json({
    success: ready,
    data: { status: ready ? 'ready' : 'degraded', checks: { mongo, redis } },
  });
});

/**
 * Resolves to a failed check rather than rejecting, so one unreachable
 * dependency cannot stop the other's result being reported.
 */
function withTimeout(promise, name) {
  let timer;

  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: `${name} check timed out` }),
      CHECK_TIMEOUT_MS
    );
    // Do not hold the event loop open for a check nobody is waiting on any more.
    timer.unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkMongo() {
  try {
    if (mongoose.connection.readyState !== 1) return { ok: false, error: 'not connected' };
    await mongoose.connection.db.admin().ping();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkRedis() {
  try {
    const client = getRedis();

    // `connect()` on a dead Redis retries on a schedule and can outlive the
    // request, so an idle client is reported as not-ready instead of waited on.
    if (client.status !== 'ready') {
      return { ok: false, error: `not connected (${client.status})` };
    }

    await client.ping();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export default router;
