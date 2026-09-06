import ApiError from '../utils/ApiError.js';
import { ROLES } from '../modules/users/user.model.js';

/**
 * Declarative role check (spec §9): `authorize(ROLES.ADMIN, ROLES.SELLER)`.
 *
 * Roles answer "may this kind of user call this endpoint at all". They do not
 * answer "is this *their* resource" — ownership is checked in the service layer,
 * where the document is actually in hand.
 */
export function authorize(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized('Authentication required'));

    if (!allowedRoles.includes(req.user.role)) {
      return next(ApiError.forbidden('You do not have permission to perform this action'));
    }

    return next();
  };
}

/** Admins bypass ownership checks; everyone else must own the resource. */
export function isOwnerOrAdmin(user, ownerId) {
  if (!user) return false;
  if (user.role === ROLES.ADMIN) return true;
  return String(ownerId) === String(user._id);
}

export default authorize;
