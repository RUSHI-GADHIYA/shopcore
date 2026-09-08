/**
 * Every resource exposes `id`, whichever endpoint returned it.
 *
 * Listing endpoints use `.lean()` for speed, which skips the document layer and
 * with it the `id` virtual. That left `GET /products` returning `_id` while
 * `GET /products/:slug` returned both — two shapes for one resource, and every
 * client left to paper over the difference. The browser harness hit it
 * immediately: its add-to-cart button read `product.id` from a listing and sent
 * `undefined`.
 *
 * `utils/ApiResponse.js` normalises every success payload, and these tests keep
 * it that way. A Mongoose plugin was the first attempt and was wrong: a global
 * plugin only applies to schemas compiled after it registers, so it depended on
 * import order and did nothing at all in this suite.
 */
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { setupStore, addToCart } from '../setup/catalog.js';

const app = createApp();
const api = '/api/v1';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

const isObjectIdString = (value) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

describe('listings expose id, not only _id', () => {
  it('GET /products', async () => {
    await setupStore(app);

    const response = await request(app).get(`${api}/products`);
    const [product] = response.body.data.products;

    expect(isObjectIdString(product.id)).toBe(true);
    expect(product.id).toBe(String(product._id));
  });

  it('GET /categories in both formats', async () => {
    await setupStore(app);

    const flat = await request(app).get(`${api}/categories?format=flat`);
    const tree = await request(app).get(`${api}/categories`);

    expect(isObjectIdString(flat.body.data.categories[0].id)).toBe(true);
    expect(isObjectIdString(tree.body.data.categories[0].id)).toBe(true);
  });

  it('GET /orders', async () => {
    const store = await setupStore(app);
    await addToCart(app, store.customer, { product: store.product.id, sku: 'AUR-14-SLV' });
    await request(app).post(`${api}/orders/checkout`).set(store.customer.auth).send({});

    const response = await request(app).get(`${api}/orders`).set(store.customer.auth);
    const [order] = response.body.data.orders;

    expect(isObjectIdString(order.id)).toBe(true);
  });

  it('GET /users, for an admin', async () => {
    const store = await setupStore(app);

    const response = await request(app).get(`${api}/users`).set(store.admin.auth);

    for (const user of response.body.data.users) {
      expect(isObjectIdString(user.id)).toBe(true);
    }
  });
});

describe('the same resource has one shape either way', () => {
  it('a product is identical whether listed or fetched', async () => {
    await setupStore(app);

    const listed = (await request(app).get(`${api}/products`)).body.data.products[0];
    const fetched = (await request(app).get(`${api}/products/${listed.slug}`)).body.data.product;

    expect(listed.id).toBe(fetched.id);
  });

  it('nested subdocuments carry an id too', async () => {
    const store = await setupStore(app);

    const response = await request(app).get(`${api}/products/${store.product.slug}`);

    // Variants are what a cart line is added by, so they need a stable handle.
    for (const variant of response.body.data.product.variants) {
      expect(isObjectIdString(variant.id)).toBe(true);
    }
  });
});

describe('normalisation is additive', () => {
  it('keeps _id alongside the new id', async () => {
    await setupStore(app);

    const [product] = (await request(app).get(`${api}/products`)).body.data.products;

    expect(product._id).toBeDefined();
    expect(product.id).toBeDefined();
  });

  it('leaves a populated reference resolvable', async () => {
    await setupStore(app);

    const [product] = (await request(app).get(`${api}/products`)).body.data.products;

    // `category` is populated, so it is a nested document, not a bare id.
    expect(product.category.name).toBe('Electronics');
    expect(isObjectIdString(product.category.id)).toBe(true);
  });

  it('does not corrupt dates', async () => {
    await setupStore(app);

    const [product] = (await request(app).get(`${api}/products`)).body.data.products;

    expect(Number.isNaN(Date.parse(product.createdAt))).toBe(false);
  });
});
