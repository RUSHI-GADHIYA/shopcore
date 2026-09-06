/**
 * Jest runs the source as native ESM (see the `--experimental-vm-modules` flag
 * in the npm scripts), so there is no transform step and no Babel.
 */
export default {
  testEnvironment: 'node',
  // Env vars must exist before `config/env.js` is imported, which happens as
  // soon as any module under test is loaded.
  setupFiles: ['<rootDir>/tests/setup/env.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/server.js', '!src/docs/**'],
  coverageDirectory: 'coverage',
  // The in-memory Mongo binary can take a while to download on a cold run.
  testTimeout: 30_000,
  clearMocks: true,
  verbose: false,
};
