import request from 'supertest';
import { createApp } from '../../src/app.js';
import { Category } from '../../src/modules/categories/category.model.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { signUp, signUpAdmin } from '../setup/auth.js';
import { sellerPayload } from '../fixtures/users.js';

const app = createApp();
const api = '/api/v1/categories';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

async function createCategory(auth, body) {
  const response = await request(app).post(api).set(auth).send(body);
  return response;
}

describe('POST /categories', () => {
  it('creates a root category with a generated slug', async () => {
    const { auth } = await signUpAdmin(app);

    const response = await createCategory(auth, { name: 'Electronics & Gadgets' });

    expect(response.status).toBe(201);
    expect(response.body.data.category.slug).toBe('electronics-gadgets');
    expect(response.body.data.category.parent).toBeNull();
    expect(response.body.data.category.ancestors).toEqual([]);
  });

  it('records the full ancestor chain on a nested category', async () => {
    const { auth } = await signUpAdmin(app);

    const root = await createCategory(auth, { name: 'Electronics' });
    const mid = await createCategory(auth, {
      name: 'Computers',
      parent: root.body.data.category.id,
    });
    const leaf = await createCategory(auth, {
      name: 'Laptops',
      parent: mid.body.data.category.id,
    });

    expect(leaf.body.data.category.ancestors).toEqual([
      root.body.data.category.id,
      mid.body.data.category.id,
    ]);
  });

  it('refuses a non-admin', async () => {
    const { auth } = await signUp(app, sellerPayload);

    const response = await createCategory(auth, { name: 'Electronics' });

    expect(response.status).toBe(403);
  });

  it('refuses an unknown parent', async () => {
    const { auth } = await signUpAdmin(app);

    const response = await createCategory(auth, {
      name: 'Laptops',
      parent: '507f1f77bcf86cd799439011',
    });

    expect(response.status).toBe(400);
  });
});

describe('GET /categories', () => {
  it('returns a nested tree by default', async () => {
    const { auth } = await signUpAdmin(app);
    const root = await createCategory(auth, { name: 'Electronics' });
    await createCategory(auth, { name: 'Laptops', parent: root.body.data.category.id });

    const response = await request(app).get(api);

    expect(response.status).toBe(200);
    expect(response.body.data.categories).toHaveLength(1);
    expect(response.body.data.categories[0].children).toHaveLength(1);
    expect(response.body.data.categories[0].children[0].name).toBe('Laptops');
  });

  it('returns a flat list on request', async () => {
    const { auth } = await signUpAdmin(app);
    const root = await createCategory(auth, { name: 'Electronics' });
    await createCategory(auth, { name: 'Laptops', parent: root.body.data.category.id });

    const response = await request(app).get(`${api}?format=flat`);

    expect(response.body.data.categories).toHaveLength(2);
    expect(response.body.data.categories[0]).not.toHaveProperty('children');
  });

  it('hides inactive categories unless asked', async () => {
    const { auth } = await signUpAdmin(app);
    await createCategory(auth, { name: 'Electronics' });
    await createCategory(auth, { name: 'Discontinued', isActive: false });

    const publicView = await request(app).get(`${api}?format=flat`);
    const fullView = await request(app).get(`${api}?format=flat&includeInactive=true`);

    expect(publicView.body.data.categories).toHaveLength(1);
    expect(fullView.body.data.categories).toHaveLength(2);
  });

  it('is reachable without authentication', async () => {
    const response = await request(app).get(api);

    expect(response.status).toBe(200);
  });
});

describe('PATCH /categories/:id', () => {
  it('rewrites the subtree when a category is re-parented', async () => {
    const { auth } = await signUpAdmin(app);

    const electronics = await createCategory(auth, { name: 'Electronics' });
    const computers = await createCategory(auth, {
      name: 'Computers',
      parent: electronics.body.data.category.id,
    });
    const laptops = await createCategory(auth, {
      name: 'Laptops',
      parent: computers.body.data.category.id,
    });
    const office = await createCategory(auth, { name: 'Office' });

    // Move Computers (and Laptops beneath it) under Office.
    const response = await request(app)
      .patch(`${api}/${computers.body.data.category.id}`)
      .set(auth)
      .send({ parent: office.body.data.category.id });

    expect(response.status).toBe(200);
    expect(response.body.data.category.ancestors).toEqual([office.body.data.category.id]);

    const movedLeaf = await Category.findById(laptops.body.data.category.id).lean();
    expect(movedLeaf.ancestors.map(String)).toEqual([
      office.body.data.category.id,
      computers.body.data.category.id,
    ]);
  });

  it('refuses to make a category its own parent', async () => {
    const { auth } = await signUpAdmin(app);
    const category = await createCategory(auth, { name: 'Electronics' });

    const response = await request(app)
      .patch(`${api}/${category.body.data.category.id}`)
      .set(auth)
      .send({ parent: category.body.data.category.id });

    expect(response.status).toBe(400);
  });

  it('refuses to move a category beneath its own descendant', async () => {
    const { auth } = await signUpAdmin(app);
    const parent = await createCategory(auth, { name: 'Electronics' });
    const child = await createCategory(auth, {
      name: 'Laptops',
      parent: parent.body.data.category.id,
    });

    const response = await request(app)
      .patch(`${api}/${parent.body.data.category.id}`)
      .set(auth)
      .send({ parent: child.body.data.category.id });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/descendant/i);
  });

  it('regenerates the slug when the name changes', async () => {
    const { auth } = await signUpAdmin(app);
    const category = await createCategory(auth, { name: 'Electronics' });

    const response = await request(app)
      .patch(`${api}/${category.body.data.category.id}`)
      .set(auth)
      .send({ name: 'Consumer Electronics' });

    expect(response.body.data.category.slug).toBe('consumer-electronics');
  });
});

describe('DELETE /categories/:id', () => {
  it('deletes a leaf category', async () => {
    const { auth } = await signUpAdmin(app);
    const category = await createCategory(auth, { name: 'Electronics' });

    const response = await request(app)
      .delete(`${api}/${category.body.data.category.id}`)
      .set(auth);

    expect(response.status).toBe(200);
    expect(await Category.countDocuments()).toBe(0);
  });

  it('refuses to delete a category that still has children', async () => {
    const { auth } = await signUpAdmin(app);
    const parent = await createCategory(auth, { name: 'Electronics' });
    await createCategory(auth, { name: 'Laptops', parent: parent.body.data.category.id });

    const response = await request(app).delete(`${api}/${parent.body.data.category.id}`).set(auth);

    expect(response.status).toBe(409);
  });
});
