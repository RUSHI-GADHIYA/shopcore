import ApiError from '../../utils/ApiError.js';
import { buildMeta, resolvePagination } from '../../utils/pagination.js';
import { fromCents, percentOfCents, toCents } from '../../utils/money.js';
import { Coupon, CouponRedemption, DISCOUNT_TYPE } from './coupon.model.js';

/**
 * Coupon validation and redemption (spec §6.9).
 *
 * `validateForOrder` is deliberately free of side effects: checkout calls it to
 * price the order, and a "check my code" endpoint calls the same function to
 * preview a discount. Only `recordRedemption` writes, and only inside the
 * checkout transaction.
 */

export async function validateForOrder({ code, userId, subtotal }) {
  const coupon = await Coupon.findOne({ code: String(code).toUpperCase().trim() });
  if (!coupon) throw ApiError.notFound('That coupon code is not valid');

  const now = new Date();

  if (!coupon.isActive) throw ApiError.badRequest('That coupon is no longer active');
  if (coupon.startsAt && coupon.startsAt > now) {
    throw ApiError.badRequest('That coupon is not active yet');
  }
  if (coupon.expiresAt && coupon.expiresAt < now) {
    throw ApiError.badRequest('That coupon has expired');
  }

  if (coupon.totalUsageLimit !== null && coupon.usedCount >= coupon.totalUsageLimit) {
    throw ApiError.badRequest('That coupon has been fully redeemed');
  }

  const subtotalCents = toCents(subtotal);
  if (subtotalCents < toCents(coupon.minOrderValue)) {
    throw ApiError.badRequest(
      `That coupon needs a subtotal of at least ${coupon.minOrderValue.toFixed(2)}`,
      { code: 'MIN_ORDER_VALUE_NOT_MET' }
    );
  }

  const timesUsed = await CouponRedemption.countDocuments({ coupon: coupon._id, user: userId });
  if (timesUsed >= coupon.maxUsagePerUser) {
    throw ApiError.badRequest('You have already used that coupon');
  }

  return { coupon, discount: computeDiscount(coupon, subtotalCents) };
}

/**
 * Works in integer cents like the rest of the pricing code, and can never
 * exceed the subtotal — a discount larger than the order would produce a
 * negative total.
 */
export function computeDiscount(coupon, subtotalCents) {
  let discountCents =
    coupon.discountType === DISCOUNT_TYPE.PERCENT
      ? percentOfCents(subtotalCents, coupon.discountValue)
      : toCents(coupon.discountValue);

  if (coupon.maxDiscountAmount !== null && coupon.maxDiscountAmount !== undefined) {
    discountCents = Math.min(discountCents, toCents(coupon.maxDiscountAmount));
  }

  return fromCents(Math.min(discountCents, subtotalCents));
}

/**
 * Books the redemption. Called only from inside the checkout transaction, so it
 * commits or rolls back with the order.
 *
 * The `$inc` plus a conditional filter is what stops a limited coupon being
 * over-redeemed: two simultaneous checkouts for the last use mean one update
 * matches no document.
 */
export async function recordRedemption({ coupon, userId, orderId, discount, session }) {
  const filter = { _id: coupon._id };
  if (coupon.totalUsageLimit !== null) filter.usedCount = { $lt: coupon.totalUsageLimit };

  const result = await Coupon.updateOne(filter, { $inc: { usedCount: 1 } }, { session });

  if (result.modifiedCount !== 1) {
    throw ApiError.conflict('That coupon has just been fully redeemed');
  }

  await CouponRedemption.create([{ coupon: coupon._id, user: userId, order: orderId, discount }], {
    session,
  });
}

/** Gives back a redemption when an order that used one is cancelled. */
export async function releaseRedemption({ couponId, orderId, session }) {
  const redemption = await CouponRedemption.findOneAndDelete(
    { coupon: couponId, order: orderId },
    session ? { session } : {}
  );

  if (!redemption) return;

  await Coupon.updateOne(
    { _id: couponId },
    { $inc: { usedCount: -1 } },
    session ? { session } : {}
  );
}

export async function createCoupon(input) {
  const existing = await Coupon.findOne({ code: input.code.toUpperCase() }).select('_id').lean();
  if (existing) throw ApiError.conflict('A coupon with that code already exists');

  const coupon = await Coupon.create(input);
  return coupon.toJSON();
}

export async function updateCoupon(couponId, updates) {
  const coupon = await Coupon.findById(couponId);
  if (!coupon) throw ApiError.notFound('Coupon not found');

  Object.assign(coupon, updates);
  await coupon.save();

  return coupon.toJSON();
}

export async function deleteCoupon(couponId) {
  const coupon = await Coupon.findById(couponId);
  if (!coupon) throw ApiError.notFound('Coupon not found');

  // Deactivated rather than deleted once it has been used: past orders point at
  // it, and an order should always be able to explain its own discount.
  if (coupon.usedCount > 0) {
    coupon.isActive = false;
    await coupon.save();
    return { deactivated: true };
  }

  await coupon.deleteOne();
  return { deleted: true };
}

export async function listCoupons({ page, limit, isActive }) {
  const filter = {};
  if (typeof isActive === 'boolean') filter.isActive = isActive;

  const { page: safePage, limit: safeLimit, skip } = resolvePagination({ page, limit });

  const [items, total] = await Promise.all([
    Coupon.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    Coupon.countDocuments(filter),
  ]);

  return { items, meta: buildMeta({ page: safePage, limit: safeLimit, total }) };
}
