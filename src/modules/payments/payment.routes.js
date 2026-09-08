import { Router } from 'express';
import authenticate from '../../middlewares/auth.middleware.js';
import validate from '../../middlewares/validate.middleware.js';
import * as paymentController from './payment.controller.js';
import { initiatePaymentSchema, orderIdParamSchema, webhookSchema } from './payment.validation.js';

const router = Router();

// Public, but not unauthenticated: the signature check in the service is what
// authenticates it. Mounted before the auth middleware because a gateway has no
// bearer token.
router.post('/webhook', validate({ body: webhookSchema }), paymentController.webhook);

router.use(authenticate);

router.post(
  '/initiate',
  validate({ body: initiatePaymentSchema }),
  paymentController.initiatePayment
);
router.get('/:orderId', validate({ params: orderIdParamSchema }), paymentController.getPayment);

export default router;
