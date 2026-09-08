import { Router } from 'express';
import authenticate from '../../middlewares/auth.middleware.js';
import authorize from '../../middlewares/rbac.middleware.js';
import validate from '../../middlewares/validate.middleware.js';
import { ROLES } from '../users/user.model.js';
import * as adminController from './admin.controller.js';
import { dashboardSchema, lowStockSchema, salesTrendSchema } from './admin.validation.js';

const router = Router();

router.use(authenticate);

// The low-stock report is the one thing here a seller may also see — scoped in
// the service to their own products (spec §8).
/**
 * @openapi
 * /admin/reports/low-stock:
 *   get:
 *     tags: [Admin]
 *     summary: Variants at or below the stock threshold
 *     description: >
 *       An admin sees the whole catalogue; a seller sees only their own products.
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *       - { in: query, name: threshold, schema: { type: integer }, description: Defaults to LOW_STOCK_THRESHOLD }
 *     responses:
 *       200: { description: Low-stock variants, scarcest first }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get(
  '/reports/low-stock',
  authorize(ROLES.ADMIN, ROLES.SELLER),
  validate({ query: lowStockSchema }),
  adminController.getLowStockReport
);

router.use(authorize(ROLES.ADMIN));

/**
 * @openapi
 * /admin/dashboard:
 *   get:
 *     tags: [Admin]
 *     summary: Revenue, order counts, and top products (admin)
 *     description: >
 *       Revenue counts only orders actually paid for and not refunded; counting
 *       PENDING would report money nobody has sent. Top products rank by revenue
 *       rather than units.
 *     parameters:
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to, schema: { type: string, format: date } }
 *     responses:
 *       200: { description: The dashboard }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.get('/dashboard', validate({ query: dashboardSchema }), adminController.getDashboard);
/**
 * @openapi
 * /admin/reports/sales-trend:
 *   get:
 *     tags: [Admin]
 *     summary: Revenue per day (admin)
 *     parameters:
 *       - { in: query, name: days, schema: { type: integer, minimum: 1, maximum: 365, default: 30 } }
 *     responses:
 *       200: { description: One row per day that had orders }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get(
  '/reports/sales-trend',
  validate({ query: salesTrendSchema }),
  adminController.getSalesTrend
);

export default router;
