import ApiError from '../../utils/ApiError.js';
import { paginate } from '../../utils/pagination.js';
import { User, ROLES } from './user.model.js';

/**
 * Profile and address management, plus the admin user directory (spec §6.2).
 */

export async function getById(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

export async function updateProfile(userId, updates) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found');

  if (updates.email && updates.email !== user.email) {
    const taken = await User.findOne({ email: updates.email }).select('_id').lean();
    if (taken) throw ApiError.conflict('An account with that email already exists');

    // A new address is unproven until it is confirmed, so verification resets.
    user.email = updates.email;
    user.isEmailVerified = false;
  }

  if (updates.name) user.name = updates.name;

  await user.save();
  return user.toJSON();
}

export async function addAddress(userId, address) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found');

  // The first address a user saves is their default whether they asked or not.
  const shouldBeDefault = address.isDefault || user.addresses.length === 0;
  if (shouldBeDefault) {
    user.addresses.forEach((existing) => {
      existing.isDefault = false;
    });
  }

  user.addresses.push({ ...address, isDefault: shouldBeDefault });
  await user.save();

  return user.toJSON().addresses;
}

export async function removeAddress(userId, addressId) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found');

  const address = user.addresses.id(addressId);
  if (!address) throw ApiError.notFound('Address not found');

  const wasDefault = address.isDefault;
  address.deleteOne();

  // Never leave the user without a default while they still have addresses.
  if (wasDefault && user.addresses.length > 0) user.addresses[0].isDefault = true;

  await user.save();
  return user.toJSON().addresses;
}

export async function listUsers({ page, limit, search, role, isActive, sort }) {
  const filter = {};

  if (role) filter.role = role;
  if (typeof isActive === 'boolean') filter.isActive = isActive;
  if (search) {
    // Escaped so a user-supplied `.` or `(` cannot become a regex operator, and
    // anchored to the start so the query can still use the email index.
    const pattern = new RegExp(`^${escapeRegex(search)}`, 'i');
    filter.$or = [{ name: pattern }, { email: pattern }];
  }

  const direction = sort.startsWith('-') ? -1 : 1;
  const sortField = sort.replace(/^-/, '');

  return paginate(User, { filter, sort: { [sortField]: direction }, page, limit });
}

/**
 * Ban / unban. Deactivating also drops the refresh token, so the account cannot
 * mint a new access token once the current one expires.
 */
export async function setActiveStatus({ actor, userId, isActive }) {
  if (String(actor._id) === String(userId)) {
    throw ApiError.badRequest('You cannot change your own account status');
  }

  const target = await User.findById(userId);
  if (!target) throw ApiError.notFound('User not found');

  if (target.role === ROLES.ADMIN) {
    throw ApiError.forbidden('Admin accounts cannot be deactivated through this endpoint');
  }

  target.isActive = isActive;
  if (!isActive) target.refreshTokenHash = null;
  await target.save();

  return target.toJSON();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
