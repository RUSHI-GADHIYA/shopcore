/**
 * Development seed data (spec §19).
 *
 * Idempotent: re-running updates the same accounts rather than creating
 * duplicates, so it is safe to call repeatedly while developing. Refuses to run
 * against production — the whole point is a set of known, weak passwords.
 */
import { env } from '../src/config/env.js';
import logger from '../src/config/logger.js';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { User, ROLES } from '../src/modules/users/user.model.js';
import { Category } from '../src/modules/categories/category.model.js';
import { Product } from '../src/modules/products/product.model.js';
import { slugify } from '../src/utils/generateSlug.js';

const SEED_PASSWORD = 'Password123';

const users = [
  { name: 'Site Admin', email: 'admin@shopcore.dev', role: ROLES.ADMIN },
  { name: 'Sam Seller', email: 'seller@shopcore.dev', role: ROLES.SELLER },
  { name: 'Casey Customer', email: 'customer@shopcore.dev', role: ROLES.CUSTOMER },
];

async function seedUsers() {
  const results = [];

  for (const spec of users) {
    // `findOne` + `save` rather than an upsert: the password hashing lives in a
    // pre-save hook, which an update query would bypass.
    const existing = await User.findOne({ email: spec.email }).select('+password');
    const user = existing ?? new User(spec);

    user.name = spec.name;
    user.role = spec.role;
    user.password = SEED_PASSWORD;
    user.isEmailVerified = true;
    user.isActive = true;

    await user.save();
    results.push({ email: user.email, role: user.role, created: !existing });
  }

  return results;
}

/**
 * A small category tree plus a product in each leaf, so the listing, search and
 * descendant-filter endpoints have something realistic to return.
 */
const categoryTree = [
  {
    name: 'Electronics',
    children: [{ name: 'Laptops' }, { name: 'Peripherals' }],
  },
  { name: 'Home & Kitchen', children: [{ name: 'Coffee' }] },
];

const productCatalog = [
  {
    categoryName: 'Laptops',
    name: 'Aurora Ultrabook 14',
    description: 'A thin and light aluminium laptop with a 14-inch display and all-day battery.',
    variants: [
      { sku: 'AUR-14-SLV', attributes: { color: 'Silver' }, price: 1299.99, stock: 12 },
      { sku: 'AUR-14-BLK', attributes: { color: 'Black' }, price: 1349.99, stock: 4 },
    ],
  },
  {
    categoryName: 'Peripherals',
    name: 'Nimbus Mechanical Keyboard',
    description: 'A compact 65% mechanical keyboard with hot-swappable switches and PBT keycaps.',
    variants: [
      { sku: 'NMB-65-RED', attributes: { color: 'Red' }, price: 89.5, stock: 40 },
      { sku: 'NMB-65-BRN', attributes: { color: 'Brown' }, price: 89.5, stock: 3 },
    ],
  },
  {
    categoryName: 'Peripherals',
    name: 'Vantage 27 Monitor',
    description: 'A 27-inch 4K monitor with an adjustable stand and a single-cable USB-C input.',
    variants: [{ sku: 'VNT-27-4K', price: 449, stock: 30 }],
  },
  {
    categoryName: 'Coffee',
    name: 'Ember Pour-Over Kettle',
    description: 'A gooseneck kettle with variable temperature control for pour-over coffee.',
    variants: [{ sku: 'EMB-KTL-01', attributes: { color: 'Matte Black' }, price: 119, stock: 0 }],
  },
];

/** Creates the tree depth-first so each child can inherit its parent's chain. */
async function seedCategories(nodes, parent = null, ancestors = []) {
  const created = [];

  for (const node of nodes) {
    const slug = slugify(node.name);

    let category = await Category.findOne({ slug });
    if (category) {
      category.set({ name: node.name, parent, ancestors });
    } else {
      category = new Category({ name: node.name, slug, parent, ancestors });
    }
    await category.save();

    created.push(category);

    if (node.children) {
      created.push(
        ...(await seedCategories(node.children, category._id, [...ancestors, category._id]))
      );
    }
  }

  return created;
}

async function seedProducts(categories, seller) {
  const byName = new Map(categories.map((category) => [category.name, category]));
  const results = [];

  for (const spec of productCatalog) {
    const category = byName.get(spec.categoryName);
    const slug = slugify(spec.name);

    const existing = await Product.findOne({ slug });
    const product = existing ?? new Product({ slug });

    product.set({
      name: spec.name,
      description: spec.description,
      category: category._id,
      seller: seller._id,
      variants: spec.variants,
      basePrice: Math.min(...spec.variants.map((variant) => variant.price)),
      isActive: true,
    });

    await product.save();
    results.push({ name: product.name, category: category.name, price: product.basePrice });
  }

  return results;
}

async function main() {
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to seed a production database.');
    process.exit(1);
  }

  await connectDatabase();

  const seededUsers = await seedUsers();
  const categories = await seedCategories(categoryTree);

  const seller = await User.findOne({ email: 'seller@shopcore.dev' });
  const seededProducts = await seedProducts(categories, seller);

  console.log('\nSeeded accounts (password for all: %s)\n', SEED_PASSWORD);
  console.table(seededUsers);

  console.log('\nSeeded catalogue (%d categories)\n', categories.length);
  console.table(seededProducts);

  await disconnectDatabase();
}

main().catch(async (error) => {
  logger.error('Seed failed', { error: error.message, stack: error.stack });
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
