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

/**
 * @openapi
 * /reviews/{id}:
 *   patch:
 *     tags: [Reviews]
 *     summary: Edit your own review
 *     description: >
 *       The author only - an admin moderates rather than rewrites what somebody
 *       said. Changing the rating recomputes the product average.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               rating: { type: integer, minimum: 1, maximum: 5 }
 *               title: { type: string }
 *               comment: { type: string }
 *     responses:
 *       200: { description: Review updated }
 *       403: { description: Not your review }
 *   delete:
 *     tags: [Reviews]
 *     summary: Delete a review (author or admin)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Review removed and the rating recomputed }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.patch(
  '/:id',
  validate({ params: reviewIdParamSchema, body: updateReviewSchema }),
  reviewController.updateReview
);
router.delete('/:id', validate({ params: reviewIdParamSchema }), reviewController.deleteReview);

/**
 * @openapi
 * /reviews/{id}/flag:
 *   patch:
 *     tags: [Reviews]
 *     summary: Hide or restore a review (admin)
 *     description: >
 *       A flagged review is excluded from public listings and from the product
 *       rating, but is not destroyed. Unflagging restores both.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isFlagged]
 *             properties:
 *               isFlagged: { type: boolean }
 *               reason: { type: string, maxLength: 280 }
 *     responses:
 *       200: { description: Moderation applied }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.patch(
  '/:id/flag',
  authorize(ROLES.ADMIN),
  validate({ params: reviewIdParamSchema, body: flagReviewSchema }),
  reviewController.flagReview
);

export default router;
