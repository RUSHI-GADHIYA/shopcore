import request from 'supertest';
import { jest } from '@jest/globals';
import { createApp } from '../../src/app.js';
import { User } from '../../src/modules/users/user.model.js';
import { hashToken } from '../../src/modules/auth/token.service.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { customerPayload } from '../fixtures/users.js';

const app = createApp();
const api = '/api/v1/auth';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

/** Pulls the refresh cookie out of a Set-Cookie header for reuse on later requests. */
function refreshCookie(response) {
  const cookies = response.headers['set-cookie'] ?? [];
  return cookies.find((cookie) => cookie.startsWith('refreshToken='));
}

async function registerCustomer(overrides = {}) {
  return request(app)
    .post(`${api}/register`)
    .send({ ...customerPayload, ...overrides });
}

describe('POST /auth/register', () => {
  it('creates an account and returns an access token', async () => {
    const response = await registerCustomer();

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.user.email).toBe(customerPayload.email);
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshCookie(response)).toMatch(/HttpOnly/i);
  });

  it('never returns the password hash', async () => {
    const response = await registerCustomer();

    expect(response.body.data.user).not.toHaveProperty('password');
    expect(response.body.data.user).not.toHaveProperty('refreshTokenHash');
  });

  it('rejects a weak password with field-level details', async () => {
    const response = await registerCustomer({ password: 'short' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'password' })])
    );
  });

  it('refuses a duplicate email', async () => {
    await registerCustomer();
    const response = await registerCustomer();

    expect(response.status).toBe(409);
  });

  it('ignores an attempt to self-assign the admin role', async () => {
    const response = await registerCustomer({ role: 'admin' });

    expect(response.status).toBe(422);
  });
});

describe('POST /auth/login', () => {
  beforeEach(() => registerCustomer());

  it('signs in with correct credentials', async () => {
    const response = await request(app)
      .post(`${api}/login`)
      .send({ email: customerPayload.email, password: customerPayload.password });

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toEqual(expect.any(String));
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    const wrongPassword = await request(app)
      .post(`${api}/login`)
      .send({ email: customerPayload.email, password: 'Wr0ngPassword' });

    const unknownUser = await request(app)
      .post(`${api}/login`)
      .send({ email: 'nobody@example.com', password: 'Wr0ngPassword' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it('locks the account after the configured number of failures', async () => {
    const attempts = Number(process.env.MAX_FAILED_LOGIN_ATTEMPTS ?? 5);

    for (let i = 0; i < attempts; i += 1) {
      await request(app)
        .post(`${api}/login`)
        .send({ email: customerPayload.email, password: 'Wr0ngPassword' });
    }

    // Correct credentials now, but the account is locked.
    const response = await request(app)
      .post(`${api}/login`)
      .send({ email: customerPayload.email, password: customerPayload.password });

    expect(response.status).toBe(423);
    expect(response.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('refuses a deactivated account', async () => {
    await User.updateOne({ email: customerPayload.email }, { $set: { isActive: false } });

    const response = await request(app)
      .post(`${api}/login`)
      .send({ email: customerPayload.email, password: customerPayload.password });

    expect(response.status).toBe(403);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const registration = await registerCustomer();
    const cookie = refreshCookie(registration);

    const response = await request(app).post(`${api}/refresh`).set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshCookie(response)).not.toBe(cookie);
  });

  it('rejects a replayed token and kills the session (theft detection)', async () => {
    const registration = await registerCustomer();
    const original = refreshCookie(registration);

    const rotated = await request(app).post(`${api}/refresh`).set('Cookie', original);
    const replay = await request(app).post(`${api}/refresh`).set('Cookie', original);

    expect(replay.status).toBe(401);

    // The rotated token is invalidated too: reuse is treated as a compromise.
    const afterReuse = await request(app)
      .post(`${api}/refresh`)
      .set('Cookie', refreshCookie(rotated));

    expect(afterReuse.status).toBe(401);
  });

  it('rejects a missing cookie', async () => {
    const response = await request(app).post(`${api}/refresh`);

    expect(response.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('invalidates the refresh token', async () => {
    const registration = await registerCustomer();
    const cookie = refreshCookie(registration);
    const { accessToken } = registration.body.data;

    const logout = await request(app)
      .post(`${api}/logout`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(logout.status).toBe(200);

    const afterLogout = await request(app).post(`${api}/refresh`).set('Cookie', cookie);
    expect(afterLogout.status).toBe(401);
  });
});

describe('password reset', () => {
  it('reveals nothing about whether an account exists', async () => {
    const known = await registerCustomer();
    expect(known.status).toBe(201);

    const forKnown = await request(app)
      .post(`${api}/forgot-password`)
      .send({ email: customerPayload.email });
    const forUnknown = await request(app)
      .post(`${api}/forgot-password`)
      .send({ email: 'nobody@example.com' });

    expect(forKnown.status).toBe(200);
    expect(forUnknown.status).toBe(200);
    expect(forKnown.body.message).toBe(forUnknown.body.message);
  });

  it('resets the password and invalidates existing sessions', async () => {
    const registration = await registerCustomer();
    const oldCookie = refreshCookie(registration);

    // The emailed link carries the raw token; the database stores only its
    // hash, so the test plants a hash it knows the plaintext for.
    const token = 'a'.repeat(64);
    await User.updateOne(
      { email: customerPayload.email },
      {
        $set: {
          passwordResetTokenHash: hashToken(token),
          passwordResetExpires: new Date(Date.now() + 60_000),
        },
      }
    );

    const reset = await request(app)
      .post(`${api}/reset-password/${token}`)
      .send({ password: 'N3wStrongPass' });

    expect(reset.status).toBe(200);

    const oldSession = await request(app).post(`${api}/refresh`).set('Cookie', oldCookie);
    expect(oldSession.status).toBe(401);

    const login = await request(app)
      .post(`${api}/login`)
      .send({ email: customerPayload.email, password: 'N3wStrongPass' });
    expect(login.status).toBe(200);
  });

  it('rejects an expired reset token', async () => {
    await registerCustomer();

    const token = 'b'.repeat(64);
    await User.updateOne(
      { email: customerPayload.email },
      {
        $set: {
          passwordResetTokenHash: hashToken(token),
          passwordResetExpires: new Date(Date.now() - 1000),
        },
      }
    );

    const response = await request(app)
      .post(`${api}/reset-password/${token}`)
      .send({ password: 'N3wStrongPass' });

    expect(response.status).toBe(400);
  });
});

describe('GET /auth/verify-email/:token', () => {
  it('marks the address verified', async () => {
    await registerCustomer();

    const token = 'c'.repeat(64);
    await User.updateOne(
      { email: customerPayload.email },
      {
        $set: {
          emailVerifyTokenHash: hashToken(token),
          emailVerifyExpires: new Date(Date.now() + 60_000),
        },
      }
    );

    const response = await request(app).get(`${api}/verify-email/${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.user.isEmailVerified).toBe(true);
  });

  it('rejects a malformed token before touching the database', async () => {
    const spy = jest.spyOn(User, 'findOne');

    const response = await request(app).get(`${api}/verify-email/not-a-token`);

    expect(response.status).toBe(422);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
