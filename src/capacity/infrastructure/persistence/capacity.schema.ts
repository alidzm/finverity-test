import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { CHANGE_SOURCES } from '@/capacity/domain/change-source';
import { LEDGER_ENTRY_TYPES } from '@/capacity/domain/ledger';
import { PROGRAM_STATUSES } from '@/capacity/domain/program';
import { RESERVATION_STATUSES } from '@/capacity/domain/reservation';
import type { CurrencyCode } from '@/shared/domain/money/currency';

// Monetary amounts are integer minor units (see docs/ARCHITECTURE.md §2.2).
const minorUnits = (name: string) => bigint(name, { mode: 'bigint' });
const currency = (name: string) => char(name, { length: 3 }).$type<CurrencyCode>();
// Millisecond precision matches JS Date exactly, so keyset cursors round-trip losslessly.
const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });

export const programs = pgTable(
  'programs',
  {
    id: text('id').primaryKey(),
    currency: currency('currency').notNull(),
    creditLimitMinor: minorUnits('credit_limit_minor').notNull(),
    reservedMinor: minorUnits('reserved_minor')
      .notNull()
      .default(sql`0`),
    status: text('status', { enum: PROGRAM_STATUSES }).notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    treasurySequence: bigint('treasury_sequence', { mode: 'number' }).notNull().default(0),
    lastReconciledAt: timestamptz('last_reconciled_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('programs_credit_limit_non_negative', sql`${t.creditLimitMinor} >= 0`),
    check('programs_reserved_non_negative', sql`${t.reservedMinor} >= 0`),
    check('programs_status_valid', sql`${t.status} in ('ACTIVE', 'SUSPENDED')`),
  ],
);

export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: text('program_id')
      .notNull()
      .references(() => programs.id),
    invoiceId: text('invoice_id').notNull(),
    /** Denormalised from the program (immutable there) so reservation reads need no join. */
    programCurrency: currency('program_currency').notNull(),
    invoiceCurrency: currency('invoice_currency').notNull(),
    invoiceAmountMinor: minorUnits('invoice_amount_minor').notNull(),
    fxRate: numeric('fx_rate', { precision: 30, scale: 12 }),
    fxRateAsOf: timestamptz('fx_rate_as_of'),
    reservedMinor: minorUnits('reserved_minor').notNull(),
    releasedMinor: minorUnits('released_minor')
      .notNull()
      .default(sql`0`),
    releasedInvoiceMinor: minorUnits('released_invoice_minor')
      .notNull()
      .default(sql`0`),
    status: text('status', { enum: RESERVATION_STATUSES }).notNull(),
    source: text('source', { enum: CHANGE_SOURCES }).notNull(),
    discrepancy: boolean('discrepancy').notNull().default(false),
    apiModifiedAt: timestamptz('api_modified_at'),
    createdBy: text('created_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reservations_program_invoice_uq').on(t.programId, t.invoiceId),
    index('reservations_program_status_idx').on(t.programId, t.status),
    index('reservations_program_created_idx').on(t.programId, t.createdAt, t.id),
    check('reservations_invoice_amount_positive', sql`${t.invoiceAmountMinor} > 0`),
    check('reservations_reserved_non_negative', sql`${t.reservedMinor} >= 0`),
    check(
      'reservations_released_within_reserved',
      sql`${t.releasedMinor} >= 0 and ${t.releasedMinor} <= ${t.reservedMinor}`,
    ),
    check(
      'reservations_released_invoice_within_amount',
      sql`${t.releasedInvoiceMinor} >= 0 and ${t.releasedInvoiceMinor} <= ${t.invoiceAmountMinor}`,
    ),
    check('reservations_status_valid', sql`${t.status} in ('ACTIVE', 'RELEASED')`),
    check('reservations_source_valid', sql`${t.source} in ('API', 'TREASURY')`),
  ],
);

export const reservationReleases = pgTable(
  'reservation_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: text('program_id')
      .notNull()
      .references(() => programs.id),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id),
    releaseId: text('release_id').notNull(),
    invoiceAmountMinor: minorUnits('invoice_amount_minor').notNull(),
    programAmountMinor: minorUnits('program_amount_minor').notNull(),
    source: text('source', { enum: CHANGE_SOURCES }).notNull(),
    createdBy: text('created_by'),
    correlationId: text('correlation_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reservation_releases_program_release_uq').on(t.programId, t.releaseId),
    index('reservation_releases_reservation_idx').on(t.reservationId),
    check(
      'reservation_releases_amounts_valid',
      sql`${t.invoiceAmountMinor} >= 0 and ${t.programAmountMinor} >= 0`,
    ),
  ],
);

/** Append-only journal explaining every change of a program's limit or reserved amount. */
export const capacityLedger = pgTable(
  'capacity_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    programId: text('program_id')
      .notNull()
      .references(() => programs.id),
    entryType: text('entry_type', { enum: LEDGER_ENTRY_TYPES }).notNull(),
    reservationId: uuid('reservation_id').references(() => reservations.id),
    deltaReservedMinor: minorUnits('delta_reserved_minor')
      .notNull()
      .default(sql`0`),
    deltaCreditLimitMinor: minorUnits('delta_credit_limit_minor')
      .notNull()
      .default(sql`0`),
    reservedAfterMinor: minorUnits('reserved_after_minor').notNull(),
    creditLimitAfterMinor: minorUnits('credit_limit_after_minor').notNull(),
    source: text('source', { enum: CHANGE_SOURCES }).notNull(),
    actor: text('actor'),
    correlationId: text('correlation_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('capacity_ledger_program_idx').on(t.programId, t.id)],
);
