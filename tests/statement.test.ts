import { describe, expect, test } from "bun:test";
import { istDayStartMs } from "../src/lib/finance/excelReports";
import {
  buildCombinedStatement,
  buildLoanStatement,
  resolveClientMatches,
  LEDGER_TYPE_LABELS,
  type StatementLoan,
} from "../src/lib/finance/statement";

/**
 * Reports → Statement engine. These tests pin the promises the screen makes:
 *   - a query only ever matches exact stored IDs (ambiguity lists candidates)
 *   - the ledger's running balance always ends at Σ max(0, totalDue − paid)
 *   - reversed payments + their refunds net to zero — never double counted
 *   - "No Upcoming Dues" only when the real schedule has no open row
 *   - a period's summary reconciles: opening + disbursement − paid = closing
 */

const DAY = 86_400_000;
/** 2026-10-01 00:00 IST — fixed anchor so nothing depends on "today". */
const OCT_1 = istDayStartMs(Date.UTC(2026, 9, 1, 6, 30));
const NOW = OCT_1 + 20 * DAY;

const row = (over: {
  index: number;
  dueDate: number;
  totalDue?: number;
  paid?: number;
  principal?: number;
  interest?: number;
}) => ({
  _id: `s${over.index}`,
  index: over.index,
  dueDate: over.dueDate,
  principal: over.principal ?? 5000,
  interest: over.interest ?? 1500,
  totalDue: over.totalDue ?? 6500,
  paid: over.paid ?? 0,
});

const pay = (over: {
  _id: string;
  createdAt: number;
  amount: number;
  status?: string;
  reversalOfId?: string;
  principalPortion?: number;
  interestPortion?: number;
  code?: string;
  receiptNumber?: string;
  mode?: string;
  staffId?: string;
  remarks?: string;
}) => ({
  _id: over._id,
  code: over.code ?? `PY-${over._id}`,
  createdAt: over.createdAt,
  amount: over.amount,
  principalPortion: over.principalPortion ?? over.amount,
  interestPortion: over.interestPortion ?? 0,
  mode: over.mode ?? "CASH",
  status: over.status ?? "NORMAL",
  reversalOfId: over.reversalOfId,
  receiptNumber: over.receiptNumber,
  staffId: over.staffId ?? "staff-1",
  remarks: over.remarks,
});

const loanFixture = (over: Partial<StatementLoan> = {}): StatementLoan => ({
  _id: "loan-1",
  loanId: "LN-000001",
  clientId: "client-1",
  productId: "prod-1",
  staffId: "staff-1",
  branchId: "branch-1",
  principal: 25000,
  charges: 1000,
  totalPayable: 27000,
  installment: 6750,
  frequency: "MONTHLY",
  tenure: 4,
  interestRate: 24,
  interestMethod: "FLAT",
  status: "ACTIVE",
  outstanding: 27000,
  paidTotal: 0,
  disbursedAt: OCT_1 - 10 * DAY,
  approvedAt: OCT_1 - 11 * DAY,
  createdAt: OCT_1 - 15 * DAY,
  // Receivable 26,000: charges financed into the first installment, exactly
  // as `baseScheduleRows` writes them (5,000 + 1,500 + 1,000 charged).
  schedule: [
    row({ index: 1, dueDate: OCT_1 - 5 * DAY, totalDue: 7500, paid: 7500, principal: 6000, interest: 1500 }),
    row({ index: 2, dueDate: OCT_1 + 5 * DAY, totalDue: 6500, paid: 6500 }),
    row({ index: 3, dueDate: OCT_1 + 25 * DAY, totalDue: 6000, paid: 0 }),
    row({ index: 4, dueDate: OCT_1 + 45 * DAY, totalDue: 6000, paid: 0 }),
  ],
  collections: [
    pay({ _id: "p1", createdAt: OCT_1 - 4 * DAY, amount: 7500 }),
    pay({ _id: "p2", createdAt: OCT_1 + 6 * DAY, amount: 6500, principalPortion: 5000, interestPortion: 1500 }),
  ],
  receipts: [],
  ...over,
});

/* ------------------------------ ID search -------------------------------- */

describe("resolveClientMatches", () => {
  const clients = [
    { _id: "c1", code: "C-000128", name: "Sunita Devi", mobile: "9876543210" },
    { _id: "c2", code: "C-000129", name: "Rekha Yadav" },
  ];
  const loansByClient = { c1: ["LN-000123"], c2: ["LN-000124", "LN-000125"] };

  test("matches a Client ID exactly, case-insensitively", () => {
    const m = resolveClientMatches(clients, loansByClient, "  c-000128 ");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ clientId: "c1", matchedOn: "CLIENT_ID" });
  });

  test("matches a LAN / Loan ID to the owning client", () => {
    const m = resolveClientMatches(clients, loansByClient, "ln-000125");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ clientId: "c2", matchedOn: "LAN" });
    expect(m[0].loanIds).toEqual(["LN-000124", "LN-000125"]);
  });

  test("an ambiguous query lists every candidate — never one silently", () => {
    const dup = [
      { _id: "c1", code: "C-000128", name: "A" },
      { _id: "c2", code: "C-000129", name: "B" },
    ];
    const dupLoans = { c1: ["LN-000777"], c2: ["LN-000777"] };
    const m = resolveClientMatches(dup, dupLoans, "LN-000777");
    expect(m.map((x) => x.clientId)).toEqual(["c1", "c2"]);
  });

  test("a partial or fuzzy ID never matches", () => {
    expect(resolveClientMatches(clients, loansByClient, "C-0001")).toHaveLength(0);
    expect(resolveClientMatches(clients, loansByClient, "128")).toHaveLength(0);
    expect(resolveClientMatches(clients, loansByClient, "Sunita")).toHaveLength(0);
    expect(resolveClientMatches(clients, loansByClient, "   ")).toHaveLength(0);
  });
});

/* ------------------------------- Ledger ---------------------------------- */

describe("buildLoanStatement — ledger & reconciliation", () => {
  test("full-history ledger is chronological and the balance ends exactly at Σ max(0, totalDue − paid)", () => {
    const l = loanFixture();
    const s = buildLoanStatement(l, {}, NOW);
    expect(s.ledger.map((r) => r.type)).toEqual([
      "DISBURSEMENT",
      "INSTALLMENT_DUE",
      "PAYMENT", // p1 (Sep-27) lands right after inst-1's due date (Sep-26)
      "INSTALLMENT_DUE",
      "PAYMENT", // p2 (Oct-7) after inst-2's due date (Oct-6)
      "INSTALLMENT_DUE",
      "INSTALLMENT_DUE",
    ]);
    const expectedOutstanding = l.schedule.reduce(
      (sum, r) => sum + Math.max(0, r.totalDue - r.paid),
      0,
    );
    expect(s.summary.closingOutstanding).toBe(expectedOutstanding); // 12,000
    expect(s.ledger[s.ledger.length - 1].balanceAfter).toBe(expectedOutstanding);
    expect(s.repayment.outstanding).toBe(expectedOutstanding);
  });

  test("disbursement opens the receivable (Σ totalDue incl. financed charges)", () => {
    const s = buildLoanStatement(loanFixture(), {}, NOW);
    const disb = s.ledger[0];
    expect(disb.type).toBe("DISBURSEMENT");
    expect(disb.balanceAfter).toBe(26000); // 7,500 + 6,500 + 6,000 + 6,000
    expect(s.summary.disbursementInPeriod).toBe(26000);
    expect(s.summary.disbursedAmount).toBe(25000); // sanctioned cash
  });

  test("installment-due rows never move the balance — and show account-truth for their date", () => {
    const s = buildLoanStatement(loanFixture(), {}, NOW);
    for (let i = 1; i < s.ledger.length; i++) {
      const prev = s.ledger[i - 1];
      const cur = s.ledger[i];
      if (cur.type !== "INSTALLMENT_DUE") continue;
      // A demand notice changes nothing — only a counted payment can.
      expect(cur.balanceAfter).toBe(prev.balanceAfter);
      expect(cur.counted).toBe(false);
    }
    // inst-3 falls after p1 + p2 were counted, so it shows the balance
    // as of ITS date — not the stale post-disbursement figure.
    const inst3 = s.ledger.find((r) => r.id === "due-loan-1-s3");
    expect(inst3?.balanceAfter).toBe(12000); // 26,000 − 7,500 − 6,500
  });

  test("reversed original + its REVERSAL entry net to zero and leave the totals alone", () => {
    const l = loanFixture({
      collections: [
        pay({ _id: "p1", createdAt: OCT_1 - 4 * DAY, amount: 7500 }),
        // p2 was later reversed: original flipped + refund entry booked.
        pay({ _id: "p2", createdAt: OCT_1 + 6 * DAY, amount: 6500, status: "REVERSED" }),
        pay({
          _id: "r1",
          createdAt: OCT_1 + 8 * DAY,
          amount: 6500,
          status: "REVERSAL",
          reversalOfId: "p2",
        }),
      ],
      schedule: [
        row({ index: 1, dueDate: OCT_1 - 5 * DAY, totalDue: 7500, paid: 7500 }),
        row({ index: 2, dueDate: OCT_1 + 5 * DAY, totalDue: 6500, paid: 0 }),
        row({ index: 3, dueDate: OCT_1 + 25 * DAY, totalDue: 6000, paid: 0 }),
        row({ index: 4, dueDate: OCT_1 + 45 * DAY, totalDue: 6000, paid: 0 }),
      ],
    });
    const s = buildLoanStatement(l, {}, NOW);
    expect(s.summary.totalPaid).toBe(7500); // only p1 survives
    expect(s.summary.adjustments).toBe(6500); // refund shown as memo
    // Reversed pair leaves the running balance untouched; closing reconciles.
    const closing = s.ledger[s.ledger.length - 1].balanceAfter;
    expect(closing).toBe(18500); // 26,000 − 7,500
    expect(s.summary.closingOutstanding).toBe(18500);
    const reversedRow = s.ledger.find((r) => r.id === "pay-loan-1-p2");
    const refundRow = s.ledger.find((r) => r.id === "pay-loan-1-r1");
    expect(reversedRow?.counted).toBe(false);
    expect(refundRow?.type).toBe("REVERSAL");
    expect(refundRow?.counted).toBe(false);
  });

  test("a NORMAL row carrying reversalOfId is excluded (Collection Report rule)", () => {
    const l = loanFixture({
      collections: [
        pay({ _id: "p1", createdAt: OCT_1 - 4 * DAY, amount: 7500 }),
        pay({ _id: "x1", createdAt: OCT_1 + 6 * DAY, amount: 500, reversalOfId: "p0" }),
      ],
    });
    const s = buildLoanStatement(l, {}, NOW);
    expect(s.summary.totalPaid).toBe(7500);
  });
});

/* ----------------------------- Repayment --------------------------------- */

describe("buildLoanStatement — next due & repayment status", () => {
  test("next due is the earliest OPEN installment, amount is its unpaid remainder", () => {
    const s = buildLoanStatement(loanFixture(), {}, NOW);
    expect(s.repayment.nextDueDate).toBe(OCT_1 + 25 * DAY);
    expect(s.repayment.nextDueAmount).toBe(6000);
    expect(s.repayment.upcoming.map((u) => u.index)).toEqual([3, 4]);
  });

  test("overdue figures come from open rows past NOW, counted in IST days", () => {
    const l = loanFixture({
      schedule: [
        row({ index: 1, dueDate: OCT_1 - 5 * DAY, totalDue: 7500, paid: 7500 }),
        row({ index: 2, dueDate: OCT_1 + 5 * DAY, totalDue: 6500, paid: 2000 }),
        row({ index: 3, dueDate: OCT_1 + 25 * DAY, totalDue: 6000 }),
        row({ index: 4, dueDate: OCT_1 + 45 * DAY, totalDue: 6000 }),
      ],
      collections: [
        pay({ _id: "p1", createdAt: OCT_1 - 4 * DAY, amount: 7500 }),
        pay({ _id: "p2", createdAt: OCT_1 + 6 * DAY, amount: 2000 }),
      ],
    });
    const s = buildLoanStatement(l, {}, NOW); // NOW = Oct 21; inst-2 due Oct 6
    expect(s.repayment.totalOverdueAmount).toBe(4500); // 6,500 − 2,000
    expect(s.repayment.overdueDays).toBe(15);
    expect(s.repayment.installmentsDue).toBe(1);
    expect(s.repayment.installmentsPaid).toBe(1);
    expect(s.repayment.installmentsRemaining).toBe(3);
  });

  test("No Upcoming Dues only when the real schedule has nothing open", () => {
    const l = loanFixture({
      schedule: [
        row({ index: 1, dueDate: OCT_1 - 5 * DAY, totalDue: 7500, paid: 7500 }),
        row({ index: 2, dueDate: OCT_1 + 5 * DAY, totalDue: 6500, paid: 6500 }),
        row({ index: 3, dueDate: OCT_1 + 25 * DAY, totalDue: 6000, paid: 6000 }),
        row({ index: 4, dueDate: OCT_1 + 45 * DAY, totalDue: 6000, paid: 6000 }),
      ],
      // Ledger-consistent: schedule.paid only ever moves WITH a collection.
      collections: [
        pay({ _id: "p1", createdAt: OCT_1 - 4 * DAY, amount: 7500 }),
        pay({ _id: "p2", createdAt: OCT_1 + 6 * DAY, amount: 6500 }),
        pay({ _id: "p3", createdAt: OCT_1 + 26 * DAY, amount: 6000 }),
        pay({ _id: "p4", createdAt: OCT_1 + 46 * DAY, amount: 6000 }),
      ],
    });
    const s = buildLoanStatement(l, {}, NOW);
    expect(s.repayment.nextDueDate).toBeNull();
    expect(s.repayment.nextDueAmount).toBeNull();
    expect(s.repayment.upcoming).toHaveLength(0);
    expect(s.summary.closingOutstanding).toBe(0);
    expect(s.repayment.outstanding).toBe(0);
  });

  test("last payment is the newest counted collection", () => {
    const s = buildLoanStatement(loanFixture(), {}, NOW);
    expect(s.repayment.lastPaymentDate).toBe(OCT_1 + 6 * DAY);
    expect(s.repayment.lastPaymentAmount).toBe(6500);
    expect(s.repayment.totalPaidToDate).toBe(14000);
  });
});

/* ------------------------------- Period ---------------------------------- */

describe("buildLoanStatement — period filter & summary", () => {
  const bounds = { fromMs: OCT_1, toMs: OCT_1 + 10 * DAY - 1 }; // Oct 1–10

  test("ledger rows honour the period, balances stay account-truth", () => {
    const s = buildLoanStatement(loanFixture(), bounds, NOW);
    // Disbursement (Sep 21) and inst-1 (Sep 26) fall outside; p1 (Sep 27) too.
    for (const r of s.ledger) {
      expect(r.date).toBeGreaterThanOrEqual(bounds.fromMs);
      expect(r.date).toBeLessThanOrEqual(bounds.toMs);
    }
    // Yet the balance column still reflects everything before the period.
    const pay2 = s.ledger.find((r) => r.id === "pay-loan-1-p2");
    expect(pay2?.balanceAfter).toBe(12000); // 26,000 − 7,500 − 6,500
  });

  test("period summary reconciles: opening + disbursement − paid = closing", () => {
    const s = buildLoanStatement(loanFixture(), bounds, NOW);
    expect(s.summary.openingBalance).toBe(18500); // 26,000 − p1 (7,500)
    expect(s.summary.disbursementInPeriod).toBe(0); // disbursed before period
    expect(s.summary.totalPaid).toBe(6500); // p2 only
    expect(s.summary.closingOutstanding).toBe(12000);
    expect(
      s.summary.openingBalance + s.summary.disbursementInPeriod - s.summary.totalPaid,
    ).toBe(s.summary.closingOutstanding);
  });

  test("full history has zero opening balance and totals the whole ledger", () => {
    const s = buildLoanStatement(loanFixture(), {}, NOW);
    expect(s.summary.openingBalance).toBe(0);
    expect(s.summary.totalDues).toBe(26000);
    expect(s.summary.totalPaid).toBe(14000);
    expect(s.summary.lifetimePaid).toBe(14000);
  });
});

/* ------------------------------ Combined --------------------------------- */

describe("buildCombinedStatement", () => {
  const loan2 = loanFixture({
    _id: "loan-2",
    loanId: "LN-000002",
    principal: 10000,
    charges: 0,
    disbursedAt: OCT_1 - 2 * DAY,
    schedule: [
      row({ index: 1, dueDate: OCT_1 + 3 * DAY, totalDue: 5500, paid: 5500 }),
      row({ index: 2, dueDate: OCT_1 + 33 * DAY, totalDue: 5500 }),
    ],
    collections: [pay({ _id: "p3", createdAt: OCT_1 + 4 * DAY, amount: 5500 })],
  });

  test("merges per-loan ledgers chronologically, de-duplicated", () => {
    const c = buildCombinedStatement([loanFixture(), loan2], {}, NOW);
    expect(new Set(c.ledger.map((r) => r.id)).size).toBe(c.ledger.length);
    for (let i = 1; i < c.ledger.length; i++) {
      expect(c.ledger[i].date).toBeGreaterThanOrEqual(c.ledger[i - 1].date);
    }
    expect(c.loanId).toBeNull();
  });

  test("sums money across loans and takes the earliest next due", () => {
    const c = buildCombinedStatement([loanFixture(), loan2], {}, NOW);
    expect(c.summary.closingOutstanding).toBe(12000 + 5500);
    expect(c.summary.totalPaid).toBe(14000 + 5500);
    expect(c.repayment.nextDueDate).toBe(OCT_1 + 25 * DAY); // loan-1 inst 3
    expect(c.repayment.nextDueAmount).toBe(6000);
    expect(c.repayment.outstanding).toBe(17500);
    expect(c.repayment.upcoming.map((u) => `${u.loanId}#${u.index}`)).toEqual([
      "LN-000001#3",
      "LN-000002#2",
      "LN-000001#4",
    ]);
  });

  test("single loan behaves like the per-loan view", () => {
    const c = buildCombinedStatement([loanFixture()], {}, NOW);
    const s = buildLoanStatement(loanFixture(), {}, NOW);
    expect(c.summary.closingOutstanding).toBe(s.summary.closingOutstanding);
    expect(c.ledger.length).toBe(s.ledger.length);
  });
});

/* ------------------------- Settlement waivers ---------------------------- */

describe("buildLoanStatement — approved settlement waiver", () => {
  /**
   * Settled loan: 24,000 collected over its life (10,000 of it at the
   * settlement), 2,000 waived by the approved settlement. Receivable 26,000.
   */
  const settledFixture = (): StatementLoan =>
    loanFixture({
      status: "SETTLED",
      outstanding: 0,
      paidTotal: 24000,
      closeDate: NOW,
      waivedAmount: 2000,
      schedule: [
        row({ index: 1, dueDate: OCT_1 - 5 * DAY, totalDue: 7500, paid: 7500, principal: 6000, interest: 1500 }),
        row({ index: 2, dueDate: OCT_1 + 5 * DAY, totalDue: 6500, paid: 6500 }),
        row({ index: 3, dueDate: OCT_1 + 25 * DAY, totalDue: 6000, paid: 6000 }),
        {
          ...row({ index: 4, dueDate: OCT_1 + 45 * DAY, totalDue: 6000, paid: 4000 }),
          waived: 2000,
        },
      ],
      collections: [
        pay({ _id: "p1", createdAt: OCT_1 - 4 * DAY, amount: 7500 }),
        pay({ _id: "p2", createdAt: OCT_1 + 6 * DAY, amount: 6500, principalPortion: 5000, interestPortion: 1500 }),
        // The actual settlement payment (real money, receipted).
        pay({ _id: "p3", createdAt: NOW, amount: 10000 }),
      ],
    });

  test("a waived rupee closes the row but is never counted as cash", () => {
    const s = buildLoanStatement(settledFixture(), {}, NOW);
    // Money received stays 24,000 — the 2,000 waiver never enters totals.
    expect(s.summary.totalPaid).toBe(24000);
    expect(s.repayment.totalPaidToDate).toBe(24000);
    expect(s.summary.waivedAmount).toBe(2000);
    // …and the balance still reconciles to zero: 26,000 − 24,000 − 2,000.
    expect(s.summary.closingOutstanding).toBe(0);
    expect(s.repayment.outstanding).toBe(0);
  });

  test("the waiver appears as its own non-counted ledger row", () => {
    const s = buildLoanStatement(settledFixture(), {}, NOW);
    const waivers = s.ledger.filter((r) => r.type === "WAIVER");
    expect(waivers).toHaveLength(1);
    expect(waivers[0].due).toBe(2000);
    expect(waivers[0].counted).toBe(false); // never money received
    expect(waivers[0].balanceAfter).toBe(0);
    expect(LEDGER_TYPE_LABELS.WAIVER).toBeTruthy(); // renders in the UI
    for (const r of s.ledger.filter((x) => x.type === "PAYMENT")) {
      expect(r.counted).toBe(true);
    }
    // The last row of the ledger always equals the stored outstanding (0).
    expect(s.ledger[s.ledger.length - 1].balanceAfter).toBe(0);
  });

  test("the waived installment is marked WAIVED, not PAID, and has no open dues", () => {
    const s = buildLoanStatement(settledFixture(), {}, NOW);
    const dueRow = s.ledger.find(
      (r) => r.type === "INSTALLMENT_DUE" && r.reference === "Inst 4/4",
    );
    expect(dueRow?.status).toBe("WAIVED");
    expect(s.repayment.upcoming).toHaveLength(0); // "No upcoming dues"
    expect(s.repayment.totalOverdueAmount).toBe(0);
  });

  test("a period after the settlement opens at zero — the waiver rolls in", () => {
    const s = buildLoanStatement(
      settledFixture(),
      { fromMs: NOW + DAY, toMs: NOW + 5 * DAY },
      NOW + 2 * DAY,
    );
    expect(s.summary.openingBalance).toBe(0);
    expect(s.summary.closingOutstanding).toBe(0);
    expect(s.summary.waivedAmount).toBe(0); // the waiver itself is outside the period
  });
});

describe("buildLoanStatement — surrendered loan keeps the debt on record", () => {
  test("nothing is waived or erased: outstanding, next due and open rows survive", () => {
    const l = loanFixture({
      status: "SURRENDERED",
      closeDate: NOW,
      outstanding: 12000,
      // Rows 3 and 4 were never paid — the debt stays visible.
      schedule: [
        row({ index: 1, dueDate: OCT_1 - 5 * DAY, totalDue: 7500, paid: 7500, principal: 6000, interest: 1500 }),
        row({ index: 2, dueDate: OCT_1 + 5 * DAY, totalDue: 6500, paid: 6500 }),
        row({ index: 3, dueDate: OCT_1 - 3 * DAY, totalDue: 6000, paid: 0 }),
        row({ index: 4, dueDate: OCT_1 + 45 * DAY, totalDue: 6000, paid: 0 }),
      ],
    });
    const s = buildLoanStatement(l, {}, NOW);
    expect(s.repayment.outstanding).toBe(12000);
    expect(s.summary.waivedAmount).toBe(0);
    // No waiver row appears — a surrender writes nothing off.
    expect(s.ledger.filter((r) => r.type === "WAIVER")).toHaveLength(0);
    // The overdue installment stays in the arrears for recovery.
    expect(s.repayment.totalOverdueAmount).toBe(6000);
    expect(s.repayment.upcoming).toHaveLength(2);
    expect(s.repayment.installmentsRemaining).toBe(2);
  });
});
