import { enqueue } from './index.js';
import { EMAIL_JOBS, QUEUE_NAMES } from '../job-types.js';

/**
 * Typed producers for the email queue (spec §12): transactional mail is queued,
 * never sent inline, so an SMTP hiccup cannot hang an API response.
 */
export const emailQueue = {
  verifyEmail: (payload) => enqueue(QUEUE_NAMES.EMAIL, EMAIL_JOBS.VERIFY_EMAIL, payload),
  passwordReset: (payload) => enqueue(QUEUE_NAMES.EMAIL, EMAIL_JOBS.PASSWORD_RESET, payload),
  passwordChanged: (payload) => enqueue(QUEUE_NAMES.EMAIL, EMAIL_JOBS.PASSWORD_CHANGED, payload),
  orderConfirmation: (payload) =>
    enqueue(QUEUE_NAMES.EMAIL, EMAIL_JOBS.ORDER_CONFIRMATION, payload),
  orderStatusChanged: (payload) =>
    enqueue(QUEUE_NAMES.EMAIL, EMAIL_JOBS.ORDER_STATUS_CHANGED, payload),
  lowStockAlert: (payload) => enqueue(QUEUE_NAMES.EMAIL, EMAIL_JOBS.LOW_STOCK_ALERT, payload),
};

export default emailQueue;
