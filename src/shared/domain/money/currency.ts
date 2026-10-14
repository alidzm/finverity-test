import { DomainError } from '@/shared/domain/domain-error';

/**
 * ISO 4217 minor-unit exponents of the currencies this service accepts.
 *
 * An explicit allow-list keeps precision rules auditable instead of depending on the
 * ICU data bundled with the runtime, and rejects currencies nobody has signed off on.
 */
const MINOR_UNIT_EXPONENTS = {
  AED: 2,
  AUD: 2,
  BHD: 3,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  CZK: 2,
  DKK: 2,
  EGP: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  JOD: 3,
  JPY: 0,
  KES: 2,
  KRW: 0,
  KWD: 3,
  MXN: 2,
  MYR: 2,
  NGN: 2,
  NOK: 2,
  NZD: 2,
  OMR: 3,
  PHP: 2,
  PKR: 2,
  PLN: 2,
  QAR: 2,
  RON: 2,
  SAR: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TRY: 2,
  USD: 2,
  VND: 0,
  ZAR: 2,
} as const satisfies Record<string, number>;

export type CurrencyCode = keyof typeof MINOR_UNIT_EXPONENTS;

export const SUPPORTED_CURRENCIES = Object.keys(MINOR_UNIT_EXPONENTS) as CurrencyCode[];

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return Object.hasOwn(MINOR_UNIT_EXPONENTS, code);
}

export function assertSupportedCurrency(code: string): CurrencyCode {
  if (!isSupportedCurrency(code)) {
    throw new DomainError('UNSUPPORTED_CURRENCY', `Currency '${code}' is not supported`, {
      currency: code,
    });
  }
  return code;
}

export function minorUnitExponent(currency: CurrencyCode): number {
  return MINOR_UNIT_EXPONENTS[currency];
}
