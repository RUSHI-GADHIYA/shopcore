import { z } from 'zod';
import { ROLE_VALUES } from './user.model.js';
import { emailField } from '../auth/auth.validation.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');

export const idParamSchema = z.object({ id: objectId });

export const addressSchema = z
  .object({
    label: z.string().trim().max(40).default('Home'),
    fullName: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(5).max(20),
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(3).max(20),
    country: z.string().trim().min(2).max(100),
    isDefault: z.boolean().default(false),
  })
  .strict();

/**
 * Note what is absent: `role`, `isActive` and `isEmailVerified` are not editable
 * here. Privilege changes go through the admin routes only.
 */
export const updateMeSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    email: emailField.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' });

export const addressIdParamSchema = z.object({ addressId: objectId });

export const listUsersSchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    search: z.string().trim().max(120).optional(),
    role: z.enum(ROLE_VALUES).optional(),
    isActive: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    sort: z.enum(['createdAt', '-createdAt', 'name', '-name']).default('-createdAt'),
  })
  .strict();

export const updateStatusSchema = z
  .object({
    isActive: z.boolean({ required_error: 'isActive is required' }),
    reason: z.string().trim().max(280).optional(),
  })
  .strict();
