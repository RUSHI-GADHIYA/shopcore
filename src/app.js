import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import hpp from 'hpp';
import mongoSanitize from 'express-mongo-sanitize';
import { env, isProduction, isTest } from './config/env.js';
import { morganStream } from './config/logger.js';
import requestId from './middlewares/requestId.middleware.js';
import { globalLimiter } from './middlewares/rateLimiter.middleware.js';
import errorHandler from './middlewares/errorHandler.middleware.js';
import notFound from './middlewares/notFound.middleware.js';
import ApiError from './utils/ApiError.js';
import healthRoutes from './routes/health.routes.js';
import apiRoutes from './routes/index.js';

/**
 * Express application wiring. Kept separate from `server.js` so tests can mount
 * the app with supertest without opening a port or connecting to anything.
 *
 * Middleware order matters and is roughly: identify → protect → parse →
 * sanitise → route → handle errors.
 */
export function createApp() {
  const app = express();

  // Rate limiting and secure cookies both depend on knowing the real client IP,
  // which behind a load balancer only arrives via X-Forwarded-For.
  app.set('trust proxy', isProduction ? 1 : false);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(helmet());
  app.use(cors(corsOptions()));

  // The raw body is kept because a webhook signature is computed over the exact
  // bytes sent; re-serialising the parsed object can reorder keys and would no
  // longer match (see modules/payments).
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buffer) => {
        req.rawBody = buffer;
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  // Strips `$`-prefixed and dotted keys so user input cannot become a Mongo
  // query operator (spec §15).
  app.use(mongoSanitize({ replaceWith: '_' }));
  // `?sort=a&sort=b` would otherwise arrive as an array and surprise validators.
  app.use(hpp());

  if (!isTest) {
    app.use(
      morgan(isProduction ? 'combined' : 'dev', {
        stream: morganStream,
        skip: (req) => req.path.startsWith('/health'),
      })
    );
  }

  // Uploaded product images are served straight from disk in the local setup
  // (spec §11). `dotfiles: deny` keeps anything hidden that lands there private.
  app.use(
    '/uploads',
    express.static(path.resolve(env.UPLOAD_DIR), { dotfiles: 'deny', maxAge: '7d', index: false })
  );

  // Generated invoices. Served like uploads, but from their own directory so an
  // invoice can never be reached through the product-image path.
  app.use(
    '/invoices',
    express.static(path.resolve(env.INVOICE_DIR), { dotfiles: 'deny', index: false })
  );

  // Health checks sit outside the rate limiter: probes run constantly and must
  // never be throttled into reporting a false outage.
  app.use('/health', healthRoutes);

  app.use(`/api/${env.API_VERSION}`, globalLimiter, apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

function corsOptions() {
  const allowed = env.CORS_ORIGINS;

  return {
    origin(origin, callback) {
      // No Origin header: same-origin, curl, or a server-to-server call.
      if (!origin) return callback(null, true);
      if (allowed.includes('*') || allowed.includes(origin)) return callback(null, true);
      return callback(ApiError.forbidden(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  };
}

export default createApp;
