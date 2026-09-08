import { Router } from 'express';
import authenticate from '../../middlewares/auth.middleware.js';
import authorize from '../../middlewares/rbac.middleware.js';
import validate from '../../middlewares/validate.middleware.js';
import { ROLES } from '../users/user.model.js';
import * as categoryController from './category.controller.js';
import {
  categoryIdParamSchema,
  categorySlugParamSchema,
  createCategorySchema,
  listCategoriesSchema,
  updateCategorySchema,
} from './category.validation.js';

const router = Router();

// Browsing is public; the catalogue structure is admin-owned (spec §6.4).
/**
 * @openapi
 * /categories:
 *   get:
 *     tags: [Categories]
 *     summary: The category tree
 *     security: []
 *     parameters:
 *       - { in: query, name: format, schema: { type: string, enum: [tree, flat], default: tree } }
 *       - { in: query, name: includeInactive, schema: { type: string, enum: ["true", "false"] } }
 *     responses:
 *       200: { description: Categories, nested by default }
 *   post:
 *     tags: [Categories]
 *     summary: Create a category (admin)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, minLength: 2 }
 *               description: { type: string }
 *               parent: { type: string, nullable: true, description: Omit or null for a root category }
 *               isActive: { type: boolean, default: true }
 *     responses:
 *       201: { description: Category created }
 *       400: { description: The parent does not exist }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', validate({ query: listCategoriesSchema }), categoryController.listCategories);
/**
 * @openapi
 * /categories/{slug}:
 *   get:
 *     tags: [Categories]
 *     summary: One category by slug
 *     security: []
 *     parameters:
 *       - { in: path, name: slug, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The category }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:slug', validate({ params: categorySlugParamSchema }), categoryController.getCategory);

router.use(authenticate, authorize(ROLES.ADMIN));

router.post('/', validate({ body: createCategorySchema }), categoryController.createCategory);
/**
 * @openapi
 * /categories/{id}:
 *   patch:
 *     tags: [Categories]
 *     summary: Rename, re-parent or deactivate a category (admin)
 *     description: >
 *       Re-parenting rewrites the ancestor chain of the whole subtree. A category
 *       cannot become its own parent or move beneath one of its own descendants.
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
 *               parent: { type: string, nullable: true }
 *               isActive: { type: boolean }
 *     responses:
 *       200: { description: Category updated }
 *       400: { description: The move would create a cycle }
 *   delete:
 *     tags: [Categories]
 *     summary: Delete a category (admin)
 *     description: >
 *       Refused while subcategories or products still reference it - orphaning a
 *       product would corrupt the orders that contain it.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Category deleted }
 *       409: { description: Still referenced by subcategories or products }
 */
router.patch(
  '/:id',
  validate({ params: categoryIdParamSchema, body: updateCategorySchema }),
  categoryController.updateCategory
);
router.delete(
  '/:id',
  validate({ params: categoryIdParamSchema }),
  categoryController.deleteCategory
);

export default router;
