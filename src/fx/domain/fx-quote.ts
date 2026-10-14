import { DomainError } from '@/shared/domain/domain-error';
import type { CurrencyCode } from '@/shared/domain/money/currency';
import { type ExchangeRate, IDENTITY_RATE, invertRate, parseRate } from '@/shared/domain/money/fx';

/** A rate as published by treasury: 1 `base` = `rate` × `quote`. */
export interface PublishedRate {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  /** Decimal string, e.g. "1.0834". */
  readonly rate: string;
  readonly asOf: Date;
}

export interface FxQuote {
  /** 1 unit of `from` = rate units of `to`. */
  readonly rate: ExchangeRate;
  /** When treasury published the underlying rate; null for same-currency conversions. */
  readonly asOf: Date | null;
}

export const SAME_CURRENCY_QUOTE: FxQuote = { rate: IDENTITY_RATE, asOf: null };

/**
 * Chooses the rate to convert `from` into `to`: the freshest published rate for the pair,
 * inverted exactly when only the opposite direction is published. Fails closed when no
 * rate exists or the freshest one is older than `maxAgeMs`.
 */
export function selectQuote(
  published: readonly PublishedRate[],
  from: CurrencyCode,
  to: CurrencyCode,
  now: Date,
  maxAgeMs: number,
): FxQuote {
  if (from === to) {
    return SAME_CURRENCY_QUOTE;
  }
  const freshest = published
    .filter(
      (rate) =>
        (rate.base === from && rate.quote === to) || (rate.base === to && rate.quote === from),
    )
    .sort((a, b) => b.asOf.getTime() - a.asOf.getTime())[0];
  if (!freshest) {
    throw new DomainError('FX_RATE_NOT_FOUND', `No exchange rate available for ${from}/${to}`, {
      from,
      to,
    });
  }
  if (now.getTime() - freshest.asOf.getTime() > maxAgeMs) {
    throw new DomainError('FX_RATE_STALE', `The ${from}/${to} exchange rate is out of date`, {
      from,
      to,
      rateAsOf: freshest.asOf.toISOString(),
    });
  }
  const rate = parseRate(freshest.rate);
  return { rate: freshest.base === from ? rate : invertRate(rate), asOf: freshest.asOf };
}
