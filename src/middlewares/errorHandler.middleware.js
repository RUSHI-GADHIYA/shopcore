import mongoose from 'mongoose';
import { ZodError } from 'zod';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import ApiError from '../utils/ApiError.js';
import { buildErrorBody } from '../utils/ApiResponse.js';
import { isProduction } from '../config/env.js';
import logger from '../config/logger.js';
import { formatIssues } from './validate.middleware.js';

/**
 * The single place any error becomes an HTTP response (spec §16).
 *
 * Errors arrive from three sources: `ApiError` thrown deliberately by services,
 * library errors (Mongoose, zod, jwt, multer) that map cleanly onto a status
 * code, and genuine bugs. Only the first two are safe to describe to a client;
 * the third gets a generic message in production so internals never leak.
 */
// Express identifies error handlers by their four-parameter arity, so `_next`
// must stay in the signature even though it is never called.
export function errorHandler(error, req, res, _next) {
  const apiError = toApiError(error);
  const log = req.log ?? logger;

  const context = {
    method: req.method,
    path: req.originalUrl,
    statusCode: apiError.statusCode,
    code: apiError.code,
    userId: req.user?.id,
  };

  if (apiError.statusCode >= 500) {
    // Non-operational: log the original error so the stack points at the real bug.
    log.error(apiError.message, { ...context, stack: error.stack });
  } else {
    log.warn(apiError.message, context);
  }

  const body = buildErrorBody({
    code: apiError.code,
    message: apiError.statusCode >= 500 && isProduction ? 'Something went wrong' : apiError.message,
    details: apiError.details,
  });

  if (!isProduction && apiError.statusCode >= 500) {
    body.error.stack = error.stack;
  }

  return res.status(apiError.statusCode).json(body);
}

/** Normalises anything throwable into an ApiError. */
function toApiError(error) {
  if (error instanceof ApiError) return error;

  if (error instanceof ZodError) {
    return ApiError.validation('Request validation failed', formatIssues(error, 'body'));
  }

  if (error instanceof mongoose.Error.ValidationError) {
    const details = Object.values(error.errors).map((fieldError) => ({
      field: fieldError.path,
      message: fieldError.message,
    }));
    return ApiError.validation('Document validation failed', details);
  }

  // A malformed ObjectId in a path param is a client mistake, not a server fault.
  if (error instanceof mongoose.Error.CastError) {
    return ApiError.badRequest(`Invalid value for '${error.path}'`);
  }

  if (error?.code === 11000) {
    const field = Object.keys(error.keyPattern ?? {})[0] ?? 'value';
    return ApiError.conflict(`A record with that ${field} already exists`);
  }

  if (error instanceof jwt.TokenExpiredError) {
    return ApiError.unauthorized('Token has expired', { code: 'TOKEN_EXPIRED' });
  }

  if (error instanceof jwt.JsonWebTokenError) {
    return ApiError.unauthorized('Invalid token', { code: 'INVALID_TOKEN' });
  }

  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE' ? 'Uploaded file is too large' : 'File upload failed';
    return ApiError.badRequest(message, { code: error.code });
  }

  // Express's body parser rejects malformed JSON with a SyntaxError carrying a status.
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return ApiError.badRequest('Request body is not valid JSON');
  }

  return ApiError.internal(error?.message ?? 'Something went wrong', { cause: error });
}

export default errorHandler;
