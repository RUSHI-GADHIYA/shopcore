import { z } from 'zod';
import { DISCOUNT_TYPE_VALUES } from './coupon.model.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');

export const couponIdParamSchema = z.object({ id: objectId });

const couponCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(3)
  .max(32)
  .regex(/^[A-Z0-9_-]+$/, 'A code may contain letters, digits, hyphens and underscores');

export const createCouponSchema = z
  .object({
    code: couponCode,
    description: z.string().trim().max(280).optional(),
    discountType: z.enum(DISCOUNT_TYPE_VALUES),
    discountValue: z.number().positive('A discount must be greater than zero'),
    maxDiscountAmount: z.number().positive().nullable().optional(),
    minOrderValue: z.number().nonnegative().default(0),
    maxUsagePerUser: z.number().int().positive().default(1),
    totalUsageLimit: z.number().int().positive().nullable().optional(),
    startsAt: z.coerce.date().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine((body) => body.discountType !== 'PERCENT' || body.discountValue <= 100, {
    message: 'A percentage discount cannot exceed 100',
    path: ['discountValue'],
  })
  .refine((body) => !body.startsAt || !body.expiresAt || body.expiresAt > body.startsAt, {
    message: 'expiresAt must be after startsAt',
    path: ['expiresAt'],
  });

export const updateCouponSchema = z
  .object({
    description: z.string().trim().max(280).optional(),
    discountValue: z.number().positive().optional(),
    maxDiscountAmount: z.number().positive().nullable().optional(),
    minOrderValue: z.number().nonnegative().optional(),
    maxUsagePerUser: z.number().int().positive().optional(),
    totalUsageLimit: z.number().int().positive().nullable().optional(),
    startsAt: z.coerce.date().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' });

export const listCouponsSchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    isActive: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();

/** Previewing a code against the caller's current cart. */
export const previewCouponSchema = z.object({ code: couponCode }).strict();
