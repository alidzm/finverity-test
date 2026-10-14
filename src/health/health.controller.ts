import { Controller, Get, Res, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import type { Response } from 'express';
import { Public } from '@/auth/presentation/decorators';
import { DatabaseService } from '@/shared/infrastructure/database/database.service';
import { KafkaConsumerRunner } from '@/shared/infrastructure/kafka/kafka-consumer.runner';

/**
 * Orchestrator probes — the only unauthenticated routes (probes cannot carry tokens).
 * They expose no business data.
 */
@ApiExcludeController()
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly database: DatabaseService,
    private readonly consumers: KafkaConsumerRunner,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<unknown> {
    try {
      return await this.health.check([
        async () => {
          const indicator = this.indicators.check('database');
          try {
            await this.database.ping();
            return indicator.up();
          } catch {
            return indicator.down();
          }
        },
        () => {
          const indicator = this.indicators.check('kafkaConsumer');
          if (!this.consumers.enabled) {
            return indicator.up({ enabled: false });
          }
          return this.consumers.isRunning ? indicator.up() : indicator.down();
        },
      ]);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        // Keep terminus' per-check report instead of a generic problem document.
        response.status(503);
        return error.getResponse();
      }
      throw error;
    }
  }
}
