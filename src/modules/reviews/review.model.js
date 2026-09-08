import mongoose from 'mongoose';

/**
 * A product review, permitted only after a delivered order (spec §6.8).
 *
 * The `order` reference is what makes "verified purchase" enforceable rather
 * than decorative: a review cannot exist without pointing at the delivered
 * order that entitles it.
 */
const reviewSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },

    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, trim: true, maxlength: 120 },
    comment: { type: String, trim: true, maxlength: 2000 },

    // Admin moderation. A flagged review stays in the database (the author can
    // see it) but is excluded from public listings and from the rating average.
    isFlagged: { type: Boolean, default: false },
    flagReason: { type: String, maxlength: 280, default: null },
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

// One review per user per product (spec §7.3). Enforced by the database, not by
// a check-then-write in the service, which two concurrent requests would slip past.
reviewSchema.index({ product: 1, user: 1 }, { unique: true });

// The public listing: a product's newest unflagged reviews.
reviewSchema.index({ product: 1, isFlagged: 1, createdAt: -1 });

export const Review = mongoose.model('Review', reviewSchema);

export default Review;
