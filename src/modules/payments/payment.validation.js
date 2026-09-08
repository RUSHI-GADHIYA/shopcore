import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');

export const orderIdParamSchema = z.object({ orderId: objectId });

/**
 * Note the absence of an amount: what the order costs was settled at checkout
 * and is read from the order, never from whoever calls this (spec §15).
 */
export const initiatePaymentSchema = z.object({ order: objectId }).strict();

/**
 * The webhook body is deliberately loose. It is signed, and the provider
 * adapter is what knows the gateway's payload shape — pinning it here would
 * mean editing this file every time a gateway adds a field.
 */
export const webhookSchema = z
  .object({
    event: z.string().min(1),
    data: z.object({ providerRef: z.string().min(1) }).passthrough(),
  })
  .passthrough();
