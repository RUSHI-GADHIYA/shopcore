import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { env } from '../../config/env.js';

export const ROLES = Object.freeze({
  CUSTOMER: 'customer',
  SELLER: 'seller',
  ADMIN: 'admin',
});

export const ROLE_VALUES = Object.values(ROLES);

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, maxlength: 40, default: 'Home' },
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    line1: { type: String, required: true, trim: true, maxlength: 200 },
    line2: { type: String, trim: true, maxlength: 200 },
    city: { type: String, required: true, trim: true, maxlength: 100 },
    state: { type: String, required: true, trim: true, maxlength: 100 },
    postalCode: { type: String, required: true, trim: true, maxlength: 20 },
    country: { type: String, required: true, trim: true, maxlength: 100 },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true, timestamps: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // `select: false` keeps the hash out of every incidental query; the two places
    // that need it ask for it explicitly.
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLE_VALUES, default: ROLES.CUSTOMER, index: true },

    isEmailVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },

    addresses: { type: [addressSchema], default: [] },

    // Brute-force protection (spec §15). Counters reset on a successful login.
    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, select: false },

    // Refresh tokens are stored hashed and rotated on every use (spec §9), so a
    // leaked database dump cannot be replayed against the refresh endpoint.
    refreshTokenHash: { type: String, select: false, default: null },

    // Reset/verification tokens follow the same rule: only the hash is persisted.
    passwordResetTokenHash: { type: String, select: false, default: null },
    passwordResetExpires: { type: Date, select: false },
    emailVerifyTokenHash: { type: String, select: false, default: null },
    emailVerifyExpires: { type: Date, select: false },
    // Lets already-issued access tokens be rejected after a password change.
    passwordChangedAt: { type: Date, select: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.password;
        delete ret.refreshTokenHash;
        delete ret.passwordResetTokenHash;
        delete ret.emailVerifyTokenHash;
        delete ret.__v;
        return ret;
      },
    },
  }
);

userSchema.virtual('isLocked').get(function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
});

/** Hash on the way in, so no caller can ever persist a plaintext password. */
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();

  this.password = await bcrypt.hash(this.password, env.BCRYPT_ROUNDS);
  // Backdated by a second: the token issued moments later must not look older
  // than the change itself, which would invalidate it immediately.
  if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000);
  return next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

/** True if the password changed after the given JWT `iat` (seconds since epoch). */
userSchema.methods.passwordChangedAfter = function passwordChangedAfter(issuedAtSeconds) {
  if (!this.passwordChangedAt) return false;
  return Math.floor(this.passwordChangedAt.getTime() / 1000) > issuedAtSeconds;
};

export const User = mongoose.model('User', userSchema);

export default User;
