import { env } from '../../../config/env.js';
import { MockPaymentProvider } from './mock-payment.provider.js';

/**
 * Resolves the configured gateway (spec §10). Adding Stripe means writing one
 * adapter, registering it here, and widening the PAYMENT_PROVIDER enum in
 * config/env.js — no order or payment logic changes.
 */
const PROVIDERS = {
  mock: MockPaymentProvider,
};

let instance = null;

export function getPaymentProvider() {
  if (!instance) {
    const Provider = PROVIDERS[env.PAYMENT_PROVIDER];
    if (!Provider) throw new Error(`Unknown payment provider: ${env.PAYMENT_PROVIDER}`);
    instance = new Provider();
  }
  return instance;
}

/** Test hook: reset the memoised instance. */
export function __resetPaymentProvider() {
  instance = null;
}
