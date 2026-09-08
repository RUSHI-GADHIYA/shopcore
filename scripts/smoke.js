/**
 * Post-deploy smoke test.
 *
 * Checks a *running* instance over HTTP — the CI Docker job points it at the
 * container, and it works equally well against a staging or production URL.
 *
 * This exists because the Jest suite runs with `NODE_ENV=test`, and some
 * failures only appear outside it. A rate limiter that silently stopped
 * enforcing shipped once precisely because every test asserted behaviour the
 * test environment configured away.
 *
 *   npm run smoke                                  # http://127.0.0.1:5000
 *   SMOKE_BASE_URL=https://shopcore.example npm run smoke
 */
const BASE_URL = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5000').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 10_000);

const results = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function get(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(BASE_URL + path, { signal: controller.signal });
    const text = await response.text();

    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    return { status: response.status, headers: response.headers, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Waits for the instance to come up before asserting anything about it. */
async function waitForBoot(attempts = 30) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const response = await get('/health');
      if (response.status === 200) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

async function main() {
  console.log(`Smoke-testing ${BASE_URL}\n`);

  if (!(await waitForBoot())) {
    console.error(`\n${BASE_URL} never started responding.`);
    process.exit(1);
  }

  const health = await get('/health');
  record('liveness responds', health.status === 200, `status ${health.status}`);

  // Readiness pings Mongo and Redis, so a pass proves the instance can reach
  // both — the thing a bare "the process started" check misses.
  const ready = await get('/health/ready');
  record(
    'readiness reports every dependency healthy',
    ready.status === 200 && ready.body?.data?.status === 'ready',
    JSON.stringify(ready.body?.data?.checks ?? {})
  );

  const products = await get('/api/v1/products');
  record('catalogue endpoint serves', products.status === 200, `status ${products.status}`);

  record(
    'responses use the standard envelope',
    products.body?.success === true && 'data' in products.body,
    Object.keys(products.body ?? {}).join(', ')
  );

  const docs = await get('/api-docs.json');
  record(
    'OpenAPI document is served',
    docs.status === 200 && typeof docs.body?.paths === 'object',
    `${Object.keys(docs.body?.paths ?? {}).length} paths`
  );

  // The regression guard: a limiter that has failed open still answers 200 but
  // stops emitting these, so their absence is the signal that matters.
  record(
    'rate limiting is actually installed',
    Boolean(products.headers.get('ratelimit')),
    products.headers.get('ratelimit') ?? 'no RateLimit header'
  );

  record(
    'security headers are set',
    products.headers.get('x-content-type-options') === 'nosniff' &&
      !products.headers.get('x-powered-by'),
    `nosniff=${products.headers.get('x-content-type-options')}, powered-by=${
      products.headers.get('x-powered-by') ?? 'absent'
    }`
  );

  record('requests are traceable', Boolean(products.headers.get('x-request-id')));

  const missing = await get('/api/v1/no-such-route');
  record(
    'unknown routes use the error envelope',
    missing.status === 404 && missing.body?.error?.code === 'NOT_FOUND',
    `status ${missing.status}`
  );

  const failed = results.filter((result) => !result.passed);

  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length) {
    console.error(`Failed: ${failed.map((result) => result.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Smoke test crashed:', error.message);
  process.exit(1);
});
