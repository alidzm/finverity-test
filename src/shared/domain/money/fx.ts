import { DomainError } from '@/shared/domain/domain-error';
import { type CurrencyCode, minorUnitExponent } from './currency';

/**
 * An exchange rate as an exact rational number: 1 unit of the base currency equals
 * `numerator / denominator` units of the quote currency. Keeping rates rational makes
 * inversion exact and lets conversion round exactly once, at the very end.
 */
export interface ExchangeRate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export type Rounding = 'CEIL' | 'FLOOR';

export const IDENTITY_RATE: ExchangeRate = { numerator: 1n, denominator: 1n };

const RATE_PATTERN = /^(0|[1-9]\d{0,17})(?:\.(\d{1,18}))?$/;

export function parseRate(value: string): ExchangeRate {
  const match = RATE_PATTERN.exec(value);
  if (!match) {
    throw new DomainError('VALIDATION_FAILED', `'${value}' is not a valid exchange rate`, {
      value,
    });
  }
  const [, integerPart, fractionPart = ''] = match;
  const numerator = BigInt(integerPart + fractionPart);
  if (numerator === 0n) {
    throw new DomainError('VALIDATION_FAILED', 'Exchange rate must be positive', { value });
  }
  return { numerator, denominator: 10n ** BigInt(fractionPart.length) };
}

export function invertRate(rate: ExchangeRate): ExchangeRate {
  return { numerator: rate.denominator, denominator: rate.numerator };
}

/** Divides non-negative `dividend` by positive `divisor` with the given rounding. */
export function divideRounded(dividend: bigint, divisor: bigint, rounding: Rounding): bigint {
  if (dividend < 0n || divisor <= 0n) {
    throw new RangeError('divideRounded expects a non-negative dividend and positive divisor');
  }
  const quotient = dividend / divisor;
  return rounding === 'CEIL' && quotient * divisor !== dividend ? quotient + 1n : quotient;
}

/**
 * Converts an amount in minor units of `from` into minor units of `to`:
 *
 *   target = amount × rate × 10^exp(to) / 10^exp(from)
 *
 * computed with integers only and rounded once.
 */
export function convertMinor(
  amountMinor: bigint,
  from: CurrencyCode,
  to: CurrencyCode,
  rate: ExchangeRate,
  rounding: Rounding,
): bigint {
  const scaleTo = 10n ** BigInt(minorUnitExponent(to));
  const scaleFrom = 10n ** BigInt(minorUnitExponent(from));
  return divideRounded(
    amountMinor * rate.numerator * scaleTo,
    rate.denominator * scaleFrom,
    rounding,
  );
}

/** Decimal representation of a rate (rounded half-up to `scale` digits) for display/audit. */
export function formatRate(rate: ExchangeRate, scale = 12): string {
  const factor = 10n ** BigInt(scale);
  const scaled = (rate.numerator * factor * 2n + rate.denominator) / (rate.denominator * 2n);
  const digits = scaled.toString().padStart(scale + 1, '0');
  const integerPart = digits.slice(0, digits.length - scale);
  const fractionPart = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
}
