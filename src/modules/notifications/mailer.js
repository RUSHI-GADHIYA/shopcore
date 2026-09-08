import nodemailer from 'nodemailer';
import { env, isProduction } from '../../config/env.js';
import logger from '../../config/logger.js';

/**
 * Low-level SMTP transport (spec §12).
 *
 * Without SMTP credentials configured the mailer logs what it *would* have sent
 * instead of failing, so local development and tests need no mail server. In
 * production a missing configuration is a real misconfiguration, so it throws.
 *
 * Nothing calls this directly: transactional mail goes through the email queue
 * (`jobs/queues/email.queue.js`), whose handler owns the templates and calls
 * this only from a worker, so an SMTP stall never blocks a request.
 */
let transporter = null;

export function isMailConfigured() {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
}

export async function sendMail({ to, subject, html, text }) {
  if (!isMailConfigured()) {
    if (isProduction) {
      throw new Error('SMTP is not configured; cannot send transactional email');
    }

    logger.info('Email suppressed (SMTP not configured)', { to, subject, text });
    return { suppressed: true };
  }

  const info = await getTransporter().sendMail({
    from: env.EMAIL_FROM,
    to,
    subject,
    text,
    html,
  });

  logger.info('Email sent', { to, subject, messageId: info.messageId });
  return info;
}

/** Test hook: lets a suite swap in a stub transport. */
export function __setTransporter(next) {
  transporter = next;
}
