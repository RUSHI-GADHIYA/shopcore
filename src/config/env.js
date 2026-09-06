/**
 * Validated application configuration.
 *
 * Every environment variable the app reads is declared here and parsed once at
 * import time. A missing or malformed value fails the process immediately with a
 * readable report, rather than surfacing as a confusing runtime error later.
 */
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/** Coerce the common "true"/"false" string form into a real boolean. */
const booleanFromString = (defaultValue) =>
  z
    .enum(['true', 'false'])
    .default(String(defaultValue))
    .transform((value) => value === 'true');

/** A positive integer supplied as a string, e.g. PORT=5000. */
const intFromString = (defaultValue) => z.coerce.number().int().positive().default(defaultValue);

const csv = (defaultValue) =>
  z
    .string()
    .default(defaultValue)
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: intFromString(5000),
    API_VERSION: z.string().default('v1'),
    CORS_ORIGINS: csv('http://localhost:3000'),

    MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_EXPIRY: z.string().default('15m'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_REFRESH_EXPIRY: z.string().default('7d'),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: intFromString(587),
    SMTP_SECURE: booleanFromString(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    EMAIL_FROM: z.string().default('no-reply@shopcore.dev'),

    UPLOAD_PROVIDER: z.enum(['local']).default('local'),
    UPLOAD_DIR: z.string().default('uploads'),
    UPLOAD_MAX_BYTES: intFromString(5 * 1024 * 1024),
    PUBLIC_BASE_URL: z.string().default('http://localhost:5000'),

    RATE_LIMIT_WINDOW_MS: intFromString(15 * 60 * 1000),
    RATE_LIMIT_MAX: intFromString(100),
    AUTH_RATE_LIMIT_MAX: intFromString(5),

    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
    MAX_FAILED_LOGIN_ATTEMPTS: intFromString(5),
    ACCOUNT_LOCK_MINUTES: intFromString(15),
    PASSWORD_RESET_EXPIRY_MINUTES: intFromString(30),
    EMAIL_VERIFY_EXPIRY_HOURS: intFromString(24),

    PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
    PAYMENT_WEBHOOK_SECRET: z
      .string()
      .min(16, 'PAYMENT_WEBHOOK_SECRET must be at least 16 characters'),

    // Lets caching be switched off wholesale — used by the test suite, where a
    // background Redis reconnect loop would outlive the tests, and useful when
    // debugging whether a stale read is a cache problem or a query problem.
    CACHE_ENABLED: booleanFromString(true),
    CACHE_TTL_PRODUCT_LIST: intFromString(300),
    CACHE_TTL_PRODUCT_DETAIL: intFromString(300),
    CACHE_TTL_CATEGORY_TREE: intFromString(3600),

    LOW_STOCK_THRESHOLD: intFromString(5),

    // Order pricing. The spec's Order schema carries tax and shipping, so the
    // rules that produce them belong in configuration rather than hard-coded in
    // the checkout service.
    TAX_RATE_PERCENT: z.coerce.number().min(0).max(100).default(0),
    SHIPPING_FLAT_FEE: z.coerce.number().min(0).default(0),
    FREE_SHIPPING_THRESHOLD: z.coerce.number().min(0).default(0),
    ORDER_CANCELLATION_WINDOW_HOURS: intFromString(24),
  })
  // In production a wildcard CORS policy is almost always a mistake, so refuse to boot with one.
  .refine((cfg) => cfg.NODE_ENV !== 'production' || !cfg.CORS_ORIGINS.includes('*'), {
    message: 'CORS_ORIGINS may not contain "*" when NODE_ENV=production',
    path: ['CORS_ORIGINS'],
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const report = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  // Deliberately console.error + exit rather than throw: the logger itself depends
  // on this config, so there is nothing else available this early in the boot.
  console.error(`\nInvalid environment configuration:\n${report}\n`);
  console.error('Copy .env.example to .env and fill in the missing values.\n');
  process.exit(1);
}

export const env = Object.freeze(parsed.data);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

export default env;
