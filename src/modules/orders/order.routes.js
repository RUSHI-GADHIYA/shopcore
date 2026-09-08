import { Router } from 'express';
import authenticate from '../../middlewares/auth.middleware.js';
import authorize from '../../middlewares/rbac.middleware.js';
import validate from '../../middlewares/validate.middleware.js';
import { ROLES } from '../users/user.model.js';
import * as orderController from './order.controller.js';
import {
  cancelOrderSchema,
  checkoutSchema,
  listOrdersSchema,
  orderIdParamSchema,
  updateOrderStatusSchema,
} from './order.validation.js';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * /orders/checkout:
 *   post:
 *     tags: [Orders]
 *     summary: Turn the cart into an order
 *     description: >
 *       The server prices the order. No item list, price or total is accepted -
 *       only an optional address, note and coupon code. Line prices are re-read
 *       from the catalogue at this moment, so a stale cart price is never
 *       charged.
 *
 *       Stock decrement, order creation, coupon redemption and clearing the cart
 *       all happen in one MongoDB transaction, and each decrement is conditional
 *       on sufficient stock - two simultaneous checkouts for the last unit
 *       cannot both succeed.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               addressId: { type: string, description: Omit to use the default address }
 *               couponCode: { type: string }
 *               note: { type: string, maxLength: 500 }
 *     responses:
 *       201: { description: Order placed, awaiting payment }
 *       400: { description: Empty cart, unknown address, or an invalid coupon }
 *       409: { description: An item is no longer available in that quantity }
 */
router.post('/checkout', validate({ body: checkoutSchema }), orderController.checkout);

// One listing endpoint, scoped by role in the service: a customer sees their
// own orders, a seller sees orders containing their products, an admin sees all.
/**
 * @openapi
 * /orders:
 *   get:
 *     tags: [Orders]
 *     summary: Orders, scoped by role
 *     description: >
 *       A customer sees their own orders, a seller sees orders containing their
 *       products, an admin sees everything.
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, PAID, PROCESSING, SHIPPED, DELIVERED, CANCELLED, PAYMENT_FAILED, RETURNED, REFUNDED]
 *     responses:
 *       200: { description: A page of orders }
 */
router.get('/', validate({ query: listOrdersSchema }), orderController.listOrders);
/**
 * @openapi
 * /orders/{id}:
 *   get:
 *     tags: [Orders]
 *     summary: Order detail
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The order }
 *       403: { description: Not yours, and you do not sell anything in it }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:id', validate({ params: orderIdParamSchema }), orderController.getOrder);

/**
 * @openapi
 * /orders/{id}/cancel:
 *   patch:
 *     tags: [Orders]
 *     summary: Cancel an order and release its stock
 *     description: >
 *       A customer may cancel only before dispatch and only within
 *       ORDER_CANCELLATION_WINDOW_HOURS of placing the order; staff are not
 *       bound by the window. Stock and any coupon redemption are returned in the
 *       same transaction, and a repeat cancellation cannot credit them twice.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string, maxLength: 280 }
 *     responses:
 *       200: { description: Order cancelled }
 *       400: { description: Too late to cancel, or already in a terminal state }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.patch(
  '/:id/cancel',
  validate({ params: orderIdParamSchema, body: cancelOrderSchema }),
  orderController.cancelOrder
);

/**
 * @openapi
 * /orders/{id}/status:
 *   patch:
 *     tags: [Orders]
 *     summary: Advance fulfilment (seller or admin)
 *     description: >
 *       Legal transitions only:
 *       PENDING to PAID, PROCESSING, SHIPPED, DELIVERED, with RETURNED then
 *       REFUNDED as the return path. PAID and PAYMENT_FAILED are owned by the
 *       payment webhook and cannot be set here by any role; REFUNDED is
 *       admin-only. Stock is returned automatically on any transition that stops
 *       reserving it.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [PROCESSING, SHIPPED, DELIVERED, RETURNED, REFUNDED, CANCELLED]
 *               note: { type: string, maxLength: 500 }
 *     responses:
 *       200: { description: Status changed }
 *       400: { description: That transition is not legal from the current status }
 *       403: { description: Your role may not drive that transition }
 */
router.patch(
  '/:id/status',
  authorize(ROLES.SELLER, ROLES.ADMIN),
  validate({ params: orderIdParamSchema, body: updateOrderStatusSchema }),
  orderController.updateStatus
);

export default router;
