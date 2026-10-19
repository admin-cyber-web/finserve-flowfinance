import { describe, expect, test } from "bun:test";
import { rowOutstanding } from "../src/lib/finance/schedule";

/**
 * The single definition of "what is still open on an installment".
 *
 * Every outstanding / arrears figure in the app (loanOps, collections,
 * reports, statements, Excel sheets) derives from this helper, so these
 * tests pin the two money rules of a settlement:
 *   - a waived rupee closes the row WITHOUT ever being money received
 *   - `paid` is only ever real cash — the waiver never inflates it
 */

describe("rowOutstanding — waived dues math", () => {
  test("a plain row is unchanged: totalDue − paid, never negative", () => {
    expect(rowOutstanding({ totalDue: 6500, paid: 2000 })).toBe(4500);
    expect(rowOutstanding({ totalDue: 6500, paid: 6500 })).toBe(0);
    // Overpaid (legacy data) clamps to 0 — never a negative balance.
    expect(rowOutstanding({ totalDue: 6500, paid: 7000 })).toBe(0);
  });

  test("a waiver reduces what is open without touching paid", () => {
    const row = { totalDue: 6000, paid: 1000, waived: 500 };
    expect(rowOutstanding(row)).toBe(4500);
    // Cash received is still what was actually paid — 1,000, not 1,500.
    expect(row.paid).toBe(1000);
  });

  test("a fully waived row is settled with zero open balance", () => {
    expect(rowOutstanding({ totalDue: 6000, paid: 0, waived: 6000 })).toBe(0);
    expect(
      rowOutstanding({ totalDue: 6000, paid: 4000, waived: 2000 }),
    ).toBe(0);
  });

  test("a missing waiver behaves exactly like before", () => {
    expect(rowOutstanding({ totalDue: 1000, paid: 0 })).toBe(1000);
    expect(rowOutstanding({ totalDue: 1000, paid: 0, waived: undefined })).toBe(
      1000,
    );
  });

  test("results are rounded to 2 decimals", () => {
    expect(rowOutstanding({ totalDue: 100.005, paid: 0, waived: 0 })).toBe(
      100.01,
    );
  });
});
