import { ZodError } from 'zod';
import ApiError from '../utils/ApiError.js';

/**
 * Generic zod request validator (spec §15: never trust `req.body`).
 *
 * Takes a map of the request parts to check and replaces each one with zod's
 * parsed output, so controllers receive coerced, defaulted, stripped values
 * rather than raw strings. Unknown keys are dropped by the schemas themselves.
 *
 *   router.post('/', validate({ body: createProductSchema }), controller.create)
 */
export function validate(schemas = {}) {
  const parts = Object.entries(schemas);

  return (req, _res, next) => {
    const details = [];

    for (const [part, schema] of parts) {
      const result = schema.safeParse(req[part]);

      if (result.success) {
        assignParsed(req, part, result.data);
        continue;
      }

      details.push(...formatIssues(result.error, part));
    }

    if (details.length) {
      return next(ApiError.validation('Request validation failed', details));
    }

    return next();
  };
}

/**
 * `req.query` and `req.params` are getter-only on some Express versions, so the
 * parsed object is merged in place rather than reassigned.
 */
function assignParsed(req, part, data) {
  if (part === 'body') {
    req.body = data;
    return;
  }

  const target = req[part];
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, data);
}

/** Flattens a ZodError into the `details` array of the error envelope (spec §8). */
export function formatIssues(error, part) {
  if (!(error instanceof ZodError)) return [];

  return error.issues.map((issue) => ({
    field: [part, ...issue.path].filter((segment) => segment !== 'body').join('.'),
    message: issue.message,
  }));
}

export default validate;
