import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { Order } from '../../src/modules/orders/order.model.js';
import { Payment, PAYMENT_STATUS } from '../../src/modules/payments/payment.model.js';
import { ORDER_STATUS } from '../../src/modules/orders/order.state-machine.js';
import { MockPaymentProvider } from '../../src/modules/payments/providers/mock-payment.provider.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { setupStore, addToCart } from '../setup/catalog.js';
import { signUp } from '../setup/auth.js';
import { customerPayload } from '../fixtures/users.js';

const app = createApp();
const api = '/api/v1/payments';
const invoiceDir = path.resolve(env.INVOICE_DIR);

beforeAll(connectTestDatabase);
afterEach(async () => {
  await clearTestDatabase();
  await fs.rm(invoiceDir, { recursive: true, force: true });
});
afterAll(disconnectTestDatabase);

/** Places an order and starts a payment against it. */
async function orderAwaitingPayment({ quantity = 1 } = {}) {
  const store = await setupStore(app);
  await addToCart(app, store.customer, {
    product: store.product.id,
    sku: 'AUR-14-SLV',
    quantity,
  });

  const checkout = await request(app)
    .post('/api/v1/orders/checkout')
    .set(store.customer.auth)
    .send({});

  const order = checkout.body.data.order;

  const initiated = await request(app)
    .post(`${api}/initiate`)
    .set(store.customer.auth)
    .send({ order: order.id });

  return { ...store, order, payment: initiated.body.data.payment };
}

/**
 * Fires a webhook the way the gateway would: a raw JSON body plus an HMAC over
 * exactly those bytes.
 */
function sendWebhook(payload, { signature } = {}) {
  const rawBody = JSON.stringify(payload);

  return request(app)
    .post(`${api}/webhook`)
    .set('Content-Type', 'application/json')
    .set('x-shopcore-signature', signature ?? MockPaymentProvider.sign(rawBody))
    .send(rawBody);
}

const succeeded = (providerRef) => ({ event: 'payment.succeeded', data: { providerRef } });
const failed = (providerRef, reason) => ({
  event: 'payment.failed',
  data: { providerRef, reason },
});

describe('POST /payments/initiate', () => {
  it('creates an INITIATED payment for the order total', async () => {
    const { order, payment } = await orderAwaitingPayment();

    expect(payment.status).toBe(PAYMENT_STATUS.INITIATED);
    expect(payment.amount).toBe(order.total);
    expect(payment.providerRef).toMatch(/^mock_[a-f0-9]{24}$/);
  });

  it('links the payment back to the order', async () => {
    const { order, payment } = await orderAwaitingPayment();

    const stored = await Order.findById(order.id).lean();
    expect(String(stored.payment)).toBe(payment.id);
  });

  it('reuses an outstanding attempt rather than opening a second one', async () => {
    const { customer, order, payment } = await orderAwaitingPayment();

    const second = await request(app)
      .post(`${api}/initiate`)
      .set(customer.auth)
      .send({ order: order.id });

    expect(second.body.data.payment.providerRef).toBe(payment.providerRef);
    expect(await Payment.countDocuments({ order: order.id })).toBe(1);
  });

  it('refuses to pay for somebody else’s order', async () => {
    const { order } = await orderAwaitingPayment();
    const stranger = await signUp(app, { ...customerPayload, email: 'stranger@example.com' });

    const response = await request(app)
      .post(`${api}/initiate`)
      .set(stranger.auth)
      .send({ order: order.id });

    expect(response.status).toBe(403);
  });

  it('refuses an order that is not awaiting payment', async () => {
    const { customer, order } = await orderAwaitingPayment();
    await Order.updateOne({ _id: order.id }, { $set: { status: ORDER_STATUS.CANCELLED } });

    const response = await request(app)
      .post(`${api}/initiate`)
      .set(customer.auth)
      .send({ order: order.id });

    expect(response.status).toBe(400);
  });

  it('ignores an amount sent by the client', async () => {
    const { customer, order } = await orderAwaitingPayment();

    const response = await request(app)
      .post(`${api}/initiate`)
      .set(customer.auth)
      .send({ order: order.id, amount: 0.01 });

    expect(response.status).toBe(422);
  });

  it('requires authentication', async () => {
    const { order } = await orderAwaitingPayment();

    const response = await request(app).post(`${api}/initiate`).send({ order: order.id });

    expect(response.status).toBe(401);
  });
});

describe('POST /payments/webhook — signature verification', () => {
  it('rejects a payload with no signature', async () => {
    const { payment } = await orderAwaitingPayment();

    const response = await request(app)
      .post(`${api}/webhook`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(succeeded(payment.providerRef)));

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects a forged signature', async () => {
    const { payment } = await orderAwaitingPayment();

    const response = await sendWebhook(succeeded(payment.providerRef), {
      signature: 'a'.repeat(64),
    });

    expect(response.status).toBe(401);
  });

  it('rejects a body altered after signing', async () => {
    const { payment } = await orderAwaitingPayment();

    // Sign one payload, send a different one — the classic tampering attempt.
    const signature = MockPaymentProvider.sign(JSON.stringify(succeeded(payment.providerRef)));

    const response = await sendWebhook(succeeded('mock_someoneelsesreference'), { signature });

    expect(response.status).toBe(401);
  });

  it('leaves the order untouched when a signature fails', async () => {
    const { order, payment } = await orderAwaitingPayment();

    await sendWebhook(succeeded(payment.providerRef), { signature: 'nope' });

    const stored = await Order.findById(order.id).lean();
    expect(stored.status).toBe(ORDER_STATUS.PENDING);
  });
});

describe('POST /payments/webhook — outcomes', () => {
  it('marks the payment successful and the order PAID', async () => {
    const { order, payment } = await orderAwaitingPayment();

    const response = await sendWebhook(succeeded(payment.providerRef));
    expect(response.status).toBe(200);

    const storedPayment = await Payment.findById(payment.id).lean();
    const storedOrder = await Order.findById(order.id).lean();

    expect(storedPayment.status).toBe(PAYMENT_STATUS.SUCCESS);
    expect(storedPayment.processedAt).not.toBeNull();
    expect(storedOrder.status).toBe(ORDER_STATUS.PAID);
  });

  it('keeps the gateway payload for audit', async () => {
    const { payment } = await orderAwaitingPayment();

    await sendWebhook(succeeded(payment.providerRef));

    const stored = await Payment.findById(payment.id).lean();
    expect(stored.rawResponse.event).toBe('payment.succeeded');
  });

  it('records the failure reason and moves the order to PAYMENT_FAILED', async () => {
    const { order, payment } = await orderAwaitingPayment();

    await sendWebhook(failed(payment.providerRef, 'Card declined'));

    const storedPayment = await Payment.findById(payment.id).lean();
    const storedOrder = await Order.findById(order.id).lean();

    expect(storedPayment.status).toBe(PAYMENT_STATUS.FAILED);
    expect(storedPayment.failureReason).toBe('Card declined');
    expect(storedOrder.status).toBe(ORDER_STATUS.PAYMENT_FAILED);
  });

  it('appends the transition to the order history', async () => {
    const { order, payment } = await orderAwaitingPayment();

    await sendWebhook(succeeded(payment.providerRef));

    const stored = await Order.findById(order.id).lean();
    const last = stored.statusHistory.at(-1);

    expect(last.status).toBe(ORDER_STATUS.PAID);
    // Driven by the gateway, not a person.
    expect(last.changedBy).toBeNull();
    expect(last.note).toContain(payment.providerRef);
  });

  it('is idempotent: a retried event does not apply twice', async () => {
    const { order, payment } = await orderAwaitingPayment();

    const first = await sendWebhook(succeeded(payment.providerRef));
    const second = await sendWebhook(succeeded(payment.providerRef));

    expect(first.body.data.duplicate).toBe(false);
    // A gateway retries until it sees a 2xx, so a duplicate must still succeed.
    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);

    const stored = await Order.findById(order.id).lean();
    const paidEntries = stored.statusHistory.filter((entry) => entry.status === ORDER_STATUS.PAID);
    expect(paidEntries).toHaveLength(1);
  });

  it('records a late callback but refuses to drag a cancelled order back to PAID', async () => {
    const { customer, order, payment } = await orderAwaitingPayment();

    await request(app).patch(`/api/v1/orders/${order.id}/cancel`).set(customer.auth).send({});

    const response = await sendWebhook(succeeded(payment.providerRef));
    expect(response.status).toBe(200);

    const storedPayment = await Payment.findById(payment.id).lean();
    const storedOrder = await Order.findById(order.id).lean();

    expect(storedPayment.status).toBe(PAYMENT_STATUS.SUCCESS);
    expect(storedOrder.status).toBe(ORDER_STATUS.CANCELLED);
  });

  it('404s for a reference nothing matches', async () => {
    const response = await sendWebhook(succeeded('mock_doesnotexist'));

    expect(response.status).toBe(404);
  });

  it('rejects an unsupported event type', async () => {
    const { payment } = await orderAwaitingPayment();

    const response = await sendWebhook({
      event: 'payment.teleported',
      data: { providerRef: payment.providerRef },
    });

    expect(response.status).toBe(400);
  });

  it('rejects a payload with no providerRef', async () => {
    const response = await sendWebhook({ event: 'payment.succeeded', data: {} });

    expect(response.status).toBe(422);
  });
});

describe('side effects of a successful payment', () => {
  it('generates an invoice PDF and records its URL', async () => {
    const { order, payment } = await orderAwaitingPayment();

    await sendWebhook(succeeded(payment.providerRef));

    const stored = await Order.findById(order.id).lean();
    expect(stored.invoiceUrl).toContain(`${order.reference}.pdf`);

    const written = await fs.readFile(path.join(invoiceDir, `${order.reference}.pdf`));
    // A real PDF starts with %PDF-.
    expect(written.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('does not generate an invoice for a failed payment', async () => {
    const { payment } = await orderAwaitingPayment();

    await sendWebhook(failed(payment.providerRef, 'Insufficient funds'));

    const files = await fs.readdir(invoiceDir).catch(() => []);
    expect(files).toHaveLength(0);
  });

  it('does not regenerate the invoice on a retried webhook', async () => {
    const { payment } = await orderAwaitingPayment();

    await sendWebhook(succeeded(payment.providerRef));
    await sendWebhook(succeeded(payment.providerRef));

    const files = await fs.readdir(invoiceDir);
    expect(files).toHaveLength(1);
  });
});

describe('GET /payments/:orderId', () => {
  it('returns the payment to the order owner', async () => {
    const { customer, order, payment } = await orderAwaitingPayment();

    const response = await request(app).get(`${api}/${order.id}`).set(customer.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.payment.providerRef).toBe(payment.providerRef);
  });

  it('refuses an unrelated customer', async () => {
    const { order } = await orderAwaitingPayment();
    const stranger = await signUp(app, { ...customerPayload, email: 'stranger@example.com' });

    const response = await request(app).get(`${api}/${order.id}`).set(stranger.auth);

    expect(response.status).toBe(403);
  });

  it('lets an admin read any payment', async () => {
    const { admin, order } = await orderAwaitingPayment();

    const response = await request(app).get(`${api}/${order.id}`).set(admin.auth);

    expect(response.status).toBe(200);
  });
});
