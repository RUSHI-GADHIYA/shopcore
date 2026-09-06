import mongoose from 'mongoose';

/**
 * Hierarchical product categories (spec §6.4), e.g. Electronics → Laptops.
 *
 * Alongside the `parent` pointer each document stores its `ancestors` — the
 * full chain from the root down to the immediate parent. That denormalisation
 * is what makes "every product under Electronics, however deep" a single
 * indexed query instead of a recursive walk. It costs a rewrite of a subtree
 * when a category is re-parented, which is rare.
 */
const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, trim: true, maxlength: 1000, default: '' },

    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    ancestors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category', index: true }],

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

// Ordering the listing and tree build without a sort stage in memory.
categorySchema.index({ parent: 1, name: 1 });

/** Depth is derivable, so it is a virtual rather than another field to keep in sync. */
categorySchema.virtual('depth').get(function depth() {
  return this.ancestors?.length ?? 0;
});

export const Category = mongoose.model('Category', categorySchema);

export default Category;
