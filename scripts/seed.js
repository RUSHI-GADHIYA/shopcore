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

async function main() {
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to seed a production database.');
    process.exit(1);
  }

  await connectDatabase();

  const seeded = await seedUsers();

  console.log('\nSeeded accounts (password for all: %s)\n', SEED_PASSWORD);
  console.table(seeded);

  await disconnectDatabase();
}

main().catch(async (error) => {
  logger.error('Seed failed', { error: error.message, stack: error.stack });
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
