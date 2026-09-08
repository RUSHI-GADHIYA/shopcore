/**
 * The global limiter, in its own file because its counter is shared by every
 * request the process makes: any other test in the same file would spend the
 * allowance before the assertions here got to it.
 */
process.env.RATE_LIMIT_MAX = '5';
process.env.AUTH_RATE_LIMIT_MAX = '1000';

const { createApp } = await import('../../src/app.js');
const request = (await import('supertest')).default;
const { connectTestDatabase, disconnectTestDatabase } = await import('../setup/db.js');

const app = createApp();
const api = '/api/v1';

beforeAll(connectTestDatabase);
afterAll(disconnectTestDatabase);

describe('the global limiter', () => {
  it('never throttles the health probes', async () => {
    // Probes run constantly. Throttling one into reporting a false outage would
    // cost far more than the traffic it saves, so they sit outside the limiter.
    for (let i = 0; i < 20; i += 1) {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
    }
  });

  it('never throttles the documentation', async () => {
    for (let i = 0; i < 20; i += 1) {
      const response = await request(app).get('/api-docs.json');
      expect(response.status).toBe(200);
    }
  });

  it('throttles ordinary API traffic once the allowance is spent', async () => {
    const statuses = [];

    for (let i = 0; i < 8; i += 1) {
      const response = await request(app).get(`${api}/products`);
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
  });

  it('reports the throttle in the standard error envelope', async () => {
    const response = await request(app).get(`${api}/products`);

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('RATE_LIMITED');
  });
});
