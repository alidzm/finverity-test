import { Injectable } from '@nestjs/common';
import { AppConfig } from '@/config/app-config';
import {
  type FxQuote,
  type PublishedRate,
  SAME_CURRENCY_QUOTE,
  selectQuote,
} from '@/fx/domain/fx-quote';
import type { CurrencyCode } from '@/shared/domain/money/currency';
import { FxRateRepository } from '@/fx/application/ports/fx-rate.repository';

/** Public API of the FX module: quotes for conversions and intake of treasury rates. */
@Injectable()
export class FxRateService {
  constructor(
    private readonly rates: FxRateRepository,
    private readonly config: AppConfig,
  ) {}

  async quote(from: CurrencyCode, to: CurrencyCode, now = new Date()): Promise<FxQuote> {
    if (from === to) {
      return SAME_CURRENCY_QUOTE;
    }
    const published = await this.rates.findPair(from, to);
    return selectQuote(published, from, to, now, this.config.fx.maxRateAgeMs);
  }

  /** Idempotent and order-insensitive: an out-of-date rate never overwrites a newer one. */
  record(rate: PublishedRate): Promise<boolean> {
    return this.rates.saveIfNewer(rate);
  }
}
