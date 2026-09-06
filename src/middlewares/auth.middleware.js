import ApiError from '../utils/ApiError.js';
import { User } from '../modules/users/user.model.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';

/**
 * Verifies the bearer access token and loads the user onto `req.user`.
 *
 * The database lookup on every request is deliberate: a JWT cannot be revoked,
 * so without it a banned or deleted user would keep working for the remainder
 * of the token's 15-minute life.
 */
export async function authenticate(req, _res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) throw ApiError.unauthorized('Authentication required');

    const payload = verifyAccessToken(token);

    const user = await User.findById(payload.sub).select('+passwordChangedAt');
    if (!user) throw ApiError.unauthorized('Account no longer exists');
    if (!user.isActive) throw ApiError.forbidden('Account has been deactivated');
    if (user.passwordChangedAfter(payload.iat)) {
      throw ApiError.unauthorized('Password was changed, please sign in again');
    }

    req.user = user;
    req.token = token;
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Populates `req.user` when a valid token is present but never rejects.
 * Used by public endpoints that personalise their response for signed-in users.
 */
export async function optionalAuthenticate(req, _res, next) {
  if (!extractBearerToken(req)) return next();

  return authenticate(req, _res, (error) => next(error && !isAuthError(error) ? error : undefined));
}

function isAuthError(error) {
  return error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403);
}

function extractBearerToken(req) {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const token = header.slice(7).trim();
  return token || null;
}

export default authenticate;
