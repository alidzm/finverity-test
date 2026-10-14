import { DomainError } from '@/shared/domain/domain-error';
import { type PublishedRate, SAME_CURRENCY_QUOTE, selectQuote } from './fx-quote';

const NOW = new Date('2026-10-13T12:00:00Z');
const DAY = 86_400_000;
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

function rate(base: 'EUR' | 'USD', quote: 'EUR' | 'USD', value: string, asOf: Date): PublishedRate {
  return { base, quote, rate: value, asOf };
}

describe('selectQuote', () => {
  it('needs no rate for same-currency conversions', () => {
    expect(selectQuote([], 'USD', 'USD', NOW, DAY)).toBe(SAME_CURRENCY_QUOTE);
  });

  it('uses the direct pair', () => {
    const quote = selectQuote([rate('EUR', 'USD', '1.25', at(1000))], 'EUR', 'USD', NOW, DAY);
    expect(quote.rate).toEqual({ numerator: 125n, denominator: 100n });
    expect(quote.asOf).toEqual(at(1000));
  });

  it('inverts the opposite pair exactly', () => {
    const quote = selectQuote([rate('EUR', 'USD', '1.25', at(1000))], 'USD', 'EUR', NOW, DAY);
    expect(quote.rate).toEqual({ numerator: 100n, denominator: 125n });
  });

  it('prefers the freshest of the direct and inverse rates', () => {
    const quote = selectQuote(
      [rate('EUR', 'USD', '1.25', at(5000)), rate('USD', 'EUR', '0.5', at(1000))],
      'EUR',
      'USD',
      NOW,
      DAY,
    );
    expect(quote.rate).toEqual({ numerator: 10n, denominator: 5n });
  });

  it('fails closed when no rate exists or the freshest is too old', () => {
    expect(() => selectQuote([], 'EUR', 'USD', NOW, DAY)).toThrow(
      expect.objectContaining({ code: 'FX_RATE_NOT_FOUND' }),
    );
    expect(() =>
      selectQuote([rate('EUR', 'USD', '1.25', at(DAY + 1))], 'EUR', 'USD', NOW, DAY),
    ).toThrow(DomainError);
    expect(() =>
      selectQuote([rate('EUR', 'USD', '1.25', at(DAY + 1))], 'EUR', 'USD', NOW, DAY),
    ).toThrow(expect.objectContaining({ code: 'FX_RATE_STALE' }));
  });
});
