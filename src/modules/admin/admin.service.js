import { env } from '../../config/env.js';
import { buildMeta, resolvePagination } from '../../utils/pagination.js';
import { ROLES } from '../users/user.model.js';
import { User } from '../users/user.model.js';
import { Product } from '../products/product.model.js';
import { Order } from '../orders/order.model.js';
import { Review } from '../reviews/review.model.js';
import { ORDER_STATUS } from '../orders/order.state-machine.js';

/**
 * Dashboard aggregations (spec §6.12).
 *
 * All of it is computed in MongoDB rather than by pulling documents into Node
 * and reducing them: revenue over a year of orders is a pipeline, not an array
 * the API process should ever hold in memory.
 *
 * "Revenue" deliberately counts only orders that were actually paid for and not
 * refunded — counting PENDING would report money nobody has sent.
 */
const REVENUE_STATUSES = [
  ORDER_STATUS.PAID,
  ORDER_STATUS.PROCESSING,
  ORDER_STATUS.SHIPPED,
  ORDER_STATUS.DELIVERED,
];

export async function getDashboard({ from, to } = {}) {
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  const dateFilter = Object.keys(range).length ? { createdAt: range } : {};

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [revenue, statusCounts, todayCount, topProducts, newCustomers, catalogue] =
    await Promise.all([
      revenueSummary(dateFilter),
      ordersByStatus(dateFilter),
      Order.countDocuments({ createdAt: { $gte: startOfToday } }),
      topSellingProducts(dateFilter),
      User.countDocuments({ role: ROLES.CUSTOMER, ...dateFilter }),
      catalogueSummary(),
    ]);

  return {
    revenue,
    orders: {
      today: todayCount,
      byStatus: statusCounts,
      total: Object.values(statusCounts).reduce((sum, count) => sum + count, 0),
    },
    topProducts,
    customers: { new: newCustomers },
    catalogue,
  };
}

async function revenueSummary(dateFilter) {
  const [summary] = await Order.aggregate([
    { $match: { status: { $in: REVENUE_STATUSES }, ...dateFilter } },
    {
      $group: {
        _id: null,
        gross: { $sum: '$total' },
        discounts: { $sum: '$discount' },
        tax: { $sum: '$tax' },
        shipping: { $sum: '$shippingFee' },
        orders: { $sum: 1 },
      },
    },
  ]);

  if (!summary) {
    return { gross: 0, discounts: 0, tax: 0, shipping: 0, orders: 0, averageOrderValue: 0 };
  }

  const round = (value) => Math.round(value * 100) / 100;

  return {
    gross: round(summary.gross),
    discounts: round(summary.discounts),
    tax: round(summary.tax),
    shipping: round(summary.shipping),
    orders: summary.orders,
    averageOrderValue: round(summary.gross / summary.orders),
  };
}

async function ordersByStatus(dateFilter) {
  const rows = await Order.aggregate([
    { $match: dateFilter },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  // Every status is present even at zero, so a client can render a stable set
  // of tiles rather than a shifting one.
  const counts = Object.fromEntries(Object.values(ORDER_STATUS).map((status) => [status, 0]));
  for (const row of rows) counts[row._id] = row.count;

  return counts;
}

/**
 * Ranked by revenue rather than units: ten cheap keychains are not a better
 * seller than one laptop, and the dashboard exists to inform buying decisions.
 */
async function topSellingProducts(dateFilter, limit = 5) {
  return Order.aggregate([
    { $match: { status: { $in: REVENUE_STATUSES }, ...dateFilter } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.product',
        name: { $first: '$items.name' },
        unitsSold: { $sum: '$items.quantity' },
        revenue: { $sum: '$items.lineTotal' },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        productId: '$_id',
        name: 1,
        unitsSold: 1,
        revenue: { $round: ['$revenue', 2] },
      },
    },
  ]);
}

async function catalogueSummary() {
  const [products, activeProducts, reviews] = await Promise.all([
    Product.countDocuments(),
    Product.countDocuments({ isActive: true }),
    Review.countDocuments({ isFlagged: false }),
  ]);

  return { products, activeProducts, reviews };
}

/**
 * Low-stock report (spec §6.12). A seller sees only their own products; an
 * admin sees the whole catalogue.
 */
export async function getLowStockReport({ actor, page, limit, threshold }) {
  const cutoff = threshold ?? env.LOW_STOCK_THRESHOLD;
  const { page: safePage, limit: safeLimit, skip } = resolvePagination({ page, limit });

  const match = { isActive: true, 'variants.stock': { $lte: cutoff } };
  if (actor.role === ROLES.SELLER) match.seller = actor._id;

  const pipeline = [
    { $match: match },
    { $unwind: '$variants' },
    // Re-filtered after the unwind: the first match selects products having at
    // least one low variant, this keeps only the low variants themselves.
    { $match: { 'variants.stock': { $lte: cutoff } } },
    { $sort: { 'variants.stock': 1 } },
    {
      $project: {
        _id: 0,
        productId: '$_id',
        name: 1,
        slug: 1,
        seller: 1,
        sku: '$variants.sku',
        stock: '$variants.stock',
        price: '$variants.price',
      },
    },
  ];

  const [items, counted] = await Promise.all([
    Product.aggregate([...pipeline, { $skip: skip }, { $limit: safeLimit }]),
    Product.aggregate([...pipeline, { $count: 'total' }]),
  ]);

  const total = counted[0]?.total ?? 0;

  return { items, meta: buildMeta({ page: safePage, limit: safeLimit, total }), threshold: cutoff };
}

/** Revenue per day, for charting a trend (spec §6.12). */
export async function getSalesTrend({ days = 30 } = {}) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  return Order.aggregate([
    { $match: { status: { $in: REVENUE_STATUSES }, createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        revenue: { $sum: '$total' },
        orders: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, date: '$_id', revenue: { $round: ['$revenue', 2] }, orders: 1 } },
  ]);
}
