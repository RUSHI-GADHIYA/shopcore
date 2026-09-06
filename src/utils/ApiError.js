/**
 * An error the API knows how to present to a client.
 *
 * `isOperational` distinguishes expected failures (validation, 404, forbidden)
 * from genuine bugs. The error handler leaks details only for the former.
 */
export class ApiError extends Error {
  constructor(statusCode, message, { code, details = null, isOperational = true, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code ?? ApiError.defaultCodeFor(statusCode);
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace?.(this, ApiError);
  }

  static defaultCodeFor(statusCode) {
    return (
      {
        400: 'BAD_REQUEST',
        401: 'UNAUTHORIZED',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
        409: 'CONFLICT',
        422: 'VALIDATION_ERROR',
        429: 'RATE_LIMITED',
      }[statusCode] ?? 'INTERNAL_ERROR'
    );
  }

  static badRequest(message, options) {
    return new ApiError(400, message, options);
  }

  static unauthorized(message = 'Authentication required', options) {
    return new ApiError(401, message, options);
  }

  static forbidden(message = 'You do not have permission to perform this action', options) {
    return new ApiError(403, message, options);
  }

  static notFound(message = 'Resource not found', options) {
    return new ApiError(404, message, options);
  }

  static conflict(message, options) {
    return new ApiError(409, message, options);
  }

  static validation(message = 'Validation failed', details) {
    return new ApiError(422, message, { code: 'VALIDATION_ERROR', details });
  }

  static internal(message = 'Something went wrong', options) {
    return new ApiError(500, message, { isOperational: false, ...options });
  }
}

export default ApiError;
