import os from 'node:os';
import path from 'node:path';

/**
 * Test environment defaults.
 *
 * `MONGO_URI` is a placeholder: the integration suites replace the connection
 * with an in-memory server. Secrets are fixed dummy values so `config/env.js`
 * validates without a developer needing a populated `.env`.
 */
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/shopcore-test';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-000';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough-00';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret-000';
// Keep hashing cheap; the suite is not measuring bcrypt.
process.env.BCRYPT_ROUNDS = '4';
process.env.PUBLIC_BASE_URL = 'http://localhost:5000';

// Rate limiting is stateful across a whole worker process, so the production
// thresholds would throttle the suite itself rather than the code under test.
// The limiter middleware is exercised as part of the Phase 6 hardening pass.
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';

// Redis is not running in CI; a background reconnect loop would also keep the
// Jest worker alive past the last test.
process.env.CACHE_ENABLED = 'false';

// Upload tests write real files through sharp. Sending them to a temp
// directory keeps the repository's uploads/ folder clean.
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'shopcore-test-uploads');
