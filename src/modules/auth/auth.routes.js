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

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a customer or seller
 *     description: >
 *       Creates an account, signs it in, and emails a verification link.
 *       The `admin` role cannot be self-assigned — admins are provisioned by
 *       another admin or the seed script.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name: { type: string, minLength: 2, example: Ada Lovelace }
 *               email: { type: string, format: email, example: ada@example.com }
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 description: At least 8 characters with an upper, a lower and a digit.
 *                 example: Str0ngPassw0rd
 *               role: { type: string, enum: [customer, seller], default: customer }
 *     responses:
 *       201:
 *         description: Account created; the refresh token is set as an httpOnly cookie
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         user: { type: object }
 *                         accessToken: { type: string }
 *       409: { description: An account with that email already exists }
 *       422: { $ref: '#/components/responses/ValidationError' }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.post('/register', authLimiter, validate({ body: registerSchema }), authController.register);

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in
 *     description: >
 *       Returns a 15-minute access token and sets the rotating refresh cookie.
 *       An unknown email and a wrong password are answered identically, in both
 *       message and timing, so this endpoint cannot enumerate accounts.
 *       Repeated failures lock the account temporarily.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200: { description: Signed in }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: The account has been deactivated }
 *       423: { description: Locked after too many failed attempts }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);

/**
 * @openapi
 * /auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Request a password reset link
 *     description: >
 *       Always answers the same way whether or not the address is registered,
 *       so it cannot be used to discover which emails have accounts.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: A reset link has been sent if the account exists }
 *       429: { $ref: '#/components/responses/RateLimited' }
 */
router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  authController.forgotPassword
);

/**
 * @openapi
 * /auth/reset-password/{token}:
 *   post:
 *     tags: [Auth]
 *     summary: Set a new password from a reset link
 *     description: >
 *       Single-use. Succeeding invalidates every existing session, which is the
 *       point of a reset when the account may already be compromised.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string, pattern: '^[a-f0-9]{64}$' }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password: { type: string, minLength: 8 }
 *     responses:
 *       200: { description: Password updated }
 *       400: { description: The link is invalid or has expired }
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.post(
  '/reset-password/:token',
  authLimiter,
  validate({ params: tokenParamSchema, body: resetPasswordSchema }),
  authController.resetPassword
);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Rotate the refresh token and mint a new access token
 *     description: >
 *       The presented token is invalidated and replaced. Replaying an old one is
 *       treated as theft: the stored token is cleared, ending every session.
 *     security: [{ refreshCookie: [] }]
 *     responses:
 *       200: { description: A new access token, and a new refresh cookie }
 *       401: { description: The cookie is missing, expired, or already used }
 */
router.post('/refresh', authController.refresh);

/**
 * @openapi
 * /auth/verify-email/{token}:
 *   get:
 *     tags: [Auth]
 *     summary: Confirm an email address
 *     security: []
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string, pattern: '^[a-f0-9]{64}$' }
 *     responses:
 *       200: { description: Email verified }
 *       400: { description: The link is invalid or has expired }
 */
router.get(
  '/verify-email/:token',
  validate({ params: tokenParamSchema }),
  authController.verifyEmail
);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Sign out and invalidate the refresh token
 *     responses:
 *       200: { description: Signed out }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/logout', authenticate, authController.logout);

export default router;
