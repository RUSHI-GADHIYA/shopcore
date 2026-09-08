import mongoose from 'mongoose';
import ApiError from '../../utils/ApiError.js';
import { buildMeta, resolvePagination } from '../../utils/pagination.js';
import { cacheDelPattern } from '../../utils/cache.js';
import { ROLES } from '../users/user.model.js';
import { Product } from '../products/product.model.js';
import { Order } from '../orders/order.model.js';
import { ORDER_STATUS } from '../orders/order.state-machine.js';
import { Review } from './review.model.js';

/**
 * Reviews with a verified-purchase gate (spec §6.8).
 *
 * The product's `ratingAvg` / `ratingCount` are recomputed by aggregating the
 * reviews rather than incrementally adjusted. Incremental updates drift the
 * moment anything unusual happens — a deletion, a flag, a rating edit — and the
 * aggregate is cheap at these volumes.
 */

/**
 * Finds the delivered order that entitles this user to review this product.
 * Delivered, specifically: paid is not enough, you have to have received it.
 */
async function findQualifyingOrder(userId, productId) {
  return Order.findOne({
    user: userId,
    status: ORDER_STATUS.DELIVERED,
    'items.product': productId,
  })
    .select('_id')
    .lean();
}

export async function createReview({ actor, productId, input }) {
  const product = await Product.findById(productId).select('_id isActive').lean();
  if (!product || !product.isActive) throw ApiError.notFound('Product not found');

  const order = await findQualifyingOrder(actor._id, productId);
  if (!order) {
    throw ApiError.forbidden(
      'You can only review a product from an order that has been delivered to you',
      { code: 'NOT_A_VERIFIED_PURCHASE' }
    );
  }

  try {
    const review = await Review.create({
      product: productId,
      user: actor._id,
      order: order._id,
      ...input,
    });

    await recalculateRating(productId);
    return review.toJSON();
  } catch (error) {
    // The unique index is the real guard against a double review; two
    // simultaneous requests would both pass a findOne check.
    if (error?.code === 11000) {
      throw ApiError.conflict('You have already reviewed this product');
    }
    throw error;
  }
}

export async function listReviews({ productId, page, limit, rating, sort }) {
  // Flagged reviews are hidden from the public listing but not deleted.
  const filter = { product: productId, isFlagged: false };
  if (rating) filter.rating = rating;

  const { page: safePage, limit: safeLimit, skip } = resolvePagination({ page, limit });

  const sortBy = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    rating: { rating: 1, createdAt: -1 },
    '-rating': { rating: -1, createdAt: -1 },
  }[sort];

  const [items, total, summary] = await Promise.all([
    Review.find(filter).sort(sortBy).skip(skip).limit(safeLimit).populate('user', 'name').lean(),
    Review.countDocuments(filter),
    summariseRatings(productId),
  ]);

  return { items, meta: buildMeta({ page: safePage, limit: safeLimit, total }), summary };
}

export async function updateReview({ actor, reviewId, updates }) {
  const review = await Review.findById(reviewId);
  if (!review) throw ApiError.notFound('Review not found');

  // Editing is the author's alone — an admin moderates, it does not rewrite.
  if (String(review.user) !== String(actor._id)) {
    throw ApiError.forbidden('You can only edit your own review');
  }

  Object.assign(review, updates);
  await review.save();

  if (updates.rating !== undefined) await recalculateRating(review.product);

  return review.toJSON();
}

export async function deleteReview({ actor, reviewId }) {
  const review = await Review.findById(reviewId);
  if (!review) throw ApiError.notFound('Review not found');

  const isAuthor = String(review.user) === String(actor._id);
  if (!isAuthor && actor.role !== ROLES.ADMIN) {
    throw ApiError.forbidden('You can only delete your own review');
  }

  const { product } = review;
  await review.deleteOne();
  await recalculateRating(product);
}

/** Admin moderation (spec §6.8): hide abusive content without destroying it. */
export async function setFlagged({ reviewId, isFlagged, reason }) {
  const review = await Review.findById(reviewId);
  if (!review) throw ApiError.notFound('Review not found');

  review.isFlagged = isFlagged;
  review.flagReason = isFlagged ? (reason ?? 'Flagged by a moderator') : null;
  await review.save();

  // A flagged review no longer counts towards the score.
  await recalculateRating(review.product);

  return review.toJSON();
}

/**
 * Recomputes a product's rating from its unflagged reviews and writes it back.
 * Also drops the product caches, since a listing carries ratingAvg.
 */
export async function recalculateRating(productId) {
  const id = new mongoose.Types.ObjectId(String(productId));

  const [summary] = await Review.aggregate([
    { $match: { product: id, isFlagged: false } },
    { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);

  // Stored to one decimal: "4.3 stars" is meaningful, 4.333333 is noise.
  const ratingAvg = summary ? Math.round(summary.average * 10) / 10 : 0;
  const ratingCount = summary?.count ?? 0;

  await Product.updateOne({ _id: productId }, { $set: { ratingAvg, ratingCount } });

  const product = await Product.findById(productId).select('slug').lean();
  await Promise.all([
    cacheDelPattern('products:list:*'),
    product ? cacheDelPattern(`products:detail:${product.slug}`) : Promise.resolve(),
  ]);

  return { ratingAvg, ratingCount };
}

/** The star-distribution histogram a product page shows beside the average. */
async function summariseRatings(productId) {
  const id = new mongoose.Types.ObjectId(String(productId));

  const rows = await Review.aggregate([
    { $match: { product: id, isFlagged: false } },
    { $group: { _id: '$rating', count: { $sum: 1 } } },
  ]);

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let weighted = 0;

  for (const row of rows) {
    distribution[row._id] = row.count;
    total += row.count;
    weighted += row._id * row.count;
  }

  return {
    average: total ? Math.round((weighted / total) * 10) / 10 : 0,
    count: total,
    distribution,
  };
}
