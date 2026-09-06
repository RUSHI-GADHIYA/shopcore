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
router.get('/', validate({ query: listCategoriesSchema }), categoryController.listCategories);
router.get('/:slug', validate({ params: categorySlugParamSchema }), categoryController.getCategory);

router.use(authenticate, authorize(ROLES.ADMIN));

router.post('/', validate({ body: createCategorySchema }), categoryController.createCategory);
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
