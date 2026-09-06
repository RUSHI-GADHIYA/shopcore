import { Router } from 'express';
import validate from '../../middlewares/validate.middleware.js';
import authenticate from '../../middlewares/auth.middleware.js';
import { authLimiter } from '../../middlewares/rateLimiter.middleware.js';
import * as authController from './auth.controller.js';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  tokenParamSchema,
} from './auth.validation.js';

const router = Router();

// The credential-guessing surface (spec §9): stricter limits than the global one.
router.post('/register', authLimiter, validate({ body: registerSchema }), authController.register);
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);
router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  authController.forgotPassword
);
router.post(
  '/reset-password/:token',
  authLimiter,
  validate({ params: tokenParamSchema, body: resetPasswordSchema }),
  authController.resetPassword
);

router.post('/refresh', authController.refresh);
router.get(
  '/verify-email/:token',
  validate({ params: tokenParamSchema }),
  authController.verifyEmail
);
router.post('/logout', authenticate, authController.logout);

export default router;
