import request from 'supertest';
import { User, ROLES } from '../../src/modules/users/user.model.js';
import { customerPayload } from '../fixtures/users.js';

const api = '/api/v1';

/** Registers a user and returns their access token, id, and an auth header. */
export async function signUp(app, payload) {
  const response = await request(app).post(`${api}/auth/register`).send(payload);

  if (response.status !== 201) {
    throw new Error(`Test setup failed to register: ${response.status} ${response.text}`);
  }

  const { accessToken, user } = response.body.data;
  return { token: accessToken, user, auth: { Authorization: `Bearer ${accessToken}` } };
}

/**
 * Admins cannot self-register (the registration schema refuses the role), so
 * one is created as a customer, promoted directly, then signed in to pick up a
 * token carrying the new role.
 */
export async function signUpAdmin(app, email = 'admin@example.com') {
  const { user } = await signUp(app, { ...customerPayload, email });
  await User.updateOne({ _id: user.id }, { $set: { role: ROLES.ADMIN } });

  const login = await request(app)
    .post(`${api}/auth/login`)
    .send({ email, password: customerPayload.password });

  const { accessToken, user: refreshed } = login.body.data;
  return { token: accessToken, user: refreshed, auth: { Authorization: `Bearer ${accessToken}` } };
}
