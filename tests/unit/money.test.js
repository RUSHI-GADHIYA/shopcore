import { fromCents, lineTotalCents, percentOfCents, toCents } from '../../src/utils/money.js';

describe('toCents', () => {
  it.each([
    [0, 0],
    [1, 100],
    [19.99, 1999],
    [1299.99, 129999],
    [0.1, 10],
    [0.7, 70],
  ])('converts %s to %s cents', (amount, expected) => {
    expect(toCents(amount)).toBe(expected);
  });

  it('rounds a value that arrived imprecise', () => {
    // 8.115 is not representable and lands just below; naive rounding loses a cent.
    expect(toCents(8.115)).toBe(812);
  });

  it('rejects a non-numeric amount rather than silently producing NaN', () => {
    expect(() => toCents('abc')).toThrow(TypeError);
    expect(() => toCents(Infinity)).toThrow(TypeError);
    expect(() => toCents(undefined)).toThrow(TypeError);
  });
});

describe('round-tripping', () => {
  it.each([0, 0.01, 19.99, 89.5, 449, 1299.99])('survives %s', (amount) => {
    expect(fromCents(toCents(amount))).toBe(amount);
  });
});

describe('lineTotalCents', () => {
  it('multiplies without floating-point drift', () => {
    // The bug this exists to prevent: 0.1 * 3 is 0.30000000000000004 in floats.
    expect(fromCents(lineTotalCents(0.1, 3))).toBe(0.3);
  });

  it('keeps a large cart exact', () => {
    // 30 x 19.99 is 599.70; accumulating floats gives 599.6999999999999.
    expect(fromCents(lineTotalCents(19.99, 30))).toBe(599.7);
  });

  it('sums many lines without accumulating error', () => {
    const lines = Array.from({ length: 100 }, () => ({ price: 0.07, quantity: 3 }));
    const totalCents = lines.reduce(
      (sum, line) => sum + lineTotalCents(line.price, line.quantity),
      0
    );

    expect(fromCents(totalCents)).toBe(21);
  });
});

describe('percentOfCents', () => {
  it('applies a tax rate and rounds to the cent', () => {
    // 8.25% of $19.99 is 1.649175 -> 165 cents.
    expect(percentOfCents(1999, 8.25)).toBe(165);
  });

  it('returns nothing for a zero rate', () => {
    expect(percentOfCents(129999, 0)).toBe(0);
  });
});
