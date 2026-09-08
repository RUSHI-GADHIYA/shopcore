/**
 * The contract every payment gateway adapter implements (spec §10).
 *
 * The point of this seam is that swapping the mock for Stripe or Razorpay is a
 * configuration change plus one new file — the order module never learns which
 * gateway took the money.
 */
export class PaymentProvider {
  /** Machine name, stored on the Payment document. */
  get name() {
    throw new Error('PaymentProvider.name is not implemented');
  }

  /**
   * Starts a payment.
   * @returns {Promise<{providerRef: string, checkoutUrl: string, clientSecret?: string}>}
   */
  // eslint-disable-next-line no-unused-vars -- documents the shape implementers receive
  async initiate(order) {
    throw new Error('PaymentProvider.initiate is not implemented');
  }

  /**
   * Verifies a callback really came from the gateway.
   * Must compare in constant time and must operate on the *raw* body.
   * @returns {boolean}
   */
  // eslint-disable-next-line no-unused-vars
  verifyWebhookSignature(rawBody, signature) {
    throw new Error('PaymentProvider.verifyWebhookSignature is not implemented');
  }

  /**
   * Normalises a gateway payload into the shape the payment service acts on.
   * @returns {{providerRef: string, outcome: 'SUCCESS'|'FAILED'|'REFUNDED', reason?: string}}
   */
  // eslint-disable-next-line no-unused-vars
  parseWebhook(payload) {
    throw new Error('PaymentProvider.parseWebhook is not implemented');
  }
}

export default PaymentProvider;
