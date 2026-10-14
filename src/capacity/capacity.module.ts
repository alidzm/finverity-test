import { Module } from '@nestjs/common';
import { CapacityChangeFeed } from '@/capacity/application/ports/capacity-change-feed';
import { CapacityJournal } from '@/capacity/application/ports/capacity-journal';
import { ProgramRepository } from '@/capacity/application/ports/program.repository';
import { ReservationRepository } from '@/capacity/application/ports/reservation.repository';
import { CapacityQueries } from '@/capacity/application/queries/capacity.queries';
import { WatchCapacityQuery } from '@/capacity/application/queries/watch-capacity.query';
import { ApplyRepaymentUseCase } from '@/capacity/application/use-cases/apply-repayment.use-case';
import { ReconcileProgramUseCase } from '@/capacity/application/use-cases/reconcile-program.use-case';
import { ReleaseCapacityUseCase } from '@/capacity/application/use-cases/release-capacity.use-case';
import { ReserveCapacityUseCase } from '@/capacity/application/use-cases/reserve-capacity.use-case';
import { UpsertProgramUseCase } from '@/capacity/application/use-cases/upsert-program.use-case';
import { PostgresCapacityChangeFeed } from '@/capacity/infrastructure/notifications/postgres-capacity-change-feed';
import { DrizzleProgramRepository } from '@/capacity/infrastructure/persistence/drizzle-program.repository';
import { DrizzleReservationRepository } from '@/capacity/infrastructure/persistence/drizzle-reservation.repository';
import { PostgresCapacityJournal } from '@/capacity/infrastructure/persistence/postgres-capacity-journal';
import { ProgramsController } from '@/capacity/presentation/http/programs.controller';
import { ReservationsController } from '@/capacity/presentation/http/reservations.controller';
import { TreasuryCapacityConsumer } from '@/capacity/presentation/messaging/treasury-capacity.consumer';
import { FxModule } from '@/fx/fx.module';

/** Composition root of the capacity module: binds application ports to their adapters. */
@Module({
  imports: [FxModule],
  controllers: [ProgramsController, ReservationsController],
  providers: [
    // application
    ReserveCapacityUseCase,
    ReleaseCapacityUseCase,
    UpsertProgramUseCase,
    ApplyRepaymentUseCase,
    ReconcileProgramUseCase,
    CapacityQueries,
    WatchCapacityQuery,
    // ports → infrastructure adapters
    { provide: ProgramRepository, useClass: DrizzleProgramRepository },
    { provide: ReservationRepository, useClass: DrizzleReservationRepository },
    { provide: CapacityJournal, useClass: PostgresCapacityJournal },
    { provide: CapacityChangeFeed, useClass: PostgresCapacityChangeFeed },
    // inbound messaging adapter
    TreasuryCapacityConsumer,
  ],
})
export class CapacityModule {}
