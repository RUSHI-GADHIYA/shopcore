import { Router } from 'express';
import authenticate from '../../middlewares/auth.middleware.js';
import validate from '../../middlewares/validate.middleware.js';
import * as cartController from './cart.controller.js';
import { addCartItemSchema, skuParamSchema, updateCartItemSchema } from './cart.validation.js';

const router = Router();

// A cart belongs to exactly one user, so there is no public surface here.
router.use(authenticate);

/**
 * @openapi
 * /cart:
 *   get:
 *     tags: [Cart]
 *     summary: The current cart, reconciled against the live catalogue
 *     description: >
 *       Every line is re-resolved against its product, and anything that changed
 *       is reported in `issues`: PRICE_CHANGED, OUT_OF_STOCK, INSUFFICIENT_STOCK,
 *       PRODUCT_UNAVAILABLE, VARIANT_UNAVAILABLE. A price change is informational
 *       and the live price wins; the others block checkout, which is the
 *       difference between `hasIssues` and `isCheckoutable`.
 *     responses:
 *       200: { description: The cart, with a server-computed subtotal }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/', cartController.getCart);
/**
 * @openapi
 * /cart/items:
 *   post:
 *     tags: [Cart]
 *     summary: Add a line, or top up one already present
 *     description: >
 *       Adding a SKU already in the cart increases its quantity rather than
 *       duplicating the line, so the stock check covers the combined quantity.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [product, sku]
 *             properties:
 *               product: { type: string }
 *               sku: { type: string }
 *               quantity: { type: integer, minimum: 1, maximum: 100, default: 1 }
 *     responses:
 *       201: { description: The updated cart }
 *       404: { description: No such product or variant }
 *       409: { description: Not enough stock }
 */
router.post('/items', validate({ body: addCartItemSchema }), cartController.addItem);

// The design document addresses a line by :productId, but a product can be in
// the cart several times under different variants. SKUs are unique across the
// catalogue, so they identify a line unambiguously.
/**
 * @openapi
 * /cart/items/{sku}:
 *   patch:
 *     tags: [Cart]
 *     summary: Set a line's quantity
 *     description: >
 *       Lines are addressed by SKU rather than product id: one product can be in
 *       the cart several times under different variants, and SKUs are unique
 *       across the catalogue.
 *     parameters:
 *       - { in: path, name: sku, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [quantity]
 *             properties:
 *               quantity: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200: { description: The updated cart }
 *       404: { description: That line is not in the cart }
 *       409: { description: Not enough stock }
 *   delete:
 *     tags: [Cart]
 *     summary: Remove a line
 *     parameters:
 *       - { in: path, name: sku, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The updated cart }
 *       404: { description: That line is not in the cart }
 */
router.patch(
  '/items/:sku',
  validate({ params: skuParamSchema, body: updateCartItemSchema }),
  cartController.updateItem
);
router.delete('/items/:sku', validate({ params: skuParamSchema }), cartController.removeItem);

export default router;
