import { computeRelease, type ReleasableReservation } from './release-calculation';

function reservation(overrides: Partial<ReleasableReservation> = {}): ReleasableReservation {
  // 1,000.00 EUR reserved as 1,083.45 USD
  return {
    invoiceAmountMinor: 100000n,
    reservedMinor: 108345n,
    releasedMinor: 0n,
    releasedInvoiceMinor: 0n,
    ...overrides,
  };
}

describe('computeRelease', () => {
  it('releases everything on a full repayment', () => {
    expect(computeRelease(reservation(), 100000n)).toEqual({
      programAmountMinor: 108345n,
      releasedMinorAfter: 108345n,
      releasedInvoiceMinorAfter: 100000n,
      fullyReleased: true,
    });
  });

  it('releases proportionally (rounded down) on a partial repayment', () => {
    // 333.33 EUR of 1,000.00 → floor(108345 × 33333 / 100000) = 36114
    const result = computeRelease(reservation(), 33333n);
    expect(result.programAmountMinor).toBe(36114n);
    expect(result.fullyReleased).toBe(false);
  });

  it('never leaves dust after many partial repayments', () => {
    let state = reservation();
    let releasedTotal = 0n;
    // three repayments of 333.33 and a final 0.01
    for (const part of [33333n, 33333n, 33333n, 1n]) {
      const result = computeRelease(state, part);
      releasedTotal += result.programAmountMinor;
      state = {
        ...state,
        releasedMinor: result.releasedMinorAfter,
        releasedInvoiceMinor: result.releasedInvoiceMinorAfter,
      };
    }
    expect(releasedTotal).toBe(108345n);
    expect(state.releasedMinor).toBe(state.reservedMinor);
  });

  it('does not move backwards when reconciliation set a higher released amount', () => {
    // Treasury reported 600.00 USD released for 500.00 EUR repaid (not proportional).
    const result = computeRelease(
      reservation({ releasedMinor: 60000n, releasedInvoiceMinor: 50000n }),
      1000n,
    );
    expect(result.programAmountMinor).toBe(0n);
    expect(result.releasedMinorAfter).toBe(60000n);
  });
});
