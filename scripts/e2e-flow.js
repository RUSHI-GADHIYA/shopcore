/**
 * End-to-end walkthrough of the whole system, driven the way the browser
 * harness drives it: real HTTP, bearer tokens, the refresh cookie, and the
 * dev-only webhook simulator.
 *
 * This is the check that the harness's assumptions about the API actually hold
 * — request shapes, response shapes, and the order operations must happen in.
 * The Jest suite covers each module; this covers them joined together.
 *
 *   npm run e2e                                   # against http://127.0.0.1:5000
 *   SMOKE_BASE_URL=http://localhost:3000 npm run e2e
 */
const BASE = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5000').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;

const steps = [];
let failures = 0;

function check(name, condition, detail = '') {
  const passed = Boolean(condition);
  if (!passed) failures += 1;

  steps.push({ name, passed, detail });
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  return passed;
}

/** A session: holds an access token and the refresh cookie, like the browser. */
function session(label) {
  let token = null;
  let cookie = null;

  async function request(method, path, body, isForm = false) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';

    const response = await fetch(API + path, {
      method,
      headers,
      body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    });

    const setCookie = response.headers.getSetCookie?.() ?? [];
    const refresh = setCookie.find((value) => value.startsWith('refreshToken='));
    if (refresh) cookie = refresh.split(';')[0];

    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }

    return { status: response.status, body: parsed };
  }

  return {
    label,
    get token() {
      return token;
    },
    setToken(value) {
      token = value;
    },
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    del: (path) => request('DELETE', path),
    async signIn(email, password) {
      const result = await request('POST', '/auth/login', { email, password });
      if (result.status === 200) token = result.body.data.accessToken;
      return result;
    },
  };
}

const unique = Date.now().toString(36);
// The API uppercases SKUs, so the harness must compare against that form.
const SKU = `HARNESS-${unique}`.toUpperCase();

async function main() {
  console.log(`End-to-end flow against ${BASE}\n`);

  // --- Sign in as the three seeded roles -----------------------------------
  const admin = session('admin');
  const seller = session('seller');
  const customer = session('customer');

  const adminLogin = await admin.signIn('admin@shopcore.dev', 'Password123');
  if (!check('admin signs in', adminLogin.status === 200, `status ${adminLogin.status}`)) {
    console.error('\nSeeded accounts are missing. Run `npm run seed` first.');
    process.exit(1);
  }

  await seller.signIn('seller@shopcore.dev', 'Password123');
  await customer.signIn('customer@shopcore.dev', 'Password123');
  check('seller and customer sign in', Boolean(seller.token && customer.token));

  // --- Role boundaries ------------------------------------------------------
  const forbidden = await customer.get('/admin/dashboard');
  check('a customer cannot reach the admin dashboard', forbidden.status === 403, 'expects 403');

  const anonymous = await session('anon').get('/users/me');
  check('an anonymous request is rejected', anonymous.status === 401, 'expects 401');

  // --- Catalogue ------------------------------------------------------------
  const categories = await admin.get('/categories?format=flat');
  const categoryId = categories.body.data.categories[0]?.id;
  check('categories exist', Boolean(categoryId));

  const created = await seller.post('/products', {
    name: `Harness Widget ${unique}`,
    description: 'A product created by the end-to-end flow, at least ten characters long.',
    category: categoryId,
    variants: [{ sku: SKU, price: 25.5, stock: 4 }],
  });
  check('seller creates a product', created.status === 201, `status ${created.status}`);
  const product = created.body?.data?.product;

  const duplicate = await seller.post('/products', {
    name: 'Duplicate SKU attempt',
    description: 'Should be refused because the SKU is already taken elsewhere.',
    category: categoryId,
    variants: [{ sku: SKU, price: 1, stock: 1 }],
  });
  check('a duplicate SKU is refused', duplicate.status === 409, `status ${duplicate.status}`);

  const rejected = await seller.post('/products', {
    name: 'Sneaky',
    description: 'Tries to set image URLs directly, which the API does not accept.',
    category: categoryId,
    variants: [{ sku: `X-${unique}`, price: 1, stock: 1 }],
    images: ['https://evil.example/x.png'],
  });
  check('client-supplied image URLs are rejected', rejected.status === 422);

  const search = await customer.get(`/products?q=Harness&sort=relevance`);
  check('full-text search works', search.status === 200, `${search.body.meta.total} result(s)`);

  const badSort = await customer.get('/products?sort=relevance');
  check('sort=relevance without a query is refused', badSort.status === 422);

  const badParam = await customer.get('/products?colour=red');
  check('an unknown query parameter is refused', badParam.status === 422);

  // --- Cart -----------------------------------------------------------------
  await customer.del(`/cart/items/${SKU}`); // Clean slate if re-run.

  const added = await customer.post('/cart/items', {
    product: product.id,
    sku: SKU,
    quantity: 2,
  });
  check('item added to the cart', added.status === 201, `status ${added.status}`);
  check(
    'the cart prices from the catalogue',
    added.body.data.cart.items.some((line) => line.lineTotal === 51),
    '2 x 25.50 = 51.00'
  );

  const tooMany = await customer.post('/cart/items', {
    product: product.id,
    sku: SKU,
    quantity: 90,
  });
  check('over-ordering is refused', tooMany.status === 409, 'only 4 in stock');

  // --- Coupon ---------------------------------------------------------------
  const couponCode = `E2E${unique.toUpperCase()}`.slice(0, 16);
  const coupon = await admin.post('/coupons', {
    code: couponCode,
    discountType: 'PERCENT',
    discountValue: 10,
    maxUsagePerUser: 5,
  });
  check('admin creates a coupon', coupon.status === 201, `status ${coupon.status}`);

  const preview = await customer.post('/coupons/preview', { code: couponCode });
  check(
    'previewing a coupon computes the discount',
    preview.status === 200 && preview.body.data.discount > 0,
    `saves ${preview.body?.data?.discount}`
  );

  const stillUnused = await admin.get('/coupons?limit=50');
  const previewed = stillUnused.body.data.coupons.find((entry) => entry.code === couponCode);
  check('previewing does not consume a use', previewed?.usedCount === 0);

  // --- Checkout -------------------------------------------------------------
  const checkout = await customer.post('/orders/checkout', { couponCode });
  check('checkout succeeds', checkout.status === 201, `status ${checkout.status}`);
  const order = checkout.body?.data?.order;

  check(
    'the discount was applied server-side',
    order?.discount > 0 && order.total < order.subtotal,
    `subtotal ${order?.subtotal}, discount ${order?.discount}, total ${order?.total}`
  );

  check(
    'the order total equals the sum of its lines, less the discount',
    Math.abs(
      order.items.reduce((sum, item) => sum + item.lineTotal, 0) - order.discount - order.total
    ) < 0.005
  );

  const emptied = await customer.get('/cart');
  check('the cart was emptied in the same transaction', emptied.body.data.cart.items.length === 0);

  const stockAfter = await customer.get(`/products/${product.slug}`);
  const variantAfter = stockAfter.body.data.product.variants.find((variant) => variant.sku === SKU);
  check('stock was decremented', variantAfter.stock === 2, `4 - 2 = ${variantAfter.stock}`);

  // --- Payment --------------------------------------------------------------
  const intent = await customer.post('/payments/initiate', { order: order.id });
  check('a payment intent is created', intent.status === 201, `status ${intent.status}`);
  const providerRef = intent.body?.data?.payment?.providerRef;

  const reused = await customer.post('/payments/initiate', { order: order.id });
  check(
    'an outstanding intent is reused rather than duplicated',
    reused.body?.data?.payment?.providerRef === providerRef
  );

  const stillPending = await customer.get(`/orders/${order.id}`);
  check(
    'the order stays PENDING until the gateway calls back',
    stillPending.body.data.order.status === 'PENDING'
  );

  const webhook = await customer.post('/payments/dev/simulate', {
    providerRef,
    outcome: 'succeeded',
  });
  check('the simulated webhook is accepted', webhook.status === 200, `status ${webhook.status}`);

  const paid = await customer.get(`/orders/${order.id}`);
  check('the order is now PAID', paid.body.data.order.status === 'PAID');

  const replay = await customer.post('/payments/dev/simulate', {
    providerRef,
    outcome: 'succeeded',
  });
  check(
    'a replayed webhook is idempotent',
    replay.status === 200 && replay.body.data.duplicate === true,
    'answers 200 with duplicate: true'
  );

  const paidHistory = (await customer.get(`/orders/${order.id}`)).body.data.order.statusHistory;
  check(
    'the replay did not add a second PAID entry',
    paidHistory.filter((entry) => entry.status === 'PAID').length === 1
  );

  // --- Fulfilment -----------------------------------------------------------
  const skip = await seller.patch(`/orders/${order.id}/status`, { status: 'DELIVERED' });
  check('an illegal transition is refused', skip.status === 400, 'PAID cannot jump to DELIVERED');

  const byCustomer = await customer.patch(`/orders/${order.id}/status`, { status: 'PROCESSING' });
  check('a customer cannot drive fulfilment', byCustomer.status === 403);

  for (const status of ['PROCESSING', 'SHIPPED', 'DELIVERED']) {
    const moved = await seller.patch(`/orders/${order.id}/status`, { status });
    check(`seller marks the order ${status}`, moved.status === 200, `status ${moved.status}`);
  }

  // --- Reviews --------------------------------------------------------------
  const review = await customer.post(`/products/${product.id}/reviews`, {
    rating: 5,
    title: 'Works',
    comment: 'Posted by the end-to-end flow.',
  });
  check('a delivered order permits a review', review.status === 201, `status ${review.status}`);

  const second = await customer.post(`/products/${product.id}/reviews`, { rating: 1 });
  check('a second review of the same product is refused', second.status === 409);

  const unverified = await seller.post(`/products/${product.id}/reviews`, { rating: 5 });
  check('someone who did not buy it cannot review it', unverified.status === 403);

  const rated = await customer.get(`/products/${product.slug}`);
  check(
    'the product rating was recalculated',
    rated.body.data.product.ratingAvg === 5 && rated.body.data.product.ratingCount === 1
  );

  // --- Admin reporting ------------------------------------------------------
  const dashboard = await admin.get('/admin/dashboard');
  check(
    'the dashboard reports revenue',
    dashboard.status === 200 && dashboard.body.data.dashboard.revenue.gross > 0,
    `gross ${dashboard.body?.data?.dashboard?.revenue?.gross}`
  );

  const lowStock = await seller.get('/admin/reports/low-stock?threshold=10');
  check('the seller sees a low-stock report', lowStock.status === 200);

  // --- Session handling -----------------------------------------------------
  const refreshed = await customer.post('/auth/refresh');
  check('the refresh cookie mints a new access token', refreshed.status === 200);

  const loggedOut = await customer.post('/auth/logout');
  check('logout succeeds', loggedOut.status === 200);

  const afterLogout = await customer.post('/auth/refresh');
  check('the refresh token is dead after logout', afterLogout.status === 401);

  // --- Cleanup --------------------------------------------------------------
  await seller.del(`/products/${product.id}`);
  await admin.del(`/coupons/${coupon.body.data.coupon.id}`);

  console.log(`\n${steps.length - failures}/${steps.length} checks passed`);

  if (failures) {
    console.error(
      `\nFailed: ${steps
        .filter((step) => !step.passed)
        .map((step) => step.name)
        .join(', ')}`
    );
    process.exit(1);
  }

  console.log('The whole flow works end to end.');
}

main().catch((error) => {
  console.error('\nFlow crashed:', error.message);
  process.exit(1);
});
