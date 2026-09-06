import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');
const sku = z.string().trim().toUpperCase().min(1).max(64);

// A cap on the per-line quantity: without one, a typo becomes a request to
// reserve the entire stock of an item.
const quantity = z.number().int().min(1, 'Quantity must be at least 1').max(100);

export const skuParamSchema = z.object({ sku });

export const addCartItemSchema = z
  .object({
    product: objectId,
    sku,
    quantity: quantity.default(1),
  })
  .strict();

export const updateCartItemSchema = z.object({ quantity }).strict();
