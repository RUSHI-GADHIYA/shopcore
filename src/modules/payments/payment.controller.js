import asyncHandler from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/ApiResponse.js';
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
