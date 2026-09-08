import request from 'supertest';
import { createApp } from '../../src/app.js';
import { Coupon, CouponRedemption } from '../../src/modules/coupons/coupon.model.js';
import { Order } from '../../src/modules/orders/order.model.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { setupStore, addToCart } from '../setup/catalog.js';
import { signUp } from '../setup/auth.js';
import { customerPayload } from '../fixtures/users.js';

const app = createApp();
const api = '/api/v1';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

function createCoupon(admin, body) {
  return request(app)
    .post(`${api}/coupons`)
    .set(admin.auth)
    .send({ code: 'SAVE10', discountType: 'PERCENT', discountValue: 10, ...body });
}

/** A store whose customer has one 1299.99 laptop in the cart. */
async function storeWithCart({ quantity = 1 } = {}) {
  const store = await setupStore(app);
  await addToCart(app, store.customer, {
    product: store.product.id,
    sku: 'AUR-14-SLV',
    quantity,
  });
  return store;
}

function checkout(customer, body = {}) {
  return request(app).post(`${api}/orders/checkout`).set(customer.auth).send(body);
}

describe('POST /coupons (admin)', () => {
  it('creates a percentage coupon', async () => {
    const { admin } = await setupStore(app);

    const response = await createCoupon(admin);

    expect(response.status).toBe(201);
    expect(response.body.data.coupon.code).toBe('SAVE10');
  });

  it('uppercases the code', async () => {
    const { admin } = await setupStore(app);

    const response = await createCoupon(admin, { code: 'lower10' });

    expect(response.body.data.coupon.code).toBe('LOWER10');
  });

  it('refuses a percentage above 100', async () => {
    const { admin } = await setupStore(app);

    const response = await createCoupon(admin, { discountValue: 150 });

    expect(response.status).toBe(422);
  });

  it('refuses an expiry before the start', async () => {
    const { admin } = await setupStore(app);

    const response = await createCoupon(admin, {
      startsAt: '2030-01-02',
      expiresAt: '2030-01-01',
    });

    expect(response.status).toBe(422);
  });

  it('refuses a duplicate code', async () => {
    const { admin } = await setupStore(app);
    await createCoupon(admin);

    const response = await createCoupon(admin);

    expect(response.status).toBe(409);
  });

  it('refuses a non-admin', async () => {
    const { seller } = await setupStore(app);

    const response = await createCoupon(seller);

    expect(response.status).toBe(403);
  });
});

describe('POST /coupons/preview', () => {
  it('previews the discount against the live cart', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin);

    const response = await request(app)
      .post(`${api}/coupons/preview`)
      .set(store.customer.auth)
      .send({ code: 'SAVE10' });

    expect(response.status).toBe(200);
    expect(response.body.data.discount).toBe(130);
    expect(response.body.data.newSubtotal).toBe(1169.99);
  });

  it('does not consume a use', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin, { maxUsagePerUser: 1 });

    await request(app)
      .post(`${api}/coupons/preview`)
      .set(store.customer.auth)
      .send({ code: 'SAVE10' });

    const coupon = await Coupon.findOne({ code: 'SAVE10' }).lean();
    expect(coupon.usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments()).toBe(0);
  });

  it('404s for an unknown code', async () => {
    const store = await storeWithCart();

    const response = await request(app)
      .post(`${api}/coupons/preview`)
      .set(store.customer.auth)
      .send({ code: 'NOSUCHCODE' });

    expect(response.status).toBe(404);
  });
});

describe('coupon rules at checkout', () => {
  it('applies a percentage discount to the order', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin);

    const response = await checkout(store.customer, { couponCode: 'SAVE10' });

    expect(response.status).toBe(201);
    expect(response.body.data.order.subtotal).toBe(1299.99);
    expect(response.body.data.order.discount).toBe(130);
    expect(response.body.data.order.total).toBe(1169.99);
  });

  it('applies a flat discount', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin, { code: 'FLAT50', discountType: 'FLAT', discountValue: 50 });

    const response = await checkout(store.customer, { couponCode: 'FLAT50' });

    expect(response.body.data.order.discount).toBe(50);
    expect(response.body.data.order.total).toBe(1249.99);
  });

  it('caps a percentage discount at maxDiscountAmount', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin, { code: 'HALF', discountValue: 50, maxDiscountAmount: 100 });

    const response = await checkout(store.customer, { couponCode: 'HALF' });

    // 50% of 1299.99 would be 649.99, but the cap wins.
    expect(response.body.data.order.discount).toBe(100);
  });

  it('never discounts below zero', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin, {
      code: 'HUGE',
      discountType: 'FLAT',
      discountValue: 99999,
    });

    const response = await checkout(store.customer, { couponCode: 'HUGE' });

    expect(response.body.data.order.discount).toBe(1299.99);
    expect(response.body.data.order.total).toBe(0);
  });

  it('records the coupon on the order and books the redemption', async () => {
    const store = await storeWithCart();
    const coupon = await createCoupon(store.admin);

    const response = await checkout(store.customer, { couponCode: 'SAVE10' });

    const order = await Order.findById(response.body.data.order.id).lean();
    expect(String(order.couponApplied)).toBe(coupon.body.data.coupon.id);

    const stored = await Coupon.findOne({ code: 'SAVE10' }).lean();
    expect(stored.usedCount).toBe(1);
    expect(await CouponRedemption.countDocuments()).toBe(1);
  });

  it('refuses a subtotal below minOrderValue', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin, { minOrderValue: 5000 });

    const response = await checkout(store.customer, { couponCode: 'SAVE10' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MIN_ORDER_VALUE_NOT_MET');
  });

  it('refuses an expired coupon', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin, { expiresAt: '2020-01-01' });

    const response = await checkout(store.customer, { couponCode: 'SAVE10' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/expired/i);
  });

  it('refuses a coupon that has not started', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin, { startsAt: '2099-01-01' });

    const response = await checkout(store.customer, { couponCode: 'SAVE10' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/not active yet/i);
  });

  it('refuses an inactive coupon', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin, { isActive: false });

    const response = await checkout(store.customer, { couponCode: 'SAVE10' });

    expect(response.status).toBe(400);
  });

  it('enforces the per-user limit', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin, { maxUsagePerUser: 1 });

    await checkout(store.customer, { couponCode: 'SAVE10' });

    await addToCart(app, store.customer, { product: store.product.id, sku: 'AUR-14-SLV' });
    const second = await checkout(store.customer, { couponCode: 'SAVE10' });

    expect(second.status).toBe(400);
    expect(second.body.error.message).toMatch(/already used/i);
  });

  it('enforces the global usage limit across users', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin, { totalUsageLimit: 1, maxUsagePerUser: 5 });

    await checkout(store.customer, { couponCode: 'SAVE10' });

    const second = await signUp(app, { ...customerPayload, email: 'second@example.com' });
    await request(app).post(`${api}/users/me/addresses`).set(second.auth).send({
      fullName: 'Second Buyer',
      phone: '+15550144',
      line1: '4 Fourth Street',
      city: 'Hull',
      state: 'East Yorkshire',
      postalCode: 'HU1 1AA',
      country: 'United Kingdom',
    });
    await addToCart(app, second, { product: store.product.id, sku: 'AUR-14-SLV' });

    const response = await checkout(second, { couponCode: 'SAVE10' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/fully redeemed/i);
  });

  it('gives the redemption back when the order is cancelled', async () => {
    const store = await storeWithCart();
    await createCoupon(store.admin, { maxUsagePerUser: 1 });

    const placed = await checkout(store.customer, { couponCode: 'SAVE10' });
    await request(app)
      .patch(`${api}/orders/${placed.body.data.order.id}/cancel`)
      .set(store.customer.auth)
      .send({});

    const coupon = await Coupon.findOne({ code: 'SAVE10' }).lean();
    expect(coupon.usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments()).toBe(0);

    // And the customer can use it again on a fresh order.
    await addToCart(app, store.customer, { product: store.product.id, sku: 'AUR-14-SLV' });
    const retry = await checkout(store.customer, { couponCode: 'SAVE10' });
    expect(retry.status).toBe(201);
  });

  it('leaves no redemption behind when checkout fails', async () => {
    const store = await storeWithCart({ quantity: 2 });
    await createCoupon(store.admin);

    const { Product } = await import('../../src/modules/products/product.model.js');
    await Product.updateOne(
      { _id: store.product.id, 'variants.sku': 'AUR-14-SLV' },
      { $set: { 'variants.$.stock': 1 } }
    );

    const response = await checkout(store.customer, { couponCode: 'SAVE10' });
    expect(response.status).toBe(409);

    const coupon = await Coupon.findOne({ code: 'SAVE10' }).lean();
    expect(coupon.usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments()).toBe(0);
  });

  it('rejects an unknown code at checkout', async () => {
    const store = await storeWithCart();

    const response = await checkout(store.customer, { couponCode: 'NOPE123' });

    expect(response.status).toBe(404);
  });
});

describe('DELETE /coupons/:id', () => {
  it('deletes an unused coupon outright', async () => {
    const { admin } = await setupStore(app);
    const coupon = await createCoupon(admin);

    await request(app).delete(`${api}/coupons/${coupon.body.data.coupon.id}`).set(admin.auth);

    expect(await Coupon.countDocuments()).toBe(0);
  });

  it('deactivates rather than deletes one that has been used', async () => {
    const store = await storeWithCart();
    const coupon = await createCoupon(store.admin);
    await checkout(store.customer, { couponCode: 'SAVE10' });

    const response = await request(app)
      .delete(`${api}/coupons/${coupon.body.data.coupon.id}`)
      .set(store.admin.auth);

    expect(response.status).toBe(200);

    // Past orders point at it, so it must survive to explain its own discount.
    const stored = await Coupon.findById(coupon.body.data.coupon.id).lean();
    expect(stored).not.toBeNull();
    expect(stored.isActive).toBe(false);
  });
});
