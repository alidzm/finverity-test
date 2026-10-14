import type { PublishedRate } from '@/fx/domain/fx-quote';
import type { CurrencyCode } from '@/shared/domain/money/currency';

/** Port: storage of the latest treasury rate per currency pair. */
export abstract class FxRateRepository {
  /** Published rates for the pair, in either direction. */
  abstract findPair(a: CurrencyCode, b: CurrencyCode): Promise<PublishedRate[]>;

  /** Stores the rate unless a newer one (by `asOf`) is already stored; returns whether it was written. */
  abstract saveIfNewer(rate: PublishedRate): Promise<boolean>;
}
