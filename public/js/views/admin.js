import { api } from '../api.js';
import { date, esc, empty, formValues, guard, money, panel, toast } from '../ui.js';

export async function render(root, { refresh }) {
  root.innerHTML = '<div class="empty">Loading dashboard…</div>';

  const [dashboard, categories, coupons, users, trend] = await Promise.all([
    api.get('/admin/dashboard'),
    api.get('/categories?format=flat&includeInactive=true'),
    api.get('/coupons?limit=25'),
    api.get('/users?limit=25'),
    api.get('/admin/reports/sales-trend?days=30'),
  ]);

  root.innerHTML = [
    dashboardPanel(dashboard.data.dashboard, trend.data.trend),
    categoriesPanel(categories.data.categories),
    couponsPanel(coupons.data.coupons),
    usersPanel(users.data.users),
  ].join('');

  wire(root, refresh);
}

function dashboardPanel(dashboard, trend) {
  const { revenue, orders, topProducts, catalogue, customers } = dashboard;

  return panel(
    'Dashboard',
    'Revenue counts only orders actually paid for and not refunded — counting PENDING would report money nobody has sent.',
    `
    <div class="stat-grid">
      <div class="stat"><div class="label">Revenue</div><div class="value">${money(revenue.gross)}</div></div>
      <div class="stat"><div class="label">Paid orders</div><div class="value">${revenue.orders}</div></div>
      <div class="stat"><div class="label">Avg order</div><div class="value">${money(revenue.averageOrderValue)}</div></div>
      <div class="stat"><div class="label">Discounts</div><div class="value">${money(revenue.discounts)}</div></div>
      <div class="stat"><div class="label">Orders today</div><div class="value">${orders.today}</div></div>
      <div class="stat"><div class="label">New customers</div><div class="value">${customers.new}</div></div>
      <div class="stat"><div class="label">Products</div><div class="value">${catalogue.activeProducts}/${catalogue.products}</div></div>
      <div class="stat"><div class="label">Reviews</div><div class="value">${catalogue.reviews}</div></div>
    </div>

    <h3 style="margin:16px 0 4px;font-size:14px">Orders by status</h3>
    <div class="row">
      ${Object.entries(orders.byStatus)
        .map(
          ([status, count]) =>
            `<span class="tag ${count ? '' : 'muted'}">${esc(status)}: ${count}</span>`
        )
        .join('')}
    </div>

    <h3 style="margin:16px 0 4px;font-size:14px">Top products by revenue</h3>
    ${
      topProducts.length
        ? `<table>
            <thead><tr><th>Product</th><th>Units</th><th>Revenue</th></tr></thead>
            <tbody>
              ${topProducts
                .map(
                  (product) =>
                    `<tr><td>${esc(product.name)}</td><td>${product.unitsSold}</td><td>${money(product.revenue)}</td></tr>`
                )
                .join('')}
            </tbody>
          </table>`
        : empty('No paid orders yet.')
    }

    <h3 style="margin:16px 0 4px;font-size:14px">Sales trend (30 days)</h3>
    ${
      trend.length
        ? `<table>
            <thead><tr><th>Date</th><th>Orders</th><th>Revenue</th></tr></thead>
            <tbody>
              ${trend.map((row) => `<tr><td>${esc(row.date)}</td><td>${row.orders}</td><td>${money(row.revenue)}</td></tr>`).join('')}
            </tbody>
          </table>`
        : empty('No sales in the last 30 days.')
    }`
  );
}

function categoriesPanel(categories) {
  return panel(
    'Categories',
    'Hierarchical. Deleting is refused while subcategories or products still reference a category.',
    `
    <form id="create-category" class="row">
      <label>Name <input name="name" required minlength="2" placeholder="Electronics" /></label>
      <label>Parent
        <select name="parent">
          <option value="">(root)</option>
          ${categories.map((category) => `<option value="${esc(category.id)}">${esc(category.name)}</option>`).join('')}
        </select>
      </label>
      <button class="action" type="submit">Create</button>
    </form>

    ${
      categories.length
        ? `<table style="margin-top:12px">
            <thead><tr><th>Name</th><th>Slug</th><th>Depth</th><th>Active</th><th></th></tr></thead>
            <tbody>
              ${categories
                .map(
                  (category) => `
                <tr>
                  <td>${'— '.repeat(category.ancestors?.length ?? 0)}${esc(category.name)}</td>
                  <td><code>${esc(category.slug)}</code></td>
                  <td>${category.ancestors?.length ?? 0}</td>
                  <td>${category.isActive ? '<span class="tag ok">yes</span>' : '<span class="tag bad">no</span>'}</td>
                  <td><button class="action danger" data-delete-category="${esc(category.id)}">Delete</button></td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>`
        : empty('No categories yet — create one so products have somewhere to live.')
    }`
  );
}

function couponsPanel(coupons) {
  return panel(
    'Coupons',
    'A coupon that has been redeemed is deactivated rather than deleted, since past orders must be able to explain their own discount.',
    `
    <form id="create-coupon" class="row">
      <label>Code <input name="code" required placeholder="SAVE10" /></label>
      <label>Type
        <select name="discountType">
          <option value="PERCENT">PERCENT</option>
          <option value="FLAT">FLAT</option>
        </select>
      </label>
      <label>Value <input name="discountValue" type="number" step="0.01" min="0.01" required value="10" /></label>
      <label>Max discount <input name="maxDiscountAmount" type="number" step="0.01" placeholder="cap (optional)" /></label>
      <label>Min order <input name="minOrderValue" type="number" step="0.01" value="0" /></label>
      <label>Per user <input name="maxUsagePerUser" type="number" min="1" value="1" /></label>
      <label>Total limit <input name="totalUsageLimit" type="number" min="1" placeholder="unlimited" /></label>
      <button class="action" type="submit">Create</button>
    </form>

    ${
      coupons.length
        ? `<table style="margin-top:12px">
            <thead><tr><th>Code</th><th>Discount</th><th>Used</th><th>Limits</th><th>Active</th><th></th></tr></thead>
            <tbody>
              ${coupons
                .map(
                  (coupon) => `
                <tr>
                  <td><code>${esc(coupon.code)}</code></td>
                  <td>${coupon.discountType === 'PERCENT' ? `${coupon.discountValue}%` : money(coupon.discountValue)}
                      ${coupon.maxDiscountAmount ? `<div class="muted">cap ${money(coupon.maxDiscountAmount)}</div>` : ''}</td>
                  <td>${coupon.usedCount}${coupon.totalUsageLimit ? ` / ${coupon.totalUsageLimit}` : ''}</td>
                  <td class="muted">
                    ${coupon.minOrderValue ? `min ${money(coupon.minOrderValue)}<br />` : ''}
                    ${coupon.maxUsagePerUser} per user
                    ${coupon.expiresAt ? `<br />expires ${date(coupon.expiresAt)}` : ''}
                  </td>
                  <td>${coupon.isActive ? '<span class="tag ok">yes</span>' : '<span class="tag bad">no</span>'}</td>
                  <td><button class="action danger" data-delete-coupon="${esc(coupon.id)}">Delete</button></td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>`
        : empty('No coupons yet.')
    }`
  );
}

function usersPanel(users) {
  return panel(
    'Users',
    'Deactivating also clears the refresh token, so the account cannot mint a new access token once the current one expires.',
    `<table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th></th></tr></thead>
      <tbody>
        ${users
          .map(
            (user) => `
          <tr>
            <td>${esc(user.name)}</td>
            <td>${esc(user.email)}</td>
            <td><span class="tag">${esc(user.role)}</span></td>
            <td>${user.isActive ? '<span class="tag ok">active</span>' : '<span class="tag bad">banned</span>'}</td>
            <td>
              <button class="action secondary" data-toggle-user="${esc(user._id ?? user.id)}"
                      data-active="${user.isActive ? 'false' : 'true'}">
                ${user.isActive ? 'Ban' : 'Reinstate'}
              </button>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`
  );
}

function wire(root, refresh) {
  root.querySelector('#create-category')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(event.target);

    guard(async () => {
      await api.post('/categories', values);
      toast('Category created', 'ok');
      refresh();
    })({ currentTarget: event.target.querySelector('button') });
  });

  root.querySelector('#create-coupon')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(event.target);

    guard(async () => {
      await api.post('/coupons', {
        code: values.code,
        discountType: values.discountType,
        discountValue: Number(values.discountValue),
        minOrderValue: Number(values.minOrderValue ?? 0),
        maxUsagePerUser: Number(values.maxUsagePerUser ?? 1),
        ...(values.maxDiscountAmount
          ? { maxDiscountAmount: Number(values.maxDiscountAmount) }
          : {}),
        ...(values.totalUsageLimit ? { totalUsageLimit: Number(values.totalUsageLimit) } : {}),
      });

      toast('Coupon created', 'ok');
      refresh();
    })({ currentTarget: event.target.querySelector('button') });
  });

  for (const button of root.querySelectorAll('[data-delete-category]')) {
    button.addEventListener(
      'click',
      guard(async (event) => {
        await api.delete(`/categories/${event.currentTarget.dataset.deleteCategory}`);
        toast('Category deleted', 'ok');
        refresh();
      })
    );
  }

  for (const button of root.querySelectorAll('[data-delete-coupon]')) {
    button.addEventListener(
      'click',
      guard(async (event) => {
        await api.delete(`/coupons/${event.currentTarget.dataset.deleteCoupon}`);
        toast('Coupon removed or deactivated', 'ok');
        refresh();
      })
    );
  }

  for (const button of root.querySelectorAll('[data-toggle-user]')) {
    button.addEventListener(
      'click',
      guard(async (event) => {
        const { toggleUser: id, active } = event.currentTarget.dataset;
        await api.patch(`/users/${id}/status`, { isActive: active === 'true' });
        toast('User status changed', 'ok');
        refresh();
      })
    );
  }
}
