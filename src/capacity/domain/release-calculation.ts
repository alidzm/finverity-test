/** The reservation fields that release math depends on (all in minor units). */
export interface ReleasableReservation {
  invoiceAmountMinor: bigint;
  reservedMinor: bigint;
  releasedMinor: bigint;
  releasedInvoiceMinor: bigint;
}

export interface ReleaseComputation {
  /** Capacity returned to the program, in program currency. */
  programAmountMinor: bigint;
  releasedMinorAfter: bigint;
  releasedInvoiceMinorAfter: bigint;
  fullyReleased: boolean;
}

/**
 * Computes the program-currency amount freed by releasing `releaseInvoiceMinor`
 * (invoice currency) of a reservation.
 *
 * The released total is derived cumulatively from the share of the invoice repaid so far:
 *
 *   releasedTotal = floor(reserved × releasedInvoiceTotal / invoiceAmount)
 *
 * This is equivalent to applying the rate locked at reservation time, never re-converts
 * at a current rate (FX moves cannot leak or mint capacity), does not accumulate rounding
 * error over many partial repayments, and releases exactly the remainder on the final one.
 * The caller validates that `releaseInvoiceMinor` does not exceed the outstanding amount.
 */
export function computeRelease(
  reservation: ReleasableReservation,
  releaseInvoiceMinor: bigint,
): ReleaseComputation {
  const releasedInvoiceMinorAfter = reservation.releasedInvoiceMinor + releaseInvoiceMinor;
  const fullyReleased = releasedInvoiceMinorAfter >= reservation.invoiceAmountMinor;

  const proportional =
    (reservation.reservedMinor * releasedInvoiceMinorAfter) / reservation.invoiceAmountMinor;
  // Reconciliation may have set released amounts that do not follow the proportional
  // formula exactly; never move the released total backwards or beyond the reservation.
  const releasedMinorAfter = fullyReleased
    ? reservation.reservedMinor
    : clamp(proportional, reservation.releasedMinor, reservation.reservedMinor);

  return {
    programAmountMinor: releasedMinorAfter - reservation.releasedMinor,
    releasedMinorAfter,
    releasedInvoiceMinorAfter: fullyReleased
      ? reservation.invoiceAmountMinor
      : releasedInvoiceMinorAfter,
    fullyReleased,
  };
}

function clamp(value: bigint, min: bigint, max: bigint): bigint {
  return value < min ? min : value > max ? max : value;
}
