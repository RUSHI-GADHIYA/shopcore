import asyncHandler from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/ApiResponse.js';
import * as orderService from './order.service.js';

export const checkout = asyncHandler(async (req, res) => {
  const order = await orderService.checkout({ user: req.user, ...req.body });

  req.log?.info('Checkout completed', { orderId: order.id, total: order.total });
  return sendCreated(res, { data: { order }, message: 'Order placed' });
});

export const listOrders = asyncHandler(async (req, res) => {
  const { items, meta } = await orderService.listOrders({ actor: req.user, ...req.query });
  return sendSuccess(res, { data: { orders: items }, meta });
});

export const getOrder = asyncHandler(async (req, res) => {
  const order = await orderService.getOrder({ actor: req.user, orderId: req.params.id });
  return sendSuccess(res, { data: { order } });
});

export const cancelOrder = asyncHandler(async (req, res) => {
  const order = await orderService.cancelOrder({
    actor: req.user,
    orderId: req.params.id,
    reason: req.body.reason,
  });

  return sendSuccess(res, { data: { order }, message: 'Order cancelled' });
});

export const updateStatus = asyncHandler(async (req, res) => {
  const order = await orderService.updateStatus({
    actor: req.user,
    orderId: req.params.id,
    status: req.body.status,
    note: req.body.note,
  });

  return sendSuccess(res, { data: { order }, message: `Order is now ${order.status}` });
});
