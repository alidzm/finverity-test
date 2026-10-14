import { NonRetryableMessageError } from '@/shared/application/messaging/inbound-message';
import { DomainError } from '@/shared/domain/domain-error';
import { InvariantViolationError } from '@/shared/domain/invariant';
import { findPgError } from '@/shared/infrastructure/database/pg-errors';

/**
 * Business-rule violations, broken aggregate invariants and data/integrity errors are
 * deterministic — the same message will fail the same way forever — so they go to the DLQ.
 * Anything else (connection loss, timeouts, serialization failures) is assumed transient and
 * retried in place.
 */
export function isNonRetryable(error: unknown): boolean {
  if (
    error instanceof NonRetryableMessageError ||
    error instanceof DomainError ||
    error instanceof InvariantViolationError
  ) {
    return true;
  }
  const code = findPgError(error)?.code;
  // 22xxx data exception, 23xxx integrity constraint violation
  return code !== undefined && (code.startsWith('22') || code.startsWith('23'));
}
