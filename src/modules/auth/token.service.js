import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env, isProduction } from '../../config/env.js';

export const REFRESH_COOKIE_NAME = 'refreshToken';

/**
 * Token issuing, verification and rotation (spec §9).
 *
 * Access tokens are short-lived JWTs carried in the Authorization header.
 * Refresh tokens are opaque random strings: they are stored only as a SHA-256
 * hash on the user document, so the database never holds a usable credential,
 * and each use rotates them.
 */
export function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, type: 'access' },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRY }
  );
}

export function verifyAccessToken(token) {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
  if (payload.type !== 'access') throw new jwt.JsonWebTokenError('Wrong token type');
  return payload;
}

/**
 * The refresh token is a JWT *and* an opaque secret: the JWT half gives it an
 * expiry and a subject the server can read without a database round trip, while
 * the `jti` is what gets hashed and compared, so an old token fails even if its
 * signature is still valid.
 */
export function signRefreshToken(user) {
  const tokenId = crypto.randomBytes(32).toString('hex');

  const token = jwt.sign(
    { sub: String(user._id), jti: tokenId, type: 'refresh' },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRY }
  );

  return { token, tokenHash: hashToken(tokenId) };
}

export function verifyRefreshToken(token) {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET);
  if (payload.type !== 'refresh') throw new jwt.JsonWebTokenError('Wrong token type');
  return payload;
}

/**
 * SHA-256 rather than bcrypt: these values are already 256 bits of entropy, so
 * there is nothing to brute-force and the comparison stays cheap enough to run
 * on every refresh.
 */
export function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** A single-use token for email verification / password reset. */
export function createOneTimeToken(ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) };
}

/** Constant-time comparison so a hash cannot be recovered by timing the check. */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict',
  path: '/',
};

export function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: parseDuration(env.JWT_REFRESH_EXPIRY),
  });
}

export function clearRefreshCookie(res) {
  // Options must match the ones used to set it or the browser keeps the cookie.
  res.clearCookie(REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS);
}

/** Converts the `7d` / `15m` form jsonwebtoken accepts into milliseconds. */
export function parseDuration(value) {
  const match = /^(\d+)([smhd])$/.exec(String(value).trim());
  if (!match) return Number(value) || 0;

  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * multipliers[match[2]];
}
