import { env } from './config/env.js';
import logger from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { createApp } from './app.js';

/**
 * Process entry point: connect dependencies, start listening, and shut down
 * cleanly. Nothing here belongs in `app.js` — keeping them apart is what lets
 * the integration tests mount the app against an in-memory Mongo instance.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function start() {
  await connectDatabase();

  // Redis backs caching and rate limiting, neither of which is worth refusing to
  // boot over — a warning plus degraded behaviour beats a down service.
  await connectRedis().catch((error) =>
    logger.warn('Redis unavailable at startup; caching and rate limiting are degraded', {
      error: error.message,
    })
  );

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`ShopCore API listening on port ${env.PORT}`, {
      env: env.NODE_ENV,
      docs: `${env.PUBLIC_BASE_URL}/api/${env.API_VERSION}`,
    });
  });

  registerShutdownHandlers(server);
  return server;
}

function registerShutdownHandlers(server) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`${signal} received, shutting down`);

    // If a connection refuses to drain, exit anyway rather than hang the deploy.
    const failsafe = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    try {
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
      clearTimeout(failsafe);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error: error.message });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unhandled rejection or uncaught exception leaves the process in an
  // unknown state; log it and let the orchestrator restart a clean one.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: reason?.message ?? String(reason) });
    shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    shutdown('uncaughtException');
  });
}

start().catch((error) => {
  logger.error('Failed to start server', { error: error.message, stack: error.stack });
  process.exit(1);
});
