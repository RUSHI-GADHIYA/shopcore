import asyncHandler from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess } from '../../utils/ApiResponse.js';
import { processProductImages, removeProductImage } from '../../middlewares/upload.middleware.js';
import * as productService from './product.service.js';

export const listProducts = asyncHandler(async (req, res) => {
  const { items, meta } = await productService.listProducts(req.query);
  return sendSuccess(res, { data: { products: items }, meta });
});

export const getProduct = asyncHandler(async (req, res) => {
  const product = await productService.getBySlug(req.params.slug);
  return sendSuccess(res, { data: { product } });
});

export const createProduct = asyncHandler(async (req, res) => {
  const product = await productService.createProduct({ ...req.body, seller: req.user });
  return sendCreated(res, { data: { product }, message: 'Product created' });
});

export const updateProduct = asyncHandler(async (req, res) => {
  const product = await productService.updateProduct({
    actor: req.user,
    productId: req.params.id,
    updates: req.body,
  });

  return sendSuccess(res, { data: { product }, message: 'Product updated' });
});

export const deleteProduct = asyncHandler(async (req, res) => {
  await productService.deleteProduct({ actor: req.user, productId: req.params.id });
  return sendSuccess(res, { message: 'Product removed from the catalogue' });
});

export const uploadImages = asyncHandler(async (req, res) => {
  // Ownership is re-checked inside the service, so a failed check here would
  // leave freshly written files with nothing pointing at them. Processing
  // first and attaching second keeps that window as small as possible.
  const urls = await processProductImages(req.files);

  try {
    const product = await productService.addImages({
      actor: req.user,
      productId: req.params.id,
      urls,
    });

    return sendCreated(res, { data: { product }, message: 'Images uploaded' });
  } catch (error) {
    await Promise.all(urls.map((url) => removeProductImage(url.split('/').pop())));
    throw error;
  }
});

export const deleteImage = asyncHandler(async (req, res) => {
  const product = await productService.removeImage({
    actor: req.user,
    productId: req.params.id,
    filename: req.params.filename,
  });

  // Only unlink once the document no longer refers to the file, so a failure
  // here leaves an orphan rather than a broken image on a live product.
  await removeProductImage(req.params.filename);

  return sendSuccess(res, { data: { product }, message: 'Image removed' });
});
