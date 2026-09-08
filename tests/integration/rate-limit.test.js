/**
 * Rate limiting (spec §9, §15).
 *
 * The limits are read from the environment once, when `config/env.js` is first
 * imported, and the counters live for the lifetime of the process. Every other
 * suite therefore runs with the limits effectively switched off, or it would
 * throttle itself rather than the code under test.
 *
 * This file lowers them before anything is imported and pulls the app in
 * dynamically, so it gets an app whose limiter is actually strict. Jest gives
 * each test file its own module registry, so the low limits stay contained here.
 */
process.env.RATE_LIMIT_MAX = '1000';
process.env.AUTH_RATE_LIMIT_MAX = '3';

const { createApp } = await import('../../src/app.js');
const request = (await import('supertest')).default;
const { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } =
  await import('../setup/db.js');
const { customerPayload } = await import('../fixtures/users.js');

const app = createApp();
const api = '/api/v1';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

/** Fires N logins for one email and returns the statuses in order. */
async function attemptLogins(count, email) {
  const statuses = [];

  for (let i = 0; i < count; i += 1) {
    const response = await request(app)
      .post(`${api}/auth/login`)
      .send({ email, password: 'Wr0ngPassword' });
    statuses.push(response.status);
  }

  return statuses;
}

describe('the auth limiter', () => {
  it('blocks once the attempt allowance is spent', async () => {
    const statuses = await attemptLogins(5, 'target@example.com');

    // The first three are answered normally (401), then the limiter takes over.
    expect(statuses.slice(0, 3).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(3).every((status) => status === 429)).toBe(true);
  });

  it('returns the standard error envelope, not a bare string', async () => {
    await attemptLogins(3, 'envelope@example.com');

    const blocked = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: 'envelope@example.com', password: 'Wr0ngPassword' });

    expect(blocked.status).toBe(429);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.body.error.message).toMatch(/too many/i);
  });

  it('sets the standard rate-limit headers', async () => {
    const response = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: 'headers@example.com', password: 'Wr0ngPassword' });

    // draft-7 of the IETF RateLimit header spec emits one combined field.
    expect(response.headers.ratelimit).toMatch(/limit=3, remaining=\d+, reset=\d+/);
    expect(response.headers['ratelimit-policy']).toBe('3;w=900');
  });

  it('keys on the email as well as the IP, so one target cannot lock out another', async () => {
    // Exhaust the allowance for one account.
    await attemptLogins(4, 'victim@example.com');

    // A different account from the same IP is unaffected: without the email in
    // the key, one attacker behind a shared NAT could lock out everybody.
    const other = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: 'bystander@example.com', password: 'Wr0ngPassword' });

    expect(other.status).toBe(401);
  });

  it('protects the password-reset endpoint too', async () => {
    const statuses = [];

    for (let i = 0; i < 5; i += 1) {
      const response = await request(app)
        .post(`${api}/auth/forgot-password`)
        .send({ email: 'reset@example.com' });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('counts a successful registration against the allowance', async () => {
    const first = await request(app)
      .post(`${api}/auth/register`)
      .send({ ...customerPayload, email: 'r1@example.com' });

    expect(first.status).toBe(201);

    // Same IP, same allowance bucket for this email.
    await request(app)
      .post(`${api}/auth/register`)
      .send({ ...customerPayload, email: 'r1@example.com' });
    await request(app)
      .post(`${api}/auth/register`)
      .send({ ...customerPayload, email: 'r1@example.com' });

    const blocked = await request(app)
      .post(`${api}/auth/register`)
      .send({ ...customerPayload, email: 'r1@example.com' });

    expect(blocked.status).toBe(429);
  });
});
