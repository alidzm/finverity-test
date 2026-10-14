import { convertMinor, divideRounded, formatRate, invertRate, parseRate } from './fx';

describe('parseRate / formatRate', () => {
  it('parses decimal rates into exact rationals', () => {
    expect(parseRate('1.08345')).toEqual({ numerator: 108345n, denominator: 100000n });
    expect(parseRate('150')).toEqual({ numerator: 150n, denominator: 1n });
  });

  it('rejects zero, negative and malformed rates', () => {
    for (const value of ['0', '0.000', '-1.2', 'abc', '1,2']) {
      expect(() => parseRate(value)).toThrow();
    }
  });

  it('formats rates, including inverted (non-terminating) ones', () => {
    expect(formatRate(parseRate('1.08345'))).toBe('1.08345');
    expect(formatRate(invertRate(parseRate('1.25')))).toBe('0.8');
    expect(formatRate(invertRate(parseRate('3')))).toBe('0.333333333333');
  });
});

describe('divideRounded', () => {
  it('rounds up or down only when there is a remainder', () => {
    expect(divideRounded(10n, 5n, 'CEIL')).toBe(2n);
    expect(divideRounded(11n, 5n, 'CEIL')).toBe(3n);
    expect(divideRounded(11n, 5n, 'FLOOR')).toBe(2n);
    expect(divideRounded(0n, 5n, 'CEIL')).toBe(0n);
  });
});

describe('convertMinor', () => {
  const eurUsd = parseRate('1.08345');

  it('converts between currencies with the same exponent', () => {
    // 1,000.00 EUR × 1.08345 = 1,083.45 USD exactly
    expect(convertMinor(100000n, 'EUR', 'USD', eurUsd, 'CEIL')).toBe(108345n);
  });

  it('rounds up when reserving so capacity is never under-reserved', () => {
    // 0.01 EUR × 1.08345 = 0.0108345 USD → 0.02 (ceil) / 0.01 (floor)
    expect(convertMinor(1n, 'EUR', 'USD', eurUsd, 'CEIL')).toBe(2n);
    expect(convertMinor(1n, 'EUR', 'USD', eurUsd, 'FLOOR')).toBe(1n);
  });

  it('handles currencies with different exponents', () => {
    const usdJpy = parseRate('149.5');
    // 10.00 USD → 1,495 JPY
    expect(convertMinor(1000n, 'USD', 'JPY', usdJpy, 'CEIL')).toBe(1495n);
    // 1,495 JPY → 10.00 USD using the exact inverse rate
    expect(convertMinor(1495n, 'JPY', 'USD', invertRate(usdJpy), 'CEIL')).toBe(1000n);
    // 1.000 BHD × 2.65 = 2.65 USD
    expect(convertMinor(1000n, 'BHD', 'USD', parseRate('2.65'), 'CEIL')).toBe(265n);
  });
});
