import { env } from '../../config/env.js';
import logger from '../../config/logger.js';
import { sendMail } from '../../modules/notifications/mailer.js';
import { EMAIL_JOBS } from '../job-types.js';

/**
 * Renders and sends every transactional email (spec §12).
 *
 * Templates live here rather than in the services that trigger them, so the
 * wording of an order confirmation is one file to find, and a service only has
 * to know the data the template needs.
 */
const layout = (heading, body) =>
  `<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#222;max-width:600px">
    <h2 style="margin:0 0 16px">${escapeHtml(heading)}</h2>
    ${body}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="color:#666;font-size:12px">ShopCore — this is an automated message.</p>
  </div>`;

const money = (amount) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);

/** Order lines never reach a template unescaped: product names are seller input. */
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
}

function itemsTable(items = []) {
  const rows = items
    .map(
      (item) => `<tr>
        <td style="padding:6px 0">${escapeHtml(item.name)} <span style="color:#888">(${escapeHtml(item.sku)})</span></td>
        <td style="padding:6px 0;text-align:center">${item.quantity}</td>
        <td style="padding:6px 0;text-align:right">${money(item.lineTotal)}</td>
      </tr>`
    )
    .join('');

  return `<table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="border-bottom:1px solid #ddd;text-align:left">
      <th style="padding:6px 0">Item</th><th style="text-align:center">Qty</th><th style="text-align:right">Total</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

const templates = {
  [EMAIL_JOBS.VERIFY_EMAIL]: ({ name, token }) => {
    const url = `${env.PUBLIC_BASE_URL}/api/${env.API_VERSION}/auth/verify-email/${token}`;
    return {
      subject: 'Verify your ShopCore email address',
      text: `Hi ${name}, confirm your email address: ${url}`,
      html: layout(
        `Welcome, ${name}`,
        `<p>Confirm your email address to finish setting up your account.</p>
         <p><a href="${url}">Verify email</a></p>
         <p>This link expires in ${env.EMAIL_VERIFY_EXPIRY_HOURS} hours.</p>`
      ),
    };
  },

  [EMAIL_JOBS.PASSWORD_RESET]: ({ name, token }) => {
    const url = `${env.PUBLIC_BASE_URL}/reset-password/${token}`;
    return {
      subject: 'Reset your ShopCore password',
      text: `Hi ${name}, reset your password: ${url}`,
      html: layout(
        'Password reset',
        `<p>Hi ${escapeHtml(name)}, we received a request to reset your password.</p>
         <p><a href="${url}">Choose a new password</a></p>
         <p>This link expires in ${env.PASSWORD_RESET_EXPIRY_MINUTES} minutes. If you did not ask
         for this, you can safely ignore this email.</p>`
      ),
    };
  },

  [EMAIL_JOBS.PASSWORD_CHANGED]: ({ name }) => ({
    subject: 'Your ShopCore password was changed',
    text: `Hi ${name}, your password was just changed.`,
    html: layout(
      'Password changed',
      `<p>Hi ${escapeHtml(name)}, your password was just changed. If this wasn't you, reset it immediately.</p>`
    ),
  }),

  [EMAIL_JOBS.ORDER_CONFIRMATION]: ({ name, order }) => ({
    subject: `Order ${order.reference} confirmed`,
    text: `Hi ${name}, we've received your order ${order.reference} for ${money(order.total)}.`,
    html: layout(
      'Thanks for your order',
      `<p>Hi ${escapeHtml(name)}, your payment has gone through and order
       <strong>${escapeHtml(order.reference)}</strong> is confirmed.</p>
       ${itemsTable(order.items)}
       <p style="text-align:right;margin-top:16px">
         Subtotal: ${money(order.subtotal)}<br>
         ${order.discount ? `Discount: −${money(order.discount)}<br>` : ''}
         ${order.tax ? `Tax: ${money(order.tax)}<br>` : ''}
         ${order.shippingFee ? `Shipping: ${money(order.shippingFee)}<br>` : ''}
         <strong>Total: ${money(order.total)}</strong>
       </p>`
    ),
  }),

  [EMAIL_JOBS.ORDER_STATUS_CHANGED]: ({ name, reference, status, note }) => ({
    subject: `Order ${reference} is now ${status.toLowerCase()}`,
    text: `Hi ${name}, order ${reference} is now ${status}.${note ? ` ${note}` : ''}`,
    html: layout(
      `Order ${status.toLowerCase()}`,
      `<p>Hi ${escapeHtml(name)}, your order <strong>${escapeHtml(reference)}</strong> is now
       <strong>${escapeHtml(status)}</strong>.</p>
       ${note ? `<p>${escapeHtml(note)}</p>` : ''}`
    ),
  }),

  [EMAIL_JOBS.LOW_STOCK_ALERT]: ({ name, productName, sku, remaining }) => ({
    subject: `Low stock: ${productName} (${sku})`,
    text: `Hi ${name}, ${productName} (${sku}) is down to ${remaining} in stock.`,
    html: layout(
      'Low stock warning',
      `<p>Hi ${escapeHtml(name)}, <strong>${escapeHtml(productName)}</strong>
       (${escapeHtml(sku)}) is down to <strong>${remaining}</strong> in stock.</p>
       <p>Restock it to keep it listed as available.</p>`
    ),
  }),
};

/** Entry point a BullMQ worker (or the inline fallback) calls. */
export async function handleEmailJob(job) {
  const template = templates[job.name];

  if (!template) {
    // Throwing would retry forever; an unknown job name is a code bug, not a
    // transient failure.
    logger.error('No template for email job', { job: job.name });
    return { skipped: true };
  }

  const { to } = job.data;
  if (!to) throw new Error(`Email job ${job.name} has no recipient`);

  const rendered = template(job.data);
  await sendMail({ to, ...rendered });

  return { sent: true, to, subject: rendered.subject };
}

export default handleEmailJob;
