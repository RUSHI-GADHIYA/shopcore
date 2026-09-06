import asyncHandler from '../../utils/asyncHandler.js';
import { sendSuccess, sendCreated } from '../../utils/ApiResponse.js';
import * as authService from './auth.service.js';
import { REFRESH_COOKIE_NAME, clearRefreshCookie, setRefreshCookie } from './token.service.js';

/**
 * HTTP adapters for the auth service. Controllers stay thin: read the request,
 * call the service, shape the response. The refresh token never appears in a
 * response body — it goes out only as an httpOnly cookie (spec §9).
 */

export const register = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken } = await authService.register(req.body);

  setRefreshCookie(res, refreshToken);
  return sendCreated(res, {
    data: { user, accessToken },
    message: 'Account created. Check your email to verify your address.',
  });
});

export const login = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken } = await authService.login(req.body);

  setRefreshCookie(res, refreshToken);
  return sendSuccess(res, { data: { user, accessToken }, message: 'Signed in' });
});

export const refresh = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken } = await authService.refresh(
    req.cookies?.[REFRESH_COOKIE_NAME]
  );

  setRefreshCookie(res, refreshToken);
  return sendSuccess(res, { data: { user, accessToken } });
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.user._id);

  clearRefreshCookie(res);
  return sendSuccess(res, { message: 'Signed out' });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  await authService.forgotPassword(req.body.email);

  // Same response whether or not the address is registered.
  return sendSuccess(res, {
    message: 'If an account exists for that address, a reset link has been sent.',
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword({ token: req.params.token, password: req.body.password });

  clearRefreshCookie(res);
  return sendSuccess(res, { message: 'Password updated. Please sign in again.' });
});

export const verifyEmail = asyncHandler(async (req, res) => {
  const user = await authService.verifyEmail(req.params.token);

  return sendSuccess(res, { data: { user }, message: 'Email verified' });
});
