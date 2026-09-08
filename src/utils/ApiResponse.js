/**
 * The single success envelope every endpoint returns (spec §8):
 *   { success, data, message?, meta? }
 *
 * Keeping this in one place means a client can rely on the shape without
 * checking which controller produced it.
 */

/** Guards against pathological nesting; real payloads are only a few deep. */
const MAX_DEPTH = 6;

/**
 * Gives every object with an `_id` a matching string `id`.
 *
 * Listing endpoints use `.lean()` for speed, which skips the document layer and
 * with it the `id` virtual, while single-document endpoints go through
 * `toJSON()` and keep it. That left `GET /products` returning `_id` and
 * `GET /products/:slug` returning both — two shapes for one resource, with
 * every client left to handle the difference.
 *
 * Normalising here rather than with a Mongoose plugin is deliberate: a global
 * plugin only applies to schemas compiled after it is registered, so it depends
 * on import order and silently does nothing if a model is loaded first. Every
 * response passes through this function, so there is nothing to get wrong.
 */
function normaliseIds(value, depth = 0) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    for (const entry of value) normaliseIds(entry, depth + 1);
    return value;
  }

  // Only plain objects: ObjectIds, Dates and Buffers are values, not containers,
  // and walking into them would corrupt how they serialise.
  if (value.constructor !== undefined && value.constructor !== Object) return value;

  if (value._id !== undefined && value.id === undefined) value.id = String(value._id);
  for (const nested of Object.values(value)) normaliseIds(nested, depth + 1);

  return value;
}

export function sendSuccess(res, { statusCode = 200, data = null, message, meta } = {}) {
  const body = { success: true, data: normaliseIds(data) };
  if (message) body.message = message;
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

export function sendCreated(res, { data, message, meta } = {}) {
  return sendSuccess(res, { statusCode: 201, data, message, meta });
}

export function sendNoContent(res) {
  return res.status(204).send();
}

/** The mirrored error envelope. Only the error handler should call this. */
export function buildErrorBody({ code, message, details }) {
  const error = { code, message };
  if (details) error.details = details;
  return { success: false, error };
}

export default sendSuccess;
