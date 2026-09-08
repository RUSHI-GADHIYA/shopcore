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
router.get(
  '/reports/low-stock',
  authorize(ROLES.ADMIN, ROLES.SELLER),
  validate({ query: lowStockSchema }),
  adminController.getLowStockReport
);

router.use(authorize(ROLES.ADMIN));

router.get('/dashboard', validate({ query: dashboardSchema }), adminController.getDashboard);
router.get(
  '/reports/sales-trend',
  validate({ query: salesTrendSchema }),
  adminController.getSalesTrend
);

export default router;
