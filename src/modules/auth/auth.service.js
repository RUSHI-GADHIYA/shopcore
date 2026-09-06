import bcrypt from 'bcrypt';
import { env } from '../../config/env.js';
import logger from '../../config/logger.js';
import ApiError from '../../utils/ApiError.js';
import { User } from '../users/user.model.js';
import {
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from '../notifications/notification.service.js';
import {
  createOneTimeToken,
  hashToken,
  signAccessToken,
  signRefreshToken,
  timingSafeEqual,
  verifyRefreshToken,
} from './token.service.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Authentication flows (spec §9).
 *
 * Two rules shape most of what follows: secrets are only ever persisted as
 * hashes, and responses to unauthenticated callers reveal nothing about which
 * accounts exist.
 */

export async function register({ name, email, password, role }) {
  const existing = await User.findOne({ email }).select('_id').lean();
  if (existing) throw ApiError.conflict('An account with that email already exists');

  const verification = createOneTimeToken(env.EMAIL_VERIFY_EXPIRY_HOURS * HOUR);

  const user = await User.create({
    name,
    email,
    password,
    role,
    emailVerifyTokenHash: verification.tokenHash,
    emailVerifyExpires: verification.expiresAt,
  });

  await sendVerificationEmail({ to: user.email, name: user.name, token: verification.token });

  // Registering signs you in; the account just cannot do verified-only things yet.
  const tokens = await issueTokens(user);
  return { user: user.toJSON(), ...tokens };
}

export async function login({ email, password }) {
  const user = await User.findOne({ email }).select('+password +failedLoginAttempts +lockUntil');

  // Identical error for "no such user" and "wrong password" so the endpoint
  // cannot be used to enumerate registered emails.
  const invalidCredentials = ApiError.unauthorized('Invalid email or password');

  if (!user) {
    // Still spend the time a bcrypt compare would take, so response timing does
    // not distinguish a missing account from a wrong password.
    await burnTiming();
    throw invalidCredentials;
  }

  if (user.isLocked) {
    const minutes = Math.ceil((user.lockUntil.getTime() - Date.now()) / MINUTE);
    throw new ApiError(423, `Account is locked. Try again in ${minutes} minute(s).`, {
      code: 'ACCOUNT_LOCKED',
    });
  }

  if (!user.isActive) throw ApiError.forbidden('Account has been deactivated');

  const matches = await user.comparePassword(password);

  if (!matches) {
    await registerFailedAttempt(user);
    throw invalidCredentials;
  }

  if (user.failedLoginAttempts > 0 || user.lockUntil) {
    await User.updateOne(
      { _id: user._id },
      { $set: { failedLoginAttempts: 0 }, $unset: { lockUntil: 1 } }
    );
  }

  const tokens = await issueTokens(user);
  return { user: user.toJSON(), ...tokens };
}

/**
 * Refresh-token rotation (spec §9). The presented token must match the single
 * hash on record; anything else — an old token, a forged one, one belonging to
 * another session — is treated as theft and clears the stored token, forcing a
 * fresh login.
 */
export async function refresh(presentedToken) {
  if (!presentedToken) throw ApiError.unauthorized('Refresh token is missing');

  const payload = verifyRefreshToken(presentedToken);

  const user = await User.findById(payload.sub).select('+refreshTokenHash');
  if (!user || !user.isActive) throw ApiError.unauthorized('Session is no longer valid');

  if (!user.refreshTokenHash || !timingSafeEqual(user.refreshTokenHash, hashToken(payload.jti))) {
    logger.warn('Refresh token reuse detected', { userId: String(user._id) });
    await User.updateOne({ _id: user._id }, { $set: { refreshTokenHash: null } });
    throw ApiError.unauthorized('Session is no longer valid');
  }

  const tokens = await issueTokens(user);
  return { user: user.toJSON(), ...tokens };
}

export async function logout(userId) {
  await User.updateOne({ _id: userId }, { $set: { refreshTokenHash: null } });
}

/**
 * Always resolves the same way whether or not the address is registered, so the
 * endpoint cannot be used to check which emails have accounts.
 */
export async function forgotPassword(email) {
  const user = await User.findOne({ email });
  if (!user || !user.isActive) return;

  const reset = createOneTimeToken(env.PASSWORD_RESET_EXPIRY_MINUTES * MINUTE);

  await User.updateOne(
    { _id: user._id },
    { $set: { passwordResetTokenHash: reset.tokenHash, passwordResetExpires: reset.expiresAt } }
  );

  await sendPasswordResetEmail({ to: user.email, name: user.name, token: reset.token });
}

export async function resetPassword({ token, password }) {
  const user = await User.findOne({
    passwordResetTokenHash: hashToken(token),
    passwordResetExpires: { $gt: new Date() },
  }).select('+password +passwordResetTokenHash +passwordResetExpires');

  if (!user) throw ApiError.badRequest('Password reset link is invalid or has expired');

  user.password = password;
  user.passwordResetTokenHash = null;
  user.passwordResetExpires = undefined;
  // Every existing session dies with the password change: that is the point of
  // a reset when the account may already be compromised.
  user.refreshTokenHash = null;
  user.failedLoginAttempts = 0;
  user.lockUntil = undefined;
  await user.save();

  await sendPasswordChangedEmail({ to: user.email, name: user.name });
}

export async function verifyEmail(token) {
  const user = await User.findOne({
    emailVerifyTokenHash: hashToken(token),
    emailVerifyExpires: { $gt: new Date() },
  }).select('+emailVerifyTokenHash +emailVerifyExpires');

  if (!user) throw ApiError.badRequest('Verification link is invalid or has expired');

  user.isEmailVerified = true;
  user.emailVerifyTokenHash = null;
  user.emailVerifyExpires = undefined;
  await user.save();

  return user.toJSON();
}

/** Issues an access/refresh pair and stores the new refresh hash, replacing any previous one. */
async function issueTokens(user) {
  const accessToken = signAccessToken(user);
  const { token: refreshToken, tokenHash } = signRefreshToken(user);

  await User.updateOne({ _id: user._id }, { $set: { refreshTokenHash: tokenHash } });

  return { accessToken, refreshToken };
}

/** Increments the failure counter and locks the account once the threshold is hit. */
async function registerFailedAttempt(user) {
  const attempts = (user.failedLoginAttempts ?? 0) + 1;

  const update = { $set: { failedLoginAttempts: attempts } };
  if (attempts >= env.MAX_FAILED_LOGIN_ATTEMPTS) {
    update.$set.lockUntil = new Date(Date.now() + env.ACCOUNT_LOCK_MINUTES * MINUTE);
    update.$set.failedLoginAttempts = 0;
    logger.warn('Account locked after repeated failed logins', { userId: String(user._id) });
  }

  await User.updateOne({ _id: user._id }, update);
}

/**
 * Matches the cost of a real bcrypt comparison for accounts that do not exist.
 * The decoy hash is built once, at the configured cost, so the work done here
 * tracks the work done on a real login.
 */
let decoyHash = null;

async function burnTiming() {
  decoyHash ??= await bcrypt.hash('timing-equalizer', env.BCRYPT_ROUNDS);
  await bcrypt.compare('not-the-password', decoyHash);
}
