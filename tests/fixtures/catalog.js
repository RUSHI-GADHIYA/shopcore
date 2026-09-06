/** Product payloads shaped for POST /products. `category` is filled in per test. */
export const laptopPayload = {
  name: 'Aurora Ultrabook 14',
  description: 'A thin and light aluminium laptop with a 14-inch display.',
  variants: [
    { sku: 'AUR-14-SLV', attributes: { color: 'Silver' }, price: 1299.99, stock: 12 },
    { sku: 'AUR-14-BLK', attributes: { color: 'Black' }, price: 1349.99, stock: 4 },
  ],
};

export const keyboardPayload = {
  name: 'Nimbus Mechanical Keyboard',
  description: 'A compact 65% mechanical keyboard with hot-swappable switches.',
  variants: [{ sku: 'NMB-65-RED', attributes: { color: 'Red' }, price: 89.5, stock: 0 }],
};

export const monitorPayload = {
  name: 'Vantage 27 Monitor',
  description: 'A 27-inch 4K monitor with an adjustable stand and USB-C input.',
  variants: [{ sku: 'VNT-27-4K', price: 449, stock: 30 }],
};
