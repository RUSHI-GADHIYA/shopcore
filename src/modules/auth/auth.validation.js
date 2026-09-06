import { z } from 'zod';
import { ROLES } from '../users/user.model.js';

/**
 * Every auth route's input contract. `.strict()` rejects unknown keys outright
 * so a client cannot smuggle in fields such as `role: 'admin'`.
 */
export const emailField = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .email('Must be a valid email address')
  .max(254);

/**
 * Length is the requirement that actually matters; the character-class rules are
 * there because the spec calls for them, not because they add much entropy.
 */
export const passwordField = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/\d/, 'Password must contain a number');

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
    email: emailField,
    password: passwordField,
    // Self-registration may only ever create a customer or a seller; admins are
    // provisioned by another admin or the seed script.
    role: z.enum([ROLES.CUSTOMER, ROLES.SELLER]).default(ROLES.CUSTOMER),
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailField,
    // Deliberately not `passwordField`: an existing password predating a rule
    // change must still be able to sign in.
    password: z.string().min(1, 'Password is required'),
  })
  .strict();

export const forgotPasswordSchema = z.object({ email: emailField }).strict();

export const resetPasswordSchema = z.object({ password: passwordField }).strict();

export const tokenParamSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid or malformed token'),
});
