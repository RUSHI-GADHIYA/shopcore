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

/**
 * @openapi
 * /users/me:
 *   get:
 *     tags: [Users]
 *     summary: The signed-in user's profile
 *     responses:
 *       200: { description: The current profile }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   patch:
 *     tags: [Users]
 *     summary: Update name or email
 *     description: >
 *       Role, active status and verification cannot be changed here; privilege
 *       changes go through the admin routes. Changing the email resets
 *       verification, since a new address is unproven until confirmed.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, minLength: 2 }
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: Profile updated }
 *       409: { description: That email is already taken }
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.get('/me', userController.getMe);
router.patch('/me', validate({ body: updateMeSchema }), userController.updateMe);

/**
 * @openapi
 * /users/me/addresses:
 *   post:
 *     tags: [Users]
 *     summary: Add a shipping address
 *     description: The first address saved becomes the default automatically.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fullName, phone, line1, city, state, postalCode, country]
 *             properties:
 *               label: { type: string, default: Home }
 *               fullName: { type: string }
 *               phone: { type: string }
 *               line1: { type: string }
 *               line2: { type: string }
 *               city: { type: string }
 *               state: { type: string }
 *               postalCode: { type: string }
 *               country: { type: string }
 *               isDefault: { type: boolean, default: false }
 *     responses:
 *       201: { description: The updated address book }
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.post('/me/addresses', validate({ body: addressSchema }), userController.addAddress);
/**
 * @openapi
 * /users/me/addresses/{addressId}:
 *   delete:
 *     tags: [Users]
 *     summary: Remove an address
 *     description: >
 *       Removing the default promotes another address, so a user with addresses
 *       always has one selected.
 *     parameters:
 *       - in: path
 *         name: addressId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: The updated address book }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete(
  '/me/addresses/:addressId',
  validate({ params: addressIdParamSchema }),
  userController.removeAddress
);

/**
 * @openapi
 * /users:
 *   get:
 *     tags: [Users]
 *     summary: Search and page the user directory (admin)
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, minimum: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, maximum: 100 } }
 *       - { in: query, name: search, schema: { type: string }, description: Prefix match on name or email }
 *       - { in: query, name: role, schema: { type: string, enum: [customer, seller, admin] } }
 *       - { in: query, name: isActive, schema: { type: string, enum: ['true', 'false'] } }
 *       - { in: query, name: sort, schema: { type: string, enum: [createdAt, -createdAt, name, -name] } }
 *     responses:
 *       200: { description: A page of users }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get(
  '/',
  authorize(ROLES.ADMIN),
  validate({ query: listUsersSchema }),
  userController.listUsers
);
/**
 * @openapi
 * /users/{id}/status:
 *   patch:
 *     tags: [Users]
 *     summary: Ban or reinstate an account (admin)
 *     description: >
 *       Deactivating also clears the refresh token, so the account cannot mint a
 *       new access token once the current one expires. An admin cannot change
 *       their own status, and other admins cannot be deactivated here.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [isActive]
 *             properties:
 *               isActive: { type: boolean }
 *               reason: { type: string, maxLength: 280 }
 *     responses:
 *       200: { description: Status changed }
 *       400: { description: You cannot change your own status }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.patch(
  '/:id/status',
  authorize(ROLES.ADMIN),
  validate({ params: idParamSchema, body: updateStatusSchema }),
  userController.updateStatus
);

export default router;
