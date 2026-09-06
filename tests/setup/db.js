import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * In-memory MongoDB for integration tests (spec §17).
 *
 * A replica set rather than a standalone: checkout wraps stock decrement and
 * order creation in a transaction, and only a replica set supports those. It
 * costs a couple of seconds at startup and means the tests exercise the same
 * code path production does.
 */
let replSet = null;

export async function connectTestDatabase() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri(), { serverSelectionTimeoutMS: 30_000 });
  return mongoose.connection;
}

export async function clearTestDatabase() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

export async function disconnectTestDatabase() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await replSet?.stop();
  replSet = null;
}
