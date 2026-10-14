import { z } from 'zod';
import { PROGRAM_STATUSES } from '@/capacity/domain/program';

// Contract of the inbound `treasury.program-capacity.v1` topic (assumed; see ARCHITECTURE.md §3).

const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
const Decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const Currency = z.string().regex(/^[A-Z]{3}$/);
const Timestamp = z.iso.datetime({ offset: true });
const Money = z.object({ value: Decimal, currency: Currency });

const programEnvelope = {
  messageId: z.string().min(1).max(128),
  schemaVersion: z.literal(1),
  programId: Identifier,
  /** Per-program monotonic sequence assigned by treasury. */
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  occurredAt: Timestamp,
};

export const ProgramCapacityMessageSchema = z.discriminatedUnion('type', [
  z.object({
    ...programEnvelope,
    type: z.literal('ProgramUpserted'),
    payload: z.object({
      currency: Currency,
      creditLimit: Decimal,
      status: z.enum(PROGRAM_STATUSES),
    }),
  }),
  z.object({
    ...programEnvelope,
    type: z.literal('RepaymentReceived'),
    payload: z.object({
      invoiceId: Identifier,
      repaymentId: Identifier,
      amount: Money,
    }),
  }),
  z.object({
    ...programEnvelope,
    type: z.literal('ProgramReconciled'),
    payload: z.object({
      asOf: Timestamp,
      currency: Currency,
      creditLimit: Decimal,
      status: z.enum(PROGRAM_STATUSES),
      reservations: z
        .array(
          z.object({
            invoiceId: Identifier,
            invoiceAmount: Money,
            reservedAmount: Decimal,
            releasedAmount: Decimal,
            releasedInvoiceAmount: Decimal,
          }),
        )
        .max(100_000),
    }),
  }),
]);

export type ProgramCapacityMessage = z.output<typeof ProgramCapacityMessageSchema>;
