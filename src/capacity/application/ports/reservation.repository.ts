import type {
  NewRelease,
  Release,
  Reservation,
  ReservationStatus,
} from '@/capacity/domain/reservation';

export interface ReservationListFilter {
  status?: ReservationStatus;
  discrepancy?: boolean;
  limit: number;
  after?: { createdAt: Date; id: string };
}

/**
 * Port: storage of the reservation aggregate (reservations and their releases). Writes take a
 * `Reservation`, never a patch. Methods that write or lock must be called inside
 * `TransactionManager.run()`, with the program lock held.
 */
export abstract class ReservationRepository {
  abstract findById(id: string): Promise<Reservation | undefined>;

  abstract findByInvoice(programId: string, invoiceId: string): Promise<Reservation | undefined>;

  /** Oldest first, keyset-paginated. */
  abstract list(programId: string, filter: ReservationListFilter): Promise<Reservation[]>;

  abstract lockByInvoice(programId: string, invoiceId: string): Promise<Reservation | undefined>;

  /** Every ACTIVE reservation of the program plus any reservation for the given invoices. */
  abstract findForReconciliation(programId: string, invoiceIds: string[]): Promise<Reservation[]>;

  /** Stores a new or changed reservation. */
  abstract save(reservation: Reservation): Promise<Reservation>;

  /** Stores many new or changed reservations at once (reconciliation). */
  abstract saveAll(reservations: readonly Reservation[]): Promise<void>;

  abstract findRelease(programId: string, releaseId: string): Promise<Release | undefined>;

  abstract findReleases(reservationId: string): Promise<Release[]>;

  abstract insertRelease(release: NewRelease): Promise<Release>;
}
