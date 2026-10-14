import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, or, type SQL, sql } from 'drizzle-orm';
import {
  type ReservationListFilter,
  ReservationRepository,
} from '@/capacity/application/ports/reservation.repository';
import { type NewRelease, type Release, Reservation } from '@/capacity/domain/reservation';
import { DrizzleTransactionManager } from '@/shared/infrastructure/database/drizzle-transaction-manager';
import { reservationReleases, reservations } from './capacity.schema';

/** Keeps multi-row statements well below PostgreSQL's 65,535 bind-parameter limit. */
const CHUNK_SIZE = 1_000;

// A row is structurally a `ReservationState`, so it is handed to `Reservation.reconstitute`
// as is; the aggregate checks its invariants on the way in.

@Injectable()
export class DrizzleReservationRepository extends ReservationRepository {
  constructor(private readonly drizzle: DrizzleTransactionManager) {
    super();
  }

  async findById(id: string): Promise<Reservation | undefined> {
    const [row] = await this.drizzle.executor
      .select()
      .from(reservations)
      .where(eq(reservations.id, id));
    return row && Reservation.reconstitute(row);
  }

  async findByInvoice(programId: string, invoiceId: string): Promise<Reservation | undefined> {
    const [row] = await this.drizzle.executor
      .select()
      .from(reservations)
      .where(and(eq(reservations.programId, programId), eq(reservations.invoiceId, invoiceId)));
    return row && Reservation.reconstitute(row);
  }

  async list(programId: string, filter: ReservationListFilter): Promise<Reservation[]> {
    const conditions: (SQL | undefined)[] = [eq(reservations.programId, programId)];
    if (filter.status) {
      conditions.push(eq(reservations.status, filter.status));
    }
    if (filter.discrepancy !== undefined) {
      conditions.push(eq(reservations.discrepancy, filter.discrepancy));
    }
    if (filter.after) {
      conditions.push(
        or(
          gt(reservations.createdAt, filter.after.createdAt),
          and(
            eq(reservations.createdAt, filter.after.createdAt),
            gt(reservations.id, filter.after.id),
          ),
        ),
      );
    }
    const rows = await this.drizzle.executor
      .select()
      .from(reservations)
      .where(and(...conditions))
      .orderBy(asc(reservations.createdAt), asc(reservations.id))
      .limit(filter.limit);
    return rows.map((row) => Reservation.reconstitute(row));
  }

  async lockByInvoice(programId: string, invoiceId: string): Promise<Reservation | undefined> {
    const [row] = await this.drizzle.transaction
      .select()
      .from(reservations)
      .where(and(eq(reservations.programId, programId), eq(reservations.invoiceId, invoiceId)))
      .for('update');
    return row && Reservation.reconstitute(row);
  }

  async findForReconciliation(programId: string, invoiceIds: string[]): Promise<Reservation[]> {
    const tx = this.drizzle.transaction;
    const byId = new Map<string, Reservation>();
    const active = await tx
      .select()
      .from(reservations)
      .where(and(eq(reservations.programId, programId), eq(reservations.status, 'ACTIVE')));
    active.forEach((row) => byId.set(row.id, Reservation.reconstitute(row)));
    for (const ids of chunks(invoiceIds)) {
      const rows = await tx
        .select()
        .from(reservations)
        .where(and(eq(reservations.programId, programId), inArray(reservations.invoiceId, ids)));
      rows.forEach((row) => byId.set(row.id, Reservation.reconstitute(row)));
    }
    return [...byId.values()];
  }

  async save(reservation: Reservation): Promise<Reservation> {
    const [row] = await this.upsert([reservation]).returning();
    return Reservation.reconstitute(row);
  }

  async saveAll(list: readonly Reservation[]): Promise<void> {
    for (const chunk of chunks(list)) {
      await this.upsert(chunk);
    }
  }

  async findRelease(programId: string, releaseId: string): Promise<Release | undefined> {
    const [row] = await this.drizzle.executor
      .select()
      .from(reservationReleases)
      .where(
        and(
          eq(reservationReleases.programId, programId),
          eq(reservationReleases.releaseId, releaseId),
        ),
      );
    return row;
  }

  findReleases(reservationId: string): Promise<Release[]> {
    return this.drizzle.executor
      .select()
      .from(reservationReleases)
      .where(eq(reservationReleases.reservationId, reservationId))
      .orderBy(asc(reservationReleases.createdAt), asc(reservationReleases.id));
  }

  async insertRelease(release: NewRelease): Promise<Release> {
    const [row] = await this.drizzle.transaction
      .insert(reservationReleases)
      .values(release)
      .returning();
    return row;
  }

  /**
   * Inserts new reservations and updates existing ones (by id). Only the columns transitions
   * may change are updated; the rest is fixed when a reservation is opened.
   */
  private upsert(list: readonly Reservation[]) {
    return this.drizzle.transaction
      .insert(reservations)
      .values(list.map((reservation) => reservation.toState()))
      .onConflictDoUpdate({
        target: reservations.id,
        set: {
          invoiceCurrency: sql`excluded.invoice_currency`,
          invoiceAmountMinor: sql`excluded.invoice_amount_minor`,
          reservedMinor: sql`excluded.reserved_minor`,
          releasedMinor: sql`excluded.released_minor`,
          releasedInvoiceMinor: sql`excluded.released_invoice_minor`,
          status: sql`excluded.status`,
          discrepancy: sql`excluded.discrepancy`,
          apiModifiedAt: sql`excluded.api_modified_at`,
          updatedAt: sql`now()`,
        },
      });
  }
}

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    result.push(items.slice(i, i + CHUNK_SIZE));
  }
  return result;
}
