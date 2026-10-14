import type { Release, Reservation } from '@/capacity/domain/reservation';
import type { CurrencyCode } from '@/shared/domain/money/currency';
import { formatAmount } from '@/shared/domain/money/money';

/** Monetary amount on the wire: a decimal string plus its currency. */
export interface MoneyDto {
  value: string;
  currency: string;
}

export interface ReleaseDto {
  releaseId: string;
  invoiceId: string;
  releasedInvoiceAmount: MoneyDto;
  releasedAmount: MoneyDto;
  source: string;
  createdAt: string;
}

export interface ReservationDto {
  id: string;
  programId: string;
  invoiceId: string;
  status: string;
  invoiceAmount: MoneyDto;
  /** Capacity held, in program currency (fixed at reservation time). */
  reservedAmount: MoneyDto;
  releasedAmount: MoneyDto;
  outstandingAmount: MoneyDto;
  releasedInvoiceAmount: MoneyDto;
  fxRate: string | null;
  fxRateAsOf: string | null;
  source: string;
  discrepancy: boolean;
  createdAt: string;
  updatedAt: string;
  releases?: ReleaseDto[];
}

export function toReservationDto(reservation: Reservation, releases?: Release[]): ReservationDto {
  const { programCurrency, invoiceCurrency } = reservation;
  return {
    id: reservation.id,
    programId: reservation.programId,
    invoiceId: reservation.invoiceId,
    status: reservation.status,
    invoiceAmount: money(reservation.invoiceAmountMinor, invoiceCurrency),
    reservedAmount: money(reservation.reservedMinor, programCurrency),
    releasedAmount: money(reservation.releasedMinor, programCurrency),
    outstandingAmount: money(reservation.outstandingMinor, programCurrency),
    releasedInvoiceAmount: money(reservation.releasedInvoiceMinor, invoiceCurrency),
    fxRate: reservation.fxRate === null ? null : trimRate(reservation.fxRate),
    fxRateAsOf: reservation.fxRateAsOf?.toISOString() ?? null,
    source: reservation.source,
    discrepancy: reservation.discrepancy,
    createdAt: reservation.createdAt.toISOString(),
    updatedAt: reservation.updatedAt.toISOString(),
    ...(releases
      ? { releases: releases.map((release) => toReleaseDto(release, reservation)) }
      : {}),
  };
}

export function toReleaseDto(release: Release, reservation: Reservation): ReleaseDto {
  return {
    releaseId: release.releaseId,
    invoiceId: reservation.invoiceId,
    releasedInvoiceAmount: money(release.invoiceAmountMinor, reservation.invoiceCurrency),
    releasedAmount: money(release.programAmountMinor, reservation.programCurrency),
    source: release.source,
    createdAt: release.createdAt.toISOString(),
  };
}

function money(minor: bigint, currency: CurrencyCode): MoneyDto {
  return { value: formatAmount(minor, currency), currency };
}

/** `1.083450000000` → `1.08345` */
function trimRate(rate: string): string {
  return rate.includes('.') ? rate.replace(/\.?0+$/, '') : rate;
}
