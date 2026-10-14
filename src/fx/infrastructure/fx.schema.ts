import { sql } from 'drizzle-orm';
import { char, check, numeric, pgTable, primaryKey, timestamp } from 'drizzle-orm/pg-core';
import type { CurrencyCode } from '@/shared/domain/money/currency';

const currency = (name: string) => char(name, { length: 3 }).$type<CurrencyCode>();
const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });

export const fxRates = pgTable(
  'fx_rates',
  {
    baseCurrency: currency('base_currency').notNull(),
    quoteCurrency: currency('quote_currency').notNull(),
    /** 1 base = rate quote. */
    rate: numeric('rate', { precision: 30, scale: 12 }).notNull(),
    asOf: timestamptz('as_of').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.baseCurrency, t.quoteCurrency] }),
    check('fx_rates_rate_positive', sql`${t.rate} > 0`),
  ],
);
