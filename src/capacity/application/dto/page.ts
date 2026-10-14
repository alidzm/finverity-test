import { DomainError } from '@/shared/domain/domain-error';

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page; null on the last page. */
  nextCursor: string | null;
}

/** Opaque keyset-pagination cursors (base64url JSON). */
export function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, string>>(
  cursor: string,
  isValid: (value: Record<string, unknown>) => boolean = () => true,
): T {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value === 'object' && value !== null && isValid(value as Record<string, unknown>)) {
      return value as T;
    }
  } catch {
    // fall through
  }
  throw new DomainError('VALIDATION_FAILED', 'Invalid pagination cursor', {
    errors: [{ path: 'cursor', message: 'Invalid pagination cursor' }],
  });
}
