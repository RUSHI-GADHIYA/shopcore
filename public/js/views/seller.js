import { api, getUser, query } from '../api.js';
import { esc, empty, formValues, guard, money, panel, toast } from '../ui.js';

export async function render(root, { refresh }) {
  root.innerHTML = '<div class="empty">Loading…</div>';

  const user = getUser();
  const [categories, mine, lowStock] = await Promise.all([
    api.get('/categories?format=flat'),
    // Admins have no seller id of their own, so they see the whole catalogue.
    api.get(`/products${query({ seller: user.role === 'seller' ? user.id : '', limit: 50 })}`),
    api.get('/admin/reports/low-stock?threshold=10'),
  ]);

  root.innerHTML = [
    createPanel(categories.data.categories),
    imagePanel(mine.data.products),
    lowStockPanel(lowStock.data),
    myProductsPanel(mine.data.products),
  ].join('');

  wire(root, refresh);
}

function createPanel(categories) {
  if (!categories.length) {
    return panel(
      'Create a product',
      '',
      empty('No categories exist yet. An admin must create one first (Admin tab).')
    );
  }

  return panel(
    'Create a product',
    'Image URLs are not accepted here — they are only ever set by the upload endpoint. <code>basePrice</code> is derived from the cheapest variant.',
    `
    <form id="create-product" class="row">
      <label>Name <input name="name" required minlength="2" placeholder="Test Widget" /></label>
      <label>Category
        <select name="category" required>
          ${categories.map((category) => `<option value="${esc(category.id)}">${esc(category.name)}</option>`).join('')}
        </select>
      </label>
      <label style="flex:1 1 100%">Description
        <textarea name="description" required minlength="10" placeholder="At least ten characters."></textarea>
      </label>
      <label>SKU <input name="sku" required placeholder="WIDGET-001" /></label>
      <label>Price <input name="price" type="number" step="0.01" min="0" required value="19.99" /></label>
      <label>Stock <input name="stock" type="number" min="0" required value="10" /></label>
      <label>Colour <input name="color" placeholder="optional" /></label>
      <button class="action" type="submit">Create</button>
    </form>
    <p class="hint" style="margin-top:8px">SKUs are unique across the whole catalogue, so a duplicate is a 409.</p>`
  );
}

function imagePanel(products) {
  if (!products.length) return '';

  return panel(
    'Upload an image',
    'Files are decoded and re-encoded to WebP before touching disk, and the uploaded filename is discarded. A non-image is rejected even if it claims to be <code>image/png</code>.',
    `
    <form id="upload-form" class="row">
      <label>Product
        <select name="productId" required>
          ${products.map((product) => `<option value="${esc(product.id)}">${esc(product.name)}</option>`).join('')}
        </select>
      </label>
      <label>Images <input name="images" type="file" accept="image/*" multiple required /></label>
      <button class="action" type="submit">Upload</button>
    </form>`
  );
}

function lowStockPanel({ items, threshold }) {
  return panel(
    `Low stock (≤ ${threshold})`,
    'A seller sees only their own products here; an admin sees the whole catalogue.',
    items.length
      ? `<table>
          <thead><tr><th>Product</th><th>SKU</th><th>Stock</th><th>Price</th></tr></thead>
          <tbody>
            ${items
              .map(
                (item) => `
              <tr>
                <td>${esc(item.name)}</td>
                <td><code>${esc(item.sku)}</code></td>
                <td>${item.stock === 0 ? '<span class="tag bad">0</span>' : `<span class="tag warn">${item.stock}</span>`}</td>
                <td>${money(item.price)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>`
      : empty('Nothing is running low.')
  );
}

function myProductsPanel(products) {
  return panel(
    `Catalogue (${products.length})`,
    'Deleting is a soft delete: the document survives so orders referring to it keep resolving.',
    products.length
      ? `<table>
          <thead><tr><th>Name</th><th>Price</th><th>Variants</th><th>Sold</th><th>Rating</th><th></th></tr></thead>
          <tbody>
            ${products
              .map(
                (product) => `
              <tr>
                <td>${esc(product.name)}<div class="muted"><code>${esc(product.slug)}</code></div></td>
                <td>${money(product.basePrice)}</td>
                <td>${product.variants.map((variant) => `${esc(variant.sku)} (${variant.stock})`).join('<br />')}</td>
                <td>${product.soldCount ?? 0}</td>
                <td>${product.ratingCount ? `★ ${product.ratingAvg}` : '—'}</td>
                <td>
                  <span class="row">
                    <input type="number" min="0" value="${product.variants[0]?.stock ?? 0}" style="min-width:70px"
                           data-restock-input="${esc(product.id)}" />
                    <button class="action secondary" data-restock="${esc(product.id)}"
                            data-sku="${esc(product.variants[0]?.sku ?? '')}"
                            data-price="${esc(product.variants[0]?.price ?? 0)}">Restock</button>
                    <button class="action danger" data-delete-product="${esc(product.id)}">Delete</button>
                  </span>
                </td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>`
      : empty('You have no products yet.')
  );
}

function wire(root, refresh) {
  root.querySelector('#create-product')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(event.target);

    guard(async () => {
      await api.post('/products', {
        name: values.name,
        description: values.description,
        category: values.category,
        variants: [
          {
            sku: values.sku,
            price: Number(values.price),
            stock: Number(values.stock),
            attributes: values.color ? { color: values.color } : {},
          },
        ],
      });

      toast('Product created', 'ok');
      refresh();
    })({ currentTarget: event.target.querySelector('button') });
  });

  root.querySelector('#upload-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    const productId = form.productId.value;

    const formData = new FormData();
    for (const file of form.images.files) formData.append('images', file);

    guard(async () => {
      const result = await api.upload(`/products/${productId}/images`, formData);
      toast(`Uploaded — product now has ${result.data.product.images.length} image(s)`, 'ok');
      refresh();
    })({ currentTarget: form.querySelector('button') });
  });

  for (const button of root.querySelectorAll('[data-restock]')) {
    button.addEventListener(
      'click',
      guard(async (event) => {
        const { restock: id, sku, price } = event.currentTarget.dataset;
        const stock = Number(root.querySelector(`[data-restock-input="${CSS.escape(id)}"]`).value);

        // Variants are replaced wholesale, which is what the PATCH contract expects.
        await api.patch(`/products/${id}`, {
          variants: [{ sku, price: Number(price), stock }],
        });

        toast(`${sku} restocked to ${stock}`, 'ok');
        refresh();
      })
    );
  }

  for (const button of root.querySelectorAll('[data-delete-product]')) {
    button.addEventListener(
      'click',
      guard(async (event) => {
        await api.delete(`/products/${event.currentTarget.dataset.deleteProduct}`);
        toast('Product deactivated (soft delete)', 'ok');
        refresh();
      })
    );
  }
}
