/**
 * Mongoose connection lifecycle.
 *
 * The URI must point at a replica set — checkout wraps stock decrement and order
 * creation in a multi-document transaction, which standalone MongoDB cannot do.
 */
import mongoose from 'mongoose';
import { env, isProduction } from './env.js';
import logger from './logger.js';

// Reject writes for paths not declared in a schema instead of silently dropping them.
mongoose.set('strictQuery', true);

// Index building is convenient in dev but a foot-gun in production, where indexes
// should be created deliberately during a migration rather than on every boot.
mongoose.set('autoIndex', !isProduction);

export async function connectDatabase(uri = env.MONGO_URI) {
  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('error', (error) =>
    logger.error('MongoDB error', { error: error.message })
  );
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });

  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
}

/**
 * True when the connected deployment supports multi-document transactions.
 * Used to give a clear error at checkout rather than a cryptic driver failure.
 */
export function supportsTransactions() {
  const { topology } = mongoose.connection.client ?? {};
  const description = topology?.description;
  if (!description) return false;
  return description.type === 'ReplicaSetWithPrimary' || description.type === 'Sharded';
}

export default mongoose;
