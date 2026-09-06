/**
 * Offset pagination helpers shared by every list endpoint.
 *
 * `limit` is capped server-side so a client cannot ask for the entire
 * collection in one request.
 */
export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export function resolvePagination({ page, limit } = {}) {
  const parsedPage = Number.parseInt(page, 10);
  const parsedLimit = Number.parseInt(limit, 10);

  const safePage = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : DEFAULT_PAGE;
  const requestedLimit =
    Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT;
  const safeLimit = Math.min(requestedLimit, MAX_LIMIT);

  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
}

export function buildMeta({ page, limit, total }) {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

/**
 * Runs a find and its matching count against the same filter and returns the
 * page plus its meta block. Callers pass a live query so they keep control of
 * projection, population and lean().
 */
export async function paginate(
  model,
  { filter = {}, sort = { createdAt: -1 }, page, limit, select, populate, lean = true } = {}
) {
  const { page: safePage, limit: safeLimit, skip } = resolvePagination({ page, limit });

  let query = model.find(filter).sort(sort).skip(skip).limit(safeLimit);
  if (select) query = query.select(select);
  if (populate) query = query.populate(populate);
  if (lean) query = query.lean();

  const [items, total] = await Promise.all([query.exec(), model.countDocuments(filter)]);

  return { items, meta: buildMeta({ page: safePage, limit: safeLimit, total }) };
}

export default paginate;
