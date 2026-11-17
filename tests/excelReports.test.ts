import { describe, expect, test } from "bun:test";
import {
  buildCollectionRows,
  buildDisbursementRows,
  buildDueDateRows,
  buildOverdueRows,
  bucketIndex,
  istDayStartMs,
  mobMonths,
  overdueDays,
  round2,
  type CollectionFacts,
  type LoanFacts,
  type ScheduleFacts,
} from "../src/lib/finance/excelReports";

/**
 * The four reports on the Reports screen. Everything here is the exact
 * arithmetic the Convex query feeds from the ledgers, so these tests pin the
 * date scoping, MOB, arrear and bucket rules the sheet promises:
 *   - From/To are inclusive IST days
 *   - reversed payments are never counted (no double counting)
 *   - every overdue rupee lands in at most one bucket
 */

const DAY = 86_400_000;
/** 2026-10-01 00:00 IST — a fixed anchor so nothing depends on "today". */
const OCT_1 = istDayStartMs(Date.UTC(2026, 9, 1, 6, 30)); // 12:00 IST → day start
const OCT_1_START = istDayStartMs(OCT_1);
const bounds = { from: OCT_1_START, to: OCT_1_START + 10 * DAY - 1 }; // Oct 1–10 inclusive

const loan = (over: Partial<LoanFacts> = {}): LoanFacts => ({
  loanPk: "loan-1",
  loanId: "LN-000001",
  clientCode: "C-000001",
  customerName: "Sunita Devi",
  centerId: "CNT-MDG",
  centerName: "Madhopur",
  disbursedAt: OCT_1_START - 40 * DAY,
  principal: 25000,
  tenure: 12,
  installment: 2450,
  ...over,
});

const sched = (over: Partial<ScheduleFacts>): ScheduleFacts => ({
  ...loan(),
  dueDate: OCT_1_START,
  totalDue: 2450,
  paid: 0,
  ...over,
});

/* --------------------------- day / MOB helpers --------------------------- */

describe("IST day arithmetic", () => {
  test("istDayStartMs snaps to the IST midnight", () => {
    const ms = Date.UTC(2026, 9, 5, 18, 30); // 2026-10-06 00:00 IST
    expect(new Date(istDayStartMs(ms)).toISOString()).toBe("2026-10-05T18:30:00.000Z");
  });

  test("overdueDays counts calendar days, not 24h blocks", () => {
    const todayNoon = OCT_1_START + 12 * 3_600_000;
    // Due yesterday evening, checked today at noon → 1 day (never 0).
    expect(overdueDays(todayNoon - DAY - 6 * 3_600_000, todayNoon)).toBe(1);
    // Due today → not overdue yet, whatever the hour.
    expect(overdueDays(todayNoon - 3_600_000, todayNoon)).toBe(0);
    expect(overdueDays(todayNoon, todayNoon)).toBe(0);
    expect(overdueDays(todayNoon - 22 * DAY, todayNoon)).toBe(22);
  });

  test("mobMonths counts only completed months", () => {
    const disbursement = OCT_1_START - 40 * DAY; // ~2026-08-22
    expect(mobMonths(disbursement, OCT_1_START)).toBe(1);
    expect(mobMonths(undefined, OCT_1_START)).toBeNull();
    expect(mobMonths(disbursement, disbursement)).toBe(0);
    expect(mobMonths(disbursement, disbursement + 90 * DAY)).toBe(2);
  });

  test("round2 keeps money exact to paise", () => {
    expect(round2(10.005)).toBe(10.01);
    expect(round2(10.004)).toBe(10);
  });
});

/* ---------------------------- 1. Disbursement ---------------------------- */

describe("Disbursement Report", () => {
  const disbursedIn = loan({ loanId: "LN-A", disbursedAt: OCT_1_START + 2 * DAY });
  const disbursedBefore = loan({ loanId: "LN-B", disbursedAt: OCT_1_START - DAY });
  const disbursedAfter = loan({ loanId: "LN-C", disbursedAt: OCT_1_START + 11 * DAY });
  const neverDisbursed = loan({ loanId: "LN-D", disbursedAt: undefined });

  test("keeps only loans disbursed inside the inclusive range, oldest first", () => {
    const rows = buildDisbursementRows(
      [disbursedAfter, disbursedIn, neverDisbursed, disbursedBefore],
      bounds,
    );
    expect(rows.map((r) => r.loanId)).toEqual(["LN-A"]);
    expect(rows[0].sr).toBe(1);
    expect(rows[0].loanAmount).toBe(25000);
    expect(rows[0].emi).toBe(2450);
    expect(rows[0].tenure).toBe(12);
    expect(rows[0].centerName).toBe("Madhopur");
    expect(rows[0].centerId).toBe("CNT-MDG");
  });

  test("both ends of the range are inclusive", () => {
    const firstDay = loan({ loanId: "LN-FIRST", disbursedAt: OCT_1_START });
    const lastDay = loan({ loanId: "LN-LAST", disbursedAt: bounds.to });
    const rows = buildDisbursementRows([firstDay, lastDay], bounds);
    expect(rows.map((r) => r.loanId)).toEqual(["LN-FIRST", "LN-LAST"]);
    expect(rows.map((r) => r.sr)).toEqual([1, 2]);
  });
});

/* ------------------------------ 2. Collection ---------------------------- */

describe("Collection Report", () => {
  const paid = (over: Partial<CollectionFacts>): CollectionFacts => ({
    ...loan({ loanId: "LN-1" }),
    collectionId: "col-1",
    status: "NORMAL",
    paidAt: OCT_1_START + 3 * DAY,
    paidAmount: 2450,
    ...over,
  });

  test("counts NORMAL payments in range, one row each, with MOB and paid date", () => {
    const rows = buildCollectionRows(
      [
        paid({ collectionId: "c2", paidAt: OCT_1_START + 5 * DAY, paidAmount: 1000 }),
        paid({ collectionId: "c1", paidAt: OCT_1_START + 1 * DAY }),
      ],
      bounds,
    );
    expect(rows.map((r) => r.paidAmount)).toEqual([2450, 1000]); // paidAt order
    expect(rows.map((r) => r.sr)).toEqual([1, 2]);
    expect(rows[0].mob).toBe(1); // disbursed ~40 days before the payment
    expect(rows[0].paidAt).toBe(OCT_1_START + 1 * DAY);
  });

  test("reversed payments and their compensating entries are never counted", () => {
    const rows = buildCollectionRows(
      [
        paid({ collectionId: "ok", paidAmount: 1000 }),
        paid({ collectionId: "reversed", status: "REVERSED", paidAmount: 1000 }),
        paid({ collectionId: "reversal", status: "REVERSAL", paidAmount: -1000 }),
        paid({ collectionId: "flagged", status: "NORMAL", reversalOfId: "col-x" }),
      ],
      bounds,
    );
    expect(rows).toHaveLength(1);
    const total = rows.reduce((s, r) => s + r.paidAmount, 0);
    expect(total).toBe(1000); // net collections = the single NORMAL payment
  });

  test("payments outside the date range are excluded", () => {
    const rows = buildCollectionRows(
      [
        paid({ collectionId: "before", paidAt: OCT_1_START - DAY }),
        paid({ collectionId: "after", paidAt: bounds.to + 1 }),
        paid({ collectionId: "last-day", paidAt: bounds.to }),
      ],
      bounds,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].paidAmount).toBe(2450);
  });
});

/* --------------------------- 3. Due Date Collection ---------------------- */

describe("Due Date Collection", () => {
  test("one row per loan with an installment due in the range; arrear, days and total due", () => {
    const rows = buildDueDateRows(
      [
        // Loan 1: one installment due in the window, plus an older unpaid one.
        sched({
          loanPk: "L1",
          loanId: "LN-1",
          dueDate: OCT_1_START - 5 * DAY,
          totalDue: 2450,
          paid: 0,
        }),
        sched({
          loanPk: "L1",
          loanId: "LN-1",
          dueDate: OCT_1_START + 2 * DAY,
          totalDue: 2450,
          paid: 450, // partially paid — only the remainder counts
        }),
        // Loan 2: nothing due inside the window → no row.
        sched({
          loanPk: "L2",
          loanId: "LN-2",
          dueDate: OCT_1_START + 40 * DAY,
        }),
      ],
      bounds,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].loanId).toBe("LN-1");
    // Both installments are overdue as of the To date (Oct 10): Sep 26 and
    // Oct 3 — the second one only by its unpaid remainder (2450 − 450).
    expect(rows[0].arrear).toBe(4450);
    expect(rows[0].arrearDays).toBe(14); // Sep 26 → Oct 10
    expect(rows[0].totalDueAmount).toBe(4450); // everything unpaid up to Oct 10
    expect(rows[0].mob).toBe(1);
    expect(rows[0].sr).toBe(1);
  });

  test("arrear is always inside total due — never double counted", () => {
    const rows = buildDueDateRows(
      [
        sched({ loanPk: "L1", dueDate: OCT_1_START - 3 * DAY, totalDue: 1000, paid: 400 }),
        // Due ON the To date — inside the window and the total, but not
        // overdue as of the To date (0 days past due).
        sched({ loanPk: "L1", dueDate: bounds.to, totalDue: 1000, paid: 0 }),
      ],
      bounds,
    );
    expect(rows[0].arrear).toBe(600); // only the overdue installment's remainder
    expect(rows[0].totalDueAmount).toBe(1600);
    expect(rows[0].arrear).toBeLessThanOrEqual(rows[0].totalDueAmount);
    expect(rows[0].arrearDays).toBe(12); // Sep 28 → Oct 10
  });

  test("a fully paid in-window loan still reports without arrears", () => {
    const rows = buildDueDateRows(
      [
        sched({
          loanPk: "L1",
          dueDate: OCT_1_START + 1 * DAY,
          totalDue: 2450,
          paid: 2450,
        }),
      ],
      bounds,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].arrear).toBe(0);
    expect(rows[0].arrearDays).toBe(0);
    expect(rows[0].totalDueAmount).toBe(0);
  });
});

/* ---------------------------- 4. Overdue ------------------------------- */

describe("Overdue Report buckets", () => {
  test("bucketIndex partitions 1–7 / 8–15 / 16–22 with no overlap", () => {
    expect(bucketIndex(0)).toBeNull(); // due today
    expect(bucketIndex(1)).toBe(0);
    expect(bucketIndex(7)).toBe(0);
    expect(bucketIndex(8)).toBe(1);
    expect(bucketIndex(15)).toBe(1);
    expect(bucketIndex(16)).toBe(2);
    expect(bucketIndex(22)).toBe(2);
    expect(bucketIndex(23)).toBeNull(); // past the sheet's last bucket
  });

  test("each overdue rupee lands in exactly one bucket", () => {
    const rows = buildOverdueRows(
      [
        // Ages measured as of the To date (Oct 10): 3, 10, 20 and 9 days.
        sched({ loanPk: "L1", loanId: "LN-1", dueDate: OCT_1_START + 7 * DAY, totalDue: 1000, paid: 0 }), // 3d
        sched({ loanPk: "L1", loanId: "LN-1", dueDate: OCT_1_START - DAY, totalDue: 2000, paid: 500 }), // 10d
        sched({ loanPk: "L1", loanId: "LN-1", dueDate: OCT_1_START - 11 * DAY, totalDue: 3000, paid: 0 }), // 20d
        sched({ loanPk: "L1", loanId: "LN-1", dueDate: OCT_1_START - 2 * DAY, totalDue: 1500, paid: 1500 }), // paid → nothing
        sched({ loanPk: "L1", loanId: "LN-1", dueDate: bounds.to, totalDue: 1000, paid: 0 }), // due on To date → not overdue
      ],
      bounds,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bkt1).toBe(1000); // only the 3-day installment
    expect(rows[0].bkt2).toBe(1500); // 2000 − 500
    expect(rows[0].bkt3).toBe(3000);
    // The three buckets together equal the loan's total overdue remainder…
    expect(round2(rows[0].bkt1 + rows[0].bkt2 + rows[0].bkt3)).toBe(5500);
    // …and nothing already paid or not yet due leaked in (5500, not 7000/8000).
  });

  test("arrears older than 22 days stay out of the three buckets", () => {
    const rows = buildOverdueRows(
      [
        // 29 days old as of the To date — past the sheet's last bucket.
        sched({ loanPk: "L1", loanId: "LN-1", dueDate: OCT_1_START - 20 * DAY, totalDue: 4000, paid: 0 }),
        // 1 day old as of the To date → BKT 1.
        sched({ loanPk: "L2", loanId: "LN-2", dueDate: OCT_1_START + 8 * DAY, totalDue: 500, paid: 0 }),
      ],
      bounds,
    );
    // Both overdue loans are listed (it is the overdue book), but the 29-day
    // arrear is not spread across 1–22-day buckets.
    expect(rows.map((r) => r.loanId)).toEqual(["LN-1", "LN-2"]); // most overdue first
    const old = rows.find((r) => r.loanId === "LN-1")!;
    expect(old.bkt1 + old.bkt2 + old.bkt3).toBe(0);
    const fresh = rows.find((r) => r.loanId === "LN-2")!;
    expect(fresh.bkt1).toBe(500);
  });

  test("loans with nothing overdue are excluded", () => {
    const rows = buildOverdueRows(
      [
        sched({ loanPk: "L1", dueDate: bounds.to, totalDue: 1000, paid: 0 }), // due on To date
        sched({ loanPk: "L2", dueDate: OCT_1_START - 4 * DAY, totalDue: 1000, paid: 1000 }), // paid
        sched({ loanPk: "L3", dueDate: OCT_1_START + 40 * DAY, totalDue: 1000, paid: 0 }), // future
      ],
      bounds,
    );
    expect(rows).toHaveLength(0);
  });

  test("settlement waivers produce no arrears — waived is not open money", () => {
    const rows = buildOverdueRows(
      [
        // Fully waived by an approved settlement: nothing was ever paid,
        // but nothing is open either — it must not enter the arrears book.
        sched({ loanPk: "L1", loanId: "LN-1", dueDate: OCT_1_START - DAY, totalDue: 2000, paid: 0, waived: 2000 }),
        // Partially waived: only the uncovered remainder counts as arrears.
        sched({ loanPk: "L2", loanId: "LN-2", dueDate: OCT_1_START - DAY, totalDue: 3000, paid: 1000, waived: 500 }),
      ],
      bounds,
    );
    expect(rows.map((r) => r.loanId)).toEqual(["LN-2"]);
    expect(rows[0].bkt1 + rows[0].bkt2 + rows[0].bkt3).toBe(1500); // 3000 − 1000 − 500
  });
});

describe("Due Date report — waived dues", () => {
  test("a fully waived installment reports with zero due and zero arrears", () => {
    const rows = buildDueDateRows(
      [
        sched({
          loanPk: "L1",
          dueDate: OCT_1_START + 2 * DAY, // inside the From–To window
          totalDue: 2000,
          paid: 0,
          waived: 2000,
        }),
      ],
      bounds,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].arrear).toBe(0);
    expect(rows[0].totalDueAmount).toBe(0);
  });

  test("a partially waived installment counts only the uncovered remainder", () => {
    const rows = buildDueDateRows(
      [
        sched({
          loanPk: "L1",
          dueDate: OCT_1_START + 2 * DAY, // inside the From–To window
          totalDue: 3000,
          paid: 1000,
          waived: 500,
        }),
      ],
      bounds,
    );
    expect(rows[0].arrear).toBe(1500);
    expect(rows[0].totalDueAmount).toBe(1500);
  });
});
