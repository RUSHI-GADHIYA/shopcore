import {
  CUSTOMER_CANCELLABLE,
  ORDER_STATUS,
  ORDER_STATUS_VALUES,
  assertRoleMayTransition,
  assertTransition,
  canTransition,
  isTerminal,
  nextStatuses,
  releasesStock,
} from '../../src/modules/orders/order.state-machine.js';
import { ROLES } from '../../src/modules/users/user.model.js';

describe('the happy path', () => {
  it('walks PENDING → PAID → PROCESSING → SHIPPED → DELIVERED', () => {
    const path = [
      ORDER_STATUS.PENDING,
      ORDER_STATUS.PAID,
      ORDER_STATUS.PROCESSING,
      ORDER_STATUS.SHIPPED,
      ORDER_STATUS.DELIVERED,
    ];

    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });
});

describe('illegal transitions', () => {
  it.each([
    [ORDER_STATUS.PENDING, ORDER_STATUS.SHIPPED],
    [ORDER_STATUS.PENDING, ORDER_STATUS.DELIVERED],
    [ORDER_STATUS.DELIVERED, ORDER_STATUS.PENDING],
    [ORDER_STATUS.SHIPPED, ORDER_STATUS.CANCELLED],
    [ORDER_STATUS.CANCELLED, ORDER_STATUS.PAID],
    [ORDER_STATUS.REFUNDED, ORDER_STATUS.PROCESSING],
  ])('refuses %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow();
  });

  it('refuses a no-op transition with a clear message', () => {
    expect(() => assertTransition(ORDER_STATUS.PAID, ORDER_STATUS.PAID)).toThrow(/already PAID/);
  });

  it('names the legal options when it refuses', () => {
    expect(() => assertTransition(ORDER_STATUS.PENDING, ORDER_STATUS.DELIVERED)).toThrow(
      /Allowed: PAID, PAYMENT_FAILED, CANCELLED/
    );
  });

  it('says so plainly when the order can go nowhere', () => {
    expect(() => assertTransition(ORDER_STATUS.CANCELLED, ORDER_STATUS.PAID)).toThrow(
      /cannot change status/
    );
  });
});

describe('terminal states', () => {
  it('treats CANCELLED and REFUNDED as final', () => {
    expect(isTerminal(ORDER_STATUS.CANCELLED)).toBe(true);
    expect(isTerminal(ORDER_STATUS.REFUNDED)).toBe(true);
  });

  it('leaves every other status with somewhere to go', () => {
    const nonTerminal = ORDER_STATUS_VALUES.filter(
      (status) => status !== ORDER_STATUS.CANCELLED && status !== ORDER_STATUS.REFUNDED
    );

    for (const status of nonTerminal) {
      expect(nextStatuses(status).length).toBeGreaterThan(0);
    }
  });

  it('allows a retry after a failed payment', () => {
    expect(canTransition(ORDER_STATUS.PAYMENT_FAILED, ORDER_STATUS.PENDING)).toBe(true);
  });
});

describe('releasesStock', () => {
  it('gives stock back when an order is cancelled before dispatch', () => {
    expect(releasesStock(ORDER_STATUS.PENDING, ORDER_STATUS.CANCELLED)).toBe(true);
    expect(releasesStock(ORDER_STATUS.PAID, ORDER_STATUS.CANCELLED)).toBe(true);
    expect(releasesStock(ORDER_STATUS.PROCESSING, ORDER_STATUS.CANCELLED)).toBe(true);
  });

  it('gives stock back on a refund', () => {
    expect(releasesStock(ORDER_STATUS.PAID, ORDER_STATUS.REFUNDED)).toBe(true);
    expect(releasesStock(ORDER_STATUS.RETURNED, ORDER_STATUS.REFUNDED)).toBe(false);
  });

  it('holds stock through the whole fulfilment path', () => {
    expect(releasesStock(ORDER_STATUS.PAID, ORDER_STATUS.PROCESSING)).toBe(false);
    expect(releasesStock(ORDER_STATUS.PROCESSING, ORDER_STATUS.SHIPPED)).toBe(false);
    expect(releasesStock(ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED)).toBe(false);
  });

  it('releases stock once the goods come back', () => {
    expect(releasesStock(ORDER_STATUS.SHIPPED, ORDER_STATUS.RETURNED)).toBe(true);
    expect(releasesStock(ORDER_STATUS.DELIVERED, ORDER_STATUS.RETURNED)).toBe(true);
  });
});

describe('role permissions', () => {
  it('lets a seller drive fulfilment', () => {
    expect(() => assertRoleMayTransition(ROLES.SELLER, ORDER_STATUS.SHIPPED)).not.toThrow();
    expect(() => assertRoleMayTransition(ROLES.SELLER, ORDER_STATUS.DELIVERED)).not.toThrow();
  });

  it('reserves refunds for an admin', () => {
    expect(() => assertRoleMayTransition(ROLES.ADMIN, ORDER_STATUS.REFUNDED)).not.toThrow();
    expect(() => assertRoleMayTransition(ROLES.SELLER, ORDER_STATUS.REFUNDED)).toThrow(/admin/);
  });

  it('refuses a customer any fulfilment transition', () => {
    expect(() => assertRoleMayTransition(ROLES.CUSTOMER, ORDER_STATUS.SHIPPED)).toThrow();
    expect(() => assertRoleMayTransition(ROLES.CUSTOMER, ORDER_STATUS.PROCESSING)).toThrow();
  });

  it('refuses everyone the payment outcomes, which the webhook owns', () => {
    for (const role of Object.values(ROLES)) {
      expect(() => assertRoleMayTransition(role, ORDER_STATUS.PAID)).toThrow(/set by the system/);
      expect(() => assertRoleMayTransition(role, ORDER_STATUS.PAYMENT_FAILED)).toThrow();
    }
  });
});

describe('customer cancellation window', () => {
  it('covers exactly the pre-dispatch statuses', () => {
    expect(CUSTOMER_CANCELLABLE).toEqual([
      ORDER_STATUS.PENDING,
      ORDER_STATUS.PAID,
      ORDER_STATUS.PROCESSING,
    ]);
  });

  it('lists only statuses the machine actually allows cancelling from', () => {
    for (const status of CUSTOMER_CANCELLABLE) {
      expect(canTransition(status, ORDER_STATUS.CANCELLED)).toBe(true);
    }
  });
});
