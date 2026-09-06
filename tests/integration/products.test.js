import request from 'supertest';
import { createApp } from '../../src/app.js';
import { Product } from '../../src/modules/products/product.model.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { signUp, signUpAdmin } from '../setup/auth.js';
import { customerPayload, sellerPayload } from '../fixtures/users.js';
import { keyboardPayload, laptopPayload, monitorPayload } from '../fixtures/catalog.js';

const app = createApp();
const api = '/api/v1/products';

beforeAll(async () => {
  await connectTestDatabase();
  // The text index backs the search tests, and Mongoose builds indexes in the
  // background — waiting here avoids a race on the first search.
  await Product.init();
});
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

/** Signs up an admin, a seller, and a category for the catalogue under test. */
async function setupCatalog() {
  const admin = await signUpAdmin(app);
  const seller = await signUp(app, sellerPayload);

  const category = await request(app)
    .post('/api/v1/categories')
    .set(admin.auth)
    .send({ name: 'Electronics' });

  return { admin, seller, category: category.body.data.category };
}

async function createProduct(auth, payload, categoryId) {
  return request(app)
    .post(api)
    .set(auth)
    .send({ ...payload, category: categoryId });
}

describe('POST /products', () => {
  it('creates a product owned by the calling seller', async () => {
    const { seller, category } = await setupCatalog();

    const response = await createProduct(seller.auth, laptopPayload, category.id);

    expect(response.status).toBe(201);
    expect(response.body.data.product.slug).toBe('aurora-ultrabook-14');
    expect(String(response.body.data.product.seller)).toBe(seller.user.id);
  });

  it('derives basePrice from the cheapest variant', async () => {
    const { seller, category } = await setupCatalog();

    const response = await createProduct(seller.auth, laptopPayload, category.id);

    expect(response.body.data.product.basePrice).toBe(1299.99);
  });

  it('refuses a customer', async () => {
    const { category } = await setupCatalog();
    const customer = await signUp(app, customerPayload);

    const response = await createProduct(customer.auth, laptopPayload, category.id);

    expect(response.status).toBe(403);
  });

  it('refuses an unknown category', async () => {
    const { seller } = await setupCatalog();

    const response = await createProduct(seller.auth, laptopPayload, '507f1f77bcf86cd799439011');

    expect(response.status).toBe(400);
  });

  it('refuses a product with no variants', async () => {
    const { seller, category } = await setupCatalog();

    const response = await createProduct(
      seller.auth,
      { ...laptopPayload, variants: [] },
      category.id
    );

    expect(response.status).toBe(422);
  });

  it('refuses duplicate SKUs within one product', async () => {
    const { seller, category } = await setupCatalog();

    const response = await createProduct(
      seller.auth,
      { ...laptopPayload, variants: [laptopPayload.variants[0], laptopPayload.variants[0]] },
      category.id
    );

    expect(response.status).toBe(422);
  });

  it('refuses a SKU already used by another product', async () => {
    const { seller, category } = await setupCatalog();
    await createProduct(seller.auth, laptopPayload, category.id);

    const response = await createProduct(
      seller.auth,
      { ...monitorPayload, variants: [{ ...monitorPayload.variants[0], sku: 'AUR-14-SLV' }] },
      category.id
    );

    expect(response.status).toBe(409);
  });

  it('ignores client-supplied image URLs', async () => {
    const { seller, category } = await setupCatalog();

    const response = await request(app)
      .post(api)
      .set(seller.auth)
      .send({ ...laptopPayload, category: category.id, images: ['https://evil.example/x.png'] });

    expect(response.status).toBe(422);
  });
});

describe('GET /products', () => {
  async function seedCatalog() {
    const context = await setupCatalog();
    await createProduct(context.seller.auth, laptopPayload, context.category.id);
    await createProduct(context.seller.auth, keyboardPayload, context.category.id);
    await createProduct(context.seller.auth, monitorPayload, context.category.id);
    return context;
  }

  it('lists active products with pagination meta', async () => {
    await seedCatalog();

    const response = await request(app).get(`${api}?limit=2`);

    expect(response.status).toBe(200);
    expect(response.body.data.products).toHaveLength(2);
    expect(response.body.meta).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
  });

  it('is reachable without authentication', async () => {
    await seedCatalog();

    const response = await request(app).get(api);

    expect(response.status).toBe(200);
  });

  it('filters by price range', async () => {
    await seedCatalog();

    const response = await request(app).get(`${api}?minPrice=100&maxPrice=500`);

    expect(response.body.data.products).toHaveLength(1);
    expect(response.body.data.products[0].name).toBe(monitorPayload.name);
  });

  it('rejects an inverted price range', async () => {
    const response = await request(app).get(`${api}?minPrice=500&maxPrice=100`);

    expect(response.status).toBe(422);
  });

  it('filters to items that are actually buyable', async () => {
    await seedCatalog();

    const inStock = await request(app).get(`${api}?inStock=true`);
    const outOfStock = await request(app).get(`${api}?inStock=false`);

    expect(inStock.body.data.products).toHaveLength(2);
    expect(outOfStock.body.data.products).toHaveLength(1);
    expect(outOfStock.body.data.products[0].name).toBe(keyboardPayload.name);
  });

  it('sorts by price ascending and descending', async () => {
    await seedCatalog();

    const ascending = await request(app).get(`${api}?sort=price`);
    const descending = await request(app).get(`${api}?sort=-price`);

    const ascendingPrices = ascending.body.data.products.map((p) => p.basePrice);
    expect(ascendingPrices).toEqual([...ascendingPrices].sort((a, b) => a - b));
    expect(descending.body.data.products[0].basePrice).toBe(1299.99);
  });

  it('finds products by full-text search', async () => {
    await seedCatalog();

    const response = await request(app).get(`${api}?q=mechanical`);

    expect(response.body.data.products).toHaveLength(1);
    expect(response.body.data.products[0].name).toBe(keyboardPayload.name);
  });

  it('includes products filed under a descendant category', async () => {
    const { admin, seller, category } = await setupCatalog();

    const laptops = await request(app)
      .post('/api/v1/categories')
      .set(admin.auth)
      .send({ name: 'Laptops', parent: category.id });

    await createProduct(seller.auth, laptopPayload, laptops.body.data.category.id);

    // Browsing the parent surfaces the product filed under the child.
    const response = await request(app).get(`${api}?category=electronics`);

    expect(response.body.data.products).toHaveLength(1);
  });

  it('rejects sort=relevance without a search term', async () => {
    const response = await request(app).get(`${api}?sort=relevance`);

    expect(response.status).toBe(422);
  });

  it('rejects an unknown query parameter', async () => {
    const response = await request(app).get(`${api}?colour=red`);

    expect(response.status).toBe(422);
  });

  it('omits soft-deleted products', async () => {
    const { seller, category } = await setupCatalog();
    const created = await createProduct(seller.auth, laptopPayload, category.id);

    await request(app).delete(`${api}/${created.body.data.product.id}`).set(seller.auth);

    const response = await request(app).get(api);
    expect(response.body.data.products).toHaveLength(0);
  });
});

describe('GET /products/:slug', () => {
  it('returns a product with its category and seller populated', async () => {
    const { seller, category } = await setupCatalog();
    await createProduct(seller.auth, laptopPayload, category.id);

    const response = await request(app).get(`${api}/aurora-ultrabook-14`);

    expect(response.status).toBe(200);
    expect(response.body.data.product.category.slug).toBe('electronics');
    expect(response.body.data.product.seller.name).toBe(sellerPayload.name);
  });

  it('404s for an unknown slug', async () => {
    const response = await request(app).get(`${api}/no-such-product`);

    expect(response.status).toBe(404);
  });

  it('404s for a soft-deleted product', async () => {
    const { seller, category } = await setupCatalog();
    const created = await createProduct(seller.auth, laptopPayload, category.id);
    await request(app).delete(`${api}/${created.body.data.product.id}`).set(seller.auth);

    const response = await request(app).get(`${api}/aurora-ultrabook-14`);

    expect(response.status).toBe(404);
  });
});

describe('PATCH /products/:id', () => {
  it('lets the owning seller update their product', async () => {
    const { seller, category } = await setupCatalog();
    const created = await createProduct(seller.auth, laptopPayload, category.id);

    const response = await request(app)
      .patch(`${api}/${created.body.data.product.id}`)
      .set(seller.auth)
      .send({ description: 'An updated description for the aluminium ultrabook.' });

    expect(response.status).toBe(200);
    expect(response.body.data.product.description).toMatch(/updated description/);
  });

  it('refuses a different seller', async () => {
    const { seller, category } = await setupCatalog();
    const created = await createProduct(seller.auth, laptopPayload, category.id);

    const intruder = await signUp(app, { ...sellerPayload, email: 'other-seller@example.com' });

    const response = await request(app)
      .patch(`${api}/${created.body.data.product.id}`)
      .set(intruder.auth)
      .send({ description: 'Trying to edit somebody else’s product listing.' });

    expect(response.status).toBe(403);
  });

  it('lets an admin update any product', async () => {
    const { admin, seller, category } = await setupCatalog();
    const created = await createProduct(seller.auth, laptopPayload, category.id);

    const response = await request(app)
      .patch(`${api}/${created.body.data.product.id}`)
      .set(admin.auth)
      .send({ isActive: false });

    expect(response.status).toBe(200);
    expect(response.body.data.product.isActive).toBe(false);
  });

  it('recalculates basePrice when variants change', async () => {
    const { seller, category } = await setupCatalog();
    const created = await createProduct(seller.auth, laptopPayload, category.id);

    const response = await request(app)
      .patch(`${api}/${created.body.data.product.id}`)
      .set(seller.auth)
      .send({ variants: [{ sku: 'AUR-14-SLV', price: 999, stock: 5 }] });

    expect(response.body.data.product.basePrice).toBe(999);
  });
});

describe('DELETE /products/:id', () => {
  it('soft-deletes rather than removing the document', async () => {
    const { seller, category } = await setupCatalog();
    const created = await createProduct(seller.auth, laptopPayload, category.id);

    const response = await request(app)
      .delete(`${api}/${created.body.data.product.id}`)
      .set(seller.auth);

    expect(response.status).toBe(200);

    // The document survives so that order history keeps resolving.
    const stored = await Product.findById(created.body.data.product.id).lean();
    expect(stored).not.toBeNull();
    expect(stored.isActive).toBe(false);
  });

  it('refuses a different seller', async () => {
    const { seller, category } = await setupCatalog();
    const created = await createProduct(seller.auth, laptopPayload, category.id);
    const intruder = await signUp(app, { ...sellerPayload, email: 'other-seller@example.com' });

    const response = await request(app)
      .delete(`${api}/${created.body.data.product.id}`)
      .set(intruder.auth);

    expect(response.status).toBe(403);
  });
});
