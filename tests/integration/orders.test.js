import request from 'supertest';
import { createApp } from '../../src/app.js';
import { Product } from '../../src/modules/products/product.model.js';
import { Order } from '../../src/modules/orders/order.model.js';
import { ORDER_STATUS } from '../../src/modules/orders/order.state-machine.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { setupStore, addToCart } from '../setup/catalog.js';
import { signUp } from '../setup/auth.js';
import { customerPayload, sellerPayload } from '../fixtures/users.js';

const app = createApp();
const api = '/api/v1/orders';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

async function stockOf(productId, sku) {
  const product = await Product.findById(productId).lean();
  return product.variants.find((variant) => variant.sku === sku).stock;
}

/** Places one order and returns the store context plus the created order. */
async function placeOrder({ quantity = 2 } = {}) {
  const store = await setupStore(app);
  await addToCart(app, store.customer, {
    product: store.product.id,
    sku: 'AUR-14-SLV',
    quantity,
  });

  const response = await request(app).post(`${api}/checkout`).set(store.customer.auth).send({});
  return { ...store, order: response.body.data.order };
}

/** Drives an order forward through the fulfilment path. */
function setStatus(actor, orderId, status, note) {
  return request(app)
    .patch(`${api}/${orderId}/status`)
    .set(actor.auth)
    .send({ status, ...(note ? { note } : {}) });
}

describe('GET /orders', () => {
  it('returns the customer their own orders', async () => {
    const { customer } = await placeOrder();

    const response = await request(app).get(api).set(customer.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.orders).toHaveLength(1);
    expect(response.body.meta.total).toBe(1);
  });

  it('does not leak another customer’s orders', async () => {
    await placeOrder();
    const stranger = await signUp(app, { ...customerPayload, email: 'stranger@example.com' });

    const response = await request(app).get(api).set(stranger.auth);

    expect(response.body.data.orders).toHaveLength(0);
  });

  it('shows a seller the orders containing their products', async () => {
    const { seller } = await placeOrder();

    const response = await request(app).get(api).set(seller.auth);

    expect(response.body.data.orders).toHaveLength(1);
  });

  it('does not show a seller orders for somebody else’s products', async () => {
    await placeOrder();
    const otherSeller = await signUp(app, { ...sellerPayload, email: 'other-seller@example.com' });

    const response = await request(app).get(api).set(otherSeller.auth);

    expect(response.body.data.orders).toHaveLength(0);
  });

  it('shows an admin every order', async () => {
    const { admin } = await placeOrder();

    const response = await request(app).get(api).set(admin.auth);

    expect(response.body.data.orders).toHaveLength(1);
  });

  it('filters by status', async () => {
    const { customer } = await placeOrder();

    const pending = await request(app).get(`${api}?status=PENDING`).set(customer.auth);
    const shipped = await request(app).get(`${api}?status=SHIPPED`).set(customer.auth);

    expect(pending.body.data.orders).toHaveLength(1);
    expect(shipped.body.data.orders).toHaveLength(0);
  });

  it('rejects an unknown status', async () => {
    const { customer } = await placeOrder();

    const response = await request(app).get(`${api}?status=INVENTED`).set(customer.auth);

    expect(response.status).toBe(422);
  });
});

describe('GET /orders/:id', () => {
  it('lets the owner read their order', async () => {
    const { customer, order } = await placeOrder();

    const response = await request(app).get(`${api}/${order.id}`).set(customer.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.order.reference).toBe(order.reference);
  });

  it('refuses an unrelated customer', async () => {
    const { order } = await placeOrder();
    const stranger = await signUp(app, { ...customerPayload, email: 'stranger@example.com' });

    const response = await request(app).get(`${api}/${order.id}`).set(stranger.auth);

    expect(response.status).toBe(403);
  });

  it('refuses a seller with nothing in the order', async () => {
    const { order } = await placeOrder();
    const otherSeller = await signUp(app, { ...sellerPayload, email: 'other-seller@example.com' });

    const response = await request(app).get(`${api}/${order.id}`).set(otherSeller.auth);

    expect(response.status).toBe(403);
  });

  it('404s for an order that does not exist', async () => {
    const { customer } = await placeOrder();

    const response = await request(app).get(`${api}/507f1f77bcf86cd799439011`).set(customer.auth);

    expect(response.status).toBe(404);
  });
});

describe('PATCH /orders/:id/cancel', () => {
  it('cancels a pending order and returns the stock', async () => {
    const { customer, product, order } = await placeOrder({ quantity: 3 });
    const heldStock = await stockOf(product.id, 'AUR-14-SLV');

    const response = await request(app)
      .patch(`${api}/${order.id}/cancel`)
      .set(customer.auth)
      .send({ reason: 'Changed my mind' });

    expect(response.status).toBe(200);
    expect(response.body.data.order.status).toBe(ORDER_STATUS.CANCELLED);
    expect(await stockOf(product.id, 'AUR-14-SLV')).toBe(heldStock + 3);
  });

  it('records who cancelled it and why', async () => {
    const { customer, order } = await placeOrder();

    await request(app)
      .patch(`${api}/${order.id}/cancel`)
      .set(customer.auth)
      .send({ reason: 'Ordered by mistake' });

    const stored = await Order.findById(order.id).lean();
    const last = stored.statusHistory.at(-1);

    expect(last.status).toBe(ORDER_STATUS.CANCELLED);
    expect(last.note).toBe('Ordered by mistake');
    expect(String(last.changedBy)).toBe(customer.user.id);
  });

  it('refuses to credit the stock twice', async () => {
    const { customer, product, order } = await placeOrder({ quantity: 2 });

    await request(app).patch(`${api}/${order.id}/cancel`).set(customer.auth).send({});
    const afterFirst = await stockOf(product.id, 'AUR-14-SLV');

    const second = await request(app)
      .patch(`${api}/${order.id}/cancel`)
      .set(customer.auth)
      .send({});

    expect(second.status).toBe(400);
    expect(await stockOf(product.id, 'AUR-14-SLV')).toBe(afterFirst);
  });

  it('refuses once the order has shipped', async () => {
    const { customer, seller, order } = await placeOrder();

    await setStatus(seller, order.id, ORDER_STATUS.PAID).expect(403);
    // Payment statuses are system-driven, so move it along the seller's path.
    await Order.updateOne({ _id: order.id }, { $set: { status: ORDER_STATUS.PROCESSING } });
    await setStatus(seller, order.id, ORDER_STATUS.SHIPPED);

    const response = await request(app)
      .patch(`${api}/${order.id}/cancel`)
      .set(customer.auth)
      .send({});

    expect(response.status).toBe(400);
  });

  it('refuses a customer who does not own the order', async () => {
    const { order } = await placeOrder();
    const stranger = await signUp(app, { ...customerPayload, email: 'stranger@example.com' });

    const response = await request(app)
      .patch(`${api}/${order.id}/cancel`)
      .set(stranger.auth)
      .send({});

    expect(response.status).toBe(403);
  });

  it('refuses a customer once the cancellation window has closed', async () => {
    const { customer, order } = await placeOrder();

    // Backdate the order beyond ORDER_CANCELLATION_WINDOW_HOURS.
    await Order.updateOne(
      { _id: order.id },
      { $set: { placedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) } }
    );

    const response = await request(app)
      .patch(`${api}/${order.id}/cancel`)
      .set(customer.auth)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/within/i);
  });

  it('still lets an admin cancel outside the customer window', async () => {
    const { admin, order } = await placeOrder();

    await Order.updateOne(
      { _id: order.id },
      { $set: { placedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) } }
    );

    const response = await request(app)
      .patch(`${api}/${order.id}/cancel`)
      .set(admin.auth)
      .send({ reason: 'Support request' });

    expect(response.status).toBe(200);
  });
});

describe('PATCH /orders/:id/status', () => {
  it('walks the fulfilment path', async () => {
    const { seller, order } = await placeOrder();
    await Order.updateOne({ _id: order.id }, { $set: { status: ORDER_STATUS.PAID } });

    const processing = await setStatus(seller, order.id, ORDER_STATUS.PROCESSING);
    const shipped = await setStatus(seller, order.id, ORDER_STATUS.SHIPPED, 'Tracking AB123');
    const delivered = await setStatus(seller, order.id, ORDER_STATUS.DELIVERED);

    expect(processing.body.data.order.status).toBe(ORDER_STATUS.PROCESSING);
    expect(shipped.body.data.order.status).toBe(ORDER_STATUS.SHIPPED);
    expect(delivered.body.data.order.status).toBe(ORDER_STATUS.DELIVERED);

    const stored = await Order.findById(order.id).lean();
    expect(stored.statusHistory.map((entry) => entry.status)).toEqual([
      ORDER_STATUS.PENDING,
      ORDER_STATUS.PROCESSING,
      ORDER_STATUS.SHIPPED,
      ORDER_STATUS.DELIVERED,
    ]);
  });

  it('refuses to skip a step', async () => {
    const { seller, order } = await placeOrder();

    const response = await setStatus(seller, order.id, ORDER_STATUS.DELIVERED);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/Cannot move an order from PENDING to DELIVERED/);
  });

  it('refuses a customer any fulfilment transition', async () => {
    const { customer, order } = await placeOrder();

    const response = await setStatus(customer, order.id, ORDER_STATUS.SHIPPED);

    expect(response.status).toBe(403);
  });

  it('refuses a seller with nothing in the order', async () => {
    const { order } = await placeOrder();
    const otherSeller = await signUp(app, { ...sellerPayload, email: 'other-seller@example.com' });

    const response = await setStatus(otherSeller, order.id, ORDER_STATUS.PROCESSING);

    expect(response.status).toBe(403);
  });

  it('reserves refunds for an admin', async () => {
    const { admin, seller, order } = await placeOrder();
    await Order.updateOne({ _id: order.id }, { $set: { status: ORDER_STATUS.PAID } });

    const bySeller = await setStatus(seller, order.id, ORDER_STATUS.REFUNDED);
    expect(bySeller.status).toBe(403);

    const byAdmin = await setStatus(admin, order.id, ORDER_STATUS.REFUNDED);
    expect(byAdmin.status).toBe(200);
  });

  it('returns the stock when a paid order is refunded', async () => {
    const { admin, product, order } = await placeOrder({ quantity: 2 });
    await Order.updateOne({ _id: order.id }, { $set: { status: ORDER_STATUS.PAID } });

    const heldStock = await stockOf(product.id, 'AUR-14-SLV');
    await setStatus(admin, order.id, ORDER_STATUS.REFUNDED);

    expect(await stockOf(product.id, 'AUR-14-SLV')).toBe(heldStock + 2);
  });

  it('returns the stock when delivered goods are sent back', async () => {
    const { seller, product, order } = await placeOrder({ quantity: 2 });
    await Order.updateOne({ _id: order.id }, { $set: { status: ORDER_STATUS.SHIPPED } });

    const heldStock = await stockOf(product.id, 'AUR-14-SLV');
    await setStatus(seller, order.id, ORDER_STATUS.DELIVERED);
    // Still held: delivery does not release anything.
    expect(await stockOf(product.id, 'AUR-14-SLV')).toBe(heldStock);

    await setStatus(seller, order.id, ORDER_STATUS.RETURNED);
    expect(await stockOf(product.id, 'AUR-14-SLV')).toBe(heldStock + 2);
  });

  it('holds stock through the whole fulfilment path', async () => {
    const { seller, product, order } = await placeOrder({ quantity: 2 });
    await Order.updateOne({ _id: order.id }, { $set: { status: ORDER_STATUS.PAID } });

    const heldStock = await stockOf(product.id, 'AUR-14-SLV');

    await setStatus(seller, order.id, ORDER_STATUS.PROCESSING);
    await setStatus(seller, order.id, ORDER_STATUS.SHIPPED);
    await setStatus(seller, order.id, ORDER_STATUS.DELIVERED);

    expect(await stockOf(product.id, 'AUR-14-SLV')).toBe(heldStock);
  });

  it('refuses to move a terminal order anywhere', async () => {
    const { admin, customer, order } = await placeOrder();
    await request(app).patch(`${api}/${order.id}/cancel`).set(customer.auth).send({});

    const response = await setStatus(admin, order.id, ORDER_STATUS.PROCESSING);

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/cannot change status/);
  });
});
