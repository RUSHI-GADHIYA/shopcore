import fs from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { env } from '../../config/env.js';
import logger from '../../config/logger.js';
import { Order } from '../../modules/orders/order.model.js';

/**
 * Renders an order invoice to PDF after payment succeeds (spec §13).
 *
 * Reads the order fresh rather than trusting the job payload: a job can sit in
 * the queue through a retry backoff, and the invoice must reflect the order as
 * it stands when the document is actually produced.
 */
export async function handleInvoiceJob(job) {
  const { orderId } = job.data;

  const order = await Order.findById(orderId).populate('user', 'name email').lean();
  if (!order) {
    logger.warn('Invoice requested for an order that no longer exists', { orderId });
    return { skipped: true };
  }

  const targetDir = path.resolve(env.INVOICE_DIR);
  await fs.mkdir(targetDir, { recursive: true });

  // Named by the order reference, so regenerating overwrites rather than
  // accumulating duplicates on every webhook retry.
  const filename = `${order.reference}.pdf`;
  const buffer = await renderInvoice(order);
  await fs.writeFile(path.join(targetDir, filename), buffer);

  const url = `${env.PUBLIC_BASE_URL}/invoices/${filename}`;
  await Order.updateOne({ _id: order._id }, { $set: { invoiceUrl: url } });

  logger.info('Invoice generated', { orderId: String(order._id), reference: order.reference });
  return { generated: true, url };
}

/** Buffers the PDF in memory: these documents are a few KB, not a stream worth managing. */
function renderInvoice(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const money = (amount) => `$${Number(amount).toFixed(2)}`;

    doc.fontSize(20).text('ShopCore', { continued: false });
    doc.fontSize(10).fillColor('#666').text('Invoice');
    doc.moveDown();

    doc.fillColor('#000').fontSize(12).text(`Invoice for order ${order.reference}`);
    doc
      .fontSize(10)
      .fillColor('#444')
      .text(`Placed: ${new Date(order.placedAt).toISOString().slice(0, 10)}`)
      .text(`Status: ${order.status}`)
      .text(`Billed to: ${order.user?.name ?? 'Customer'} <${order.user?.email ?? ''}>`);

    doc.moveDown();
    doc.fillColor('#000').fontSize(11).text('Ship to:');
    const address = order.shippingAddress;
    doc
      .fontSize(10)
      .fillColor('#444')
      .text(
        [
          address.fullName,
          address.line1,
          address.line2,
          `${address.city}, ${address.state} ${address.postalCode}`,
          address.country,
        ]
          .filter(Boolean)
          .join('\n')
      );

    doc.moveDown();
    doc.fillColor('#000').fontSize(11).text('Items');
    doc.moveDown(0.5);

    for (const item of order.items) {
      doc
        .fontSize(10)
        .text(`${item.quantity} x ${item.name} (${item.sku})`, { continued: true })
        .text(money(item.lineTotal), { align: 'right' });
    }

    doc.moveDown();
    const line = (label, amount) =>
      doc.fontSize(10).text(label, { continued: true }).text(money(amount), { align: 'right' });

    line('Subtotal', order.subtotal);
    if (order.discount) line('Discount', -order.discount);
    if (order.tax) line('Tax', order.tax);
    if (order.shippingFee) line('Shipping', order.shippingFee);

    doc.moveDown(0.3);
    doc
      .fontSize(12)
      .fillColor('#000')
      .text('Total', { continued: true })
      .text(money(order.total), { align: 'right' });

    doc.end();
  });
}

export default handleInvoiceJob;
