/**
 * The API must boot and serve traffic when Redis is unreachable.
 *
 * This exists because it once did not. `rate-limit-redis` loads a Lua script
 * inside its constructor; against a client with `enableOfflineQueue: false`
 * that command throws immediately, and because the limiter was built at import
 * time there was nothing to catch it. The container died on startup and CI
 * caught what 360 passing tests had not — the suite skipped the Redis store
 * entirely with an `isTest` branch, so it never ran the code that broke.
 *
 * The limiter now decides its store on the first request, from the client's
 * real connection status, and the test environment exercises that same path
 * rather than a special case.
 */
process.env.CACHE_ENABLED = 'true';
process.env.QUEUE_ENABLED = 'false';
// Nothing is listening here, which is the whole point.
process.env.REDIS_URL = 'redis://127.0.0.1:6399';

const { createApp } = await import('../../src/app.js');
const request = (await import('supertest')).default;
const { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } =
  await import('../setup/db.js');
const { customerPayload } = await import('../fixtures/users.js');
const { disconnectRedis } = await import('../../src/config/redis.js');

const app = createApp();
const api = '/api/v1';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(async () => {
  await disconnectTestDatabase();
  // This is the one suite that lets a real Redis client exist. It retries
  // forever by design — correct for a long-running server, but it would keep
  // this worker alive after the last test.
  await disconnectRedis();
});

describe('with Redis unreachable', () => {
  it('creates the app without throwing', () => {
    expect(app).toBeDefined();
  });

  it('serves the liveness probe', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
  });

  it('reports readiness as degraded rather than hanging', async () => {
    const started = Date.now();
    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body.data.checks.redis.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('serves a rate-limited public endpoint', async () => {
    // The limiter builds its store on this request and must fall back to
    // memory rather than throwing.
    const response = await request(app).get(`${api}/products`);

    expect(response.status).toBe(200);
  });

  it('still counts requests, using in-memory counters', async () => {
    const first = await request(app).get(`${api}/products`);
    const second = await request(app).get(`${api}/products`);

    expect(first.headers.ratelimit).toBeDefined();
    expect(second.headers.ratelimit).toBeDefined();
  });

  it('completes a full registration and login', async () => {
    const registered = await request(app)
      .post(`${api}/auth/register`)
      .send({ ...customerPayload, email: 'no-redis@example.com' });

    expect(registered.status).toBe(201);

    const login = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: 'no-redis@example.com', password: customerPayload.password });

    expect(login.status).toBe(200);
  });

  it('serves cached endpoints by reading through to Mongo', async () => {
    // Caching is enabled here but has no Redis behind it, so every read is a
    // miss that must still be answered.
    const response = await request(app).get(`${api}/categories`);

    expect(response.status).toBe(200);
    expect(response.body.data.categories).toEqual([]);
  });
});
