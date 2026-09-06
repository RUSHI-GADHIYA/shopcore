import ApiError from '../utils/ApiError.js';

/**
 * Terminal 404 handler. Registered after every route so an unmatched request
 * produces the standard error envelope instead of Express's HTML page.
 */
export function notFound(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

export default notFound;
