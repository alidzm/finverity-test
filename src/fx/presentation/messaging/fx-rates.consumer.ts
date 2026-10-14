import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '@/config/app-config';
import { FxRateService } from '@/fx/application/fx-rate.service';
import {
  type InboundMessage,
  MessageConsumer,
  type MessageHandler,
} from '@/shared/application/messaging/inbound-message';
import { assertSupportedCurrency } from '@/shared/domain/money/currency';
import { decodeMessage } from '@/shared/presentation/messaging/decode-message';
import { FxRateMessageSchema } from './fx-rate.messages';

/** Inbound adapter for `treasury.fx-rates.v1`. Idempotent: stale rates are ignored. */
@MessageConsumer()
@Injectable()
export class FxRatesConsumer implements MessageHandler {
  private readonly logger = new Logger(FxRatesConsumer.name);
  readonly topic: string;

  constructor(
    config: AppConfig,
    private readonly fx: FxRateService,
  ) {
    this.topic = config.kafka.topics.fxRates;
  }

  async handle(message: InboundMessage): Promise<void> {
    const { payload } = decodeMessage(message, FxRateMessageSchema);
    const applied = await this.fx.record({
      base: assertSupportedCurrency(payload.base),
      quote: assertSupportedCurrency(payload.quote),
      rate: payload.rate,
      asOf: new Date(payload.asOf),
    });
    this.logger.log(
      { pair: `${payload.base}/${payload.quote}`, rate: payload.rate, asOf: payload.asOf, applied },
      'FX rate processed',
    );
  }
}
