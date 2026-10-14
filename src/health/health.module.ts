import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';

/**
 * Operational probes. Not a layered business module: it only reports on infrastructure
 * (database, Kafka consumer) and is excluded from the public API.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
})
export class HealthModule {}
