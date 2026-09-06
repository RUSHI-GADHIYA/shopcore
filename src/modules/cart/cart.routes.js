import { Router } from 'express';
import authenticate from '../../middlewares/auth.middleware.js';
import validate from '../../middlewares/validate.middleware.js';
import * as cartController from './cart.controller.js';
import { addCartItemSchema, skuParamSchema, updateCartItemSchema } from './cart.validation.js';

const router = Router();

// A cart belongs to exactly one user, so there is no public surface here.
router.use(authenticate);

router.get('/', cartController.getCart);
router.post('/items', validate({ body: addCartItemSchema }), cartController.addItem);

// The design document addresses a line by :productId, but a product can be in
// the cart several times under different variants. SKUs are unique across the
// catalogue, so they identify a line unambiguously.
router.patch(
  '/items/:sku',
  validate({ params: skuParamSchema, body: updateCartItemSchema }),
  cartController.updateItem
);
router.delete('/items/:sku', validate({ params: skuParamSchema }), cartController.removeItem);

export default router;
