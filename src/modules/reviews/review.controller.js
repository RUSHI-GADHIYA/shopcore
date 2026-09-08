import asyncHandler from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/ApiResponse.js';
import * as reviewService from './review.service.js';

export const createReview = asyncHandler(async (req, res) => {
  const review = await reviewService.createReview({
    actor: req.user,
    productId: req.params.id,
    input: req.body,
  });

  return sendCreated(res, { data: { review }, message: 'Review posted' });
});

export const listReviews = asyncHandler(async (req, res) => {
  const { items, meta, summary } = await reviewService.listReviews({
    productId: req.params.id,
    ...req.query,
  });

  return sendSuccess(res, { data: { reviews: items, summary }, meta });
});

export const updateReview = asyncHandler(async (req, res) => {
  const review = await reviewService.updateReview({
    actor: req.user,
    reviewId: req.params.id,
    updates: req.body,
  });

  return sendSuccess(res, { data: { review }, message: 'Review updated' });
});

export const deleteReview = asyncHandler(async (req, res) => {
  await reviewService.deleteReview({ actor: req.user, reviewId: req.params.id });
  return sendSuccess(res, { message: 'Review removed' });
});

export const flagReview = asyncHandler(async (req, res) => {
  const review = await reviewService.setFlagged({
    reviewId: req.params.id,
    isFlagged: req.body.isFlagged,
    reason: req.body.reason,
  });

  return sendSuccess(res, {
    data: { review },
    message: req.body.isFlagged ? 'Review hidden' : 'Review restored',
  });
});
