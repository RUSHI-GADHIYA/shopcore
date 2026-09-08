import { enqueue } from './index.js';
import { INVOICE_JOBS, QUEUE_NAMES } from '../job-types.js';

/**
 * Invoice generation (spec §13). Rendering a PDF is slow and entirely
 * uninteresting to the caller, so it happens after the response has gone out.
 */
export const invoiceQueue = {
  generate: (payload) => enqueue(QUEUE_NAMES.INVOICE, INVOICE_JOBS.GENERATE, payload),
};

export default invoiceQueue;
