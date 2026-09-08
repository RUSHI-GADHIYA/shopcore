# ShopCore

Production-grade e-commerce backend — a modular monolith on Node.js, Express, MongoDB and Redis.

This README covers what exists today and how to run it. Section references
below (spec §6.6, §7.4, and so on) point at the project's design document, which
is kept outside the repository.

## Build status

| Phase | Scope                                                                        | State |
| ----- | ---------------------------------------------------------------------------- | ----- |
| 0     | Project setup, config, middleware, app wiring, health checks, Docker         | Done  |
| 1     | Auth & users — register/login/refresh/logout, password reset, RBAC, profiles | Done  |
| 2     | Product catalog — categories, products, search, caching, image upload        | Done  |
| 3     | Cart & checkout — transactional order creation, order state machine          | Done  |
| 4     | Payments & notifications — mock provider, webhooks, BullMQ queues            | Done  |
| 5     | Reviews, coupons, admin dashboard                                            | Done  |
| 6     | Hardening — security pass, Swagger, coverage                                 | Done  |
| 7     | Deploy — CI/CD, Docker build verification, Render blueprint                  | Done  |

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

| Command                 | What it does                                  |
| ----------------------- | --------------------------------------------- |
| `npm run dev`           | Start with nodemon                            |
| `npm start`             | Start the server                              |
| `npm run worker`        | Run the background job worker                 |
| `npm run seed`          | Seed development data (blocked in production) |
| `npm run smoke`         | Smoke-test a running instance over HTTP       |
| `npm test`              | Jest — unit + integration                     |
| `npm run test:coverage` | Tests with a coverage report                  |
| `npm run lint`          | ESLint                                        |
| `npm run format`        | Prettier                                      |

## Architecture

```
src/
├── config/       env validation, Mongo, Redis, Winston
├── docs/         OpenAPI definition
├── jobs/         BullMQ queues, shared handlers, the worker entry point
├── middlewares/  request id, auth, RBAC, validation, rate limiting, uploads, errors
├── modules/      auth, users, categories, products, cart, orders,
│                 payments, reviews, coupons, notifications, admin
├── routes/       versioned API index + health checks
├── utils/        ApiError, ApiResponse, asyncHandler, pagination, slugs, cache, money
├── app.js        Express wiring (no I/O — this is what the tests mount)
└── server.js     process entry: connect, listen, shut down gracefully
```

Each module is layered: **routes** declare the contract and attach middleware,
**controllers** adapt HTTP to the service call, **services** hold the business
rules and are the only layer that touches models. Splitting `app.js` from
`server.js` is what lets integration tests run the whole stack against an
in-memory Mongo without opening a port.

## API

Base URL `/api/v1`. Interactive documentation is served at **`/api-docs`**, and the raw OpenAPI 3.0 document at `/api-docs.json` — 40 paths, 50 operations, covering every endpoint below.

Every response uses one envelope:

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

### Cart & orders

| Method | Endpoint             | Auth                   | Description                                            |
| ------ | -------------------- | ---------------------- | ------------------------------------------------------ |
| GET    | `/cart`              | Auth                   | Current cart, reconciled against live prices and stock |
| POST   | `/cart/items`        | Auth                   | Add or top up a line                                   |
| PATCH  | `/cart/items/:sku`   | Auth                   | Set a line's quantity                                  |
| DELETE | `/cart/items/:sku`   | Auth                   | Remove a line                                          |
| POST   | `/orders/checkout`   | Auth                   | Turn the cart into an order                            |
| GET    | `/orders`            | Auth                   | Orders, scoped by role                                 |
| GET    | `/orders/:id`        | Owner / Seller / Admin | Order detail                                           |
| PATCH  | `/orders/:id/cancel` | Owner / Admin          | Cancel and release stock                               |
| PATCH  | `/orders/:id/status` | Seller / Admin         | Advance fulfilment                                     |

Cart lines are addressed by **SKU**, not product id as the design document
sketches: a product can sit in the cart several times under different variants,
and SKUs are unique across the catalogue, so they identify a line unambiguously.

`GET /cart` re-resolves every line against the live catalogue and reports what
changed — `PRICE_CHANGED`, `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`,
`PRODUCT_UNAVAILABLE`. A price change is informational and the live price wins;
the others block checkout, which is the difference between `hasIssues` and
`isCheckoutable`.

## Checkout and order integrity

Two invariants shape the order module:

**The server prices the order.** Checkout accepts an optional `addressId` and a
note — nothing else. Not the items, not the quantities' cost, not the total.
Line prices are re-read from the catalogue at the moment of checkout, so the
`priceSnapshot` a client saw in its cart never becomes the price it pays.

**Stock and the order move together.** Decrementing every variant, writing the
order, and emptying the cart happen inside one MongoDB transaction — which is
why the database has to run as a replica set. Each decrement is also a
_conditional_ update whose filter asserts sufficient stock, so two simultaneous
checkouts for the last unit cannot both succeed; the loser matches no document
and the whole transaction rolls back. There is a test for exactly that race.

Money is never added as floating point. Every calculation converts to integer
cents first (`src/utils/money.js`), because `0.1 + 0.2` is `0.30000000000000004`
and a thirty-line cart compounds that into a total that disagrees with the sum
of its own lines.

### Order state machine

`src/modules/orders/order.state-machine.js` holds the transition table, the
roles permitted to drive each transition, and which transitions return stock to
the catalogue. Keeping it in one table rather than scattering status checks
through the service means an illegal transition is impossible to express:

```
PENDING ─→ PAID ─→ PROCESSING ─→ SHIPPED ─→ DELIVERED
   │        │          │              └─→ RETURNED ─→ REFUNDED
   │        │          └─→ CANCELLED          ↑
   │        └─→ CANCELLED / REFUNDED          │
   ├─→ CANCELLED                     DELIVERED ┘
   └─→ PAYMENT_FAILED ─→ PENDING (retry) / CANCELLED
```

Stock is held from `PENDING` through `DELIVERED` and released on any exit from
that set — cancellation, refund, or return. An `stockReleasedAt` stamp written
inside the transaction stops a repeated cancellation from crediting the
catalogue twice. Payment outcomes (`PAID`, `PAYMENT_FAILED`) are reserved for
the payment webhook in Phase 4 and cannot be set by any human role.

### Payments

| Method | Endpoint             | Auth          | Description                     |
| ------ | -------------------- | ------------- | ------------------------------- |
| POST   | `/payments/initiate` | Auth          | Start a payment for an order    |
| POST   | `/payments/webhook`  | Signature     | Gateway callback (idempotent)   |
| GET    | `/payments/:orderId` | Owner / Admin | The latest payment for an order |

### Reviews, coupons, admin

| Method | Endpoint                     | Auth           | Description                           |
| ------ | ---------------------------- | -------------- | ------------------------------------- |
| GET    | `/products/:id/reviews`      | Public         | Reviews plus a rating histogram       |
| POST   | `/products/:id/reviews`      | Auth           | Review a product you have received    |
| PATCH  | `/reviews/:id`               | Author         | Edit your own review                  |
| DELETE | `/reviews/:id`               | Author / Admin | Remove a review                       |
| PATCH  | `/reviews/:id/flag`          | Admin          | Hide or restore a review              |
| POST   | `/coupons/preview`           | Auth           | Check a code against your cart        |
| GET    | `/coupons`                   | Admin          | List coupons                          |
| POST   | `/coupons`                   | Admin          | Create a coupon                       |
| PATCH  | `/coupons/:id`               | Admin          | Update a coupon                       |
| DELETE | `/coupons/:id`               | Admin          | Delete, or deactivate if already used |
| GET    | `/admin/dashboard`           | Admin          | Revenue, order counts, top products   |
| GET    | `/admin/reports/low-stock`   | Admin / Seller | Variants at or below the threshold    |
| GET    | `/admin/reports/sales-trend` | Admin          | Revenue per day                       |

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

## Background jobs

Anything that should not block a response goes on a queue (spec §13): all
transactional email, and invoice PDF generation after payment succeeds. The
worker is a separate process (`npm run worker`), so rendering a PDF cannot
starve HTTP requests of event-loop time.

The producers and the worker share one set of handlers, so a job behaves
identically wherever it runs. That matters because of the fallback: with
`QUEUE_ENABLED=false`, `enqueue()` runs the handler inline instead of pushing
it to BullMQ. The app is fully functional for a developer who has not started
Redis, and the test suite exercises the real handlers rather than asserting
that a mock was called.

Enqueueing never throws. A notification that cannot be scheduled must not fail
the order that triggered it.

## Payments

The mock gateway exists to reproduce the one thing about a real integration
that actually shapes your code: **nothing is confirmed synchronously**.
`POST /payments/initiate` records an intent and returns a checkout URL. The
order becomes `PAID` only when the gateway calls back.

- **Webhooks are signature-authenticated**, not session-authenticated —
  HMAC-SHA256 over the raw request body, compared in constant time. `app.js`
  retains the raw bytes because re-serialising parsed JSON can reorder keys and
  invalidate the signature.
- **Handling is idempotent.** Gateways retry until they see a 2xx, so the same
  event arrives repeatedly. A `processedAt` stamp means a duplicate changes
  nothing and still returns 200 — anything else makes the gateway retry forever.
- **A late callback cannot rewrite history.** If the order has moved on (been
  cancelled, say), the payment is still recorded but the order stays put.

Swapping in Stripe means writing one adapter against
`PaymentProvider` and widening the `PAYMENT_PROVIDER` enum. No order logic
changes.

Fire a webhook by hand in development:

```bash
BODY='{"event":"payment.succeeded","data":{"providerRef":"mock_..."}}'
SIG=$(node -e "console.log(require('crypto').createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET).update(process.argv[1]).digest('hex'))" "$BODY")

curl -X POST http://localhost:5000/api/v1/payments/webhook \
  -H "Content-Type: application/json" -H "x-shopcore-signature: $SIG" -d "$BODY"
```

## Reviews and coupons

**Reviews** require a verified purchase: a review cannot exist without pointing
at the `DELIVERED` order that entitles it, and paid is not enough — you have to
have received the thing. One review per user per product is a unique index, not
a check-then-write that a concurrent request slips between. Product ratings are
recomputed by aggregation rather than adjusted incrementally, because
incremental drifts the moment anything unusual happens.

Moderation hides a review and drops it from the average without destroying it.
Editing stays with the author even for an admin — moderation hides, it does not
rewrite what somebody said.

**Coupons** validate through one side-effect-free function that both checkout
and the preview endpoint call, so they cannot disagree about what a code is
worth. Redemption is booked inside the checkout transaction with a conditional
`$inc`, so a coupon with a global limit cannot be over-redeemed by two
simultaneous checkouts; cancelling an order gives the redemption back.

## Deployment

CI (`.github/workflows/ci.yml`) runs on every push: lint, format check, tests on
Node 20 and 22, a production dependency audit, and a Docker job that builds the
image, runs it against real MongoDB and Redis containers, and smoke-tests it.

The smoke test (`scripts/smoke.js`) checks a **running** instance over HTTP, so
it can also be pointed at staging or production:

```bash
SMOKE_BASE_URL=https://shopcore.example npm run smoke
```

It exists because the Jest suite runs with `NODE_ENV=test`, and some failures
only appear outside it. One of its checks asserts the `RateLimit` header is
present — a limiter that has silently failed open still answers 200, so the
missing header is the only signal that it stopped working.

`render.yaml` deploys two services from one image — the API and the queue
worker — sharing secrets so they cannot drift apart. MongoDB and Redis are not
declared there on purpose: **checkout needs a replica set** for its
transactions, so point `MONGO_URI` at Atlas (a free M0 cluster is a replica set)
and `REDIS_URL` at Upstash.

Before going live, confirm:

- `CORS_ORIGINS` names your real origins. The app refuses to boot in production
  with a wildcard.
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `PAYMENT_WEBHOOK_SECRET` are
  generated, not copied from `.env.example`.
- TLS terminates at the proxy. `trust proxy` is on in production so the real
  client IP reaches the rate limiter and secure cookies are set.
- SMTP is configured. In production the mailer throws rather than silently
  discarding mail, which is deliberate — a missing configuration is a real
  misconfiguration, not something to paper over.

## Testing

```bash
npm test              # unit + integration
npm run test:coverage # with a coverage report
```

360 tests across 20 suites. Unit tests cover the pieces worth isolating: the
token service, the money arithmetic, the order state machine, the cache
helpers, and the payment provider's signing. Integration tests run the real
Express app against `mongodb-memory-server` — a single-node replica set, so
transactions genuinely execute — via supertest. The first run downloads the
MongoDB binary and takes a few minutes; after that the whole suite is about a
minute.

Some tests exist because the bug they describe is easy to write and hard to
notice:

- Two concurrent checkouts race for the last unit in stock; exactly one wins.
- A cart of thirty lines whose total must equal the sum of its own lines.
- A webhook signed for one payload and sent with another.
- A `GIF89a<?php ... ?>` upload declared as `image/png`, rejected at the decode
  step with nothing left on disk.
- A coupon with a global limit of one, redeemed twice.

Caching and queueing are switched off in tests (`CACHE_ENABLED=false`,
`QUEUE_ENABLED=false`) so nothing needs Redis, and the rate limits are raised
out of the way — the limiter is process-global state, so a suite exercising it
would throttle itself. It has two dedicated files that lower the limits before
importing the app instead.

## Notes and known gaps

- **`qs` is pinned by an npm override.** Express 4 depends on a version inside
  its own advisory range with no release that moves off it. Revisit on the next
  Express upgrade.
- **The mock payment provider is a mock.** It signs and verifies exactly as a
  real gateway does, but no money moves.
- **Invoices and uploads are written to local disk**, which does not survive a
  container restart on an ephemeral filesystem. S3 or Cloudinary is the
  production answer; the upload middleware is the seam.
- **Multi-vendor is single-vendor-shaped.** Orders record a seller per line and
  sellers only see their own, but there is no payout or commission logic.
