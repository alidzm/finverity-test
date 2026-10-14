/**
 * Stable, machine-readable error codes. They are part of the public API contract
 * (returned as `code` in problem+json bodies) and must not be renamed.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'INVALID_AMOUNT',
  'UNSUPPORTED_CURRENCY',
  'CURRENCY_MISMATCH',
  'PROGRAM_NOT_FOUND',
  'PROGRAM_SUSPENDED',
  'PROGRAM_CURRENCY_IMMUTABLE',
  'INSUFFICIENT_CAPACITY',
  'RESERVATION_NOT_FOUND',
  'RESERVATION_CONFLICT',
  'RESERVATION_ALREADY_RELEASED',
  'RELEASE_CONFLICT',
  'RELEASE_EXCEEDS_OUTSTANDING',
  'FX_RATE_NOT_FOUND',
  'FX_RATE_STALE',
  'INVALID_TREASURY_MESSAGE',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'AUTH_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * A business-rule violation. Never retried: on the HTTP side it maps to a 4xx/503
 * problem response, on the Kafka side it sends the message to the DLQ.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
