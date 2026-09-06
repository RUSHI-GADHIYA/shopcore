import request from 'supertest';
import { createApp } from '../../src/app.js';
import { Product } from '../../src/modules/products/product.model.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { setupStore, addToCart } from '../setup/catalog.js';
import { signUp } from '../setup/auth.js';
import { customerPayload } from '../fixtures/users.js';

const app = createApp();
const api = '/api/v1/cart';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

describe('GET /cart', () => {
  it('creates an empty cart on first read', async () => {
    const { customer } = await setupStore(app);

    const response = await request(app).get(api).set(customer.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.cart.items).toEqual([]);
    expect(response.body.data.cart.subtotal).toBe(0);
  });

  it('requires authentication', async () => {
    const response = await request(app).get(api);

    expect(response.status).toBe(401);
  });

  it('keeps carts separate between users', async () => {
    const { customer, product } = await setupStore(app);
    await addToCart(app, customer, { product: product.id, sku: 'AUR-14-SLV', quantity: 2 });

    const other = await signUp(app, { ...customerPayload, email: 'second@example.com' });
    const response = await request(app).get(api).set(other.auth);

    expect(response.body.data.cart.items).toHaveLength(0);
  });
});

describe('POST /cart/items', () => {
  it('adds a line priced from the catalogue', async () => {
    const { customer, product } = await setupStore(app);

    const response = await addToCart(app, customer, {
      product: product.id,
      sku: 'AUR-14-SLV',
      quantity: 2,
    });

    expect(response.status).toBe(201);

    const [line] = response.body.data.cart.items;
    expect(line.sku).toBe('AUR-14-SLV');
    expect(line.quantity).toBe(2);
    expect(line.unitPrice).toBe(1299.99);
    expect(line.lineTotal).toBe(2599.98);
    expect(response.body.data.cart.subtotal).toBe(2599.98);
  });

  it('tops up an existing line rather than duplicating it', async () => {
    const { customer, product } = await setupStore(app);

    await addToCart(app, customer, { product: product.id, sku: 'AUR-14-SLV', quantity: 2 });
    const response = await addToCart(app, customer, {
      product: product.id,
      sku: 'AUR-14-SLV',
      quantity: 3,
    });

    expect(response.body.data.cart.items).toHaveLength(1);
    expect(response.body.data.cart.items[0].quantity).toBe(5);
  });

  it('keeps two variants of one product as separate lines', async () => {
    const { customer, product } = await setupStore(app);

    await addToCart(app, customer, { product: product.id, sku: 'AUR-14-SLV', quantity: 1 });
    const response = await addToCart(app, customer, {
      product: product.id,
      sku: 'AUR-14-BLK',
      quantity: 1,
    });

    expect(response.body.data.cart.items).toHaveLength(2);
  });

  it('refuses more than the stock on hand', async () => {
    const { customer, product } = await setupStore(app);

    // AUR-14-BLK has 4 in stock.
    const response = await addToCart(app, customer, {
      product: product.id,
      sku: 'AUR-14-BLK',
      quantity: 5,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('counts the existing quantity when checking stock on a top-up', async () => {
    const { customer, product } = await setupStore(app);

    await addToCart(app, customer, { product: product.id, sku: 'AUR-14-BLK', quantity: 3 });
    const response = await addToCart(app, customer, {
      product: product.id,
      sku: 'AUR-14-BLK',
      quantity: 2,
    });

    expect(response.status).toBe(409);
  });

  it('refuses an unknown SKU', async () => {
    const { customer, product } = await setupStore(app);

    const response = await addToCart(app, customer, { product: product.id, sku: 'NOPE-1' });

    expect(response.status).toBe(404);
  });

  it('refuses a deactivated product', async () => {
    const { customer, seller, product } = await setupStore(app);
    await request(app).delete(`/api/v1/products/${product.id}`).set(seller.auth);

    const response = await addToCart(app, customer, { product: product.id, sku: 'AUR-14-SLV' });

    expect(response.status).toBe(404);
  });

  it('rejects a zero or negative quantity', async () => {
    const { customer, product } = await setupStore(app);

    const zero = await addToCart(app, customer, {
      product: product.id,
      sku: 'AUR-14-SLV',
      quantity: 0,
    });
    const negative = await addToCart(app, customer, {
      product: product.id,
      sku: 'AUR-14-SLV',
      quantity: -3,
    });

    expect(zero.status).toBe(422);
    expect(negative.status).toBe(422);
  });
});

describe('PATCH /cart/items/:sku', () => {
  it('sets the quantity outright', async () => {
    const { customer, product } = await setupStore(app);
    await addToCart(app, customer, { product: product.id, sku: 'AUR-14-SLV', quantity: 2 });

    const response = await request(app)
      .patch(`${api}/items/AUR-14-SLV`)
      .set(customer.auth)
      .send({ quantity: 5 });

    expect(response.status).toBe(200);
    expect(response.body.data.cart.items[0].quantity).toBe(5);
  });

  it('refuses a quantity beyond stock', async () => {
    const { customer, product } = await setupStore(app);
    await addToCart(app, customer, { product: product.id, sku: 'AUR-14-BLK', quantity: 1 });

    const response = await request(app)
      .patch(`${api}/items/AUR-14-BLK`)
      .set(customer.auth)
      .send({ quantity: 99 });

    expect(response.status).toBe(409);
  });

  it('404s for a line that is not in the cart', async () => {
    const { customer } = await setupStore(app);

    const response = await request(app)
      .patch(`${api}/items/AUR-14-SLV`)
      .set(customer.auth)
      .send({ quantity: 1 });

    expect(response.status).toBe(404);
  });
});

describe('DELETE /cart/items/:sku', () => {
  it('removes the line', async () => {
    const { customer, product } = await setupStore(app);
    await addToCart(app, customer, { product: product.id, sku: 'AUR-14-SLV', quantity: 2 });

    const response = await request(app).delete(`${api}/items/AUR-14-SLV`).set(customer.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.cart.items).toHaveLength(0);
  });

  it('404s for a line that is not in the cart', async () => {
    const { customer } = await setupStore(app);

    const response = await request(app).delete(`${api}/items/AUR-14-SLV`).set(customer.auth);

    expect(response.status).toBe(404);
  });
});

describe('reconciliation against the live catalogue', () => {
  it('flags a price change and charges the live price, not the snapshot', async () => {
    const { customer, seller, product } = await setupStore(app);
    await addToCart(app, customer, { product: product.id, sku: 'AUR-14-SLV', quantity: 2 });

    await request(app)
      .patch(`/api/v1/products/${product.id}`)
      .set(seller.auth)
      .send({ variants: [{ sku: 'AUR-14-SLV', price: 1499.99, stock: 12 }] });

    const response = await request(app).get(api).set(customer.auth);
    const [line] = response.body.data.cart.items;

    expect(line.issues).toContain('PRICE_CHANGED');
    expect(line.priceSnapshot).toBe(1299.99);
    expect(line.unitPrice).toBe(1499.99);
    expect(response.body.data.cart.subtotal).toBe(2999.98);
    expect(response.body.data.cart.hasIssues).toBe(true);
  });

  it('flags a line whose stock has fallen below the cart quantity', async () => {
    const { customer, product } = await setupStore(app);
    await addToCart(app, customer, { product: product.id, sku: 'AUR-14-SLV', quantity: 10 });

    await Product.updateOne(
      { _id: product.id, 'variants.sku': 'AUR-14-SLV' },
      { $set: { 'variants.$.stock': 2 } }
    );

    const response = await request(app).get(api).set(customer.auth);

    expect(response.body.data.cart.items[0].issues).toContain('INSUFFICIENT_STOCK');
  });

  it('flags a product that was deactivated after it was added', async () => {
    const { customer, seller, product } = await setupStore(app);
    await addToCart(app, customer, { product: product.id, sku: 'AUR-14-SLV', quantity: 1 });

    await request(app).delete(`/api/v1/products/${product.id}`).set(seller.auth);

    const response = await request(app).get(api).set(customer.auth);

    expect(response.body.data.cart.items[0].issues).toContain('PRODUCT_UNAVAILABLE');
    // An unavailable line must not contribute to the subtotal.
    expect(response.body.data.cart.subtotal).toBe(0);
  });
});
