import swaggerJsdoc from 'swagger-jsdoc';
import { env } from '../config/env.js';

/**
 * OpenAPI definition (spec §20).
 *
 * The shared envelope, the error shape, and the common responses live here as
 * components so each route annotation only has to describe what is genuinely
 * particular to it. Route-level detail is read from JSDoc `@openapi` blocks in
 * the route files, which keeps the documentation beside the thing it documents.
 */
const envelope = (dataSchema) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    data: dataSchema ?? { type: 'object' },
    message: { type: 'string' },
    meta: { $ref: '#/components/schemas/PaginationMeta' },
  },
});

const definition = {
  openapi: '3.0.3',
  info: {
    title: 'ShopCore API',
    version: '1.0.0',
    description: [
      'Production-grade e-commerce backend: a modular monolith on Node.js,',
      'Express, MongoDB and Redis.',
      '',
      '**Authentication.** Sign in at `POST /auth/login`. The access token is a',
      '15-minute JWT sent as `Authorization: Bearer <token>`; the refresh token',
      'is an httpOnly cookie, rotated on every use.',
      '',
      '**Money.** Prices are never accepted from a client. Totals are computed',
      'server-side from the catalogue at the moment of checkout.',
    ].join('\n'),
    license: { name: 'MIT' },
  },
  servers: [{ url: `${env.PUBLIC_BASE_URL}/api/${env.API_VERSION}`, description: 'This instance' }],
  tags: [
    { name: 'Auth', description: 'Registration, sessions, password reset' },
    { name: 'Users', description: 'Profiles, address book, admin directory' },
    { name: 'Categories', description: 'Hierarchical catalogue structure' },
    { name: 'Products', description: 'Catalogue browsing and seller management' },
    { name: 'Reviews', description: 'Verified-purchase product reviews' },
    { name: 'Cart', description: 'The signed-in shopper’s cart' },
    { name: 'Orders', description: 'Checkout and the order lifecycle' },
    { name: 'Payments', description: 'Payment intents and gateway webhooks' },
    { name: 'Coupons', description: 'Promotional codes' },
    { name: 'Admin', description: 'Dashboards and operational reports' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      refreshCookie: { type: 'apiKey', in: 'cookie', name: 'refreshToken' },
      webhookSignature: {
        type: 'apiKey',
        in: 'header',
        name: 'x-shopcore-signature',
        description: 'HMAC-SHA256 of the raw request body, keyed with PAYMENT_WEBHOOK_SECRET.',
      },
    },
    schemas: {
      PaginationMeta: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 20 },
          total: { type: 'integer', example: 134 },
          totalPages: { type: 'integer', example: 7 },
          hasNextPage: { type: 'boolean' },
          hasPrevPage: { type: 'boolean' },
        },
      },
      SuccessResponse: envelope(),
      ErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              message: { type: 'string', example: 'Request validation failed' },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    field: { type: 'string', example: 'email' },
                    message: { type: 'string', example: 'Must be a valid email address' },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      BadRequest: {
        description: 'The request was understood but cannot be acted on',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Unauthorized: {
        description: 'Missing, expired or invalid credentials',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Forbidden: {
        description: 'Authenticated, but not permitted to do this',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      NotFound: {
        description: 'No such resource',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Conflict: {
        description: 'Conflicts with the current state, e.g. insufficient stock',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      ValidationError: {
        description: 'The request body, query or params failed validation',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      RateLimited: {
        description: 'Too many requests',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
    },
  },
  // Most endpoints need a token; the handful that do not override this locally.
  security: [{ bearerAuth: [] }],
};

export const openApiSpec = swaggerJsdoc({
  definition,
  // Globs, so a new module's annotations are picked up without touching this file.
  apis: ['./src/modules/**/*.routes.js', './src/routes/*.js'],
});

export default openApiSpec;
