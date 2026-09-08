import asyncHandler from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/ApiResponse.js';
import { MockPaymentProvider } from './providers/mock-payment.provider.js';
import * as paymentService from './payment.service.js';

export const initiatePayment = asyncHandler(async (req, res) => {
  const result = await paymentService.initiatePayment({
    actor: req.user,
    orderId: req.body.order,
  });

  return sendCreated(res, {
    data: result,
    message: result.reused ? 'Resuming the payment already in progress' : 'Payment initiated',
  });
});

export const getPayment = asyncHandler(async (req, res) => {
  const payment = await paymentService.getPaymentForOrder({
    actor: req.user,
    orderId: req.params.orderId,
  });

  return sendSuccess(res, { data: { payment } });
});

/**
 * The gateway callback. Authenticated by signature rather than by a session,
 * which is why it needs the raw body: re-serialising the parsed JSON would
 * change the bytes the signature was computed over.
 */
export const webhook = asyncHandler(async (req, res) => {
  const result = await paymentService.handleWebhook({
    rawBody: req.rawBody,
    signature: req.get('x-shopcore-signature'),
  });

  // Always 200 on a handled event, duplicate or not: anything else makes the
  // gateway retry an event that was already applied.
  return sendSuccess(res, {
    data: { received: true, duplicate: result.duplicate },
    message: result.duplicate ? 'Event already processed' : 'Event processed',
  });
});

/**
 * Development helper: signs a webhook payload server-side and runs it through
 * the same handler a real gateway callback uses.
 *
 * A browser cannot do this itself, because signing needs PAYMENT_WEBHOOK_SECRET
 * and that must never reach a client. The route is not registered at all when
 * NODE_ENV=production, so this cannot be used to forge a payment in a live
 * deployment — it takes no shortcut through the verification either, it just
 * produces a genuinely signed request.
 */
export const simulateWebhook = asyncHandler(async (req, res) => {
  const payload = {
    event: `payment.${req.body.outcome}`,
    data: { providerRef: req.body.providerRef, reason: req.body.reason },
  };

  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');

  const result = await paymentService.handleWebhook({
    rawBody,
    signature: MockPaymentProvider.sign(rawBody),
  });

  return sendSuccess(res, {
    data: { simulated: payload, duplicate: result.duplicate, order: result.order },
    message: `Simulated ${payload.event}`,
  });
});
