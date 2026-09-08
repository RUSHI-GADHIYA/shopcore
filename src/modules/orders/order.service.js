import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import logger from '../../config/logger.js';
import { supportsTransactions } from '../../config/db.js';
import ApiError from '../../utils/ApiError.js';
import { buildMeta, resolvePagination } from '../../utils/pagination.js';
import { fromCents, lineTotalCents, percentOfCents, toCents } from '../../utils/money.js';
import { ROLES } from '../users/user.model.js';
import { Product } from '../products/product.model.js';
import { Cart } from '../cart/cart.model.js';
import { Order } from './order.model.js';
import { emailQueue } from '../../jobs/queues/email.queue.js';
import * as couponService from '../coupons/coupon.service.js';
import {
  CUSTOMER_CANCELLABLE,
  ORDER_STATUS,
  assertRoleMayTransition,
  assertTransition,
  releasesStock,
} from './order.state-machine.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Checkout and order lifecycle (spec §6.6, §7.4).
 *
 * Two invariants drive the whole module:
 *
 *  1. The server prices the order. Nothing about money is read from the request
 *     — not the unit price, not the total, not the quantity's cost. Prices come
 *     from the catalogue at the moment of checkout.
 *  2. Stock and the order move together. Decrementing every variant, writing
 *     the order, and emptying the cart happen inside one transaction, so a
 *     failure half-way cannot leave stock reserved for an order that does not
 *     exist.
 */

export async function checkout({ user, addressId, note, couponCode }) {
  if (!supportsTransactions()) {
    // Far better than the driver's "Transaction numbers are only allowed on a
    // replica set member or mongos", which sends people hunting in the wrong place.
    throw ApiError.internal(
      'Checkout requires MongoDB running as a replica set. See docker-compose.yml.'
    );
  }

  const shippingAddress = resolveShippingAddress(user, addressId);
  const cart = await Cart.findOne({ user: user._id });

  if (!cart || cart.items.length === 0) throw ApiError.badRequest('Your cart is empty');

  const lines = await buildOrderLines(cart.items);

  // Validated before the transaction opens — a rejected coupon should fail fast
  // and cheaply, without holding a transaction open while it is checked.
  const applied = couponCode
    ? await couponService.validateForOrder({
        code: couponCode,
        userId: user._id,
        subtotal: subtotalOf(lines),
      })
    : null;

  const pricing = priceOrder(lines, { discount: applied?.discount ?? 0 });

  const session = await mongoose.startSession();

  try {
    let order;

    await session.withTransaction(async () => {
      // Conditional decrements: the filter itself asserts there is enough
      // stock, so two simultaneous checkouts for the last unit cannot both
      // succeed — the loser matches no document.
      for (const line of lines) {
        const result = await Product.updateOne(
          {
            _id: line.product,
            isActive: true,
            variants: { $elemMatch: { sku: line.sku, stock: { $gte: line.quantity } } },
          },
          { $inc: { 'variants.$.stock': -line.quantity, soldCount: line.quantity } },
          { session }
        );

        if (result.modifiedCount !== 1) {
          throw ApiError.conflict(
            `${line.name} (${line.sku}) is no longer available in that quantity`,
            {
              code: 'INSUFFICIENT_STOCK',
              details: { sku: line.sku },
            }
          );
        }
      }

      const [created] = await Order.create(
        [
          {
            reference: generateReference(),
            user: user._id,
            items: lines,
            shippingAddress,
            ...pricing,
            couponApplied: applied?.coupon._id ?? null,
            status: ORDER_STATUS.PENDING,
            statusHistory: [
              {
                status: ORDER_STATUS.PENDING,
                changedAt: new Date(),
                changedBy: user._id,
                note: 'Order placed',
              },
            ],
            note,
          },
        ],
        { session }
      );

      order = created;

      // Booked inside the transaction, so a limited coupon cannot be
      // over-redeemed by two simultaneous checkouts.
      if (applied) {
        await couponService.recordRedemption({
          coupon: applied.coupon,
          userId: user._id,
          orderId: created._id,
          discount: applied.discount,
          session,
        });
      }

      // The cart is emptied in the same transaction: a customer must never be
      // able to check the same cart out twice.
      await Cart.updateOne({ _id: cart._id }, { $set: { items: [] } }, { session });
    });

    logger.info('Order placed', {
      orderId: String(order._id),
      reference: order.reference,
      total: order.total,
    });

    // After the commit, never inside it: an alert must not be able to roll the
    // order back, and a queued job must not exist for a write that was undone.
    await alertOnLowStock(lines);

    return order.toJSON();
  } finally {
    await session.endSession();
  }
}

export async function listOrders({ actor, page, limit, status }) {
  const filter = {};

  // Customers see their own orders; sellers see orders containing their
  // products; admins see everything.
  if (actor.role === ROLES.CUSTOMER) filter.user = actor._id;
  else if (actor.role === ROLES.SELLER) filter['items.seller'] = actor._id;

  if (status) filter.status = status;

  const { page: safePage, limit: safeLimit, skip } = resolvePagination({ page, limit });

  const [items, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    Order.countDocuments(filter),
  ]);

  return { items, meta: buildMeta({ page: safePage, limit: safeLimit, total }) };
}

export async function getOrder({ actor, orderId }) {
  const order = await Order.findById(orderId).populate('items.product', 'name slug images').lean();

  if (!order) throw ApiError.notFound('Order not found');
  assertCanView(actor, order);

  return order;
}

/**
 * Customer-initiated cancellation. Only before dispatch, only within the
 * configured window, and it always returns the stock.
 */
export async function cancelOrder({ actor, orderId, reason }) {
  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound('Order not found');

  const isOwner = String(order.user) === String(actor._id);
  const isStaff = actor.role === ROLES.ADMIN || actor.role === ROLES.SELLER;
  if (!isOwner && !isStaff) throw ApiError.forbidden('You can only cancel your own orders');

  if (isOwner && !isStaff) {
    if (!CUSTOMER_CANCELLABLE.includes(order.status)) {
      throw ApiError.badRequest(`An order that is ${order.status} can no longer be cancelled here`);
    }

    const deadline = order.placedAt.getTime() + env.ORDER_CANCELLATION_WINDOW_HOURS * HOUR_MS;
    if (Date.now() > deadline) {
      throw ApiError.badRequest(
        `Orders can only be cancelled within ${env.ORDER_CANCELLATION_WINDOW_HOURS} hours of being placed`
      );
    }
  }

  assertTransition(order.status, ORDER_STATUS.CANCELLED);

  const updated = await applyStatusChange({
    order,
    to: ORDER_STATUS.CANCELLED,
    actor,
    note: reason ?? 'Cancelled',
  });

  await notifyStatusChange(order, reason ?? 'Cancelled');
  return updated;
}

/** Seller/admin fulfilment updates. */
export async function updateStatus({ actor, orderId, status, note }) {
  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound('Order not found');

  assertCanView(actor, order);
  assertRoleMayTransition(actor.role, status);
  assertTransition(order.status, status);

  const updated = await applyStatusChange({ order, to: status, actor, note });

  await notifyStatusChange(order, note);
  return updated;
}

/**
 * Writes a status change, returning stock in the same transaction when the new
 * status means the goods are no longer reserved.
 */
async function applyStatusChange({ order, to, actor, note }) {
  const mustRelease = releasesStock(order.status, to) && !order.stockReleasedAt;

  if (!mustRelease) {
    order.status = to;
    order.statusHistory.push({ status: to, changedAt: new Date(), changedBy: actor._id, note });
    await order.save();
    return order.toJSON();
  }

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      for (const item of order.items) {
        await Product.updateOne(
          { _id: item.product, 'variants.sku': item.sku },
          { $inc: { 'variants.$.stock': item.quantity, soldCount: -item.quantity } },
          { session }
        );
      }

      // A cancelled order should not consume the customer's one use of a coupon.
      if (order.couponApplied) {
        await couponService.releaseRedemption({
          couponId: order.couponApplied,
          orderId: order._id,
          session,
        });
      }

      order.status = to;
      // Stamped inside the transaction so a repeated cancellation cannot credit
      // the catalogue a second time.
      order.stockReleasedAt = new Date();
      order.statusHistory.push({ status: to, changedAt: new Date(), changedBy: actor._id, note });

      await order.save({ session });
    });
  } finally {
    await session.endSession();
  }

  logger.info('Order stock released', { orderId: String(order._id), status: to });
  return order.toJSON();
}

/**
 * Warns each seller whose variant just dropped below the threshold (spec §6.10).
 * Failures are swallowed: a missed alert must not fail a completed order.
 */
async function alertOnLowStock(lines) {
  try {
    const products = await Product.find({ _id: { $in: lines.map((line) => line.product) } })
      .select('name variants seller')
      .populate('seller', 'name email')
      .lean();

    const alerts = [];

    for (const line of lines) {
      const product = products.find((candidate) => String(candidate._id) === String(line.product));
      const variant = product?.variants.find((candidate) => candidate.sku === line.sku);
      if (!variant || !product.seller?.email) continue;

      if (variant.stock <= env.LOW_STOCK_THRESHOLD) {
        alerts.push(
          emailQueue.lowStockAlert({
            to: product.seller.email,
            name: product.seller.name,
            productName: product.name,
            sku: variant.sku,
            remaining: variant.stock,
          })
        );
      }
    }

    await Promise.all(alerts);
  } catch (error) {
    logger.error('Failed to raise low-stock alerts', { error: error.message });
  }
}

/** Tells the customer their order moved (spec §12). Queued, never inline. */
async function notifyStatusChange(order, note) {
  const populated = await Order.findById(order._id).populate('user', 'name email').lean();
  if (!populated?.user) return;

  await emailQueue.orderStatusChanged({
    to: populated.user.email,
    name: populated.user.name,
    reference: populated.reference,
    status: populated.status,
    note,
  });
}

/**
 * Re-reads every cart line from the catalogue and snapshots it. This is where
 * the client's idea of the price stops mattering.
 */
async function buildOrderLines(cartItems) {
  const products = await Product.find({ _id: { $in: cartItems.map((item) => item.product) } })
    .select('name seller isActive variants')
    .lean();

  const productsById = new Map(products.map((product) => [String(product._id), product]));

  return cartItems.map((item) => {
    const product = productsById.get(String(item.product));
    if (!product || !product.isActive) {
      throw ApiError.conflict('An item in your cart is no longer available', {
        code: 'PRODUCT_UNAVAILABLE',
        details: { sku: item.sku },
      });
    }

    const variant = product.variants.find((candidate) => candidate.sku === item.sku);
    if (!variant) {
      throw ApiError.conflict('An item in your cart is no longer available', {
        code: 'VARIANT_UNAVAILABLE',
        details: { sku: item.sku },
      });
    }

    if (variant.stock < item.quantity) {
      throw ApiError.conflict(`Only ${variant.stock} of ${product.name} left in stock`, {
        code: 'INSUFFICIENT_STOCK',
        details: { sku: item.sku, available: variant.stock },
      });
    }

    return {
      product: product._id,
      seller: product.seller,
      sku: variant.sku,
      name: product.name,
      // The live price, not `item.priceSnapshot`.
      price: variant.price,
      quantity: item.quantity,
      lineTotal: fromCents(lineTotalCents(variant.price, item.quantity)),
    };
  });
}

/** Subtotal of a set of priced lines, in the same integer-cent arithmetic. */
function subtotalOf(lines) {
  return fromCents(lines.reduce((sum, line) => sum + lineTotalCents(line.price, line.quantity), 0));
}

/** All arithmetic in integer cents, converted back exactly once (see utils/money.js). */
export function priceOrder(lines, { discount = 0 } = {}) {
  const subtotalCents = lines.reduce(
    (sum, line) => sum + lineTotalCents(line.price, line.quantity),
    0
  );
  const discountCents = Math.min(toCents(discount), subtotalCents);
  const discountedCents = subtotalCents - discountCents;

  const taxCents = percentOfCents(discountedCents, env.TAX_RATE_PERCENT);
  const shippingCents = shippingFeeCents(discountedCents);

  return {
    subtotal: fromCents(subtotalCents),
    discount: fromCents(discountCents),
    tax: fromCents(taxCents),
    shippingFee: fromCents(shippingCents),
    total: fromCents(discountedCents + taxCents + shippingCents),
  };
}

function shippingFeeCents(discountedCents) {
  const flatFeeCents = toCents(env.SHIPPING_FLAT_FEE);
  if (flatFeeCents === 0) return 0;

  // A threshold of 0 means "never waive it".
  const thresholdCents = toCents(env.FREE_SHIPPING_THRESHOLD);
  if (thresholdCents > 0 && discountedCents >= thresholdCents) return 0;

  return flatFeeCents;
}

/** Picks an address out of the user's own address book and snapshots it. */
function resolveShippingAddress(user, addressId) {
  const address = addressId
    ? user.addresses.id(addressId)
    : user.addresses.find((candidate) => candidate.isDefault);

  if (!address) {
    throw ApiError.badRequest(
      addressId ? 'That address is not in your address book' : 'Add a shipping address first'
    );
  }

  const { fullName, phone, line1, line2, city, state, postalCode, country } = address;
  return { fullName, phone, line1, line2, city, state, postalCode, country };
}

function assertCanView(actor, order) {
  if (actor.role === ROLES.ADMIN) return;
  if (String(order.user) === String(actor._id)) return;

  // A seller may see an order only because one of their own products is in it.
  const sellsSomethingInIt = order.items.some((item) => String(item.seller) === String(actor._id));
  if (actor.role === ROLES.SELLER && sellsSomethingInIt) return;

  throw ApiError.forbidden('You do not have access to this order');
}

/** Human-quotable, collision-resistant, and not guessable in sequence. */
function generateReference() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `SC-${today}-${suffix}`;
}
