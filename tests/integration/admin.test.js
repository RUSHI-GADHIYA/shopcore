import request from 'supertest';
import { createApp } from '../../src/app.js';
import { Order } from '../../src/modules/orders/order.model.js';
import { Product } from '../../src/modules/products/product.model.js';
import { ORDER_STATUS } from '../../src/modules/orders/order.state-machine.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { setupStore, addToCart } from '../setup/catalog.js';
import { signUp } from '../setup/auth.js';
import { sellerPayload } from '../fixtures/users.js';

const app = createApp();
const api = '/api/v1/admin';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

/** Places an order and forces it to a status that counts towards revenue. */
async function paidOrder(store, { quantity = 1, status = ORDER_STATUS.DELIVERED } = {}) {
  await addToCart(app, store.customer, {
    product: store.product.id,
    sku: 'AUR-14-SLV',
    quantity,
  });

  const checkout = await request(app)
    .post('/api/v1/orders/checkout')
    .set(store.customer.auth)
    .send({});

  await Order.updateOne({ _id: checkout.body.data.order.id }, { $set: { status } });
  return checkout.body.data.order;
}

describe('GET /admin/dashboard', () => {
  it('refuses a customer', async () => {
    const store = await setupStore(app);

    const response = await request(app).get(`${api}/dashboard`).set(store.customer.auth);

    expect(response.status).toBe(403);
  });

  it('refuses a seller', async () => {
    const store = await setupStore(app);

    const response = await request(app).get(`${api}/dashboard`).set(store.seller.auth);

    expect(response.status).toBe(403);
  });

  it('reports revenue from paid orders', async () => {
    const store = await setupStore(app);
    await paidOrder(store, { quantity: 2 });

    const response = await request(app).get(`${api}/dashboard`).set(store.admin.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.dashboard.revenue.gross).toBe(2599.98);
    expect(response.body.data.dashboard.revenue.orders).toBe(1);
    expect(response.body.data.dashboard.revenue.averageOrderValue).toBe(2599.98);
  });

  it('excludes unpaid orders from revenue', async () => {
    const store = await setupStore(app);
    // Left PENDING: nobody has actually sent this money.
    await paidOrder(store, { status: ORDER_STATUS.PENDING });

    const response = await request(app).get(`${api}/dashboard`).set(store.admin.auth);

    expect(response.body.data.dashboard.revenue.gross).toBe(0);
    expect(response.body.data.dashboard.orders.byStatus.PENDING).toBe(1);
  });

  it('excludes cancelled orders from revenue', async () => {
    const store = await setupStore(app);
    await paidOrder(store, { status: ORDER_STATUS.CANCELLED });

    const response = await request(app).get(`${api}/dashboard`).set(store.admin.auth);

    expect(response.body.data.dashboard.revenue.gross).toBe(0);
  });

  it('returns every status even at zero, so the tiles are stable', async () => {
    const store = await setupStore(app);

    const response = await request(app).get(`${api}/dashboard`).set(store.admin.auth);
    const { byStatus } = response.body.data.dashboard.orders;

    expect(Object.keys(byStatus).sort()).toEqual(Object.values(ORDER_STATUS).sort());
    expect(Object.values(byStatus).every((count) => count === 0)).toBe(true);
  });

  it('handles an empty database without dividing by zero', async () => {
    const store = await setupStore(app);

    const response = await request(app).get(`${api}/dashboard`).set(store.admin.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.dashboard.revenue).toMatchObject({
      gross: 0,
      orders: 0,
      averageOrderValue: 0,
    });
  });

  it('ranks top products by revenue', async () => {
    const store = await setupStore(app);
    await paidOrder(store, { quantity: 2 });

    const response = await request(app).get(`${api}/dashboard`).set(store.admin.auth);
    const [top] = response.body.data.dashboard.topProducts;

    expect(top.name).toBe('Aurora Ultrabook 14');
    expect(top.unitsSold).toBe(2);
    expect(top.revenue).toBe(2599.98);
  });

  it('counts today’s orders', async () => {
    const store = await setupStore(app);
    await paidOrder(store);

    const response = await request(app).get(`${api}/dashboard`).set(store.admin.auth);

    expect(response.body.data.dashboard.orders.today).toBe(1);
  });

  it('summarises the catalogue', async () => {
    const store = await setupStore(app);

    const response = await request(app).get(`${api}/dashboard`).set(store.admin.auth);

    expect(response.body.data.dashboard.catalogue).toMatchObject({
      products: 1,
      activeProducts: 1,
    });
  });

  it('rejects a reversed date range', async () => {
    const store = await setupStore(app);

    const response = await request(app)
      .get(`${api}/dashboard?from=2030-01-02&to=2030-01-01`)
      .set(store.admin.auth);

    expect(response.status).toBe(422);
  });

  it('honours a date filter', async () => {
    const store = await setupStore(app);
    await paidOrder(store);

    const future = await request(app).get(`${api}/dashboard?from=2099-01-01`).set(store.admin.auth);

    expect(future.body.data.dashboard.revenue.gross).toBe(0);
  });
});

describe('GET /admin/reports/low-stock', () => {
  it('lists variants at or below the threshold', async () => {
    const store = await setupStore(app);

    const response = await request(app).get(`${api}/reports/low-stock`).set(store.admin.auth);

    expect(response.status).toBe(200);
    // AUR-14-BLK has 4 in stock, below the default threshold of 5.
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].sku).toBe('AUR-14-BLK');
    expect(response.body.data.threshold).toBe(5);
  });

  it('accepts a custom threshold', async () => {
    const store = await setupStore(app);

    const response = await request(app)
      .get(`${api}/reports/low-stock?threshold=20`)
      .set(store.admin.auth);

    // Now both variants (12 and 4) qualify.
    expect(response.body.data.items).toHaveLength(2);
  });

  it('sorts the scarcest first', async () => {
    const store = await setupStore(app);

    const response = await request(app)
      .get(`${api}/reports/low-stock?threshold=100`)
      .set(store.admin.auth);

    const stocks = response.body.data.items.map((item) => item.stock);
    expect(stocks).toEqual([...stocks].sort((a, b) => a - b));
  });

  it('lets a seller see their own products', async () => {
    const store = await setupStore(app);

    const response = await request(app).get(`${api}/reports/low-stock`).set(store.seller.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(1);
  });

  it('does not show a seller somebody else’s stock', async () => {
    await setupStore(app);
    const otherSeller = await signUp(app, { ...sellerPayload, email: 'other@example.com' });

    const response = await request(app).get(`${api}/reports/low-stock`).set(otherSeller.auth);

    expect(response.body.data.items).toHaveLength(0);
  });

  it('refuses a customer', async () => {
    const store = await setupStore(app);

    const response = await request(app).get(`${api}/reports/low-stock`).set(store.customer.auth);

    expect(response.status).toBe(403);
  });

  it('omits deactivated products', async () => {
    const store = await setupStore(app);
    await Product.updateOne({ _id: store.product.id }, { $set: { isActive: false } });

    const response = await request(app).get(`${api}/reports/low-stock`).set(store.admin.auth);

    expect(response.body.data.items).toHaveLength(0);
  });

  it('paginates', async () => {
    const store = await setupStore(app);

    const response = await request(app)
      .get(`${api}/reports/low-stock?threshold=100&limit=1`)
      .set(store.admin.auth);

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.meta).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 });
  });
});

describe('GET /admin/reports/sales-trend', () => {
  it('returns one row per day with orders', async () => {
    const store = await setupStore(app);
    await paidOrder(store);

    const response = await request(app).get(`${api}/reports/sales-trend`).set(store.admin.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.trend).toHaveLength(1);
    expect(response.body.data.trend[0]).toMatchObject({ orders: 1, revenue: 1299.99 });
    expect(response.body.data.trend[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('caps the window at a year', async () => {
    const store = await setupStore(app);

    const response = await request(app)
      .get(`${api}/reports/sales-trend?days=400`)
      .set(store.admin.auth);

    expect(response.status).toBe(422);
  });

  it('refuses a seller', async () => {
    const store = await setupStore(app);

    const response = await request(app).get(`${api}/reports/sales-trend`).set(store.seller.auth);

    expect(response.status).toBe(403);
  });
});
