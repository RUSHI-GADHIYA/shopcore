import { Router } from 'express';
import authenticate from '../../middlewares/auth.middleware.js';
import authorize from '../../middlewares/rbac.middleware.js';
import validate from '../../middlewares/validate.middleware.js';
import { ROLES } from '../users/user.model.js';
import * as reviewController from './review.controller.js';
import { flagReviewSchema, reviewIdParamSchema, updateReviewSchema } from './review.validation.js';

/**
 * Routes addressed by review id. The nested `/products/:id/reviews` pair lives
 * on the product router, where the `:id` means a product.
 */
const router = Router();

router.use(authenticate);

router.patch(
  '/:id',
  validate({ params: reviewIdParamSchema, body: updateReviewSchema }),
  reviewController.updateReview
);
router.delete('/:id', validate({ params: reviewIdParamSchema }), reviewController.deleteReview);

router.patch(
  '/:id/flag',
  authorize(ROLES.ADMIN),
  validate({ params: reviewIdParamSchema, body: flagReviewSchema }),
  reviewController.flagReview
);

export default router;
