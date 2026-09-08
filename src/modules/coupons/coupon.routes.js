import { Router } from 'express';
import authenticate from '../../middlewares/auth.middleware.js';
import authorize from '../../middlewares/rbac.middleware.js';
import validate from '../../middlewares/validate.middleware.js';
import { ROLES } from '../users/user.model.js';
import * as couponController from './coupon.controller.js';
import {
  couponIdParamSchema,
  createCouponSchema,
  listCouponsSchema,
  previewCouponSchema,
  updateCouponSchema,
} from './coupon.validation.js';

const router = Router();

router.use(authenticate);

// Any signed-in shopper may test a code against their own cart.
/**
 * @openapi
 * /coupons/preview:
 *   post:
 *     tags: [Coupons]
 *     summary: Check a code against your current cart
 *     description: >
 *       Read-only: previewing does not consume a use. It runs the same
 *       validation checkout does, so the discount shown is the discount applied.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code: { type: string }
 *     responses:
 *       200: { description: The discount this code is worth right now }
 *       400: { description: Expired, not started, already used, or below the minimum }
 *       404: { description: No such code }
 */
router.post('/preview', validate({ body: previewCouponSchema }), couponController.previewCoupon);

// Managing the promotions themselves is admin-only.
router.use(authorize(ROLES.ADMIN));

/**
 * @openapi
 * /coupons:
 *   get:
 *     tags: [Coupons]
 *     summary: List coupons (admin)
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *       - { in: query, name: isActive, schema: { type: string, enum: ["true", "false"] } }
 *     responses:
 *       200: { description: A page of coupons }
 *   post:
 *     tags: [Coupons]
 *     summary: Create a coupon (admin)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, discountType, discountValue]
 *             properties:
 *               code: { type: string, minLength: 3, maxLength: 32 }
 *               description: { type: string }
 *               discountType: { type: string, enum: [PERCENT, FLAT] }
 *               discountValue: { type: number }
 *               maxDiscountAmount: { type: number, nullable: true, description: Caps a percentage discount }
 *               minOrderValue: { type: number, default: 0 }
 *               maxUsagePerUser: { type: integer, default: 1 }
 *               totalUsageLimit: { type: integer, nullable: true }
 *               startsAt: { type: string, format: date-time, nullable: true }
 *               expiresAt: { type: string, format: date-time, nullable: true }
 *               isActive: { type: boolean, default: true }
 *     responses:
 *       201: { description: Coupon created }
 *       409: { description: That code already exists }
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.get('/', validate({ query: listCouponsSchema }), couponController.listCoupons);
router.post('/', validate({ body: createCouponSchema }), couponController.createCoupon);
/**
 * @openapi
 * /coupons/{id}:
 *   patch:
 *     tags: [Coupons]
 *     summary: Update a coupon (admin)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Coupon updated }
 *   delete:
 *     tags: [Coupons]
 *     summary: Delete a coupon (admin)
 *     description: >
 *       A coupon that has been redeemed is deactivated rather than deleted, since
 *       past orders point at it and must be able to explain their own discount.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted, or deactivated if it has been used }
 */
router.patch(
  '/:id',
  validate({ params: couponIdParamSchema, body: updateCouponSchema }),
  couponController.updateCoupon
);
router.delete('/:id', validate({ params: couponIdParamSchema }), couponController.deleteCoupon);

export default router;
