import request from 'supertest';
import { signUp, signUpAdmin } from './auth.js';
import { sellerPayload, customerPayload, addressPayload } from '../fixtures/users.js';
import { laptopPayload } from '../fixtures/catalog.js';

const api = '/api/v1';

/**
 * Builds the minimum world a cart or checkout test needs: an admin, a seller
 * with one product, and a customer holding a saved shipping address.
 */
export async function setupStore(app, { productPayload = laptopPayload } = {}) {
  const admin = await signUpAdmin(app);
  const seller = await signUp(app, sellerPayload);
  const customer = await signUp(app, customerPayload);

  const category = await request(app)
    .post(`${api}/categories`)
    .set(admin.auth)
    .send({ name: 'Electronics' });

  const product = await request(app)
    .post(`${api}/products`)
    .set(seller.auth)
    .send({ ...productPayload, category: category.body.data.category.id });

  const addresses = await request(app)
    .post(`${api}/users/me/addresses`)
    .set(customer.auth)
    .send(addressPayload);

  return {
    admin,
    seller,
    customer,
    category: category.body.data.category,
    product: product.body.data.product,
    address: addresses.body.data.addresses[0],
  };
}

/** Adds one line to the customer's cart. */
export function addToCart(app, customer, { product, sku, quantity = 1 }) {
  return request(app).post(`${api}/cart/items`).set(customer.auth).send({ product, sku, quantity });
}
