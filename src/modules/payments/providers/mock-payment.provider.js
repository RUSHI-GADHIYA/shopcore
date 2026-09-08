import crypto from 'node:crypto';
import { env } from '../../../config/env.js';
import { PaymentProvider } from './payment-provider.interface.js';

/**
 * A stand-in gateway that reproduces the part of a real integration that
 * actually shapes the code: the asynchronous, signature-verified callback
 * (spec §10).
 *
 * Signing is genuine HMAC-SHA256 over the raw body, compared in constant time —
 * exactly what Stripe and Razorpay require. Only the money is pretend.
 */
export class MockPaymentProvider extends PaymentProvider {
  get name() {
    return 'mock';
  }

  async initiate(order) {
    const providerRef = `mock_${crypto.randomBytes(12).toString('hex')}`;

    return {
      providerRef,
      // In a real integration the customer is redirected here; in development
      // this is the reference to quote when firing a webhook by hand.
      checkoutUrl: `${env.PUBLIC_BASE_URL}/mock-checkout/${providerRef}`,
      clientSecret: crypto.randomBytes(16).toString('hex'),
      amount: order.total,
    };
  }

  /**
   * Must be given the raw body, not the parsed object: re-serialising JSON can
   * reorder keys or change spacing, and the signature would no longer match.
   */
  verifyWebhookSignature(rawBody, signature) {
    if (!rawBody || typeof signature !== 'string' || signature.length === 0) return false;

    const expected = MockPaymentProvider.sign(rawBody);
    const provided = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');

    // timingSafeEqual throws on a length mismatch, so guard first — and compare
    // in constant time so the signature cannot be recovered byte by byte.
    if (provided.length !== computed.length) return false;
    return crypto.timingSafeEqual(provided, computed);
  }

  parseWebhook(payload) {
    const { event, data } = payload ?? {};

    const outcome = {
      'payment.succeeded': 'SUCCESS',
      'payment.failed': 'FAILED',
      'payment.refunded': 'REFUNDED',
    }[event];

    if (!outcome) throw new Error(`Unsupported webhook event: ${event}`);
    if (!data?.providerRef) throw new Error('Webhook payload is missing data.providerRef');

    return { providerRef: data.providerRef, outcome, reason: data.reason };
  }

  /** Exposed so tests and the dev tooling can sign a payload the same way. */
  static sign(rawBody) {
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    return crypto.createHmac('sha256', env.PAYMENT_WEBHOOK_SECRET).update(body).digest('hex');
  }
}

export default MockPaymentProvider;
