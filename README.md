# ShopCore

Production-grade e-commerce backend — a modular monolith on Node.js, Express, MongoDB and Redis.

The full design document lives in [`ecommerce-backend-project.md`](./ecommerce-backend-project.md);
this README covers what exists today and how to run it.

## Build status

| Phase | Scope                                                                        | State       |
| ----- | ---------------------------------------------------------------------------- | ----------- |
| 0     | Project setup, config, middleware, app wiring, health checks, Docker         | Done        |
| 1     | Auth & users — register/login/refresh/logout, password reset, RBAC, profiles | Done        |
| 2     | Product catalog — categories, products, search, caching, image upload        | Done        |
| 3     | Cart & checkout — transactional order creation, order state machine          | Not started |
| 4     | Payments & notifications — mock provider, webhooks, BullMQ queues            | Not started |
| 5     | Reviews, coupons, admin dashboard                                            | Not started |
| 6     | Hardening — security pass, Swagger, coverage                                 | Not started |
| 7     | Deploy                                                                       | Not started |

## Requirements

- Node.js 20+
- MongoDB running as a **replica set** (checkout uses multi-document transactions,
  which standalone MongoDB does not support)
- Redis (caching, rate limiting, and later the job queues)

`docker compose up -d` provides both, with the replica set already initialised.

## Getting started

```bash
cp .env.example .env      # then fill in the JWT and webhook secrets
docker compose up -d      # Mongo (replica set) + Redis
npm install
npm run seed              # optional: admin / seller / customer accounts
npm run dev
```

The API is then at `http://localhost:5000/api/v1`, with `GET /health` for liveness
and `GET /health/ready` for readiness (it pings Mongo and Redis).

Generate the two JWT secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The app refuses to boot if any required variable is missing or malformed — see
`src/config/env.js` for the full schema.

## Scripts

| Command                 | What it does                                      |
| ----------------------- | ------------------------------------------------- |
| `npm run dev`           | Start with nodemon                                |
| `npm start`             | Start the server                                  |
| `npm run seed`          | Seed development accounts (blocked in production) |
| `npm test`              | Jest — unit + integration                         |
| `npm run test:coverage` | Tests with a coverage report                      |
| `npm run lint`          | ESLint                                            |
| `npm run format`        | Prettier                                          |

## Architecture

```
src/
├── config/       env validation, Mongo, Redis, Winston
├── middlewares/  request id, auth, RBAC, validation, rate limiting, errors
├── modules/      one folder per domain: model, routes, controller, service, validation
├── routes/       versioned API index + health checks
├── utils/        ApiError, ApiResponse, asyncHandler, pagination, slugs
├── app.js        Express wiring (no I/O — this is what the tests mount)
└── server.js     process entry: connect, listen, shut down gracefully
```

Each module is layered: **routes** declare the contract and attach middleware,
**controllers** adapt HTTP to the service call, **services** hold the business
rules and are the only layer that touches models. Splitting `app.js` from
`server.js` is what lets integration tests run the whole stack against an
in-memory Mongo without opening a port.

## API

Base URL `/api/v1`. Every response uses one envelope:

```jsonc
// success
{ "success": true, "data": { }, "message": "…", "meta": { "page": 1, "limit": 20, "total": 134 } }

// error
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [ … ] } }
```

### Implemented endpoints

| Method | Endpoint                         | Auth   | Description                        |
| ------ | -------------------------------- | ------ | ---------------------------------- |
| POST   | `/auth/register`                 | Public | Register a customer or seller      |
| POST   | `/auth/login`                    | Public | Access token + refresh cookie      |
| POST   | `/auth/refresh`                  | Cookie | Rotate the refresh token           |
| POST   | `/auth/logout`                   | Auth   | Invalidate the refresh token       |
| POST   | `/auth/forgot-password`          | Public | Email a reset link                 |
| POST   | `/auth/reset-password/:token`    | Public | Set a new password                 |
| GET    | `/auth/verify-email/:token`      | Public | Verify an email address            |
| GET    | `/users/me`                      | Auth   | Current profile                    |
| PATCH  | `/users/me`                      | Auth   | Update name / email                |
| POST   | `/users/me/addresses`            | Auth   | Add an address                     |
| DELETE | `/users/me/addresses/:addressId` | Auth   | Remove an address                  |
| GET    | `/users`                         | Admin  | Search and page the user directory |
| PATCH  | `/users/:id/status`              | Admin  | Ban / unban                        |

### Catalogue

| Method | Endpoint                         | Auth           | Description                             |
| ------ | -------------------------------- | -------------- | --------------------------------------- |
| GET    | `/categories`                    | Public         | Category tree (or `?format=flat`)       |
| GET    | `/categories/:slug`              | Public         | One category                            |
| POST   | `/categories`                    | Admin          | Create a category                       |
| PATCH  | `/categories/:id`                | Admin          | Rename, re-parent, activate             |
| DELETE | `/categories/:id`                | Admin          | Delete (refused while still referenced) |
| GET    | `/products`                      | Public         | Search, filter, sort, paginate          |
| GET    | `/products/:slug`                | Public         | Product detail                          |
| POST   | `/products`                      | Seller / Admin | Create a product                        |
| PATCH  | `/products/:id`                  | Owner / Admin  | Update                                  |
| DELETE | `/products/:id`                  | Owner / Admin  | Soft delete                             |
| POST   | `/products/:id/images`           | Owner / Admin  | Upload up to 5 images (multipart)       |
| DELETE | `/products/:id/images/:filename` | Owner / Admin  | Remove one image                        |

**Product listing query parameters:** `q` (full-text), `category` (slug — includes
everything beneath it), `seller`, `minPrice`, `maxPrice`, `minRating`, `inStock`,
`sort` (`newest`, `oldest`, `price`, `-price`, `rating`, `popularity`, `relevance`),
`page`, `limit`. Unknown parameters are rejected rather than ignored, so a typo in
a filter fails loudly instead of silently returning the wrong page.

## Caching

Product listings, product detail, and the category tree are cached in Redis
(spec §14). Two decisions worth noting:

- **The cache is an optimisation, never a dependency.** Every helper in
  `src/utils/cache.js` swallows its own errors and reports a miss, so a Redis
  outage degrades response times instead of returning 500s.
- **Writes drop the whole listing namespace** rather than computing which cached
  pages a change affected. An over-broad invalidation costs one repopulation; a
  missed one serves a stale price.

Invalidation uses `SCAN`, not `KEYS` — `KEYS` blocks the Redis event loop across
the entire keyspace, which is harmless with ten keys and an outage with a million.
Set `CACHE_ENABLED=false` to bypass Redis entirely.

## File uploads

Product images go through `multer` (memory storage) into `sharp`, which resizes
to fit 1200px and re-encodes to WebP before anything touches disk. The
re-encoding is the actual security control: a `.jpg` that is really a polyglot
script does not survive being decoded and written back out. Filenames are
generated server-side, so a crafted upload name can never influence the path.

## Security notes

Beyond the standard `helmet` / `cors` / `hpp` / `express-mongo-sanitize` stack:

- **Passwords** are bcrypt-hashed in a pre-save hook, so no code path can persist plaintext.
- **Refresh tokens** are stored only as a SHA-256 hash and rotated on every use. Replaying
  an old token is treated as theft: the stored token is cleared and every session dies.
- **Account lockout** after repeated failed logins, and login answers identically —
  in both message and timing — whether the account exists or the password was wrong.
- **Reset and verification tokens** are hashed at rest and single-use; `forgot-password`
  responds the same way for registered and unregistered addresses.
- **Rate limits** are Redis-backed so they hold across instances, keyed on IP _and_ email
  on the auth routes.
- **Access tokens are re-checked against the database** on every request, so a banned
  user cannot keep working for the remainder of the token's life.

## Testing

```bash
npm test
```

Unit tests cover services in isolation. Integration tests run the real Express app
against `mongodb-memory-server` (a single-node replica set, so transactions work)
via supertest. The first run downloads the Mongo binary and takes a few minutes.
