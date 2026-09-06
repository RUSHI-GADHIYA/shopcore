import crypto from 'node:crypto';

/**
 * URL-safe slug from arbitrary text: strips accents, punctuation and repeated
 * separators. Not guaranteed unique on its own — see `generateUniqueSlug`.
 */
export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Slugifies `value` and, if the slug is already taken, appends a short random
 * suffix until it is free. A random suffix beats an incrementing counter here
 * because it needs no extra query to discover the current highest number.
 *
 * @param {import('mongoose').Model} model  model to check uniqueness against
 * @param {string} value                    source text
 * @param {object} [options]
 * @param {string} [options.field]          slug field name, defaults to 'slug'
 * @param {string} [options.excludeId]      document to ignore (for updates)
 */
export async function generateUniqueSlug(model, value, { field = 'slug', excludeId } = {}) {
  const base = slugify(value) || crypto.randomBytes(4).toString('hex');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${crypto.randomBytes(3).toString('hex')}`;
    const conflict = await model
      .findOne({ [field]: candidate, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
      .select('_id')
      .lean();

    if (!conflict) return candidate;
  }

  // Extremely unlikely; fall back to something collision-proof rather than looping forever.
  return `${base}-${crypto.randomUUID()}`;
}

export default slugify;
