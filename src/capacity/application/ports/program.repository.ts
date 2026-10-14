import type { Program } from '@/capacity/domain/program';

/**
 * Port: storage of the program aggregate. Writes take a `Program`, never a patch, so a new
 * state can only come from the aggregate's own transitions. Methods that write or lock must
 * be called inside `TransactionManager.run()`.
 */
export abstract class ProgramRepository {
  abstract findById(id: string): Promise<Program | undefined>;

  abstract list(options: { limit: number; afterId?: string }): Promise<Program[]>;

  /** Takes the per-program write lock (ARCHITECTURE.md §2.1) and returns the current state. */
  abstract lockById(id: string): Promise<Program | undefined>;

  /** Stores a program created by treasury; returns undefined if it already exists. */
  abstract insertIfAbsent(program: Program): Promise<Program | undefined>;

  /** Stores the new state of a program whose lock the caller holds. */
  abstract save(program: Program): Promise<Program>;
}
