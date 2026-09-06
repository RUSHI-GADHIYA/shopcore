import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be a valid slug');

export const productIdParamSchema = z.object({ id: objectId });
export const productSlugParamSchema = z.object({ slug });

/**
 * Only the basename is accepted, and only in the shape the upload handler
 * produces. A path separator or `..` cannot survive this pattern, so the delete
 * handler can join it onto the upload directory safely.
 */
export const imageParamSchema = z.object({
  id: objectId,
  filename: z.string().regex(/^[a-f0-9-]{36}\.webp$/, 'Unknown image'),
});

const variantSchema = z
  .object({
    sku: z.string().trim().toUpperCase().min(1).max(64),
    attributes: z
      .object({
        size: z.string().trim().max(40).optional(),
        color: z.string().trim().max(40).optional(),
      })
      .strict()
      .default({}),
    price: z.number().nonnegative().finite(),
    stock: z.number().int().nonnegative().default(0),
  })
  .strict();

/**
 * `images` is deliberately absent: image URLs are only ever set by the upload
 * endpoint, never accepted from a client (spec §11). `seller` is absent for the
 * same reason — it comes from the authenticated user.
 */
export const createProductSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    description: z.string().trim().min(10, 'Description must be at least 10 characters').max(5000),
    category: objectId,
    variants: z
      .array(variantSchema)
      .min(1, 'A product must have at least one variant')
      .max(50)
      .refine(
        (variants) => new Set(variants.map((v) => v.sku)).size === variants.length,
        'Variant SKUs must be unique within a product'
      ),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateProductSchema = createProductSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' });

const priceFilter = z.coerce.number().nonnegative().optional();

export const listProductsSchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().optional(),

    q: z.string().trim().min(1).max(120).optional(),
    category: slug.optional(),
    seller: objectId.optional(),
    minPrice: priceFilter,
    maxPrice: priceFilter,
    minRating: z.coerce.number().min(0).max(5).optional(),
    inStock: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),

    sort: z
      .enum(['newest', 'oldest', 'price', '-price', 'rating', 'popularity', 'relevance'])
      .default('newest'),
  })
  .strict()
  .refine((query) => !(query.minPrice && query.maxPrice) || query.maxPrice >= query.minPrice, {
    message: 'maxPrice must be greater than or equal to minPrice',
    path: ['maxPrice'],
  })
  // Relevance is only meaningful when there is a search term to be relevant to.
  .refine((query) => query.sort !== 'relevance' || Boolean(query.q), {
    message: 'sort=relevance requires a search term (q)',
    path: ['sort'],
  });
