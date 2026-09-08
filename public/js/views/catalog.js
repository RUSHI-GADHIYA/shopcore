import { api, isSignedIn, query } from '../api.js';
import { esc, empty, guard, money, panel, rawJson, toast } from '../ui.js';

/** Filter state lives here so re-rendering after an action keeps the view. */
const filters = { q: '', category: '', sort: 'newest', minPrice: '', maxPrice: '', inStock: '' };
let openProductSlug = null;

export async function render(root, { refresh }) {
  root.innerHTML = '<div class="empty">Loading catalogue…</div>';

  const [categories, products] = await Promise.all([
    api.get('/categories?format=flat'),
    api.get(`/products${query({ ...filters, limit: 24 })}`),
  ]);

  const detail = openProductSlug ? await loadProduct(openProductSlug) : null;

  root.innerHTML = [
    filterPanel(categories.data.categories),
    detail ? productPanel(detail) : '',
    listPanel(products),
  ].join('');

  wire(root, refresh);
}

async function loadProduct(slug) {
  try {
    const product = (await api.get(`/products/${slug}`)).data.product;
    const reviews = (await api.get(`/products/${product.id}/reviews`)).data;
    return { product, reviews };
  } catch {
    openProductSlug = null;
    return null;
  }
}

function filterPanel(categories) {
  return panel(
    'Browse',
    'Filtering by a category includes everything beneath it. Unknown query parameters are rejected rather than ignored.',
    `
    <form id="filters" class="row">
      <label>Search <input name="q" value="${esc(filters.q)}" placeholder="mechanical" /></label>
      <label>Category
        <select name="category">
          <option value="">All</option>
          ${categories
            .map(
              (category) =>
                `<option value="${esc(category.slug)}" ${filters.category === category.slug ? 'selected' : ''}>${esc(category.name)}</option>`
            )
            .join('')}
        </select>
      </label>
      <label>Min price <input name="minPrice" type="number" step="0.01" value="${esc(filters.minPrice)}" /></label>
      <label>Max price <input name="maxPrice" type="number" step="0.01" value="${esc(filters.maxPrice)}" /></label>
      <label>In stock
        <select name="inStock">
          <option value="">Any</option>
          <option value="true" ${filters.inStock === 'true' ? 'selected' : ''}>In stock</option>
          <option value="false" ${filters.inStock === 'false' ? 'selected' : ''}>Out of stock</option>
        </select>
      </label>
      <label>Sort
        <select name="sort">
          ${['newest', 'oldest', 'price', '-price', 'rating', 'popularity', 'relevance']
            .map(
              (option) =>
                `<option value="${option}" ${filters.sort === option ? 'selected' : ''}>${option}</option>`
            )
            .join('')}
        </select>
      </label>
      <button class="action" type="submit">Apply</button>
      <button class="action secondary" type="button" id="reset-filters">Reset</button>
    </form>
    <p class="hint" style="margin-top:8px">
      <code>sort=relevance</code> without a search term is rejected — a deliberate 422.
    </p>`
  );
}

function listPanel({ data, meta }) {
  const products = data.products;

  return panel(
    `Products (${meta.total})`,
    `Page ${meta.page} of ${meta.totalPages || 1}`,
    products.length
      ? `<div class="card-grid">
          ${products
            .map(
              (product) => `
            <div class="card">
              ${product.images?.[0] ? `<img src="${esc(product.images[0])}" alt="" />` : ''}
              <h3>${esc(product.name)}</h3>
              <div class="muted">${esc(product.category?.name ?? '—')} · ${esc(product.seller?.name ?? '—')}</div>
              <div class="price">${money(product.basePrice)}</div>
              <div class="muted">
                ${product.ratingCount ? `★ ${product.ratingAvg} (${product.ratingCount})` : 'no reviews'}
                · sold ${product.soldCount ?? 0}
              </div>
              <div style="margin-top:8px">
                <button class="action secondary" data-open="${esc(product.slug)}">Open</button>
              </div>
            </div>`
            )
            .join('')}
        </div>`
      : empty('No products match those filters.')
  );
}

function productPanel({ product, reviews }) {
  const canAdd = isSignedIn();

  return panel(
    product.name,
    `${esc(product.category?.name ?? '')} · sold by ${esc(product.seller?.name ?? '')} · <code>${esc(product.slug)}</code>`,
    `
    <p>${esc(product.description)}</p>
    <table>
      <thead><tr><th>SKU</th><th>Attributes</th><th>Price</th><th>Stock</th><th></th></tr></thead>
      <tbody>
        ${product.variants
          .map(
            (variant) => `
          <tr>
            <td><code>${esc(variant.sku)}</code></td>
            <td>${esc([variant.attributes?.size, variant.attributes?.color].filter(Boolean).join(' / ') || '—')}</td>
            <td>${money(variant.price)}</td>
            <td>${variant.stock > 0 ? `${variant.stock}` : '<span class="tag bad">out of stock</span>'}</td>
            <td>
              ${
                canAdd
                  ? `<span class="row">
                       <input type="number" min="1" max="100" value="1" style="min-width:70px" data-qty-for="${esc(variant.sku)}" />
                       <button class="action" data-add-sku="${esc(variant.sku)}" data-product="${esc(product.id)}" ${
                         variant.stock === 0 ? 'disabled' : ''
                       }>Add to cart</button>
                     </span>`
                  : '<span class="muted">sign in to buy</span>'
              }
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>

    <h3 style="margin:16px 0 4px;font-size:14px">
      Reviews — ${reviews.summary.count ? `★ ${reviews.summary.average} from ${reviews.summary.count}` : 'none yet'}
    </h3>
    <p class="hint">Reviewing requires an order containing this product that reached DELIVERED.</p>
    ${
      reviews.reviews.length
        ? reviews.reviews
            .map(
              (review) => `
        <div style="border-top:1px solid var(--line);padding:8px 0">
          <strong>★ ${review.rating}</strong> ${esc(review.title ?? '')}
          <span class="muted">— ${esc(review.user?.name ?? 'someone')}</span>
          <div>${esc(review.comment ?? '')}</div>
        </div>`
            )
            .join('')
        : '<div class="muted">No reviews yet.</div>'
    }

    <div class="row" style="margin-top:12px">
      <button class="action secondary" id="close-product">Close</button>
    </div>
    ${rawJson('Raw product', product)}`
  );
}

function wire(root, refresh) {
  root.querySelector('#filters')?.addEventListener('submit', (event) => {
    event.preventDefault();
    for (const [key, value] of new FormData(event.target).entries()) filters[key] = value;
    refresh();
  });

  root.querySelector('#reset-filters')?.addEventListener('click', () => {
    Object.assign(filters, {
      q: '',
      category: '',
      sort: 'newest',
      minPrice: '',
      maxPrice: '',
      inStock: '',
    });
    refresh();
  });

  for (const button of root.querySelectorAll('[data-open]')) {
    button.addEventListener('click', () => {
      openProductSlug = button.dataset.open;
      refresh();
    });
  }

  root.querySelector('#close-product')?.addEventListener('click', () => {
    openProductSlug = null;
    refresh();
  });

  for (const button of root.querySelectorAll('[data-add-sku]')) {
    button.addEventListener(
      'click',
      guard(async (event) => {
        const { addSku: sku, product } = event.currentTarget.dataset;
        const quantity =
          Number(root.querySelector(`[data-qty-for="${CSS.escape(sku)}"]`).value) || 1;

        await api.post('/cart/items', { product, sku, quantity });
        toast(`Added ${quantity} x ${sku} to the cart`, 'ok');
      })
    );
  }
}
