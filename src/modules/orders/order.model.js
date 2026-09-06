import mongoose from 'mongoose';
import { ORDER_STATUS, ORDER_STATUS_VALUES } from './order.state-machine.js';

/**
 * An order line, snapshotted at checkout (spec §7.2).
 *
 * Name and price are copied rather than referenced on purpose: a seller
 * renaming a product or changing its price must not silently rewrite what a
 * customer already bought. The product reference remains for navigation only.
 */
const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sku: { type: String, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: true, timestamps: false, toJSON: { virtuals: true } }
);

/** The shipping address as it stood at checkout, not a pointer into the address book. */
const shippingAddressSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true },
    phone: { type: String, required: true },
    line1: { type: String, required: true },
    line2: { type: String },
    city: { type: String, required: true },
    state: { type: String, required: true },
    postalCode: { type: String, required: true },
    country: { type: String, required: true },
  },
  { _id: false, timestamps: false }
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: ORDER_STATUS_VALUES, required: true },
    changedAt: { type: Date, default: Date.now },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, maxlength: 500 },
  },
  { _id: false, timestamps: false }
);

const orderSchema = new mongoose.Schema(
  {
    // Human-quotable reference. Customers cannot read an ObjectId over the phone.
    reference: { type: String, required: true, unique: true, index: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [orderItemSchema], required: true },
    shippingAddress: { type: shippingAddressSchema, required: true },

    // Every figure is computed server-side from live prices at checkout; none
    // of them is ever accepted from a client (spec §15).
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    shippingFee: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },

    couponApplied: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', default: null },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },

    status: {
      type: String,
      enum: ORDER_STATUS_VALUES,
      default: ORDER_STATUS.PENDING,
      index: true,
    },
    // An append-only audit trail: who moved the order where, and when.
    statusHistory: { type: [statusHistorySchema], default: [] },

    // Set when stock is handed back, so a double cancellation cannot credit
    // the catalogue twice.
    stockReleasedAt: { type: Date, default: null },

    placedAt: { type: Date, default: Date.now },
    note: { type: String, maxlength: 500 },
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

// Order history, newest first, is the single most common query (spec §7.3).
orderSchema.index({ user: 1, createdAt: -1 });
// A seller's fulfilment queue.
orderSchema.index({ 'items.seller': 1, status: 1, createdAt: -1 });

export const Order = mongoose.model('Order', orderSchema);

export default Order;
