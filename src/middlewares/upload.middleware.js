import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import { env } from '../config/env.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';

/**
 * Product image uploads (spec §11).
 *
 * Files are held in memory, never written where the client named them, and are
 * re-encoded through sharp before they touch disk. Re-encoding is the real
 * defence: a `.jpg` that is actually a polyglot script does not survive being
 * decoded and written back out as WebP.
 */
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const MAX_FILES = 5;
const MAX_DIMENSION = 1200;

const PRODUCTS_SUBDIR = 'products';

export const uploadProductImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_BYTES, files: MAX_FILES },
  fileFilter: (_req, file, callback) => {
    // A declared mime type is a hint, not proof; sharp rejects anything that
    // is not really an image when it decodes the buffer.
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return callback(ApiError.badRequest('Only JPEG, PNG, WebP and AVIF images are accepted'));
    }
    return callback(null, true);
  },
}).array('images', MAX_FILES);

/**
 * Resizes and re-encodes each uploaded buffer, writes it under a generated
 * name, and returns the public URLs.
 */
export async function processProductImages(files = []) {
  if (files.length === 0) throw ApiError.badRequest('No images were uploaded');

  const targetDir = path.resolve(env.UPLOAD_DIR, PRODUCTS_SUBDIR);
  await fs.mkdir(targetDir, { recursive: true });

  const written = [];

  try {
    for (const file of files) {
      // The name comes from us, never from the upload: a client-supplied name
      // is how path traversal and overwrite attacks get in.
      const filename = `${crypto.randomUUID()}.webp`;

      await sharp(file.buffer)
        .rotate() // Honour the EXIF orientation before it is stripped.
        .resize({
          width: MAX_DIMENSION,
          height: MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82 })
        .toFile(path.join(targetDir, filename));

      written.push(filename);
    }
  } catch (error) {
    // Partial success would leave orphaned files with no document referring to
    // them, so anything already written is rolled back.
    await Promise.all(written.map((filename) => removeProductImage(filename)));

    if (error instanceof ApiError) throw error;
    throw ApiError.badRequest('One or more files could not be processed as an image');
  }

  return written.map((filename) => publicUrlFor(filename));
}

/** Deletes a processed image from disk, tolerating one that is already gone. */
export async function removeProductImage(filename) {
  const target = path.resolve(env.UPLOAD_DIR, PRODUCTS_SUBDIR, filename);

  // Belt and braces: the route already validates the filename shape, but this
  // guarantees nothing outside the upload directory can ever be unlinked.
  const root = path.resolve(env.UPLOAD_DIR, PRODUCTS_SUBDIR);
  if (!target.startsWith(root + path.sep)) {
    throw ApiError.badRequest('Invalid image reference');
  }

  try {
    await fs.unlink(target);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Failed to delete product image', { filename, error: error.message });
    }
  }
}

export function publicUrlFor(filename) {
  return `${env.PUBLIC_BASE_URL}/uploads/${PRODUCTS_SUBDIR}/${filename}`;
}

export default uploadProductImages;
