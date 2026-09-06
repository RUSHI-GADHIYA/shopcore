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

router.post('/checkout', validate({ body: checkoutSchema }), orderController.checkout);

// One listing endpoint, scoped by role in the service: a customer sees their
// own orders, a seller sees orders containing their products, an admin sees all.
router.get('/', validate({ query: listOrdersSchema }), orderController.listOrders);
router.get('/:id', validate({ params: orderIdParamSchema }), orderController.getOrder);

router.patch(
  '/:id/cancel',
  validate({ params: orderIdParamSchema, body: cancelOrderSchema }),
  orderController.cancelOrder
);

router.patch(
  '/:id/status',
  authorize(ROLES.SELLER, ROLES.ADMIN),
  validate({ params: orderIdParamSchema, body: updateOrderStatusSchema }),
  orderController.updateStatus
);

export default router;
