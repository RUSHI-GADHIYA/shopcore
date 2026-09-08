import request from 'supertest';
import { Order } from '../../src/modules/orders/order.model.js';
import { ORDER_STATUS } from '../../src/modules/orders/order.state-machine.js';
import { setupStore, addToCart } from './catalog.js';

const api = '/api/v1';

/**
 * Drives a store all the way to a delivered order, which is the state reviews
 * and dashboard revenue both depend on.
 *
 * Statuses the payment webhook owns are set directly rather than faked through
 * a signed callback — that path has its own suite, and going through it here
 * would couple every review test to the payment module.
 */
export async function deliveredOrder(app, { quantity = 1, sku = 'AUR-14-SLV' } = {}) {
  const store = await setupStore(app);

  await addToCart(app, store.customer, { product: store.product.id, sku, quantity });

  const checkout = await request(app)
    .post(`${api}/orders/checkout`)
    .set(store.customer.auth)
    .send({});

  const order = checkout.body.data.order;

  await Order.updateOne({ _id: order.id }, { $set: { status: ORDER_STATUS.PROCESSING } });
  await request(app)
    .patch(`${api}/orders/${order.id}/status`)
    .set(store.seller.auth)
    .send({ status: ORDER_STATUS.SHIPPED });
  await request(app)
    .patch(`${api}/orders/${order.id}/status`)
    .set(store.seller.auth)
    .send({ status: ORDER_STATUS.DELIVERED });

  return { ...store, order };
}
