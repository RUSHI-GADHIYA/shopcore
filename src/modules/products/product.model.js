import mongoose from 'mongoose';

/**
 * A purchasable variant of a product — the thing that actually carries stock
 * and a price (spec §6.3). Even a product with no real options gets one
 * variant, so checkout and inventory never need a special case.
 */
const variantSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
    attributes: {
      size: { type: String, trim: true, maxlength: 40 },
      color: { type: String, trim: true, maxlength: 40 },
    },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: true, timestamps: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, required: true, trim: true, maxlength: 5000 },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
      index: true,
    },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // The headline price. Variants may each override it; this is what listings
    // sort and filter on.
    basePrice: { type: Number, required: true, min: 0 },
    variants: {
      type: [variantSchema],
      validate: {
        validator: (variants) => variants.length > 0,
        message: 'A product must have at least one variant',
      },
    },

    // Only ever written by the upload handler, never from a client payload
    // (spec §11).
    images: { type: [String], default: [] },

    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    // Maintained by the order module; here now so listings can sort by
    // popularity without a schema migration later.
    soldCount: { type: Number, default: 0, min: 0 },

    // Soft delete: a product with order history must never disappear, or past
    // orders would lose the item they refer to.
    isActive: { type: Boolean, default: true, index: true },
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

// Free-text search over the two fields a shopper actually types into (spec §7.3).
// `name` is weighted above `description` so a title match ranks first.
productSchema.index(
  { name: 'text', description: 'text' },
  { weights: { name: 10, description: 2 } }
);

// The filtered-browse query: category page, active only, sorted or ranged by price.
productSchema.index({ category: 1, isActive: 1, basePrice: 1 });

// A seller's own catalogue view.
productSchema.index({ seller: 1, createdAt: -1 });

// SKUs must be unique across the whole catalogue, since checkout resolves a
// line item by SKU. Sparse so the index ignores products mid-construction.
productSchema.index({ 'variants.sku': 1 }, { unique: true, sparse: true });

/** Total stock across variants — what "in stock" means for a listing. */
productSchema.virtual('totalStock').get(function totalStock() {
  return this.variants?.reduce((sum, variant) => sum + variant.stock, 0) ?? 0;
});

/** Keeps `basePrice` honest: it should be the cheapest way to buy the product. */
productSchema.pre('save', function syncBasePrice(next) {
  if (this.isModified('variants') && this.variants.length > 0) {
    this.basePrice = Math.min(...this.variants.map((variant) => variant.price));
  }
  return next();
});

export const Product = mongoose.model('Product', productSchema);

export default Product;
