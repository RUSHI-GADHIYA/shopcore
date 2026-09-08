import { Router } from 'express';
import authenticate from '../../middlewares/auth.middleware.js';
import validate from '../../middlewares/validate.middleware.js';
import * as paymentController from './payment.controller.js';
import { initiatePaymentSchema, orderIdParamSchema, webhookSchema } from './payment.validation.js';

const router = Router();

// Public, but not unauthenticated: the signature check in the service is what
// authenticates it. Mounted before the auth middleware because a gateway has no
// bearer token.
/**
 * @openapi
 * /payments/webhook:
 *   post:
 *     tags: [Payments]
 *     summary: Gateway callback (signature-verified)
 *     description: >
 *       Authenticated by an HMAC-SHA256 signature over the raw request body
 *       rather than by a session. Idempotent: gateways retry until they see a
 *       2xx, so a repeated event returns 200 with `duplicate: true` and changes
 *       nothing. A late callback for an order that has moved on is recorded
 *       against the payment but cannot drag the order backwards.
 *     security: [{ webhookSignature: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [event, data]
 *             properties:
 *               event:
 *                 type: string
 *                 enum: [payment.succeeded, payment.failed, payment.refunded]
 *               data:
 *                 type: object
 *                 required: [providerRef]
 *                 properties:
 *                   providerRef: { type: string }
 *                   reason: { type: string }
 *     responses:
 *       200: { description: Event processed (or recognised as a duplicate) }
 *       401: { description: Missing or invalid signature }
 *       404: { description: No payment matches that reference }
 */
router.post('/webhook', validate({ body: webhookSchema }), paymentController.webhook);

router.use(authenticate);

/**
 * @openapi
 * /payments/initiate:
 *   post:
 *     tags: [Payments]
 *     summary: Start a payment for an order
 *     description: >
 *       Records an intent and returns a checkout URL; it does not confirm
 *       anything. The order becomes PAID only when the gateway calls the webhook.
 *       An outstanding attempt is reused rather than opening a second one.
 *       The amount comes from the order, never from the request.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [order]
 *             properties:
 *               order: { type: string }
 *     responses:
 *       201: { description: Payment intent created }
 *       400: { description: The order is not awaiting payment }
 *       403: { description: You can only pay for your own orders }
 */
router.post(
  '/initiate',
  validate({ body: initiatePaymentSchema }),
  paymentController.initiatePayment
);
/**
 * @openapi
 * /payments/{orderId}:
 *   get:
 *     tags: [Payments]
 *     summary: The latest payment for an order
 *     parameters:
 *       - { in: path, name: orderId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The payment }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { description: No payment has been started for that order }
 */
router.get('/:orderId', validate({ params: orderIdParamSchema }), paymentController.getPayment);

export default router;
