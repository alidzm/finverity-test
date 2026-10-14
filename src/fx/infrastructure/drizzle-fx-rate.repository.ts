import { Injectable } from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import { FxRateRepository } from '@/fx/application/ports/fx-rate.repository';
import type { PublishedRate } from '@/fx/domain/fx-quote';
import type { CurrencyCode } from '@/shared/domain/money/currency';
import { DrizzleTransactionManager } from '@/shared/infrastructure/database/drizzle-transaction-manager';
import { fxRates } from './fx.schema';

@Injectable()
export class DrizzleFxRateRepository extends FxRateRepository {
  constructor(private readonly drizzle: DrizzleTransactionManager) {
    super();
  }

  async findPair(a: CurrencyCode, b: CurrencyCode): Promise<PublishedRate[]> {
    const rows = await this.drizzle.executor
      .select()
      .from(fxRates)
      .where(
        or(
          and(eq(fxRates.baseCurrency, a), eq(fxRates.quoteCurrency, b)),
          and(eq(fxRates.baseCurrency, b), eq(fxRates.quoteCurrency, a)),
        ),
      );
    return rows.map((row) => ({
      base: row.baseCurrency,
      quote: row.quoteCurrency,
      rate: row.rate,
      asOf: row.asOf,
    }));
  }

  async saveIfNewer(rate: PublishedRate): Promise<boolean> {
    const written = await this.drizzle.executor
      .insert(fxRates)
      .values({
        baseCurrency: rate.base,
        quoteCurrency: rate.quote,
        rate: rate.rate,
        asOf: rate.asOf,
      })
      .onConflictDoUpdate({
        target: [fxRates.baseCurrency, fxRates.quoteCurrency],
        set: { rate: sql`excluded.rate`, asOf: sql`excluded.as_of`, updatedAt: sql`now()` },
        setWhere: sql`${fxRates.asOf} < excluded.as_of`,
      })
      .returning({ base: fxRates.baseCurrency });
    return written.length > 0;
  }
}
