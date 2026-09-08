import { MockPaymentProvider } from '../../src/modules/payments/providers/mock-payment.provider.js';
import { PaymentProvider } from '../../src/modules/payments/providers/payment-provider.interface.js';

const provider = new MockPaymentProvider();

describe('the provider contract', () => {
  it('implements the interface', () => {
    expect(provider).toBeInstanceOf(PaymentProvider);
    expect(provider.name).toBe('mock');
  });

  it('refuses to let the base class be used directly', async () => {
    const bare = new PaymentProvider();

    await expect(bare.initiate({})).rejects.toThrow(/not implemented/);
    expect(() => bare.verifyWebhookSignature('{}', 'sig')).toThrow(/not implemented/);
    expect(() => bare.parseWebhook({})).toThrow(/not implemented/);
  });
});

describe('initiate', () => {
  it('returns a reference and a checkout URL', async () => {
    const intent = await provider.initiate({ total: 42.5 });

    expect(intent.providerRef).toMatch(/^mock_[a-f0-9]{24}$/);
    expect(intent.checkoutUrl).toContain(intent.providerRef);
    expect(intent.amount).toBe(42.5);
  });

  it('never repeats a reference', async () => {
    const refs = await Promise.all(
      Array.from({ length: 50 }, () => provider.initiate({ total: 1 }))
    );

    expect(new Set(refs.map((intent) => intent.providerRef)).size).toBe(50);
  });
});

describe('verifyWebhookSignature', () => {
  const body = JSON.stringify({ event: 'payment.succeeded', data: { providerRef: 'mock_x' } });

  it('accepts a correctly signed body', () => {
    expect(provider.verifyWebhookSignature(body, MockPaymentProvider.sign(body))).toBe(true);
  });

  it('accepts a Buffer as well as a string', () => {
    const buffer = Buffer.from(body, 'utf8');

    expect(provider.verifyWebhookSignature(buffer, MockPaymentProvider.sign(buffer))).toBe(true);
  });

  it('rejects a signature for different content', () => {
    const other = JSON.stringify({ event: 'payment.failed', data: { providerRef: 'mock_x' } });

    expect(provider.verifyWebhookSignature(body, MockPaymentProvider.sign(other))).toBe(false);
  });

  it('rejects a body altered by even one byte', () => {
    const signature = MockPaymentProvider.sign(body);

    expect(provider.verifyWebhookSignature(`${body} `, signature)).toBe(false);
  });

  it('returns false rather than throwing on missing or malformed input', () => {
    // crypto.timingSafeEqual throws on a length mismatch, so these must be
    // guarded before they reach it.
    expect(provider.verifyWebhookSignature(body, undefined)).toBe(false);
    expect(provider.verifyWebhookSignature(body, '')).toBe(false);
    expect(provider.verifyWebhookSignature(body, 'short')).toBe(false);
    expect(provider.verifyWebhookSignature(null, MockPaymentProvider.sign(body))).toBe(false);
  });
});

describe('parseWebhook', () => {
  it.each([
    ['payment.succeeded', 'SUCCESS'],
    ['payment.failed', 'FAILED'],
    ['payment.refunded', 'REFUNDED'],
  ])('maps %s to %s', (event, outcome) => {
    const parsed = provider.parseWebhook({ event, data: { providerRef: 'mock_abc' } });

    expect(parsed).toMatchObject({ providerRef: 'mock_abc', outcome });
  });

  it('carries the failure reason through', () => {
    const parsed = provider.parseWebhook({
      event: 'payment.failed',
      data: { providerRef: 'mock_abc', reason: 'Card declined' },
    });

    expect(parsed.reason).toBe('Card declined');
  });

  it('rejects an unknown event', () => {
    expect(() => provider.parseWebhook({ event: 'payment.exploded', data: {} })).toThrow(
      /Unsupported webhook event/
    );
  });

  it('rejects a payload with no reference', () => {
    expect(() => provider.parseWebhook({ event: 'payment.succeeded', data: {} })).toThrow(
      /providerRef/
    );
  });

  it('rejects an empty payload', () => {
    expect(() => provider.parseWebhook(undefined)).toThrow();
  });
});
