import { env } from '../../config/env.js';
import ApiError from '../../utils/ApiError.js';
import { generateUniqueSlug } from '../../utils/generateSlug.js';
import { cacheAside, cacheDelPattern, buildKey } from '../../utils/cache.js';
import { Category } from './category.model.js';

const CACHE_NAMESPACE = 'categories';

/**
 * Category management (spec §6.4). Reads are cached with a long TTL because the
 * tree changes rarely; every mutation drops the whole namespace, which is
 * cheaper to reason about than working out which entries a re-parent affected.
 */

export async function listCategories({ format, includeInactive }) {
  const key = buildKey(CACHE_NAMESPACE, { format, includeInactive });

  return cacheAside(key, env.CACHE_TTL_CATEGORY_TREE, async () => {
    const filter = includeInactive ? {} : { isActive: true };
    const categories = await Category.find(filter).sort({ name: 1 }).lean();

    return format === 'flat' ? categories : buildTree(categories);
  });
}

export async function getBySlug(slug) {
  const category = await Category.findOne({ slug }).lean();
  if (!category) throw ApiError.notFound('Category not found');

  return category;
}

export async function createCategory({ name, description, parent, isActive }) {
  const ancestors = await resolveAncestors(parent);

  const category = await Category.create({
    name,
    description,
    parent: parent ?? null,
    ancestors,
    isActive,
    slug: await generateUniqueSlug(Category, name),
  });

  await invalidate();
  return category.toJSON();
}

export async function updateCategory(id, updates) {
  const category = await Category.findById(id);
  if (!category) throw ApiError.notFound('Category not found');

  // Re-parenting is the only change that touches other documents, so it is
  // handled first and separately.
  if (updates.parent !== undefined && String(updates.parent) !== String(category.parent)) {
    await reparent(category, updates.parent);
  }

  if (updates.name && updates.name !== category.name) {
    category.name = updates.name;
    category.slug = await generateUniqueSlug(Category, updates.name, { excludeId: category._id });
  }

  if (updates.description !== undefined) category.description = updates.description;
  if (updates.isActive !== undefined) category.isActive = updates.isActive;

  await category.save();
  await invalidate();

  return category.toJSON();
}

/**
 * Deletion is refused while anything still points at the category. Products
 * carry order history, so silently orphaning them would corrupt past orders —
 * the caller is told to move or deactivate instead.
 */
export async function deleteCategory(id) {
  const category = await Category.findById(id);
  if (!category) throw ApiError.notFound('Category not found');

  const childCount = await Category.countDocuments({ parent: category._id });
  if (childCount > 0) {
    throw ApiError.conflict('Category has subcategories; move or delete those first');
  }

  // Imported lazily: the product module imports this one for its category
  // lookups, and a static import here would close the cycle.
  const { Product } = await import('../products/product.model.js');
  const productCount = await Product.countDocuments({ category: category._id });
  if (productCount > 0) {
    throw ApiError.conflict(
      `Category still has ${productCount} product(s); reassign them or deactivate the category instead`
    );
  }

  await category.deleteOne();
  await invalidate();
}

/**
 * Returns the category plus every descendant id, for "all products under X"
 * queries. One indexed read against `ancestors`, at any depth.
 */
export async function getDescendantIds(categoryId) {
  const descendants = await Category.find({ ancestors: categoryId }).select('_id').lean();
  return [categoryId, ...descendants.map((doc) => doc._id)];
}

/** Builds the ancestor chain for a new child: the parent's chain plus the parent. */
async function resolveAncestors(parentId) {
  if (!parentId) return [];

  const parent = await Category.findById(parentId).select('ancestors').lean();
  if (!parent) throw ApiError.badRequest('Parent category does not exist');

  return [...parent.ancestors, parentId];
}

/**
 * Moves a category to a new parent and rewrites the ancestor chain of the whole
 * subtree beneath it.
 */
async function reparent(category, newParentId) {
  if (newParentId && String(newParentId) === String(category._id)) {
    throw ApiError.badRequest('A category cannot be its own parent');
  }

  // Moving a category under one of its own descendants would detach the subtree
  // from the root and create a cycle.
  if (newParentId) {
    const descendantIds = await getDescendantIds(category._id);
    if (descendantIds.some((id) => String(id) === String(newParentId))) {
      throw ApiError.badRequest('A category cannot be moved beneath one of its own descendants');
    }
  }

  const oldAncestors = [...category.ancestors];
  const newAncestors = await resolveAncestors(newParentId);

  category.parent = newParentId ?? null;
  category.ancestors = newAncestors;

  // Each descendant keeps the part of its chain below this category and swaps
  // the part above it for the new one.
  const descendants = await Category.find({ ancestors: category._id }).select('ancestors');

  await Promise.all(
    descendants.map((descendant) => {
      const belowThis = descendant.ancestors.slice(oldAncestors.length + 1);
      descendant.ancestors = [...newAncestors, category._id, ...belowThis];
      return descendant.save();
    })
  );
}

/** Assembles a flat list into a nested tree in one pass. */
export function buildTree(categories) {
  const byId = new Map();
  const roots = [];

  for (const category of categories) {
    byId.set(String(category._id), { ...category, children: [] });
  }

  for (const category of categories) {
    const node = byId.get(String(category._id));
    const parent = category.parent ? byId.get(String(category.parent)) : null;

    // A child whose parent was filtered out (inactive) is promoted to a root
    // rather than dropped, so no category becomes invisible.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

function invalidate() {
  return cacheDelPattern(`${CACHE_NAMESPACE}:*`);
}
