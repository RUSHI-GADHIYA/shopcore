import mongoose from 'mongoose';

/**
 * A persistent, per-user cart (spec §6.5) — stored server-side rather than in a
 * session, so it survives logout and follows the customer between devices.
 */
const cartItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    // The variant actually being bought. SKUs are unique across the catalogue,
    // so this alone identifies a line.
    sku: { type: String, required: true, uppercase: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },

    // What the variant cost when it was added. Never used to charge the
    // customer — checkout always re-reads the live price — but comparing the
    // two is what lets the cart warn "this went up since you added it"
    // (spec §6.5).
    priceSnapshot: { type: Number, required: true, min: 0 },
  },
  { _id: true, timestamps: false, toJSON: { virtuals: true } }
);

const cartSchema = new mongoose.Schema(
  {
    // One cart per user, enforced by the database rather than by convention:
    // two concurrent "add to cart" calls on an empty cart would otherwise race
    // into two carts.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: { type: [cartItemSchema], default: [] },
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

export const Cart = mongoose.model('Cart', cartSchema);

export default Cart;
