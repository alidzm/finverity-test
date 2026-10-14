import { Injectable } from '@nestjs/common';
import { asc, eq, gt, sql } from 'drizzle-orm';
import { ProgramRepository } from '@/capacity/application/ports/program.repository';
import { Program } from '@/capacity/domain/program';
import { DrizzleTransactionManager } from '@/shared/infrastructure/database/drizzle-transaction-manager';
import { programs } from './capacity.schema';

// A row is structurally a `ProgramState` (columns are typed with the domain enums), so it is
// handed to `Program.reconstitute` as is; the aggregate checks its invariants on the way in.

@Injectable()
export class DrizzleProgramRepository extends ProgramRepository {
  constructor(private readonly drizzle: DrizzleTransactionManager) {
    super();
  }

  async findById(id: string): Promise<Program | undefined> {
    const [row] = await this.drizzle.executor.select().from(programs).where(eq(programs.id, id));
    return row && Program.reconstitute(row);
  }

  async list(options: { limit: number; afterId?: string }): Promise<Program[]> {
    const rows = await this.drizzle.executor
      .select()
      .from(programs)
      .where(options.afterId ? gt(programs.id, options.afterId) : undefined)
      .orderBy(asc(programs.id))
      .limit(options.limit);
    return rows.map((row) => Program.reconstitute(row));
  }

  async lockById(id: string): Promise<Program | undefined> {
    const [row] = await this.drizzle.transaction
      .select()
      .from(programs)
      .where(eq(programs.id, id))
      .for('update');
    return row && Program.reconstitute(row);
  }

  async insertIfAbsent(program: Program): Promise<Program | undefined> {
    const [row] = await this.drizzle.transaction
      .insert(programs)
      .values(program.toState())
      .onConflictDoNothing({ target: programs.id })
      .returning();
    return row && Program.reconstitute(row);
  }

  async save(program: Program): Promise<Program> {
    // Absolute values are safe: the caller holds the program lock.
    const [row] = await this.drizzle.transaction
      .update(programs)
      .set({
        creditLimitMinor: program.creditLimitMinor,
        reservedMinor: program.reservedMinor,
        status: program.status,
        version: program.version,
        treasurySequence: program.treasurySequence,
        lastReconciledAt: program.lastReconciledAt,
        updatedAt: sql`now()`,
      })
      .where(eq(programs.id, program.id))
      .returning();
    return Program.reconstitute(row);
  }
}
