/**
 * The single success envelope every endpoint returns (spec §8):
 *   { success, data, message?, meta? }
 *
 * Keeping this in one place means a client can rely on the shape without
 * checking which controller produced it.
 */
export function sendSuccess(res, { statusCode = 200, data = null, message, meta } = {}) {
  const body = { success: true, data };
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
