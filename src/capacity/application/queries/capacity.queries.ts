import { Injectable } from '@nestjs/common';
import { type CapacityDto, toCapacityDto } from '@/capacity/application/dto/capacity.dto';
import { decodeCursor, encodeCursor, type Page } from '@/capacity/application/dto/page';
import { type ReservationDto, toReservationDto } from '@/capacity/application/dto/reservation.dto';
import { ProgramRepository } from '@/capacity/application/ports/program.repository';
import { ReservationRepository } from '@/capacity/application/ports/reservation.repository';
import { programNotFound } from '@/capacity/domain/program';
import { reservationNotFound, type ReservationStatus } from '@/capacity/domain/reservation';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ListReservationsQuery {
  limit: number;
  cursor?: string;
  status?: ReservationStatus;
  discrepancy?: boolean;
}

/** Read side of the capacity module (no transactions; reads see committed state). */
@Injectable()
export class CapacityQueries {
  constructor(
    private readonly programs: ProgramRepository,
    private readonly reservations: ReservationRepository,
  ) {}

  async getCapacity(programId: string): Promise<CapacityDto> {
    const program = await this.programs.findById(programId);
    if (!program) {
      throw programNotFound(programId);
    }
    return toCapacityDto(program);
  }

  async listPrograms(query: { limit: number; cursor?: string }): Promise<Page<CapacityDto>> {
    const after = query.cursor
      ? decodeCursor<{ id: string }>(query.cursor, (value) => typeof value.id === 'string')
      : undefined;
    const rows = await this.programs.list({ limit: query.limit + 1, afterId: after?.id });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toCapacityDto),
      nextCursor: rows.length > query.limit ? encodeCursor({ id: page.at(-1)!.id }) : null,
    };
  }

  async getReservation(programId: string, invoiceId: string): Promise<ReservationDto> {
    const reservation = await this.reservations.findByInvoice(programId, invoiceId);
    if (!reservation) {
      await this.assertProgramExists(programId);
      throw reservationNotFound(programId, invoiceId);
    }
    const releases = await this.reservations.findReleases(reservation.id);
    return toReservationDto(reservation, releases);
  }

  async listReservations(
    programId: string,
    query: ListReservationsQuery,
  ): Promise<Page<ReservationDto>> {
    await this.assertProgramExists(programId);
    const after = query.cursor
      ? decodeCursor<{ createdAt: string; id: string }>(
          query.cursor,
          (value) =>
            typeof value.createdAt === 'string' &&
            !Number.isNaN(Date.parse(value.createdAt)) &&
            typeof value.id === 'string' &&
            UUID_PATTERN.test(value.id),
        )
      : undefined;
    const rows = await this.reservations.list(programId, {
      status: query.status,
      discrepancy: query.discrepancy,
      limit: query.limit + 1,
      after: after ? { createdAt: new Date(after.createdAt), id: after.id } : undefined,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toReservationDto(row)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  private async assertProgramExists(programId: string): Promise<void> {
    if (!(await this.programs.findById(programId))) {
      throw programNotFound(programId);
    }
  }
}
