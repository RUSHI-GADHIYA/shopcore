import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import logger from '../../config/logger.js';
import ApiError from '../../utils/ApiError.js';
import { emailQueue } from '../../jobs/queues/email.queue.js';
import { invoiceQueue } from '../../jobs/queues/invoice.queue.js';
import { Order } from '../orders/order.model.js';
import { ORDER_STATUS, canTransition } from '../orders/order.state-machine.js';
import { ROLES } from '../users/user.model.js';
import { Payment, PAYMENT_STATUS } from './payment.model.js';
import { getPaymentProvider } from './providers/index.js';

/**
 * Payment orchestration (spec §10).
 *
 * The shape worth noticing is that nothing here confirms a payment
 * synchronously. `initiate` only records an intent; the order becomes PAID when
 * the gateway calls back. That is how real gateways work, and building against
 * it from the start means swapping the mock for Stripe changes one adapter.
 */

export async function initiatePayment({ actor, orderId }) {
  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound('Order not found');

  if (String(order.user) !== String(actor._id) && actor.role !== ROLES.ADMIN) {
    throw ApiError.forbidden('You can only pay for your own orders');
  }

  if (order.status !== ORDER_STATUS.PENDING) {
    throw ApiError.badRequest(`Order ${order.reference} is ${order.status} and cannot be paid for`);
  }

  // Re-use an outstanding attempt rather than minting a second one: two open
  // intents against one order is how a customer gets charged twice.
  const existing = await Payment.findOne({
    order: order._id,
    status: PAYMENT_STATUS.INITIATED,
  });

  if (existing) {
    return {
      payment: existing.toJSON(),
      checkoutUrl: `${env.PUBLIC_BASE_URL}/mock-checkout/${existing.providerRef}`,
      reused: true,
    };
  }

  const provider = getPaymentProvider();
  const intent = await provider.initiate(order);

  const payment = await Payment.create({
    order: order._id,
    provider: provider.name,
    providerRef: intent.providerRef,
    // The amount comes from the order the server priced, never from the client.
    amount: order.total,
    status: PAYMENT_STATUS.INITIATED,
  });

  order.payment = payment._id;
  await order.save();

  logger.info('Payment initiated', { orderId: String(order._id), providerRef: intent.providerRef });

  return {
    payment: payment.toJSON(),
    checkoutUrl: intent.checkoutUrl,
    clientSecret: intent.clientSecret,
  };
}

/**
 * Processes a verified gateway callback.
 *
 * Idempotent by design: gateways retry until they get a 2xx, so the same event
 * will arrive more than once and must not move the order twice or send two
 * confirmation emails.
 */
export async function handleWebhook({ rawBody, signature }) {
  const provider = getPaymentProvider();

  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    logger.warn('Rejected a webhook with an invalid signature');
    throw ApiError.unauthorized('Invalid webhook signature', { code: 'INVALID_SIGNATURE' });
  }

  let event;
  try {
    event = provider.parseWebhook(JSON.parse(rawBody.toString('utf8')));
  } catch (error) {
    throw ApiError.badRequest(`Malformed webhook payload: ${error.message}`);
  }

  const payment = await Payment.findOne({ providerRef: event.providerRef });
  if (!payment) throw ApiError.notFound('No payment matches that reference');

  if (payment.processedAt) {
    logger.info('Ignoring a webhook that was already processed', {
      providerRef: event.providerRef,
    });
    return { payment: payment.toJSON(), duplicate: true };
  }

  const order = await Order.findById(payment.order);
  if (!order) throw ApiError.notFound('The order for that payment no longer exists');

  const nextOrderStatus = {
    SUCCESS: ORDER_STATUS.PAID,
    FAILED: ORDER_STATUS.PAYMENT_FAILED,
    REFUNDED: ORDER_STATUS.REFUNDED,
  }[event.outcome];

  // A late callback for an order that has already moved on (cancelled, say)
  // still gets recorded against the payment, but must not drag the order
  // backwards through an illegal transition.
  const orderMoves = canTransition(order.status, nextOrderStatus);

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      payment.status = PAYMENT_STATUS[event.outcome];
      payment.rawResponse = JSON.parse(rawBody.toString('utf8'));
      payment.processedAt = new Date();
      payment.failureReason = event.reason ?? null;
      await payment.save({ session });

      if (orderMoves) {
        order.status = nextOrderStatus;
        order.statusHistory.push({
          status: nextOrderStatus,
          changedAt: new Date(),
          changedBy: null,
          note: `Payment ${event.outcome.toLowerCase()} (${event.providerRef})`,
        });
        await order.save({ session });
      }
    });
  } finally {
    await session.endSession();
  }

  if (!orderMoves) {
    logger.warn('Payment callback recorded but the order could not move', {
      providerRef: event.providerRef,
      orderStatus: order.status,
      attempted: nextOrderStatus,
    });
  }

  // Side effects happen after the transaction commits: a queued email must
  // never be sent for a database write that then rolled back.
  if (orderMoves && event.outcome === 'SUCCESS') await onPaymentSucceeded(order);

  return { payment: payment.toJSON(), order: order.toJSON(), duplicate: false };
}

/** Fan-out once an order is genuinely paid for (spec §12, §13). */
async function onPaymentSucceeded(order) {
  const populated = await Order.findById(order._id).populate('user', 'name email').lean();
  if (!populated?.user) return;

  await Promise.all([
    emailQueue.orderConfirmation({
      to: populated.user.email,
      name: populated.user.name,
      order: {
        reference: populated.reference,
        items: populated.items,
        subtotal: populated.subtotal,
        discount: populated.discount,
        tax: populated.tax,
        shippingFee: populated.shippingFee,
        total: populated.total,
      },
    }),
    invoiceQueue.generate({ orderId: String(populated._id) }),
  ]);
}

export async function getPaymentForOrder({ actor, orderId }) {
  const order = await Order.findById(orderId).select('user').lean();
  if (!order) throw ApiError.notFound('Order not found');

  if (String(order.user) !== String(actor._id) && actor.role !== ROLES.ADMIN) {
    throw ApiError.forbidden('You do not have access to this payment');
  }

  const payment = await Payment.findOne({ order: orderId }).sort({ createdAt: -1 }).lean();
  if (!payment) throw ApiError.notFound('No payment has been started for this order');

  return payment;
}
