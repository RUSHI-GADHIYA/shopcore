/**
 * Job names, shared by the producers, the workers, and the tests.
 *
 * String literals scattered across three files is how a queue quietly stops
 * delivering: a typo in the producer enqueues a job no worker listens for.
 */
export const QUEUE_NAMES = Object.freeze({
  EMAIL: 'email',
  INVOICE: 'invoice',
});

export const EMAIL_JOBS = Object.freeze({
  VERIFY_EMAIL: 'verify-email',
  PASSWORD_RESET: 'password-reset',
  PASSWORD_CHANGED: 'password-changed',
  ORDER_CONFIRMATION: 'order-confirmation',
  ORDER_STATUS_CHANGED: 'order-status-changed',
  LOW_STOCK_ALERT: 'low-stock-alert',
});

export const INVOICE_JOBS = Object.freeze({
  GENERATE: 'generate-invoice',
});

/** Retry with backoff: a transient SMTP failure should not lose the message. */
export const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 24 * 3_600 },
});
