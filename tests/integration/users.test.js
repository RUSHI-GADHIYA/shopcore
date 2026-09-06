import request from 'supertest';
import { createApp } from '../../src/app.js';
import { User, ROLES } from '../../src/modules/users/user.model.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { addressPayload, customerPayload, sellerPayload } from '../fixtures/users.js';

const app = createApp();
const api = '/api/v1';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

/** Registers a user and returns their access token plus id. */
async function signUp(payload) {
  const response = await request(app).post(`${api}/auth/register`).send(payload);
  return { token: response.body.data.accessToken, user: response.body.data.user };
}

/** Admins cannot self-register, so one is promoted directly then signed in. */
async function signUpAdmin() {
  const { user } = await signUp({ ...customerPayload, email: 'admin@example.com' });
  await User.updateOne({ _id: user.id }, { $set: { role: ROLES.ADMIN } });

  const login = await request(app)
    .post(`${api}/auth/login`)
    .send({ email: 'admin@example.com', password: customerPayload.password });

  return { token: login.body.data.accessToken, user: login.body.data.user };
}

describe('GET /users/me', () => {
  it('returns the current profile', async () => {
    const { token } = await signUp(customerPayload);

    const response = await request(app)
      .get(`${api}/users/me`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.user.email).toBe(customerPayload.email);
  });

  it('rejects a request with no token', async () => {
    const response = await request(app).get(`${api}/users/me`);

    expect(response.status).toBe(401);
  });

  it('rejects a token belonging to a deactivated account', async () => {
    const { token, user } = await signUp(customerPayload);
    await User.updateOne({ _id: user.id }, { $set: { isActive: false } });

    const response = await request(app)
      .get(`${api}/users/me`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
  });
});

describe('PATCH /users/me', () => {
  it('updates the name', async () => {
    const { token } = await signUp(customerPayload);

    const response = await request(app)
      .patch(`${api}/users/me`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Ada Lovelace' });

    expect(response.status).toBe(200);
    expect(response.body.data.user.name).toBe('Ada Lovelace');
  });

  it('resets verification when the email changes', async () => {
    const { token, user } = await signUp(customerPayload);
    await User.updateOne({ _id: user.id }, { $set: { isEmailVerified: true } });

    const response = await request(app)
      .patch(`${api}/users/me`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'ada.new@example.com' });

    expect(response.status).toBe(200);
    expect(response.body.data.user.isEmailVerified).toBe(false);
  });

  it('refuses a privilege escalation attempt', async () => {
    const { token } = await signUp(customerPayload);

    const response = await request(app)
      .patch(`${api}/users/me`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: ROLES.ADMIN });

    expect(response.status).toBe(422);
  });
});

describe('addresses', () => {
  it('makes the first address the default', async () => {
    const { token } = await signUp(customerPayload);

    const response = await request(app)
      .post(`${api}/users/me/addresses`)
      .set('Authorization', `Bearer ${token}`)
      .send(addressPayload);

    expect(response.status).toBe(201);
    expect(response.body.data.addresses).toHaveLength(1);
    expect(response.body.data.addresses[0].isDefault).toBe(true);
  });

  it('moves the default when a new address claims it', async () => {
    const { token } = await signUp(customerPayload);
    const auth = { Authorization: `Bearer ${token}` };

    await request(app).post(`${api}/users/me/addresses`).set(auth).send(addressPayload);
    const response = await request(app)
      .post(`${api}/users/me/addresses`)
      .set(auth)
      .send({ ...addressPayload, label: 'Work', isDefault: true });

    const [first, second] = response.body.data.addresses;
    expect(first.isDefault).toBe(false);
    expect(second.isDefault).toBe(true);
  });

  it('promotes a survivor when the default is removed', async () => {
    const { token } = await signUp(customerPayload);
    const auth = { Authorization: `Bearer ${token}` };

    const created = await request(app)
      .post(`${api}/users/me/addresses`)
      .set(auth)
      .send(addressPayload);
    await request(app)
      .post(`${api}/users/me/addresses`)
      .set(auth)
      .send({ ...addressPayload, label: 'Work' });

    const defaultId = created.body.data.addresses[0].id ?? created.body.data.addresses[0]._id;
    const response = await request(app).delete(`${api}/users/me/addresses/${defaultId}`).set(auth);

    expect(response.status).toBe(200);
    expect(response.body.data.addresses).toHaveLength(1);
    expect(response.body.data.addresses[0].isDefault).toBe(true);
  });
});

describe('admin user directory', () => {
  it('refuses a non-admin', async () => {
    const { token } = await signUp(sellerPayload);

    const response = await request(app).get(`${api}/users`).set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
  });

  it('lists users with pagination meta', async () => {
    const { token } = await signUpAdmin();
    await signUp(customerPayload);
    await signUp(sellerPayload);

    const response = await request(app)
      .get(`${api}/users?limit=2`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.users).toHaveLength(2);
    expect(response.body.meta).toMatchObject({ page: 1, limit: 2, total: 3 });
  });

  it('filters by role', async () => {
    const { token } = await signUpAdmin();
    await signUp(customerPayload);
    await signUp(sellerPayload);

    const response = await request(app)
      .get(`${api}/users?role=seller`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.body.data.users).toHaveLength(1);
    expect(response.body.data.users[0].role).toBe(ROLES.SELLER);
  });

  it('treats a regex metacharacter in search as a literal', async () => {
    const { token } = await signUpAdmin();
    await signUp(customerPayload);

    const response = await request(app)
      .get(`${api}/users?search=${encodeURIComponent('.*')}`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.users).toHaveLength(0);
  });

  it('bans an account and revokes its session', async () => {
    const { token } = await signUpAdmin();
    const { token: victimToken, user: victim } = await signUp(customerPayload);

    const response = await request(app)
      .patch(`${api}/users/${victim.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false, reason: 'Fraudulent orders' });

    expect(response.status).toBe(200);
    expect(response.body.data.user.isActive).toBe(false);

    const afterBan = await request(app)
      .get(`${api}/users/me`)
      .set('Authorization', `Bearer ${victimToken}`);
    expect(afterBan.status).toBe(403);
  });

  it('stops an admin from locking themselves out', async () => {
    const { token, user } = await signUpAdmin();

    const response = await request(app)
      .patch(`${api}/users/${user.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false });

    expect(response.status).toBe(400);
  });
});
