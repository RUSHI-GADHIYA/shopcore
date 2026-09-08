import asyncHandler from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import * as adminService from './admin.service.js';

export const getDashboard = asyncHandler(async (req, res) => {
  const dashboard = await adminService.getDashboard(req.query);
  return sendSuccess(res, { data: { dashboard } });
});

export const getLowStockReport = asyncHandler(async (req, res) => {
  const { items, meta, threshold } = await adminService.getLowStockReport({
    actor: req.user,
    ...req.query,
  });

  return sendSuccess(res, { data: { items, threshold }, meta });
});

export const getSalesTrend = asyncHandler(async (req, res) => {
  const trend = await adminService.getSalesTrend(req.query);
  return sendSuccess(res, { data: { trend } });
});
