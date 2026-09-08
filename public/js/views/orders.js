import { api, hasRole, query } from '../api.js';
import {
  date,
  esc,
  empty,
  formValues,
  guard,
  money,
  panel,
  rawJson,
  statusTag,
  toast,
} from '../ui.js';

let statusFilter = '';
let openOrderId = null;

/** Which transitions a seller or admin may drive, mirroring the server's table. */
const FULFILMENT_NEXT = {
  PAID: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
  RETURNED: ['REFUNDED'],
};

export async function render(root, { refresh }) {
  root.innerHTML = '<div class="empty">Loading orders…</div>';

  const orders = (await api.get(`/orders${query({ status: statusFilter, limit: 25 })}`)).data
    .orders;
  const detail = openOrderId ? await loadOrder(openOrderId) : null;

  root.innerHTML = [detail ? orderPanel(detail) : '', listPanel(orders)].join('');
  wire(root, refresh);
}

async function loadOrder(id) {
  try {
    const order = (await api.get(`/orders/${id}`)).data.order;

    let payment = null;
    try {
      payment = (await api.get(`/payments/${id}`)).data.payment;
    } catch {
      // No payment started yet — expected for a PENDING order.
    }

    return { order, payment };
  } catch {
    openOrderId = null;
    return null;
  }
}

function listPanel(orders) {
  return panel(
    `Orders (${orders.length})`,
    'Scoped by role: a customer sees their own, a seller sees orders containing their products, an admin sees everything.',
    `
    <div class="row" style="margin-bottom:12px">
      <label>Status
        <select id="status-filter">
          <option value="">All</option>
          ${[
            'PENDING',
            'PAID',
            'PROCESSING',
            'SHIPPED',
            'DELIVERED',
            'CANCELLED',
            'PAYMENT_FAILED',
            'RETURNED',
            'REFUNDED',
          ]
            .map(
              (status) =>
                `<option value="${status}" ${statusFilter === status ? 'selected' : ''}>${status}</option>`
            )
            .join('')}
        </select>
      </label>
    </div>
    ${
      orders.length
        ? `<table>
            <thead><tr><th>Reference</th><th>Placed</th><th>Status</th><th>Items</th><th>Total</th><th></th></tr></thead>
            <tbody>
              ${orders
                .map(
                  (order) => `
                <tr>
                  <td><code>${esc(order.reference)}</code></td>
                  <td>${date(order.placedAt)}</td>
                  <td>${statusTag(order.status)}</td>
                  <td>${order.items.length}</td>
                  <td>${money(order.total)}</td>
                  <td><button class="action secondary" data-open-order="${esc(order._id ?? order.id)}">Open</button></td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>`
        : empty('No orders yet. Check out from the Cart tab.')
    }`
  );
}

function orderPanel({ order, payment }) {
  const id = order._id ?? order.id;
  const canFulfil = hasRole('seller', 'admin');
  const nextStatuses = FULFILMENT_NEXT[order.status] ?? [];

  return panel(
    `Order ${order.reference}`,
    `${statusTag(order.status)} · placed ${date(order.placedAt)}`,
    `
    <table>
      <thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Unit</th><th>Line</th></tr></thead>
      <tbody>
        ${order.items
          .map(
            (item) => `
          <tr>
            <td>${esc(item.name)}</td>
            <td><code>${esc(item.sku)}</code></td>
            <td>${item.quantity}</td>
            <td>${money(item.price)}</td>
            <td>${money(item.lineTotal)}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>

    <p style="text-align:right;margin:10px 0">
      Subtotal ${money(order.subtotal)}<br />
      ${order.discount ? `Discount −${money(order.discount)}<br />` : ''}
      ${order.tax ? `Tax ${money(order.tax)}<br />` : ''}
      ${order.shippingFee ? `Shipping ${money(order.shippingFee)}<br />` : ''}
      <strong>Total ${money(order.total)}</strong>
    </p>

    ${paymentSection(id, order, payment)}

    <h3 style="margin:16px 0 4px;font-size:14px">Status history</h3>
    <table>
      <tbody>
        ${order.statusHistory
          .map(
            (entry) => `
          <tr>
            <td>${statusTag(entry.status)}</td>
            <td>${date(entry.changedAt)}</td>
            <td>${esc(entry.note ?? '')}</td>
            <td class="muted">${entry.changedBy ? 'by a user' : 'by the system'}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>

    <div class="row" style="margin-top:14px">
      <button class="action danger" data-cancel="${esc(id)}">Cancel order</button>
      ${
        canFulfil && nextStatuses.length
          ? nextStatuses
              .map(
                (status) =>
                  `<button class="action secondary" data-advance="${esc(id)}" data-status="${status}">Mark ${status}</button>`
              )
              .join('')
          : ''
      }
      ${
        order.invoiceUrl
          ? `<a class="action secondary" href="${esc(order.invoiceUrl)}" target="_blank" rel="noopener">Invoice PDF</a>`
          : ''
      }
      <button class="action secondary" id="close-order">Close</button>
    </div>

    ${order.status === 'DELIVERED' ? reviewSection(order) : ''}
    ${rawJson('Raw order', order)}`
  );
}

function paymentSection(id, order, payment) {
  if (order.status === 'PENDING' && !payment) {
    return `
      <div class="row">
        <button class="action" data-pay="${esc(id)}">Start payment</button>
        <span class="muted">Records an intent; the order only becomes PAID on the gateway callback.</span>
      </div>`;
  }

  if (!payment) return '';

  return `
    <div style="border:1px solid var(--line);border-radius:8px;padding:12px;margin-top:10px">
      <strong>Payment</strong> ${statusTag(payment.status)}
      · <code>${esc(payment.providerRef)}</code>
      · ${money(payment.amount)}
      ${payment.failureReason ? `<div class="tag bad">${esc(payment.failureReason)}</div>` : ''}
      ${
        payment.status === 'INITIATED'
          ? `<div class="row" style="margin-top:10px">
               <button class="action" data-simulate="${esc(payment.providerRef)}" data-outcome="succeeded">Simulate success</button>
               <button class="action secondary" data-simulate="${esc(payment.providerRef)}" data-outcome="failed">Simulate failure</button>
             </div>
             <p class="hint" style="margin-top:8px">
               The browser cannot sign a webhook — that needs the server's secret. These call a
               <strong>development-only</strong> endpoint that signs it server-side and runs it
               through the ordinary verified webhook path. The route does not exist in production.
             </p>`
          : `<p class="hint" style="margin-top:8px">
               Already processed. Replaying the same event is a no-op — the API answers 200 with
               <code>duplicate: true</code>, because a gateway retries until it sees a 2xx.
             </p>
             <div class="row">
               <button class="action secondary" data-simulate="${esc(payment.providerRef)}" data-outcome="succeeded">Replay event</button>
             </div>`
      }
    </div>`;
}

function reviewSection(order) {
  return `
    <h3 style="margin:16px 0 4px;font-size:14px">Leave a review</h3>
    <p class="hint">Only a delivered order entitles a review, and only one per product.</p>
    <form id="review-form" class="row">
      <label>Product
        <select name="productId">
          ${order.items
            .map(
              (item) =>
                `<option value="${esc(item.product?._id ?? item.product)}">${esc(item.name)}</option>`
            )
            .join('')}
        </select>
      </label>
      <label>Rating
        <select name="rating">
          ${[5, 4, 3, 2, 1].map((value) => `<option value="${value}">${value}</option>`).join('')}
        </select>
      </label>
      <label>Title <input name="title" placeholder="Works well" /></label>
      <label>Comment <input name="comment" placeholder="Optional" /></label>
      <button class="action" type="submit">Post review</button>
    </form>`;
}

function wire(root, refresh) {
  root.querySelector('#status-filter')?.addEventListener('change', (event) => {
    statusFilter = event.target.value;
    refresh();
  });

  for (const button of root.querySelectorAll('[data-open-order]')) {
    button.addEventListener('click', () => {
      openOrderId = button.dataset.openOrder;
      refresh();
    });
  }

  root.querySelector('#close-order')?.addEventListener('click', () => {
    openOrderId = null;
    refresh();
  });

  root.querySelector('[data-pay]')?.addEventListener(
    'click',
    guard(async (event) => {
      const result = (
        await api.post('/payments/initiate', { order: event.currentTarget.dataset.pay })
      ).data;
      toast(`Payment started — ${result.payment.providerRef}`, 'ok');
      refresh();
    })
  );

  for (const button of root.querySelectorAll('[data-simulate]')) {
    button.addEventListener(
      'click',
      guard(async (event) => {
        const { simulate: providerRef, outcome } = event.currentTarget.dataset;

        const result = (
          await api.post('/payments/dev/simulate', {
            providerRef,
            outcome,
            reason: outcome === 'failed' ? 'Card declined (simulated)' : undefined,
          })
        ).data;

        toast(
          result.duplicate
            ? 'Event was already processed — no change, exactly as a retry should behave'
            : `Gateway reported ${outcome}`,
          'ok'
        );
        refresh();
      })
    );
  }

  root.querySelector('[data-cancel]')?.addEventListener(
    'click',
    guard(async (event) => {
      await api.patch(`/orders/${event.currentTarget.dataset.cancel}/cancel`, {
        reason: 'Cancelled from the test harness',
      });
      toast('Order cancelled; stock and any coupon were returned', 'ok');
      refresh();
    })
  );

  for (const button of root.querySelectorAll('[data-advance]')) {
    button.addEventListener(
      'click',
      guard(async (event) => {
        const { advance: id, status } = event.currentTarget.dataset;
        await api.patch(`/orders/${id}/status`, { status });
        toast(`Order is now ${status}`, 'ok');
        refresh();
      })
    );
  }

  root.querySelector('#review-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const { productId, ...review } = formValues(event.target);

    guard(async () => {
      await api.post(`/products/${productId}/reviews`, {
        ...review,
        rating: Number(review.rating),
      });
      toast('Review posted; the product rating was recalculated', 'ok');
      refresh();
    })({ currentTarget: event.target.querySelector('button') });
  });
}
