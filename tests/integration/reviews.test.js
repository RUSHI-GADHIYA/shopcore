import request from 'supertest';
import { createApp } from '../../src/app.js';
import { Product } from '../../src/modules/products/product.model.js';
import { Review } from '../../src/modules/reviews/review.model.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { setupStore, addToCart } from '../setup/catalog.js';
import { deliveredOrder } from '../setup/lifecycle.js';
import { signUp } from '../setup/auth.js';
import { customerPayload } from '../fixtures/users.js';

const app = createApp();
const api = '/api/v1';

beforeAll(connectTestDatabase);
afterEach(clearTestDatabase);
afterAll(disconnectTestDatabase);

function postReview(actor, productId, body) {
  return request(app).post(`${api}/products/${productId}/reviews`).set(actor.auth).send(body);
}

describe('POST /products/:id/reviews — the verified-purchase gate', () => {
  it('accepts a review after the order was delivered', async () => {
    const { customer, product } = await deliveredOrder(app);

    const response = await postReview(customer, product.id, {
      rating: 5,
      title: 'Excellent',
      comment: 'Exactly as described.',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.review.rating).toBe(5);
  });

  it('refuses a customer who never bought it', async () => {
    const { product } = await deliveredOrder(app);
    const stranger = await signUp(app, { ...customerPayload, email: 'stranger@example.com' });

    const response = await postReview(stranger, product.id, { rating: 5 });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_A_VERIFIED_PURCHASE');
  });

  it('refuses while the order is only paid for, not delivered', async () => {
    const store = await setupStore(app);
    await addToCart(app, store.customer, { product: store.product.id, sku: 'AUR-14-SLV' });
    await request(app).post(`${api}/orders/checkout`).set(store.customer.auth).send({});

    const response = await postReview(store.customer, store.product.id, { rating: 4 });

    expect(response.status).toBe(403);
  });

  it('refuses a second review of the same product', async () => {
    const { customer, product } = await deliveredOrder(app);
    await postReview(customer, product.id, { rating: 5 });

    const response = await postReview(customer, product.id, { rating: 1 });

    expect(response.status).toBe(409);
  });

  it('rejects a rating outside 1-5', async () => {
    const { customer, product } = await deliveredOrder(app);

    const tooHigh = await postReview(customer, product.id, { rating: 6 });
    const tooLow = await postReview(customer, product.id, { rating: 0 });

    expect(tooHigh.status).toBe(422);
    expect(tooLow.status).toBe(422);
  });

  it('requires authentication', async () => {
    const { product } = await deliveredOrder(app);

    const response = await request(app)
      .post(`${api}/products/${product.id}/reviews`)
      .send({ rating: 5 });

    expect(response.status).toBe(401);
  });
});

describe('product rating aggregation', () => {
  /** Two customers who have each taken delivery of the same product. */
  async function twoReviewers() {
    const first = await deliveredOrder(app);

    const second = await signUp(app, { ...customerPayload, email: 'second@example.com' });
    await request(app).post(`${api}/users/me/addresses`).set(second.auth).send({
      fullName: 'Second Buyer',
      phone: '+15550133',
      line1: '3 Third Street',
      city: 'Bath',
      state: 'Somerset',
      postalCode: 'BA1 1AA',
      country: 'United Kingdom',
    });

    await addToCart(app, second, { product: first.product.id, sku: 'AUR-14-SLV' });
    const checkout = await request(app).post(`${api}/orders/checkout`).set(second.auth).send({});

    const { Order } = await import('../../src/modules/orders/order.model.js');
    await Order.updateOne({ _id: checkout.body.data.order.id }, { $set: { status: 'DELIVERED' } });

    return { ...first, second };
  }

  it('updates the product average when a review is posted', async () => {
    const { customer, product } = await deliveredOrder(app);

    await postReview(customer, product.id, { rating: 4 });

    const stored = await Product.findById(product.id).lean();
    expect(stored.ratingAvg).toBe(4);
    expect(stored.ratingCount).toBe(1);
  });

  it('averages several reviews to one decimal place', async () => {
    const { customer, second, product } = await twoReviewers();

    await postReview(customer, product.id, { rating: 5 });
    await postReview(second, product.id, { rating: 4 });

    const stored = await Product.findById(product.id).lean();
    expect(stored.ratingAvg).toBe(4.5);
    expect(stored.ratingCount).toBe(2);
  });

  it('recalculates when a review is deleted', async () => {
    const { customer, second, product } = await twoReviewers();

    await postReview(customer, product.id, { rating: 5 });
    const toRemove = await postReview(second, product.id, { rating: 1 });

    await request(app).delete(`${api}/reviews/${toRemove.body.data.review.id}`).set(second.auth);

    const stored = await Product.findById(product.id).lean();
    expect(stored.ratingAvg).toBe(5);
    expect(stored.ratingCount).toBe(1);
  });

  it('drops back to zero when the last review goes', async () => {
    const { customer, product } = await deliveredOrder(app);
    const review = await postReview(customer, product.id, { rating: 4 });

    await request(app).delete(`${api}/reviews/${review.body.data.review.id}`).set(customer.auth);

    const stored = await Product.findById(product.id).lean();
    expect(stored.ratingAvg).toBe(0);
    expect(stored.ratingCount).toBe(0);
  });

  it('excludes a flagged review from the average', async () => {
    const { admin, customer, second, product } = await twoReviewers();

    await postReview(customer, product.id, { rating: 5 });
    const abusive = await postReview(second, product.id, { rating: 1 });

    await request(app)
      .patch(`${api}/reviews/${abusive.body.data.review.id}/flag`)
      .set(admin.auth)
      .send({ isFlagged: true, reason: 'Abusive language' });

    const stored = await Product.findById(product.id).lean();
    expect(stored.ratingAvg).toBe(5);
    expect(stored.ratingCount).toBe(1);
  });
});

describe('GET /products/:id/reviews', () => {
  it('is public and returns a rating summary', async () => {
    const { customer, product } = await deliveredOrder(app);
    await postReview(customer, product.id, { rating: 4, comment: 'Solid.' });

    const response = await request(app).get(`${api}/products/${product.id}/reviews`);

    expect(response.status).toBe(200);
    expect(response.body.data.reviews).toHaveLength(1);
    expect(response.body.data.summary).toMatchObject({
      average: 4,
      count: 1,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 },
    });
  });

  it('hides flagged reviews from the public listing', async () => {
    const { admin, customer, product } = await deliveredOrder(app);
    const review = await postReview(customer, product.id, { rating: 1, comment: 'rude' });

    await request(app)
      .patch(`${api}/reviews/${review.body.data.review.id}/flag`)
      .set(admin.auth)
      .send({ isFlagged: true });

    const response = await request(app).get(`${api}/products/${product.id}/reviews`);

    expect(response.body.data.reviews).toHaveLength(0);
    // Hidden, not destroyed.
    expect(await Review.countDocuments()).toBe(1);
  });

  it('does not collide with the product-detail slug route', async () => {
    const { product } = await deliveredOrder(app);

    const detail = await request(app).get(`${api}/products/${product.slug}`);
    const reviews = await request(app).get(`${api}/products/${product.id}/reviews`);

    expect(detail.status).toBe(200);
    expect(reviews.status).toBe(200);
  });
});

describe('editing and moderation', () => {
  it('lets the author edit their own review', async () => {
    const { customer, product } = await deliveredOrder(app);
    const review = await postReview(customer, product.id, { rating: 3 });

    const response = await request(app)
      .patch(`${api}/reviews/${review.body.data.review.id}`)
      .set(customer.auth)
      .send({ rating: 5, comment: 'It grew on me.' });

    expect(response.status).toBe(200);

    const stored = await Product.findById(product.id).lean();
    expect(stored.ratingAvg).toBe(5);
  });

  it('refuses to let anyone else edit it', async () => {
    const { admin, customer, product } = await deliveredOrder(app);
    const review = await postReview(customer, product.id, { rating: 3 });

    // Even an admin moderates rather than rewrites.
    const response = await request(app)
      .patch(`${api}/reviews/${review.body.data.review.id}`)
      .set(admin.auth)
      .send({ rating: 5 });

    expect(response.status).toBe(403);
  });

  it('lets an admin delete any review', async () => {
    const { admin, customer, product } = await deliveredOrder(app);
    const review = await postReview(customer, product.id, { rating: 2 });

    const response = await request(app)
      .delete(`${api}/reviews/${review.body.data.review.id}`)
      .set(admin.auth);

    expect(response.status).toBe(200);
    expect(await Review.countDocuments()).toBe(0);
  });

  it('refuses a non-admin the flag endpoint', async () => {
    const { customer, product } = await deliveredOrder(app);
    const review = await postReview(customer, product.id, { rating: 2 });

    const response = await request(app)
      .patch(`${api}/reviews/${review.body.data.review.id}/flag`)
      .set(customer.auth)
      .send({ isFlagged: true });

    expect(response.status).toBe(403);
  });

  it('restores a review when it is unflagged', async () => {
    const { admin, customer, product } = await deliveredOrder(app);
    const review = await postReview(customer, product.id, { rating: 4 });
    const reviewId = review.body.data.review.id;

    await request(app)
      .patch(`${api}/reviews/${reviewId}/flag`)
      .set(admin.auth)
      .send({ isFlagged: true });
    await request(app)
      .patch(`${api}/reviews/${reviewId}/flag`)
      .set(admin.auth)
      .send({ isFlagged: false });

    const stored = await Product.findById(product.id).lean();
    expect(stored.ratingCount).toBe(1);
    expect(stored.ratingAvg).toBe(4);
  });
});
