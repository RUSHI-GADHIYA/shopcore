import { z } from 'zod';
import { ORDER_STATUS_VALUES } from './order.state-machine.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');

export const orderIdParamSchema = z.object({ id: objectId });

/**
 * Note what checkout does *not* accept: no prices, no totals, no item list.
 * The order is built from the server's own cart and the server's own catalogue
 * prices (spec §15).
 */
export const checkoutSchema = z
  .object({
    // Omitted means "use my default address".
    addressId: objectId.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const cancelOrderSchema = z
  .object({ reason: z.string().trim().max(280).optional() })
  .strict();

export const updateOrderStatusSchema = z
  .object({
    status: z.enum(ORDER_STATUS_VALUES),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const listOrdersSchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    status: z.enum(ORDER_STATUS_VALUES).optional(),
  })
  .strict();
