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
router.get('/', validate({ query: listProductsSchema }), productController.listProducts);

// Reviews are nested under the product they belong to. Declared before
// `/:slug` so the literal segment is not swallowed by the slug parameter.
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

router.get('/:slug', validate({ params: productSlugParamSchema }), productController.getProduct);

// Everything below writes to the catalogue. `authorize` gates the role;
// per-product ownership is enforced in the service, where the document is in
// hand (spec §9).
router.use(authenticate, authorize(ROLES.SELLER, ROLES.ADMIN));

router.post('/', validate({ body: createProductSchema }), productController.createProduct);
router.patch(
  '/:id',
  validate({ params: productIdParamSchema, body: updateProductSchema }),
  productController.updateProduct
);
router.delete('/:id', validate({ params: productIdParamSchema }), productController.deleteProduct);

// Multer must run before validation so the multipart body is parsed; the route
// param is validated either way.
router.post(
  '/:id/images',
  validate({ params: productIdParamSchema }),
  uploadProductImages,
  productController.uploadImages
);
router.delete(
  '/:id/images/:filename',
  validate({ params: imageParamSchema }),
  productController.deleteImage
);

export default router;
