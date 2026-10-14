import type { Program } from '@/capacity/domain/program';
import { formatAmount } from '@/shared/domain/money/money';

/**
 * Output model of a program's capacity, shared by every adapter: HTTP responses, the SSE
 * stream and outbound events. Amounts are decimal strings in the program currency.
 */
export interface CapacityDto {
  programId: string;
  currency: string;
  creditLimit: string;
  reserved: string;
  /** May be negative when treasury lowered the limit below the reserved amount. */
  available: string;
  status: string;
  version: number;
  lastReconciledAt: string | null;
  updatedAt: string;
}

export function toCapacityDto(program: Program): CapacityDto {
  return {
    programId: program.id,
    currency: program.currency,
    creditLimit: formatAmount(program.creditLimitMinor, program.currency),
    reserved: formatAmount(program.reservedMinor, program.currency),
    available: formatAmount(program.availableMinor, program.currency),
    status: program.status,
    version: program.version,
    lastReconciledAt: program.lastReconciledAt?.toISOString() ?? null,
    updatedAt: program.updatedAt.toISOString(),
  };
}
