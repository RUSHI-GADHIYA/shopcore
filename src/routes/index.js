import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import userRoutes from '../modules/users/user.routes.js';

/**
 * The versioned API surface. Every module contributes one router here, which
 * keeps `app.js` free of route detail and makes a future `/api/v2` a matter of
 * mounting a second index.
 */
const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);

export default router;
