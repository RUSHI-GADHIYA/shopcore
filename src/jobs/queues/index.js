import { Queue } from 'bullmq';
import { env } from '../../config/env.js';
import { getQueueRedis } from '../../config/redis.js';
import logger from '../../config/logger.js';
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '../job-types.js';

/**
 * Queue producers (spec §13).
 *
 * The controller pushes a job and returns immediately; a worker does the slow
 * part. The one twist is the inline fallback: with `QUEUE_ENABLED=false` there
 * is no Redis and no worker, so `enqueue` runs the handler in-process instead.
 * That keeps the app working for a developer who has not started Redis, and it
 * lets the test suite exercise the real handlers rather than assert that a mock
 * was called.
 */
const queues = new Map();

/** Lazily created so importing this module never opens a connection. */
export function getQueue(name) {
  if (!env.QUEUE_ENABLED) return null;

  if (!queues.has(name)) {
    queues.set(
      name,
      new Queue(name, {
        connection: getQueueRedis(),
        prefix: env.QUEUE_PREFIX,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      })
    );
  }

  return queues.get(name);
}

/**
 * Adds a job, or runs its handler inline when queueing is off.
 *
 * Never throws: a notification that cannot be scheduled must not fail the
 * request that triggered it. The order is placed either way.
 */
export async function enqueue(queueName, jobName, payload, options = {}) {
  const queue = getQueue(queueName);

  if (!queue) return runInline(queueName, jobName, payload);

  try {
    const job = await queue.add(jobName, payload, options);
    logger.debug('Job enqueued', { queue: queueName, job: jobName, id: job.id });
    return { queued: true, id: job.id };
  } catch (error) {
    logger.error('Failed to enqueue job, running it inline instead', {
      queue: queueName,
      job: jobName,
      error: error.message,
    });
    return runInline(queueName, jobName, payload);
  }
}

/**
 * Runs a job through the same handler a worker would use. Imported lazily to
 * keep a cycle from forming: handlers reach back into services that enqueue.
 */
async function runInline(queueName, jobName, payload) {
  try {
    const { handlerFor } = await import('../handlers/index.js');
    await handlerFor(queueName)({ name: jobName, data: payload });
    return { queued: false, inline: true };
  } catch (error) {
    logger.error('Inline job failed', { queue: queueName, job: jobName, error: error.message });
    return { queued: false, inline: true, failed: true };
  }
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}

export { QUEUE_NAMES };
