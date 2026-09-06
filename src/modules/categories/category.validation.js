import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be a valid slug');

export const categoryIdParamSchema = z.object({ id: objectId });
export const categorySlugParamSchema = z.object({ slug });

export const createCategorySchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
    description: z.string().trim().max(1000).optional(),
    // `null` is meaningful here: it makes the category a root.
    parent: objectId.nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateCategorySchema = createCategorySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' });

export const listCategoriesSchema = z
  .object({
    // Categories are few and the client usually wants the whole shape at once,
    // so the tree is the default and a flat list is opt-in.
    format: z.enum(['tree', 'flat']).default('tree'),
    includeInactive: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default('false'),
  })
  .strict();
