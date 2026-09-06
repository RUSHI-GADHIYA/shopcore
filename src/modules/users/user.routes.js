import { Router } from 'express';
import authenticate from '../../middlewares/auth.middleware.js';
import authorize from '../../middlewares/rbac.middleware.js';
import validate from '../../middlewares/validate.middleware.js';
import { ROLES } from './user.model.js';
import * as userController from './user.controller.js';
import {
  addressIdParamSchema,
  addressSchema,
  idParamSchema,
  listUsersSchema,
  updateMeSchema,
  updateStatusSchema,
} from './user.validation.js';

const router = Router();

// Every route below requires a signed-in user.
router.use(authenticate);

router.get('/me', userController.getMe);
router.patch('/me', validate({ body: updateMeSchema }), userController.updateMe);

router.post('/me/addresses', validate({ body: addressSchema }), userController.addAddress);
router.delete(
  '/me/addresses/:addressId',
  validate({ params: addressIdParamSchema }),
  userController.removeAddress
);

router.get(
  '/',
  authorize(ROLES.ADMIN),
  validate({ query: listUsersSchema }),
  userController.listUsers
);
router.patch(
  '/:id/status',
  authorize(ROLES.ADMIN),
  validate({ params: idParamSchema, body: updateStatusSchema }),
  userController.updateStatus
);

export default router;
