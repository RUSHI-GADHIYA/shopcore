import ApiError from '../../utils/ApiError.js';
import { fromCents, lineTotalCents } from '../../utils/money.js';
import { Product } from '../products/product.model.js';
import { Cart } from './cart.model.js';

/**
 * Cart management (spec §6.5).
 *
 * Every read re-resolves each line against the live product, so a cart never
 * shows a price or an availability that the catalogue has since changed. The
 * stored `priceSnapshot` exists only to detect that drift and report it.
 */

/** Loads the user's cart, creating an empty one on first use. */
export async function getOrCreateCart(userId) {
  const existing = await Cart.findOne({ user: userId });
  if (existing) return existing;

  try {
    return await Cart.create({ user: userId, items: [] });
  } catch (error) {
    // Two concurrent first requests race here; the unique index makes one lose,
    // and the loser simply reads what the winner created.
    if (error?.code === 11000) return Cart.findOne({ user: userId });
    throw error;
  }
}

/**
 * The cart as a client should see it: each line joined to its live product,
 * with the problems (gone, deactivated, out of stock, price changed) named
 * explicitly rather than left for the client to infer.
 */
export async function getCartView(userId) {
  const cart = await getOrCreateCart(userId);
  if (cart.items.length === 0) return emptyView(cart);

  const products = await Product.find({ _id: { $in: cart.items.map((item) => item.product) } })
    .select('name slug images isActive variants basePrice')
    .lean();

  const productsById = new Map(products.map((product) => [String(product._id), product]));

  const lines = cart.items.map((item) => buildLine(item, productsById.get(String(item.product))));

  // A price change is worth telling the customer about but does not stop the
  // sale; an unavailable item does. Only the latter is excluded from the total.
  const purchasable = lines.filter((line) => !line.blocked);

  const subtotalCents = purchasable.reduce(
    (sum, line) => sum + lineTotalCents(line.unitPrice, line.quantity),
    0
  );

  return {
    id: cart.id,
    items: lines,
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotal: fromCents(subtotalCents),
    // Anything the customer should be told about before they commit.
    hasIssues: lines.some((line) => line.issues.length > 0),
    // Whether checkout would actually succeed right now.
    isCheckoutable: purchasable.length > 0 && purchasable.length === lines.length,
    updatedAt: cart.updatedAt,
  };
}

/** Issues that make a line unsellable, as opposed to merely worth flagging. */
const BLOCKING_ISSUES = new Set([
  'PRODUCT_UNAVAILABLE',
  'VARIANT_UNAVAILABLE',
  'OUT_OF_STOCK',
  'INSUFFICIENT_STOCK',
]);

export async function addItem({ userId, product: productId, sku, quantity }) {
  const { product, variant } = await resolveVariant(productId, sku);

  const cart = await getOrCreateCart(userId);
  const existing = cart.items.find((item) => item.sku === sku);

  // Adding an item already in the cart tops it up rather than duplicating the
  // line, so the stock check has to cover the combined quantity.
  const desired = (existing?.quantity ?? 0) + quantity;
  assertStock({ variant, desired });

  if (existing) {
    existing.quantity = desired;
    existing.priceSnapshot = variant.price;
  } else {
    cart.items.push({
      product: product._id,
      sku,
      quantity,
      priceSnapshot: variant.price,
    });
  }

  await cart.save();
  return getCartView(userId);
}

export async function updateItemQuantity({ userId, sku, quantity }) {
  const cart = await getOrCreateCart(userId);
  const item = cart.items.find((entry) => entry.sku === sku);
  if (!item) throw ApiError.notFound('That item is not in your cart');

  const { variant } = await resolveVariant(item.product, sku);
  assertStock({ variant, desired: quantity });

  item.quantity = quantity;
  item.priceSnapshot = variant.price;

  await cart.save();
  return getCartView(userId);
}

export async function removeItem({ userId, sku }) {
  const cart = await getOrCreateCart(userId);

  const before = cart.items.length;
  cart.items = cart.items.filter((item) => item.sku !== sku);
  if (cart.items.length === before) throw ApiError.notFound('That item is not in your cart');

  await cart.save();
  return getCartView(userId);
}

export async function clearCart(userId, session) {
  await Cart.updateOne({ user: userId }, { $set: { items: [] } }, session ? { session } : {});
}

/** Resolves a product + SKU to a live, purchasable variant. */
async function resolveVariant(productId, sku) {
  const product = await Product.findById(productId).select('name isActive variants');

  if (!product || !product.isActive) throw ApiError.notFound('Product not found');

  const variant = product.variants.find((candidate) => candidate.sku === sku);
  if (!variant) throw ApiError.notFound(`Product has no variant with SKU ${sku}`);

  return { product, variant };
}

function assertStock({ variant, desired }) {
  if (variant.stock < desired) {
    throw ApiError.conflict(
      variant.stock === 0 ? 'That variant is out of stock' : `Only ${variant.stock} left in stock`,
      { code: 'INSUFFICIENT_STOCK', details: { sku: variant.sku, available: variant.stock } }
    );
  }
}

/**
 * Joins one stored line to its live product and names anything wrong with it.
 * Issues are returned rather than thrown: a single unavailable item should not
 * make the whole cart unreadable.
 */
function buildLine(item, product) {
  const base = {
    id: item.id,
    sku: item.sku,
    quantity: item.quantity,
    priceSnapshot: item.priceSnapshot,
  };

  if (!product) {
    return {
      ...base,
      product: null,
      unitPrice: item.priceSnapshot,
      lineTotal: 0,
      issues: ['PRODUCT_UNAVAILABLE'],
      blocked: true,
    };
  }

  const variant = product.variants.find((candidate) => candidate.sku === item.sku);
  const issues = [];

  if (!product.isActive) issues.push('PRODUCT_UNAVAILABLE');
  if (!variant) issues.push('VARIANT_UNAVAILABLE');
  else if (variant.stock === 0) issues.push('OUT_OF_STOCK');
  else if (variant.stock < item.quantity) issues.push('INSUFFICIENT_STOCK');

  const unitPrice = variant?.price ?? item.priceSnapshot;
  // The reconciliation the spec asks for: surfaced as a flag, and the live
  // price is the one that counts.
  if (variant && variant.price !== item.priceSnapshot) issues.push('PRICE_CHANGED');

  return {
    ...base,
    product: {
      id: product._id,
      name: product.name,
      slug: product.slug,
      image: product.images?.[0] ?? null,
    },
    unitPrice,
    available: variant?.stock ?? 0,
    lineTotal: fromCents(lineTotalCents(unitPrice, item.quantity)),
    issues,
    blocked: issues.some((issue) => BLOCKING_ISSUES.has(issue)),
  };
}

function emptyView(cart) {
  return {
    id: cart.id,
    items: [],
    itemCount: 0,
    subtotal: 0,
    hasIssues: false,
    isCheckoutable: false,
    updatedAt: cart.updatedAt,
  };
}
