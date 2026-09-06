import asyncHandler from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/ApiResponse.js';
import * as categoryService from './category.service.js';

export const listCategories = asyncHandler(async (req, res) => {
  const categories = await categoryService.listCategories(req.query);
  return sendSuccess(res, { data: { categories } });
});

export const getCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.getBySlug(req.params.slug);
  return sendSuccess(res, { data: { category } });
});

export const createCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.createCategory(req.body);
  return sendCreated(res, { data: { category }, message: 'Category created' });
});

export const updateCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.updateCategory(req.params.id, req.body);
  return sendSuccess(res, { data: { category }, message: 'Category updated' });
});

export const deleteCategory = asyncHandler(async (req, res) => {
  await categoryService.deleteCategory(req.params.id);
  return sendSuccess(res, { message: 'Category deleted' });
});
