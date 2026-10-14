import { Module } from '@nestjs/common';
import { FxRateService } from '@/fx/application/fx-rate.service';
import { FxRateRepository } from '@/fx/application/ports/fx-rate.repository';
import { DrizzleFxRateRepository } from '@/fx/infrastructure/drizzle-fx-rate.repository';
import { FxRatesConsumer } from '@/fx/presentation/messaging/fx-rates.consumer';

@Module({
  providers: [
    FxRateService,
    { provide: FxRateRepository, useClass: DrizzleFxRateRepository },
    FxRatesConsumer,
  ],
  exports: [FxRateService],
})
export class FxModule {}
