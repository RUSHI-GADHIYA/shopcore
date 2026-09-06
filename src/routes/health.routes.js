import { Router } from 'express';
import mongoose from 'mongoose';
import { sendSuccess } from '../utils/ApiResponse.js';
import { getRedis } from '../config/redis.js';
import { env } from '../config/env.js';

const router = Router();

/** Liveness: the process is up. Deliberately dependency-free so a Mongo outage
 *  does not cause an orchestrator to restart a perfectly healthy container. */
router.get('/', (_req, res) =>
  sendSuccess(res, {
    data: { status: 'ok', uptime: Math.floor(process.uptime()), env: env.NODE_ENV },
  })
);

/** Readiness: the process can actually serve traffic. */
router.get('/ready', async (_req, res) => {
  const [mongo, redis] = await Promise.all([checkMongo(), checkRedis()]);
  const ready = mongo.ok && redis.ok;

  return res.status(ready ? 200 : 503).json({
    success: ready,
    data: { status: ready ? 'ready' : 'degraded', checks: { mongo, redis } },
  });
});

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
    if (client.status === 'wait') await client.connect();
    await client.ping();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export default router;
