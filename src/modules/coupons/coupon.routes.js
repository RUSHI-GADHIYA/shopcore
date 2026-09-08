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
router.post('/preview', validate({ body: previewCouponSchema }), couponController.previewCoupon);

// Managing the promotions themselves is admin-only.
router.use(authorize(ROLES.ADMIN));

router.get('/', validate({ query: listCouponsSchema }), couponController.listCoupons);
router.post('/', validate({ body: createCouponSchema }), couponController.createCoupon);
router.patch(
  '/:id',
  validate({ params: couponIdParamSchema, body: updateCouponSchema }),
  couponController.updateCoupon
);
router.delete('/:id', validate({ params: couponIdParamSchema }), couponController.deleteCoupon);

export default router;
