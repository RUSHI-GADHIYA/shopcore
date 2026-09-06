import jwt from 'jsonwebtoken';
import {
  createOneTimeToken,
  hashToken,
  parseDuration,
  signAccessToken,
  signRefreshToken,
  timingSafeEqual,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../src/modules/auth/token.service.js';

const user = { _id: '507f1f77bcf86cd799439011', role: 'customer' };

describe('access tokens', () => {
  it('round-trips the subject and role', () => {
    const payload = verifyAccessToken(signAccessToken(user));

    expect(payload.sub).toBe(user._id);
    expect(payload.role).toBe('customer');
  });

  it('rejects a refresh token presented as an access token', () => {
    const { token } = signRefreshToken(user);

    expect(() => verifyAccessToken(token)).toThrow(jwt.JsonWebTokenError);
  });

  it('rejects a token signed with the wrong secret', () => {
    const forged = jwt.sign({ sub: user._id, type: 'access' }, 'a-different-secret-entirely');

    expect(() => verifyAccessToken(forged)).toThrow(jwt.JsonWebTokenError);
  });
});

describe('refresh tokens', () => {
  it('returns a hash that matches the embedded jti and nothing else', () => {
    const { token, tokenHash } = signRefreshToken(user);
    const payload = verifyRefreshToken(token);

    expect(tokenHash).toBe(hashToken(payload.jti));
    // The raw token must not be derivable from what is stored.
    expect(tokenHash).not.toContain(payload.jti);
  });

  it('issues a distinct token every time, so rotation always changes the hash', () => {
    const first = signRefreshToken(user);
    const second = signRefreshToken(user);

    expect(first.tokenHash).not.toBe(second.tokenHash);
  });
});

describe('one-time tokens', () => {
  it('stores only a hash and sets the expiry from the ttl', () => {
    const { token, tokenHash, expiresAt } = createOneTimeToken(60_000);

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).toBe(hashToken(token));
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('timingSafeEqual', () => {
  it('matches identical strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('abc', undefined)).toBe(false);
  });
});

describe('parseDuration', () => {
  it.each([
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
  ])('converts %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it('falls back to a numeric value', () => {
    expect(parseDuration('5000')).toBe(5000);
    expect(parseDuration('not-a-duration')).toBe(0);
  });
});
