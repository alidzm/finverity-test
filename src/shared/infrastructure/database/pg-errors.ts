import pg from 'pg';

export const PG_UNIQUE_VIOLATION = '23505';

/** Drizzle wraps driver errors (`DrizzleQueryError`); walk the cause chain to the pg error. */
export function findPgError(error: unknown): pg.DatabaseError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof pg.DatabaseError) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
