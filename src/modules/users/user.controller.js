import asyncHandler from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/ApiResponse.js';
import * as userService from './user.service.js';

export const getMe = asyncHandler(async (req, res) =>
  sendSuccess(res, { data: { user: req.user.toJSON() } })
);

export const updateMe = asyncHandler(async (req, res) => {
  const user = await userService.updateProfile(req.user._id, req.body);
  return sendSuccess(res, { data: { user }, message: 'Profile updated' });
});

export const addAddress = asyncHandler(async (req, res) => {
  const addresses = await userService.addAddress(req.user._id, req.body);
  return sendCreated(res, { data: { addresses }, message: 'Address added' });
});

export const removeAddress = asyncHandler(async (req, res) => {
  const addresses = await userService.removeAddress(req.user._id, req.params.addressId);
  return sendSuccess(res, { data: { addresses }, message: 'Address removed' });
});

export const listUsers = asyncHandler(async (req, res) => {
  const { items, meta } = await userService.listUsers(req.query);
  return sendSuccess(res, { data: { users: items }, meta });
});

export const updateStatus = asyncHandler(async (req, res) => {
  const user = await userService.setActiveStatus({
    actor: req.user,
    userId: req.params.id,
    isActive: req.body.isActive,
  });

  req.log?.info('User status changed', {
    targetUserId: String(user.id ?? user._id),
    isActive: req.body.isActive,
    reason: req.body.reason,
  });

  return sendSuccess(res, {
    data: { user },
    message: req.body.isActive ? 'Account reactivated' : 'Account deactivated',
  });
});
