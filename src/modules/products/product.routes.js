import { Router } from 'express';
import authenticate from '../../middlewares/auth.middleware.js';
import authorize from '../../middlewares/rbac.middleware.js';
import validate from '../../middlewares/validate.middleware.js';
import { uploadProductImages } from '../../middlewares/upload.middleware.js';
import { ROLES } from '../users/user.model.js';
import * as productController from './product.controller.js';
import * as reviewController from '../reviews/review.controller.js';
import {
  createReviewSchema,
  listReviewsSchema,
  productIdParamSchema as reviewProductIdParamSchema,
} from '../reviews/review.validation.js';
import {
  createProductSchema,
  imageParamSchema,
  listProductsSchema,
  productIdParamSchema,
  productSlugParamSchema,
  updateProductSchema,
} from './product.validation.js';

const router = Router();

// Browsing is public (spec §8).
/**
 * @openapi
 * /products:
 *   get:
 *     tags: [Products]
 *     summary: Search, filter, sort and page the catalogue
 *     description: >
 *       Filtering by a category includes everything beneath it. Unknown query
 *       parameters are rejected rather than ignored, so a mistyped filter fails
 *       loudly instead of silently returning the wrong page.
 *     security: []
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, minimum: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, maximum: 100 } }
 *       - { in: query, name: q, schema: { type: string }, description: Full-text search over name and description }
 *       - { in: query, name: category, schema: { type: string }, description: Category slug, descendants included }
 *       - { in: query, name: seller, schema: { type: string } }
 *       - { in: query, name: minPrice, schema: { type: number } }
 *       - { in: query, name: maxPrice, schema: { type: number } }
 *       - { in: query, name: minRating, schema: { type: number, minimum: 0, maximum: 5 } }
 *       - { in: query, name: inStock, schema: { type: string, enum: ["true", "false"] } }
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [newest, oldest, price, -price, rating, popularity, relevance] }
 *         description: relevance requires q
 *     responses:
 *       200: { description: A page of products }
 *       422: { $ref: '#/components/responses/ValidationError' }
 *   post:
 *     tags: [Products]
 *     summary: Create a product (seller or admin)
 *     description: >
 *       Image URLs are not accepted here - they are only ever set by the upload
 *       endpoint. basePrice is derived from the cheapest variant.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, description, category, variants]
 *             properties:
 *               name: { type: string }
 *               description: { type: string, minLength: 10 }
 *               category: { type: string }
 *               isActive: { type: boolean, default: true }
 *               variants:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [sku, price]
 *                   properties:
 *                     sku: { type: string, description: Unique across the whole catalogue }
 *                     price: { type: number }
 *                     stock: { type: integer, default: 0 }
 *                     attributes:
 *                       type: object
 *                       properties:
 *                         size: { type: string }
 *                         color: { type: string }
 *     responses:
 *       201: { description: Product created }
 *       409: { description: That SKU already exists }
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.get('/', validate({ query: listProductsSchema }), productController.listProducts);

// Reviews are nested under the product they belong to. Declared before
// `/:slug` so the literal segment is not swallowed by the slug parameter.
/**
 * @openapi
 * /products/{id}/reviews:
 *   get:
 *     tags: [Reviews]
 *     summary: A product's reviews, with a rating histogram
 *     security: []
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *       - { in: query, name: rating, schema: { type: integer, minimum: 1, maximum: 5 } }
 *       - { in: query, name: sort, schema: { type: string, enum: [newest, oldest, rating, -rating] } }
 *     responses:
 *       200: { description: Reviews plus a summary; flagged reviews are omitted }
 *   post:
 *     tags: [Reviews]
 *     summary: Review a product you have received
 *     description: >
 *       Permitted only when the caller has an order containing this product that
 *       reached DELIVERED. One review per user per product.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties:
 *               rating: { type: integer, minimum: 1, maximum: 5 }
 *               title: { type: string, maxLength: 120 }
 *               comment: { type: string, maxLength: 2000 }
 *     responses:
 *       201: { description: Review posted }
 *       403: { description: Not a verified purchase }
 *       409: { description: You have already reviewed this product }
 */
router.get(
  '/:id/reviews',
  validate({ params: reviewProductIdParamSchema, query: listReviewsSchema }),
  reviewController.listReviews
);
router.post(
  '/:id/reviews',
  authenticate,
  validate({ params: reviewProductIdParamSchema, body: createReviewSchema }),
  reviewController.createReview
);

/**
 * @openapi
 * /products/{slug}:
 *   get:
 *     tags: [Products]
 *     summary: Product detail by slug
 *     security: []
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The product }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:slug', validate({ params: productSlugParamSchema }), productController.getProduct);

// Everything below writes to the catalogue. `authorize` gates the role;
// per-product ownership is enforced in the service, where the document is in
// hand (spec §9).
router.use(authenticate, authorize(ROLES.SELLER, ROLES.ADMIN));

router.post('/', validate({ body: createProductSchema }), productController.createProduct);
/**
 * @openapi
 * /products/{id}:
 *   patch:
 *     tags: [Products]
 *     summary: Update a product (owner or admin)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               category: { type: string }
 *               isActive: { type: boolean }
 *               variants: { type: array, items: { type: object } }
 *     responses:
 *       200: { description: Product updated }
 *       403: { description: A seller may only edit their own products }
 *   delete:
 *     tags: [Products]
 *     summary: Remove a product from the catalogue (owner or admin)
 *     description: >
 *       A soft delete. The document survives so that orders referring to it keep
 *       resolving; it simply stops appearing in the catalogue.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Product deactivated }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.patch(
  '/:id',
  validate({ params: productIdParamSchema, body: updateProductSchema }),
  productController.updateProduct
);
router.delete('/:id', validate({ params: productIdParamSchema }), productController.deleteProduct);

// Multer must run before validation so the multipart body is parsed; the route
// param is validated either way.
/**
 * @openapi
 * /products/{id}/images:
 *   post:
 *     tags: [Products]
 *     summary: Upload product images (owner or admin)
 *     description: >
 *       Up to five files per request. Each is decoded, resized to fit 1200px and
 *       re-encoded to WebP before it touches disk; the uploaded filename is
 *       discarded and replaced with a generated one.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               images:
 *                 type: array
 *                 items: { type: string, format: binary }
 *     responses:
 *       201: { description: Images attached }
 *       400: { description: Not an image, too large, or nothing attached }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post(
  '/:id/images',
  validate({ params: productIdParamSchema }),
  uploadProductImages,
  productController.uploadImages
);
/**
 * @openapi
 * /products/{id}/images/{filename}:
 *   delete:
 *     tags: [Products]
 *     summary: Remove one product image (owner or admin)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: filename, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Image removed }
 *       404: { description: The product does not have that image }
 */
router.delete(
  '/:id/images/:filename',
  validate({ params: imageParamSchema }),
  productController.deleteImage
);

export default router;
