import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { connectTestDatabase, clearTestDatabase, disconnectTestDatabase } from '../setup/db.js';
import { signUp, signUpAdmin } from '../setup/auth.js';
import { sellerPayload } from '../fixtures/users.js';
import { laptopPayload } from '../fixtures/catalog.js';

const app = createApp();
const api = '/api/v1/products';
const uploadDir = path.resolve(env.UPLOAD_DIR, 'products');

// libvips keeps a handle on files it opens by path, which on Windows makes the
// per-test cleanup fail with EBUSY. Nothing here is hot enough to need the cache.
sharp.cache(false);

/** Reads an written image through a buffer, so no file handle outlives the call. */
async function metadataOf(filename) {
  return sharp(await fs.readFile(path.join(uploadDir, filename))).metadata();
}

beforeAll(async () => {
  await connectTestDatabase();
  // A previous aborted run may have left files behind; these tests assert on
  // directory contents, so start from a known-empty directory.
  await fs.rm(uploadDir, { recursive: true, force: true });
});
afterEach(async () => {
  await clearTestDatabase();
  // Each test asserts on directory contents, so it starts from an empty one.
  await fs.rm(uploadDir, { recursive: true, force: true });
});
afterAll(disconnectTestDatabase);

/** A real PNG, so sharp has something genuine to decode. */
function pngBuffer({ width = 40, height = 40 } = {}) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
}

async function setupProduct() {
  const admin = await signUpAdmin(app);
  const seller = await signUp(app, sellerPayload);

  const category = await request(app)
    .post('/api/v1/categories')
    .set(admin.auth)
    .send({ name: 'Electronics' });

  const product = await request(app)
    .post(api)
    .set(seller.auth)
    .send({ ...laptopPayload, category: category.body.data.category.id });

  return { admin, seller, product: product.body.data.product };
}

async function filesInUploadDir() {
  return fs.readdir(uploadDir).catch(() => []);
}

describe('POST /products/:id/images', () => {
  it('stores an uploaded image and attaches its URL to the product', async () => {
    const { seller, product } = await setupProduct();

    const response = await request(app)
      .post(`${api}/${product.id}/images`)
      .set(seller.auth)
      .attach('images', await pngBuffer(), 'photo.png');

    expect(response.status).toBe(201);
    expect(response.body.data.product.images).toHaveLength(1);
    expect(await filesInUploadDir()).toHaveLength(1);
  });

  it('re-encodes to WebP under a generated name, ignoring the uploaded filename', async () => {
    const { seller, product } = await setupProduct();

    const response = await request(app)
      .post(`${api}/${product.id}/images`)
      .set(seller.auth)
      .attach('images', await pngBuffer(), 'photo.png');

    const [url] = response.body.data.product.images;
    const filename = url.split('/').pop();

    // The client's name is discarded entirely: this is what stops a crafted
    // filename from traversing out of the upload directory.
    expect(filename).not.toContain('photo');
    expect(filename).toMatch(/^[a-f0-9-]{36}\.webp$/);

    const written = await metadataOf(filename);
    expect(written.format).toBe('webp');
  });

  it('downsizes an oversized image', async () => {
    const { seller, product } = await setupProduct();

    const response = await request(app)
      .post(`${api}/${product.id}/images`)
      .set(seller.auth)
      .attach('images', await pngBuffer({ width: 3000, height: 2000 }), 'big.png');

    const filename = response.body.data.product.images[0].split('/').pop();
    const written = await metadataOf(filename);

    expect(written.width).toBe(1200);
  });

  it('accepts several images in one request', async () => {
    const { seller, product } = await setupProduct();

    const response = await request(app)
      .post(`${api}/${product.id}/images`)
      .set(seller.auth)
      .attach('images', await pngBuffer(), 'one.png')
      .attach('images', await pngBuffer(), 'two.png');

    expect(response.body.data.product.images).toHaveLength(2);
  });

  it('rejects a file that is not an image, leaving nothing on disk', async () => {
    const { seller, product } = await setupProduct();

    const response = await request(app)
      .post(`${api}/${product.id}/images`)
      .set(seller.auth)
      .attach('images', Buffer.from('#!/bin/sh\necho not an image'), 'payload.txt');

    expect(response.status).toBe(400);
    expect(await filesInUploadDir()).toHaveLength(0);
  });

  it('rejects a non-image disguised with an image mime type', async () => {
    const { seller, product } = await setupProduct();

    // Passes the mime whitelist, then fails when sharp tries to decode it —
    // which is exactly why re-encoding is the real defence.
    const response = await request(app)
      .post(`${api}/${product.id}/images`)
      .set(seller.auth)
      .attach('images', Buffer.from('GIF89a<?php echo 1; ?>'), {
        filename: 'fake.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(400);
    expect(await filesInUploadDir()).toHaveLength(0);
  });

  it('refuses a seller who does not own the product', async () => {
    const { product } = await setupProduct();
    const intruder = await signUp(app, { ...sellerPayload, email: 'other-seller@example.com' });

    const response = await request(app)
      .post(`${api}/${product.id}/images`)
      .set(intruder.auth)
      .attach('images', await pngBuffer(), 'photo.png');

    expect(response.status).toBe(403);
    // The rejected upload must not leave a file behind.
    expect(await filesInUploadDir()).toHaveLength(0);
  });

  it('refuses an unauthenticated upload', async () => {
    const { product } = await setupProduct();

    const response = await request(app)
      .post(`${api}/${product.id}/images`)
      .attach('images', await pngBuffer(), 'photo.png');

    expect(response.status).toBe(401);
  });

  it('rejects a request with no file attached', async () => {
    const { seller, product } = await setupProduct();

    const response = await request(app).post(`${api}/${product.id}/images`).set(seller.auth);

    expect(response.status).toBe(400);
  });
});

describe('DELETE /products/:id/images/:filename', () => {
  it('removes the image from the product and from disk', async () => {
    const { seller, product } = await setupProduct();

    const upload = await request(app)
      .post(`${api}/${product.id}/images`)
      .set(seller.auth)
      .attach('images', await pngBuffer(), 'photo.png');

    const filename = upload.body.data.product.images[0].split('/').pop();

    const response = await request(app)
      .delete(`${api}/${product.id}/images/${filename}`)
      .set(seller.auth);

    expect(response.status).toBe(200);
    expect(response.body.data.product.images).toHaveLength(0);
    expect(await filesInUploadDir()).toHaveLength(0);
  });

  it('rejects a traversal attempt in the filename', async () => {
    const { seller, product } = await setupProduct();

    const response = await request(app)
      .delete(`${api}/${product.id}/images/${encodeURIComponent('../../../.env')}`)
      .set(seller.auth);

    expect(response.status).toBe(422);
  });

  it('404s for an image the product does not have', async () => {
    const { seller, product } = await setupProduct();

    const response = await request(app)
      .delete(`${api}/${product.id}/images/00000000-0000-0000-0000-000000000000.webp`)
      .set(seller.auth);

    expect(response.status).toBe(404);
  });
});
