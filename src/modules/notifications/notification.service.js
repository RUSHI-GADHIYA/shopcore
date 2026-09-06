import { env } from '../../config/env.js';
import logger from '../../config/logger.js';
import { sendMail } from './mailer.js';

/**
 * Transactional email content and dispatch (spec §12).
 *
 * `dispatch` is the seam where Phase 4 swaps a direct send for a BullMQ job:
 * everything above it already treats sending as fire-and-forget, so an SMTP
 * hiccup can never hang an API response.
 */
async function dispatch(message) {
  try {
    await sendMail(message);
  } catch (error) {
    // A failed notification must not fail the operation that triggered it.
    logger.error('Failed to send email', {
      to: message.to,
      subject: message.subject,
      error: error.message,
    });
  }
}

const layout = (heading, body) =>
  `<div style="font-family:system-ui,sans-serif;line-height:1.5">
    <h2>${heading}</h2>
    ${body}
    <p style="color:#666;font-size:12px">ShopCore — this is an automated message.</p>
  </div>`;

export function sendVerificationEmail({ to, name, token }) {
  const url = `${env.PUBLIC_BASE_URL}/api/${env.API_VERSION}/auth/verify-email/${token}`;

  return dispatch({
    to,
    subject: 'Verify your ShopCore email address',
    text: `Hi ${name}, confirm your email address: ${url}`,
    html: layout(
      `Welcome, ${name}`,
      `<p>Confirm your email address to finish setting up your account.</p>
       <p><a href="${url}">Verify email</a></p>
       <p>This link expires in ${env.EMAIL_VERIFY_EXPIRY_HOURS} hours.</p>`
    ),
  });
}

export function sendPasswordResetEmail({ to, name, token }) {
  const url = `${env.PUBLIC_BASE_URL}/reset-password/${token}`;

  return dispatch({
    to,
    subject: 'Reset your ShopCore password',
    text: `Hi ${name}, reset your password: ${url}`,
    html: layout(
      'Password reset',
      `<p>Hi ${name}, we received a request to reset your password.</p>
       <p><a href="${url}">Choose a new password</a></p>
       <p>This link expires in ${env.PASSWORD_RESET_EXPIRY_MINUTES} minutes. If you did not ask for
       this, you can safely ignore the email.</p>`
    ),
  });
}

export function sendPasswordChangedEmail({ to, name }) {
  return dispatch({
    to,
    subject: 'Your ShopCore password was changed',
    text: `Hi ${name}, your password was just changed.`,
    html: layout(
      'Password changed',
      `<p>Hi ${name}, your password was just changed. If this wasn't you, reset it immediately.</p>`
    ),
  });
}
