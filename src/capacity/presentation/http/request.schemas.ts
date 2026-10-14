import { z } from 'zod';
import { RESERVATION_STATUSES } from '@/capacity/domain/reservation';

/** External identifiers (program, invoice, release ids): conservative charset, bounded length. */
const Identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/, 'must be 1-128 chars of [A-Za-z0-9._:/-]');

export const MoneySchema = z.strictObject({
  value: z
    .string()
    .regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'must be a non-negative decimal string, e.g. "1250.00"')
    .meta({ example: '1250.00' }),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code')
    .meta({ example: 'EUR' }),
});

export const ProgramParamsSchema = z.object({ programId: Identifier });
export const ReservationParamsSchema = z.object({ programId: Identifier, invoiceId: Identifier });

export const CreateReservationBodySchema = z.strictObject({
  invoiceId: Identifier.meta({ example: 'INV-2026-000123' }),
  amount: MoneySchema.describe('Invoice amount in the invoice currency'),
});

export const CreateReleaseBodySchema = z.strictObject({
  releaseId: Identifier.describe('Repayment id; idempotency key of the release').meta({
    example: 'RPM-000987',
  }),
  amount: MoneySchema.optional().describe(
    'Amount repaid, in the invoice currency. Omit to release everything still outstanding.',
  ),
});

const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const ListProgramsQuerySchema = PageQuery;

export const ListReservationsQuerySchema = PageQuery.extend({
  status: z.enum(RESERVATION_STATUSES).optional(),
  discrepancy: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export type CreateReservationBody = z.output<typeof CreateReservationBodySchema>;
export type CreateReleaseBody = z.output<typeof CreateReleaseBodySchema>;
export type ListProgramsQuery = z.output<typeof ListProgramsQuerySchema>;
export type ListReservationsQueryParams = z.output<typeof ListReservationsQuerySchema>;
