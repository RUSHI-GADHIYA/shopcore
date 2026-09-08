import { QUEUE_NAMES } from '../job-types.js';
import { handleEmailJob } from './email.handler.js';
import { handleInvoiceJob } from './invoice.handler.js';

/**
 * One place mapping a queue to the function that processes its jobs, so the
 * BullMQ workers and the inline fallback cannot drift apart.
 */
const HANDLERS = {
  [QUEUE_NAMES.EMAIL]: handleEmailJob,
  [QUEUE_NAMES.INVOICE]: handleInvoiceJob,
};

export function handlerFor(queueName) {
  const handler = HANDLERS[queueName];
  if (!handler) throw new Error(`No handler registered for queue "${queueName}"`);
  return handler;
}

export { handleEmailJob, handleInvoiceJob };
