import request from 'supertest';
import { createApp } from '../../src/app.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { signUp } from '../setup/auth.js';
import { customerPayload } from '../fixtures/users.js';

const app = createApp();
const api = '/api/v1';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

describe('security headers', () => {
  it('sets helmet’s hardening headers', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toBeDefined();
    expect(response.headers['x-frame-options']).toBeDefined();
  });

  it('does not advertise the framework', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('returns a request id on every response', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('honours a caller-supplied request id for tracing', async () => {
    const response = await request(app).get('/health').set('X-Request-Id', 'trace-abc-123');

    expect(response.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('refuses a malformed request id rather than echoing it back', async () => {
    // The value lands in log lines and a response header, so it must never be
    // attacker-controlled free text.
    const response = await request(app)
      .get('/health')
      .set('X-Request-Id', '<script>alert(1)</script>');

    expect(response.headers['x-request-id']).not.toContain('<script>');
    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
  });
});

describe('CORS', () => {
  it('allows a configured origin', async () => {
    const response = await request(app)
      .get(`${api}/products`)
      .set('Origin', 'http://localhost:3000');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('refuses an origin that is not allow-listed', async () => {
    const response = await request(app)
      .get(`${api}/products`)
      .set('Origin', 'https://evil.example');

    expect(response.status).toBe(403);
  });

  it('allows a request with no Origin, such as curl or a server call', async () => {
    const response = await request(app).get(`${api}/products`);

    expect(response.status).toBe(200);
  });
});

describe('input hardening', () => {
  it('strips Mongo operators from the request body', async () => {
    // Without express-mongo-sanitize this is the classic NoSQL auth bypass.
    const response = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: { $gt: '' }, password: { $gt: '' } });

    expect(response.status).toBe(422);
  });

  it('rejects malformed JSON with the standard envelope', async () => {
    const response = await request(app)
      .post(`${api}/auth/login`)
      .set('Content-Type', 'application/json')
      .send('{"email": "broken"');

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a body over the size limit', async () => {
    const response = await request(app)
      .post(`${api}/auth/register`)
      .send({ ...customerPayload, name: 'x'.repeat(2 * 1024 * 1024) });

    expect(response.status).toBe(413);
  });

  it('rejects a malformed ObjectId as a client error, not a crash', async () => {
    const customer = await signUp(app, customerPayload);

    const response = await request(app).get(`${api}/orders/not-an-id`).set(customer.auth);

    expect(response.status).toBe(422);
    expect(response.body.success).toBe(false);
  });

  it('answers an unknown route with the standard error envelope', async () => {
    const response = await request(app).get(`${api}/does-not-exist`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toContain('/api/v1/does-not-exist');
  });

  it('never leaks a stack trace in the error envelope for a client error', async () => {
    const response = await request(app).get(`${api}/does-not-exist`);

    expect(response.body.error.stack).toBeUndefined();
  });
});

describe('authentication hardening', () => {
  it('rejects a token signed with the wrong secret', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const forged = jwt.sign({ sub: '507f1f77bcf86cd799439011', type: 'access' }, 'wrong-secret');

    const response = await request(app)
      .get(`${api}/users/me`)
      .set('Authorization', `Bearer ${forged}`);

    expect(response.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const expired = jwt.sign(
      { sub: '507f1f77bcf86cd799439011', type: 'access' },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: '-1s' }
    );

    const response = await request(app)
      .get(`${api}/users/me`)
      .set('Authorization', `Bearer ${expired}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects a malformed Authorization header', async () => {
    const response = await request(app).get(`${api}/users/me`).set('Authorization', 'Bearer');

    expect(response.status).toBe(401);
  });

  it('rejects a token for a user that no longer exists', async () => {
    const customer = await signUp(app, customerPayload);

    const { User } = await import('../../src/modules/users/user.model.js');
    await User.deleteOne({ _id: customer.user.id });

    const response = await request(app).get(`${api}/users/me`).set(customer.auth);

    expect(response.status).toBe(401);
  });
});

describe('API documentation', () => {
  it('serves the OpenAPI document', async () => {
    const response = await request(app).get('/api-docs.json');

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.0.3');
    expect(Object.keys(response.body.paths).length).toBeGreaterThan(30);
  });

  it('documents every mounted module', async () => {
    const response = await request(app).get('/api-docs.json');
    const paths = Object.keys(response.body.paths);

    for (const prefix of [
      '/auth',
      '/users',
      '/categories',
      '/products',
      '/cart',
      '/orders',
      '/payments',
      '/reviews',
      '/coupons',
      '/admin',
    ]) {
      expect(paths.some((path) => path.startsWith(prefix))).toBe(true);
    }
  });

  it('serves the Swagger UI', async () => {
    const response = await request(app).get('/api-docs/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('swagger');
  });
});

describe('health checks', () => {
  it('reports liveness without touching any dependency', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
  });

  it('reports readiness with a per-dependency breakdown', async () => {
    const response = await request(app).get('/health/ready');

    // Redis is not running in the test environment, so this is expected to be
    // degraded — what matters is that it says so promptly rather than hanging.
    expect([200, 503]).toContain(response.status);
    expect(response.body.data.checks.mongo.ok).toBe(true);
    expect(response.body.data.checks).toHaveProperty('redis');
  });

  it('answers quickly even with a dependency down', async () => {
    const started = Date.now();
    await request(app).get('/health/ready');

    // A probe that hangs teaches an orchestrator nothing.
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
