import { env } from '../../config/env.js';
import ApiError from '../../utils/ApiError.js';
import { generateUniqueSlug } from '../../utils/generateSlug.js';
import { buildMeta, resolvePagination } from '../../utils/pagination.js';
import { buildKey, cacheAside, cacheDelPattern } from '../../utils/cache.js';
import { isOwnerOrAdmin } from '../../middlewares/rbac.middleware.js';
import { Category } from '../categories/category.model.js';
import { getDescendantIds } from '../categories/category.service.js';
import { Product } from './product.model.js';

const LIST_NAMESPACE = 'products:list';
const DETAIL_NAMESPACE = 'products:detail';

/**
 * Product catalogue (spec §6.3).
 *
 * Listings and detail reads are cached (spec §14); every write drops both
 * namespaces. Dropping the whole list namespace rather than computing which
 * cached pages a change touched is the deliberate trade: an over-broad
 * invalidation costs one repopulation, while a missed one serves stale prices.
 */

export async function listProducts(query) {
  const key = buildKey(LIST_NAMESPACE, query);

  return cacheAside(key, env.CACHE_TTL_PRODUCT_LIST, async () => {
    const filter = await buildFilter(query);
    const { page, limit, skip } = resolvePagination(query);

    // A text search carries a relevance score that only exists inside the
    // query, so the projection has to be requested alongside the sort.
    const useTextScore = Boolean(query.q) && query.sort === 'relevance';

    let find = Product.find(filter);
    if (useTextScore) find = find.select({ score: { $meta: 'textScore' } });

    const [items, total] = await Promise.all([
      find
        .sort(buildSort(query, useTextScore))
        .skip(skip)
        .limit(limit)
        .populate('category', 'name slug')
        .populate('seller', 'name')
        .lean()
        .exec(),
      Product.countDocuments(filter),
    ]);

    return { items, meta: buildMeta({ page, limit, total }) };
  });
}

export async function getBySlug(slug) {
  const key = `${DETAIL_NAMESPACE}:${slug}`;

  const product = await cacheAside(key, env.CACHE_TTL_PRODUCT_DETAIL, async () =>
    Product.findOne({ slug, isActive: true })
      .populate('category', 'name slug')
      .populate('seller', 'name')
      .lean()
  );

  if (!product) throw ApiError.notFound('Product not found');
  return product;
}

export async function createProduct({ seller, ...input }) {
  await assertCategoryExists(input.category);

  const product = await Product.create({
    ...input,
    seller: seller._id,
    slug: await generateUniqueSlug(Product, input.name),
    // Overwritten by the pre-save hook, but the field is required, so it needs
    // a value before validation runs.
    basePrice: Math.min(...input.variants.map((variant) => variant.price)),
  });

  await invalidate();
  return product.toJSON();
}

export async function updateProduct({ actor, productId, updates }) {
  const product = await findOwned({ actor, productId });

  if (updates.category) await assertCategoryExists(updates.category);

  if (updates.name && updates.name !== product.name) {
    product.name = updates.name;
    product.slug = await generateUniqueSlug(Product, updates.name, { excludeId: product._id });
  }

  for (const field of ['description', 'category', 'variants', 'isActive']) {
    if (updates[field] !== undefined) product[field] = updates[field];
  }

  const previousSlug = product.slug;
  await product.save();
  await invalidate(previousSlug, product.slug);

  return product.toJSON();
}

/**
 * Soft delete (spec §6.3). The document stays so that orders referencing it
 * keep resolving; it simply stops appearing in the catalogue.
 */
export async function deleteProduct({ actor, productId }) {
  const product = await findOwned({ actor, productId });

  product.isActive = false;
  await product.save();
  await invalidate(product.slug);
}

export async function addImages({ actor, productId, urls }) {
  const product = await findOwned({ actor, productId });

  product.images.push(...urls);
  await product.save();
  await invalidate(product.slug);

  return product.toJSON();
}

export async function removeImage({ actor, productId, filename }) {
  const product = await findOwned({ actor, productId });

  const before = product.images.length;
  product.images = product.images.filter((url) => !url.endsWith(`/${filename}`));

  if (product.images.length === before) throw ApiError.notFound('Image not found on this product');

  await product.save();
  await invalidate(product.slug);

  return product.toJSON();
}

/**
 * Loads a product and enforces ownership (spec §9): role alone is not enough,
 * a seller may only touch their own products. Admins may touch any.
 */
async function findOwned({ actor, productId }) {
  const product = await Product.findById(productId);
  if (!product) throw ApiError.notFound('Product not found');

  if (!isOwnerOrAdmin(actor, product.seller)) {
    throw ApiError.forbidden('You can only modify your own products');
  }

  return product;
}

async function assertCategoryExists(categoryId) {
  const exists = await Category.exists({ _id: categoryId });
  if (!exists) throw ApiError.badRequest('Category does not exist');
}

/** Translates the validated query string into a Mongo filter. */
async function buildFilter({ q, category, seller, minPrice, maxPrice, minRating, inStock }) {
  const filter = { isActive: true };

  if (q) filter.$text = { $search: q };
  if (seller) filter.seller = seller;
  if (minRating !== undefined) filter.ratingAvg = { $gte: minRating };

  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.basePrice = {};
    if (minPrice !== undefined) filter.basePrice.$gte = minPrice;
    if (maxPrice !== undefined) filter.basePrice.$lte = maxPrice;
  }

  // Filtering by a category includes everything beneath it, so browsing
  // "Electronics" also surfaces products filed under "Laptops".
  if (category) {
    const parent = await Category.findOne({ slug: category }).select('_id').lean();
    if (!parent) throw ApiError.notFound('Category not found');

    filter.category = { $in: await getDescendantIds(parent._id) };
  }

  // "In stock" means some variant can actually be bought, not that the product
  // has a stock field.
  if (inStock === true) filter['variants.stock'] = { $gt: 0 };
  else if (inStock === false) filter['variants.stock'] = { $not: { $gt: 0 } };

  return filter;
}

function buildSort({ sort }, useTextScore) {
  if (useTextScore) return { score: { $meta: 'textScore' } };

  return {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    price: { basePrice: 1 },
    '-price': { basePrice: -1 },
    rating: { ratingAvg: -1, ratingCount: -1 },
    popularity: { soldCount: -1, ratingCount: -1 },
  }[sort];
}

/** Drops every cached listing, plus the detail entry for any affected slug. */
function invalidate(...slugs) {
  return Promise.all([
    cacheDelPattern(`${LIST_NAMESPACE}:*`),
    ...[...new Set(slugs.filter(Boolean))].map((slug) =>
      cacheDelPattern(`${DETAIL_NAMESPACE}:${slug}`)
    ),
  ]);
}
