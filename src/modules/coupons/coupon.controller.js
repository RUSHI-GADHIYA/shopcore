import asyncHandler from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/ApiResponse.js';
import { getCartView } from '../cart/cart.service.js';
import * as couponService from './coupon.service.js';

/** Lets a shopper check a code against their live cart before committing. */
export const previewCoupon = asyncHandler(async (req, res) => {
  const cart = await getCartView(req.user._id);

  const { coupon, discount } = await couponService.validateForOrder({
    code: req.body.code,
    userId: req.user._id,
    subtotal: cart.subtotal,
  });

  return sendSuccess(res, {
    data: {
      code: coupon.code,
      description: coupon.description,
      discount,
      subtotal: cart.subtotal,
      newSubtotal: Math.round((cart.subtotal - discount) * 100) / 100,
    },
    message: 'Coupon applied',
  });
});

export const listCoupons = asyncHandler(async (req, res) => {
  const { items, meta } = await couponService.listCoupons(req.query);
  return sendSuccess(res, { data: { coupons: items }, meta });
});

export const createCoupon = asyncHandler(async (req, res) => {
  const coupon = await couponService.createCoupon(req.body);
  return sendCreated(res, { data: { coupon }, message: 'Coupon created' });
});

export const updateCoupon = asyncHandler(async (req, res) => {
  const coupon = await couponService.updateCoupon(req.params.id, req.body);
  return sendSuccess(res, { data: { coupon }, message: 'Coupon updated' });
});

export const deleteCoupon = asyncHandler(async (req, res) => {
  const result = await couponService.deleteCoupon(req.params.id);

  return sendSuccess(res, {
    message: result.deactivated
      ? 'Coupon has been used, so it was deactivated rather than deleted'
      : 'Coupon deleted',
  });
});
