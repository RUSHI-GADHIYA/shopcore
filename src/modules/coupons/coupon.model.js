import mongoose from 'mongoose';

export const DISCOUNT_TYPE = Object.freeze({ PERCENT: 'PERCENT', FLAT: 'FLAT' });
export const DISCOUNT_TYPE_VALUES = Object.values(DISCOUNT_TYPE);

/**
 * Promotional coupons (spec §6.9).
 *
 * `usedCount` is only ever moved with `$inc` inside the checkout transaction —
 * read-modify-write would let a limited coupon be redeemed past its cap by two
 * simultaneous checkouts.
 */
const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: 32,
      index: true,
    },
    description: { type: String, trim: true, maxlength: 280, default: '' },

    discountType: { type: String, enum: DISCOUNT_TYPE_VALUES, required: true },
    discountValue: { type: Number, required: true, min: 0 },
    // Caps a percentage discount, so "50% off" on a laptop is not unbounded.
    maxDiscountAmount: { type: Number, default: null, min: 0 },

    minOrderValue: { type: Number, default: 0, min: 0 },
    maxUsagePerUser: { type: Number, default: 1, min: 1 },
    totalUsageLimit: { type: Number, default: null, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },

    startsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

/** A percentage over 100 would pay the customer to shop here. */
couponSchema.pre('validate', function capPercentage(next) {
  if (this.discountType === DISCOUNT_TYPE.PERCENT && this.discountValue > 100) {
    this.invalidate('discountValue', 'A percentage discount cannot exceed 100');
  }
  return next();
});

export const Coupon = mongoose.model('Coupon', couponSchema);

/** Per-user redemption history, which is what enforces maxUsagePerUser. */
const couponRedemptionSchema = new mongoose.Schema(
  {
    coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    discount: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);

couponRedemptionSchema.index({ coupon: 1, user: 1 });

export const CouponRedemption = mongoose.model('CouponRedemption', couponRedemptionSchema);

export default Coupon;
