import { DomainError } from '@/shared/domain/domain-error';
import { assertSupportedCurrency } from './currency';
import { formatAmount, parseAmount, parsePositiveAmount } from './money';

describe('parseAmount', () => {
  it.each([
    ['100', 'USD', 10000n],
    ['100.5', 'USD', 10050n],
    ['100.50', 'USD', 10050n],
    ['0.01', 'USD', 1n],
    ['1500', 'JPY', 1500n],
    ['1.234', 'BHD', 1234n],
    ['10000000.00', 'EUR', 1000000000n],
    ['5.000', 'USD', 500n],
  ] as const)('parses %s %s into %s minor units', (value, currency, expected) => {
    expect(parseAmount(value, currency)).toBe(expected);
  });

  it.each([
    ['1.001', 'USD'],
    ['1.5', 'JPY'],
    ['-1', 'USD'],
    ['1e5', 'USD'],
    ['01.00', 'USD'],
    ['', 'USD'],
    ['1.', 'USD'],
    ['.5', 'USD'],
    ['1234567890123456789', 'USD'],
  ] as const)('rejects %j for %s', (value, currency) => {
    expect(() => parseAmount(value, currency)).toThrow(DomainError);
  });

  it('rejects zero where a positive amount is required', () => {
    expect(() => parsePositiveAmount('0.00', 'USD')).toThrow(/greater than zero/);
  });
});

describe('formatAmount', () => {
  it.each([
    [10050n, 'USD', '100.50'],
    [1n, 'USD', '0.01'],
    [0n, 'USD', '0.00'],
    [-250n, 'USD', '-2.50'],
    [1500n, 'JPY', '1500'],
    [1234n, 'BHD', '1.234'],
  ] as const)('formats %s %s as %s', (minor, currency, expected) => {
    expect(formatAmount(minor, currency)).toBe(expected);
  });

  it('round-trips with parseAmount', () => {
    for (const value of ['0.00', '0.07', '123456789.99', '10000000.00']) {
      expect(formatAmount(parseAmount(value, 'EUR'), 'EUR')).toBe(value);
    }
  });
});

describe('assertSupportedCurrency', () => {
  it('accepts allow-listed ISO codes and rejects others', () => {
    expect(assertSupportedCurrency('EUR')).toBe('EUR');
    expect(() => assertSupportedCurrency('XXX')).toThrow(DomainError);
    expect(() => assertSupportedCurrency('usd')).toThrow(DomainError);
    expect(() => assertSupportedCurrency('toString')).toThrow(DomainError);
  });
});
