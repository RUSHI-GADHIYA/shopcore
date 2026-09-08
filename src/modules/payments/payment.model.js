import mongoose from 'mongoose';

export const PAYMENT_STATUS = Object.freeze({
  INITIATED: 'INITIATED',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
});

export const PAYMENT_STATUS_VALUES = Object.values(PAYMENT_STATUS);

const paymentSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    provider: { type: String, default: 'mock' },

    // The gateway's own identifier. Unique because it is what a webhook uses to
    // find this record, and two payments answering to one reference would make
    // that lookup ambiguous.
    providerRef: { type: String, required: true, unique: true, index: true },

    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    status: {
      type: String,
      enum: PAYMENT_STATUS_VALUES,
      default: PAYMENT_STATUS.INITIATED,
      index: true,
    },

    // The gateway's raw callback, kept for audit and for reconciling a dispute
    // months later (spec §10).
    rawResponse: { type: mongoose.Schema.Types.Mixed, default: null },

    // Set the first time a terminal webhook is processed. Gateways retry
    // aggressively, so this is what makes handling idempotent.
    processedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
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

export const Payment = mongoose.model('Payment', paymentSchema);

export default Payment;
