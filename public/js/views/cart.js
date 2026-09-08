import { api, getUser } from '../api.js';
import { esc, empty, formValues, guard, money, panel, rawJson, toast } from '../ui.js';

/** Human wording for the issue codes the cart reports. */
const ISSUE_TEXT = {
  PRICE_CHANGED: ['warn', 'price changed since you added it — the live price is charged'],
  OUT_OF_STOCK: ['bad', 'out of stock'],
  INSUFFICIENT_STOCK: ['bad', 'not enough stock left'],
  PRODUCT_UNAVAILABLE: ['bad', 'product is no longer available'],
  VARIANT_UNAVAILABLE: ['bad', 'that variant is gone'],
};

let couponPreview = null;

export async function render(root, { refresh }) {
  root.innerHTML = '<div class="empty">Loading cart…</div>';

  const cart = (await api.get('/cart')).data.cart;
  const user = getUser();
  const addresses = user?.addresses ?? [];

  root.innerHTML = [cartPanel(cart), checkoutPanel(cart, addresses)].join('');
  wire(root, refresh, cart);
}

function cartPanel(cart) {
  if (!cart.items.length)
    return panel('Cart', 'Empty.', empty('Add something from the Catalog tab.'));

  return panel(
    `Cart — ${cart.itemCount} item(s)`,
    'Every line is re-resolved against the live catalogue on each read, so nothing here is a stale price.',
    `
    <table>
      <thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Unit</th><th>Line</th><th>Notes</th><th></th></tr></thead>
      <tbody>
        ${cart.items
          .map(
            (line) => `
          <tr>
            <td>${esc(line.product?.name ?? 'Unavailable')}</td>
            <td><code>${esc(line.sku)}</code></td>
            <td>
              <span class="row">
                <input type="number" min="1" max="100" value="${line.quantity}" style="min-width:70px"
                       data-qty="${esc(line.sku)}" />
                <button class="action secondary" data-update="${esc(line.sku)}">Set</button>
              </span>
            </td>
            <td>${money(line.unitPrice)}</td>
            <td>${money(line.lineTotal)}</td>
            <td>
              ${
                line.issues.length
                  ? line.issues
                      .map((issue) => {
                        const [kind, text] = ISSUE_TEXT[issue] ?? ['', issue];
                        return `<div class="tag ${kind}">${esc(text)}</div>`;
                      })
                      .join(' ')
                  : '<span class="tag ok">ok</span>'
              }
            </td>
            <td><button class="action danger" data-remove="${esc(line.sku)}">Remove</button></td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
    <p style="text-align:right;margin:12px 0 0">
      Subtotal (purchasable lines only): <strong>${money(cart.subtotal)}</strong><br />
      <span class="muted">
        ${cart.isCheckoutable ? 'Ready to check out' : 'Blocked — resolve the flagged lines first'}
      </span>
    </p>
    ${rawJson('Raw /cart', cart)}`
  );
}

function checkoutPanel(cart, addresses) {
  if (!cart.items.length) return '';

  return panel(
    'Checkout',
    'The server prices the order: no item list, price or total is accepted from this form. Stock, the order and the coupon all move in one transaction.',
    `
    <form id="checkout-form" class="row">
      <label>Ship to
        <select name="addressId">
          ${
            addresses.length
              ? addresses
                  .map(
                    (address) =>
                      `<option value="${esc(address.id ?? address._id)}">${esc(address.label)} — ${esc(address.line1)}, ${esc(address.city)}${
                        address.isDefault ? ' (default)' : ''
                      }</option>`
                  )
                  .join('')
              : '<option value="">No address — add one on the Account tab</option>'
          }
        </select>
      </label>
      <label>Coupon <input name="couponCode" placeholder="WELCOME10" /></label>
      <label>Note <input name="note" placeholder="optional" /></label>
      <button class="action secondary" type="button" id="preview-coupon">Preview coupon</button>
      <button class="action" type="submit" ${addresses.length ? '' : 'disabled'}>Place order</button>
    </form>
    ${
      couponPreview
        ? `<p style="margin-top:10px">
             <span class="tag ok">${esc(couponPreview.code)}</span>
             saves ${money(couponPreview.discount)} —
             ${money(couponPreview.subtotal)} becomes ${money(couponPreview.newSubtotal)}
           </p>`
        : ''
    }
    <p class="hint" style="margin-top:10px">
      Previewing a coupon does not consume a use; only checkout books the redemption.
    </p>`
  );
}

function wire(root, refresh, cart) {
  for (const button of root.querySelectorAll('[data-update]')) {
    button.addEventListener(
      'click',
      guard(async (event) => {
        const sku = event.currentTarget.dataset.update;
        const quantity = Number(root.querySelector(`[data-qty="${CSS.escape(sku)}"]`).value);

        await api.patch(`/cart/items/${encodeURIComponent(sku)}`, { quantity });
        toast('Cart updated', 'ok');
        refresh();
      })
    );
  }

  for (const button of root.querySelectorAll('[data-remove]')) {
    button.addEventListener(
      'click',
      guard(async (event) => {
        await api.delete(`/cart/items/${encodeURIComponent(event.currentTarget.dataset.remove)}`);
        toast('Item removed', 'ok');
        refresh();
      })
    );
  }

  root.querySelector('#preview-coupon')?.addEventListener(
    'click',
    guard(async () => {
      const code = root.querySelector('[name="couponCode"]').value.trim();
      if (!code) return toast('Enter a coupon code first');

      couponPreview = (await api.post('/coupons/preview', { code })).data;
      toast(`${couponPreview.code} is worth ${money(couponPreview.discount)}`, 'ok');
      refresh();
    })
  );

  root.querySelector('#checkout-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(event.target);

    guard(async () => {
      if (!cart.isCheckoutable) {
        toast('Some lines are unavailable — the API will reject this checkout', 'bad');
      }

      const order = (await api.post('/orders/checkout', values)).data.order;
      couponPreview = null;

      toast(`Order ${order.reference} placed for ${money(order.total)}`, 'ok');
      refresh();
    })({ currentTarget: event.target.querySelector('button[type="submit"]') });
  });
}
