/**
 * Money arithmetic in integer minor units (spec §6.6: the server recalculates
 * every total).
 *
 * Prices are stored as decimals because that is what the schema and every
 * client expects, but arithmetic on them is not safe: `0.1 + 0.2` is
 * `0.30000000000000004`, and a cart of thirty items compounds that into a total
 * that fails to match the sum of its own lines. Every calculation here converts
 * to whole cents first, does integer maths, and converts back exactly once.
 */

/** Decimal amount → integer cents. Rounds half away from zero. */
export function toCents(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new TypeError(`Not a monetary amount: ${amount}`);

  // The epsilon nudge stops values that are already imprecise — 8.115 arriving
  // as 8.114999999999999 — from rounding down a cent.
  return Math.round((value + Number.EPSILON * Math.sign(value)) * 100);
}

/** Integer cents → decimal amount with exactly two places. */
export function fromCents(cents) {
  return Math.round(cents) / 100;
}

/** Multiplies a unit price by a whole quantity, in cents. */
export function lineTotalCents(unitPrice, quantity) {
  return toCents(unitPrice) * quantity;
}

/** Applies a percentage (e.g. 8.25 for 8.25%) to a cent amount. */
export function percentOfCents(cents, percent) {
  return Math.round((cents * percent) / 100);
}

export default { toCents, fromCents, lineTotalCents, percentOfCents };
