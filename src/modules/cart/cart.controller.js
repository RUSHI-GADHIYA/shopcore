import asyncHandler from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/ApiResponse.js';
import * as cartService from './cart.service.js';

export const getCart = asyncHandler(async (req, res) => {
  const cart = await cartService.getCartView(req.user._id);
  return sendSuccess(res, { data: { cart } });
});

export const addItem = asyncHandler(async (req, res) => {
  const cart = await cartService.addItem({ userId: req.user._id, ...req.body });
  return sendCreated(res, { data: { cart }, message: 'Item added to cart' });
});

export const updateItem = asyncHandler(async (req, res) => {
  const cart = await cartService.updateItemQuantity({
    userId: req.user._id,
    sku: req.params.sku,
    quantity: req.body.quantity,
  });

  return sendSuccess(res, { data: { cart }, message: 'Cart updated' });
});

export const removeItem = asyncHandler(async (req, res) => {
  const cart = await cartService.removeItem({ userId: req.user._id, sku: req.params.sku });
  return sendSuccess(res, { data: { cart }, message: 'Item removed from cart' });
});
