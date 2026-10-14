/**
 * An aggregate would enter, or was loaded in, a state that breaks its invariants. That is a
 * bug or corrupt data — never a business-rule rejection, which is a `DomainError`.
 */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}

export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new InvariantViolationError(message);
  }
}
