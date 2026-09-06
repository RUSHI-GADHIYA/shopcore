/**
 * Wraps an async controller so a rejected promise reaches Express's error
 * handler instead of becoming an unhandled rejection. Express 4 does not await
 * handlers, so without this every controller needs its own try/catch.
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export default asyncHandler;
