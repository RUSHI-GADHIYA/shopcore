import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import logger from '../config/logger.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { getQueueRedis, disconnectRedis } from '../config/redis.js';
import { QUEUE_NAMES } from './job-types.js';
import { handlerFor } from './handlers/index.js';

/**
 * Worker process entry point (`npm run worker`).
 *
 * Run separately from the API so a burst of PDF rendering cannot starve HTTP
 * requests of event-loop time. The handlers themselves are shared, so a job
 * behaves identically whether a worker or the inline fallback runs it.
 */
const CONCURRENCY = { [QUEUE_NAMES.EMAIL]: 5, [QUEUE_NAMES.INVOICE]: 2 };

function createWorker(name) {
  const worker = new Worker(name, (job) => handlerFor(name)(job), {
    connection: getQueueRedis(),
    prefix: env.QUEUE_PREFIX,
    concurrency: CONCURRENCY[name] ?? 1,
  });

  worker.on('completed', (job) =>
    logger.info('Job completed', { queue: name, job: job.name, id: job.id })
  );
  worker.on('failed', (job, error) =>
    logger.error('Job failed', {
      queue: name,
      job: job?.name,
      id: job?.id,
      attempts: job?.attemptsMade,
      error: error.message,
    })
  );

  return worker;
}

async function start() {
  if (!env.QUEUE_ENABLED) {
    logger.warn(
      'QUEUE_ENABLED is false — jobs run inline in the API process, so this worker has nothing to do.'
    );
    process.exit(0);
  }

  await connectDatabase();

  const workers = Object.values(QUEUE_NAMES).map(createWorker);
  logger.info('Workers started', { queues: Object.values(QUEUE_NAMES) });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, draining workers`);
    // `close()` waits for in-flight jobs, so a deploy does not abandon a
    // half-sent email.
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  logger.error('Worker failed to start', { error: error.message, stack: error.stack });
  process.exit(1);
});
