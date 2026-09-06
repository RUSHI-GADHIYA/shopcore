import ApiError from '../../utils/ApiError.js';
import { ROLES } from '../users/user.model.js';

/**
 * Order lifecycle (spec §6.6).
 *
 *   PENDING ─→ PAID ─→ PROCESSING ─→ SHIPPED ─→ DELIVERED
 *      │        │          │             └─→ RETURNED ─→ REFUNDED
 *      │        │          └─→ CANCELLED         ↑
 *      │        └─→ CANCELLED / REFUNDED         │
 *      ├─→ CANCELLED                    DELIVERED ┘
 *      └─→ PAYMENT_FAILED ─→ PENDING (retry) / CANCELLED
 *
 * Keeping the rules in one table rather than scattering `if (order.status ===
 * ...)` through the service means an illegal transition is impossible to
 * express, not merely unlikely.
 */
export const ORDER_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PAID: 'PAID',
  PROCESSING: 'PROCESSING',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  RETURNED: 'RETURNED',
  REFUNDED: 'REFUNDED',
});

export const ORDER_STATUS_VALUES = Object.values(ORDER_STATUS);

const TRANSITIONS = Object.freeze({
  [ORDER_STATUS.PENDING]: [ORDER_STATUS.PAID, ORDER_STATUS.PAYMENT_FAILED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.PAID]: [ORDER_STATUS.PROCESSING, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED],
  [ORDER_STATUS.PROCESSING]: [ORDER_STATUS.SHIPPED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.SHIPPED]: [ORDER_STATUS.DELIVERED, ORDER_STATUS.RETURNED],
  [ORDER_STATUS.DELIVERED]: [ORDER_STATUS.RETURNED],
  [ORDER_STATUS.RETURNED]: [ORDER_STATUS.REFUNDED],
  // A failed payment is retryable: the customer may fix their card and try again.
  [ORDER_STATUS.PAYMENT_FAILED]: [ORDER_STATUS.PENDING, ORDER_STATUS.CANCELLED],
  // Terminal.
  [ORDER_STATUS.CANCELLED]: [],
  [ORDER_STATUS.REFUNDED]: [],
});

/**
 * Statuses in which stock is being held for the order. Leaving one of these for
 * a status that is not also one of them must give the stock back.
 */
const STOCK_HELD_IN = new Set([
  ORDER_STATUS.PENDING,
  ORDER_STATUS.PAID,
  ORDER_STATUS.PROCESSING,
  ORDER_STATUS.SHIPPED,
  ORDER_STATUS.DELIVERED,
]);

/** Statuses a customer may cancel from — before the parcel is on its way. */
export const CUSTOMER_CANCELLABLE = Object.freeze([
  ORDER_STATUS.PENDING,
  ORDER_STATUS.PAID,
  ORDER_STATUS.PROCESSING,
]);

/**
 * Who may drive which transition. Fulfilment belongs to the seller or an admin;
 * a customer's only lever is cancelling, which has its own endpoint and rules.
 */
const ALLOWED_ROLES = Object.freeze({
  [ORDER_STATUS.PROCESSING]: [ROLES.SELLER, ROLES.ADMIN],
  [ORDER_STATUS.SHIPPED]: [ROLES.SELLER, ROLES.ADMIN],
  [ORDER_STATUS.DELIVERED]: [ROLES.SELLER, ROLES.ADMIN],
  [ORDER_STATUS.RETURNED]: [ROLES.SELLER, ROLES.ADMIN],
  [ORDER_STATUS.REFUNDED]: [ROLES.ADMIN],
  [ORDER_STATUS.CANCELLED]: [ROLES.SELLER, ROLES.ADMIN],
  // Payment outcomes are driven by the payment webhook, not by a human.
  [ORDER_STATUS.PAID]: [],
  [ORDER_STATUS.PAYMENT_FAILED]: [],
  [ORDER_STATUS.PENDING]: [],
});

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStatuses(from) {
  return TRANSITIONS[from] ?? [];
}

export function isTerminal(status) {
  return nextStatuses(status).length === 0;
}

/** True when moving `from` → `to` should return reserved stock to the catalogue. */
export function releasesStock(from, to) {
  return STOCK_HELD_IN.has(from) && !STOCK_HELD_IN.has(to);
}

/** Throws unless the transition is legal. */
export function assertTransition(from, to) {
  if (from === to) throw ApiError.badRequest(`Order is already ${to}`);

  if (!canTransition(from, to)) {
    const allowed = nextStatuses(from);
    throw ApiError.badRequest(
      allowed.length === 0
        ? `Order is ${from} and cannot change status`
        : `Cannot move an order from ${from} to ${to}. Allowed: ${allowed.join(', ')}`
    );
  }
}

/** Throws unless this role is permitted to drive the transition at all. */
export function assertRoleMayTransition(role, to) {
  const allowed = ALLOWED_ROLES[to] ?? [];

  if (!allowed.includes(role)) {
    throw ApiError.forbidden(
      allowed.length === 0
        ? `${to} is set by the system, not through this endpoint`
        : `Only ${allowed.join(' or ')} may move an order to ${to}`
    );
  }
}
