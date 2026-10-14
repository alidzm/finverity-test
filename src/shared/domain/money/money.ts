import { DomainError } from '@/shared/domain/domain-error';
import { type CurrencyCode, minorUnitExponent } from './currency';

/** An exact monetary amount: integer minor units of a currency. */
export interface Amount {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
/** 10^18 major units — far beyond any credit limit; guards against absurd inputs. */
const MAX_INTEGER_DIGITS = 18;

/**
 * Parses a non-negative decimal string into integer minor units of `currency`.
 * Extra fractional digits are accepted only if they are zeros (no precision is lost).
 */
export function parseAmount(value: string, currency: CurrencyCode): bigint {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) {
    throw new DomainError('INVALID_AMOUNT', `'${value}' is not a valid decimal amount`, {
      value,
      currency,
    });
  }
  const [, integerPart, fractionPart = ''] = match;
  if (integerPart.length > MAX_INTEGER_DIGITS) {
    throw new DomainError('INVALID_AMOUNT', `Amount '${value}' is too large`, { value, currency });
  }
  const exponent = minorUnitExponent(currency);
  const significant = fractionPart.slice(0, exponent);
  const excess = fractionPart.slice(exponent);
  if (/[1-9]/.test(excess)) {
    throw new DomainError(
      'INVALID_AMOUNT',
      `${currency} supports at most ${exponent} decimal places, got '${value}'`,
      { value, currency },
    );
  }
  return BigInt(integerPart + significant.padEnd(exponent, '0'));
}

export function parsePositiveAmount(value: string, currency: CurrencyCode): bigint {
  const minor = parseAmount(value, currency);
  if (minor <= 0n) {
    throw new DomainError('INVALID_AMOUNT', 'Amount must be greater than zero', {
      value,
      currency,
    });
  }
  return minor;
}

/** Formats minor units as a decimal string with exactly the currency's exponent. */
export function formatAmount(minor: bigint, currency: CurrencyCode): string {
  const exponent = minorUnitExponent(currency);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, '0');
  const integerPart = digits.slice(0, digits.length - exponent);
  const fractionPart = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${integerPart}${exponent > 0 ? `.${fractionPart}` : ''}`;
}
