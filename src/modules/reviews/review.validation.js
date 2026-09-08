import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');

export const productIdParamSchema = z.object({ id: objectId });
export const reviewIdParamSchema = z.object({ id: objectId });

export const createReviewSchema = z
  .object({
    rating: z.number().int().min(1, 'Rating must be 1-5').max(5, 'Rating must be 1-5'),
    title: z.string().trim().max(120).optional(),
    comment: z.string().trim().max(2000).optional(),
  })
  .strict();

export const updateReviewSchema = createReviewSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' });

export const listReviewsSchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),
    rating: z.coerce.number().int().min(1).max(5).optional(),
    sort: z.enum(['newest', 'oldest', 'rating', '-rating']).default('newest'),
  })
  .strict();

export const flagReviewSchema = z
  .object({
    isFlagged: z.boolean(),
    reason: z.string().trim().max(280).optional(),
  })
  .strict();
