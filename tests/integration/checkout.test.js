import request from 'supertest';
import { createApp } from '../../src/app.js';
import { Product } from '../../src/modules/products/product.model.js';
import { Cart } from '../../src/modules/cart/cart.model.js';
import { Order } from '../../src/modules/orders/order.model.js';
import { ORDER_STATUS } from '../../src/modules/orders/order.state-machine.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { setupStore, addToCart } from '../setup/catalog.js';
import { signUp } from '../setup/auth.js';
import { customerPayload } from '../fixtures/users.js';

const app = createApp();
const api = '/api/v1/orders';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

/** Reads the live stock of one variant. */
async function stockOf(productId, sku) {
  const product = await Product.findById(productId).lean();
  return product.variants.find((variant) => variant.sku === sku).stock;
}

/** Sets up a store and puts `quantity` of the silver laptop in the cart. */
async function readyToCheckout({ quantity = 2 } = {}) {
  const store = await setupStore(app);
  await addToCart(app, store.customer, {
    product: store.product.id,
    sku: 'AUR-14-SLV',
    quantity,
  });
  return store;
}

describe('POST /orders/checkout', () => {
  it('creates an order priced from the catalogue', async () => {
    const { customer } = await readyToCheckout({ quantity: 2 });

    const response = await request(app).post(`${api}/checkout`).set(customer.auth).send({});

    expect(response.status).toBe(201);

    const { order } = response.body.data;
    expect(order.status).toBe(ORDER_STATUS.PENDING);
    expect(order.items).toHaveLength(1);
    expect(order.subtotal).toBe(2599.98);
    expect(order.total).toBe(2599.98);
    expect(order.reference).toMatch(/^SC-\d{8}-[0-9A-F]{8}$/);
  });

  it('snapshots the item name and price onto the order', async () => {
    const { customer, seller, product } = await readyToCheckout({ quantity: 1 });

    const placed = await request(app).post(`${api}/checkout`).set(customer.auth).send({});

    // Renaming and repricing the product afterwards must not rewrite history.
    await request(app)
      .patch(`/api/v1/products/${product.id}`)
      .set(seller.auth)
      .send({ name: 'Renamed Product', variants: [{ sku: 'AUR-14-SLV', price: 1, stock: 5 }] });

    const stored = await Order.findById(placed.body.data.order.id).lean();
    expect(stored.items[0].name).toBe('Aurora Ultrabook 14');
    expect(stored.items[0].price).toBe(1299.99);
  });

  it('decrements stock by exactly the quantity ordered', async () => {
    const { customer, product } = await readyToCheckout({ quantity: 3 });
    const before = await stockOf(product.id, 'AUR-14-SLV');

    await request(app).post(`${api}/checkout`).set(customer.auth).send({});

    expect(await stockOf(product.id, 'AUR-14-SLV')).toBe(before - 3);
  });

  it('empties the cart so it cannot be checked out twice', async () => {
    const { customer } = await readyToCheckout({ quantity: 1 });

    await request(app).post(`${api}/checkout`).set(customer.auth).send({});

    const cart = await request(app).get('/api/v1/cart').set(customer.auth);
    expect(cart.body.data.cart.items).toHaveLength(0);

    const second = await request(app).post(`${api}/checkout`).set(customer.auth).send({});
    expect(second.status).toBe(400);
  });

  it('snapshots the shipping address rather than referencing it', async () => {
    const { customer, address } = await readyToCheckout({ quantity: 1 });

    const response = await request(app)
      .post(`${api}/checkout`)
      .set(customer.auth)
      .send({ addressId: address.id });

    expect(response.body.data.order.shippingAddress.city).toBe('London');
    expect(response.body.data.order.shippingAddress).not.toHaveProperty('_id');
  });

  it('refuses an address belonging to somebody else', async () => {
    const { customer } = await readyToCheckout({ quantity: 1 });
    const stranger = await signUp(app, { ...customerPayload, email: 'stranger@example.com' });

    const theirAddress = await request(app)
      .post('/api/v1/users/me/addresses')
      .set(stranger.auth)
      .send({
        fullName: 'Stranger',
        phone: '+15550111',
        line1: '9 Elsewhere Road',
        city: 'Leeds',
        state: 'West Yorkshire',
        postalCode: 'LS1 1AA',
        country: 'United Kingdom',
      });

    const response = await request(app)
      .post(`${api}/checkout`)
      .set(customer.auth)
      .send({ addressId: theirAddress.body.data.addresses[0].id });

    expect(response.status).toBe(400);
  });

  it('refuses an empty cart', async () => {
    const store = await setupStore(app);

    const response = await request(app).post(`${api}/checkout`).set(store.customer.auth).send({});

    expect(response.status).toBe(400);
  });

  it('ignores any prices the client tries to send', async () => {
    const { customer } = await readyToCheckout({ quantity: 1 });

    const response = await request(app)
      .post(`${api}/checkout`)
      .set(customer.auth)
      .send({ total: 0.01, subtotal: 0.01, items: [] });

    expect(response.status).toBe(422);
  });

  it('refuses when stock ran out after the item was added to the cart', async () => {
    const { customer, product } = await readyToCheckout({ quantity: 2 });

    await Product.updateOne(
      { _id: product.id, 'variants.sku': 'AUR-14-SLV' },
      { $set: { 'variants.$.stock': 1 } }
    );

    const response = await request(app).post(`${api}/checkout`).set(customer.auth).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('refuses when the product was deactivated after it was added', async () => {
    const { customer, seller, product } = await readyToCheckout({ quantity: 1 });
    await request(app).delete(`/api/v1/products/${product.id}`).set(seller.auth);

    const response = await request(app).post(`${api}/checkout`).set(customer.auth).send({});

    expect(response.status).toBe(409);
  });

  it('leaves stock and the cart untouched when checkout fails', async () => {
    const { customer, product } = await readyToCheckout({ quantity: 2 });

    // Two lines, the second of which cannot be fulfilled: the transaction must
    // roll the first one's decrement back.
    await addToCart(app, customer, { product: product.id, sku: 'AUR-14-BLK', quantity: 4 });
    await Product.updateOne(
      { _id: product.id, 'variants.sku': 'AUR-14-BLK' },
      { $set: { 'variants.$.stock': 0 } }
    );

    const silverBefore = await stockOf(product.id, 'AUR-14-SLV');

    const response = await request(app).post(`${api}/checkout`).set(customer.auth).send({});
    expect(response.status).toBe(409);

    expect(await stockOf(product.id, 'AUR-14-SLV')).toBe(silverBefore);
    expect(await Order.countDocuments()).toBe(0);

    const cart = await Cart.findOne({ user: customer.user.id }).lean();
    expect(cart.items).toHaveLength(2);
  });

  it('does not oversell when two checkouts race for the last unit', async () => {
    const storeA = await setupStore(app);
    const buyerB = await signUp(app, { ...customerPayload, email: 'buyer-b@example.com' });

    await request(app).post('/api/v1/users/me/addresses').set(buyerB.auth).send({
      fullName: 'Buyer B',
      phone: '+15550122',
      line1: '2 Second Street',
      city: 'York',
      state: 'North Yorkshire',
      postalCode: 'YO1 1AA',
      country: 'United Kingdom',
    });

    // Exactly one unit left, and both carts want it.
    await Product.updateOne(
      { _id: storeA.product.id, 'variants.sku': 'AUR-14-SLV' },
      { $set: { 'variants.$.stock': 1 } }
    );

    await addToCart(app, storeA.customer, {
      product: storeA.product.id,
      sku: 'AUR-14-SLV',
      quantity: 1,
    });
    await addToCart(app, buyerB, { product: storeA.product.id, sku: 'AUR-14-SLV', quantity: 1 });

    const [first, second] = await Promise.all([
      request(app).post(`${api}/checkout`).set(storeA.customer.auth).send({}),
      request(app).post(`${api}/checkout`).set(buyerB.auth).send({}),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    expect(await stockOf(storeA.product.id, 'AUR-14-SLV')).toBe(0);
    expect(await Order.countDocuments()).toBe(1);
  });

  it('requires authentication', async () => {
    const response = await request(app).post(`${api}/checkout`).send({});

    expect(response.status).toBe(401);
  });
});

describe('order totals', () => {
  it('sums many lines without floating-point drift', async () => {
    const store = await setupStore(app);

    // 3 x 1299.99 + 4 x 1349.99 = 3899.97 + 5399.96 = 9299.93
    await addToCart(app, store.customer, {
      product: store.product.id,
      sku: 'AUR-14-SLV',
      quantity: 3,
    });
    await addToCart(app, store.customer, {
      product: store.product.id,
      sku: 'AUR-14-BLK',
      quantity: 4,
    });

    const response = await request(app).post(`${api}/checkout`).set(store.customer.auth).send({});

    expect(response.body.data.order.subtotal).toBe(9299.93);
    expect(response.body.data.order.total).toBe(9299.93);
  });

  it('reports a total that equals the sum of its own line totals', async () => {
    const { customer } = await readyToCheckout({ quantity: 3 });

    const response = await request(app).post(`${api}/checkout`).set(customer.auth).send({});
    const { order } = response.body.data;

    const summed = order.items.reduce((total, item) => total + item.lineTotal, 0);
    expect(order.subtotal).toBe(Math.round(summed * 100) / 100);
  });
});
