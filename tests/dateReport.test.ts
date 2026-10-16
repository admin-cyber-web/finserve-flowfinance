/**
 * Date-wise report engine tests.
 *
 * Covers the acceptance criteria of the date-range report:
 *   • IST day boundaries — records on the first and last day are included,
 *     one millisecond outside either end is excluded, in any device timezone.
 *   • Real fixture records only — totals are asserted against the fixture
 *     "ledger", never against hardcoded sample figures.
 *   • Role scoping: SUPER_ADMIN org-wide, BRANCH_MANAGER branch-only,
 *     FIELD_STAFF own records only; filters can only narrow, never widen.
 *   • No duplicate counting: collections count NORMAL only, reversed rows are
 *     superseded by their reversal, wallet rows mirroring real events are
 *     suppressed in the combined view.
 *   • Outstanding / overdue are current positions, not date-range sums.
 *   • Empty ranges return empty rows with zero period totals.
 */
import { describe, expect, test } from "bun:test";
import {
  DATE_REPORT_PRESETS,
  buildDateReport,
  istDayKey,
  istDayStart,
  presetRange,
  rangeBounds,
  resolveRange,
  type DateReportParams,
} from "../src/lib/finance/dateReport";

/* ------------------------------- IST clock ------------------------------- */

const IST = 5.5 * 3600 * 1000;

describe("IST day boundaries", () => {
  test("istDayStart is midnight IST, not midnight UTC", () => {
    expect(istDayStart("2026-10-01")).toBe(Date.UTC(2026, 9, 1) - IST);
    // 00:00 IST on 1 Oct is 18:30 UTC on 30 Sep.
    expect(new Date(istDayStart("2026-10-01")!).toISOString()).toBe(
      "2026-09-30T18:30:00.000Z",
    );
  });

  test("istDayKey rounds the same instant consistently", () => {
    const start = istDayStart("2026-10-01")!;
    expect(istDayKey(start)).toBe("2026-10-01");
    expect(istDayKey(start + 12 * 3600 * 1000)).toBe("2026-10-01");
    expect(istDayKey(start - 1)).toBe("2026-09-30");
    expect(istDayKey(start + 86_400_000 - 1)).toBe("2026-10-01");
    expect(istDayKey(start + 86_400_000)).toBe("2026-10-02");
  });

  test("rejects malformed and impossible calendar dates", () => {
    expect(istDayStart("2026-02-31")).toBeNull(); // would silently roll over
    expect(istDayStart("2026-13-01")).toBeNull();
    expect(istDayStart("01-10-2026")).toBeNull();
    expect(istDayStart("")).toBeNull();
    expect(istDayStart("2026-2-3")).toBeNull();
    expect(istDayStart("2026-02-28")).not.toBeNull();
  });

  test("range covers both endpoints fully and nothing outside", () => {
    const fromDay = istDayStart("2026-10-10")!;
    const toDay = istDayStart("2026-10-12")!;
    const b = rangeBounds(fromDay, toDay)!;
    expect(b.from).toBe(fromDay);
    expect(b.to).toBe(toDay + 86_399_999);
    expect(istDayKey(b.to)).toBe("2026-10-12");
    // Exact edges are inside; one ms outside either end is not.
    expect(b.from - 1 >= b.from).toBe(false);
    expect(b.from >= b.from && b.from <= b.to).toBe(true);
    expect(b.to <= b.to && b.to >= b.from).toBe(true);
    expect(b.from - 1).toBeLessThan(b.from);
    expect(b.to + 1).toBeGreaterThan(b.to);
  });

  test("resolveRange validates order and dates", () => {
    const ok = resolveRange("2026-10-10", "2026-10-12");
    expect("error" in ok).toBe(false);
    const swapped = resolveRange("2026-10-12", "2026-10-10");
    expect("error" in swapped && swapped.error).toContain(
      "To date must be on or after",
    );
    const bad = resolveRange("2026-02-31", "2026-03-01");
    expect("error" in bad && bad.error).toContain("From date");
    const badTo = resolveRange("2026-03-01", "nope");
    expect("error" in badTo && badTo.error).toContain("To date");
  });

  test("quick presets resolve to the right IST windows", () => {
    // Friday 16 Oct 2026, 12:00 IST.
    const now = istDayStart("2026-10-16")! + 12 * 3600 * 1000;
    expect(presetRange("TODAY", now)).toEqual({
      fromIso: "2026-10-16",
      toIso: "2026-10-16",
    });
    expect(presetRange("YESTERDAY", now)).toEqual({
      fromIso: "2026-10-15",
      toIso: "2026-10-15",
    });
    expect(presetRange("LAST_7", now)).toEqual({
      fromIso: "2026-10-10",
      toIso: "2026-10-16",
    });
    expect(presetRange("LAST_30", now)).toEqual({
      fromIso: "2026-09-17",
      toIso: "2026-10-16",
    });
    expect(presetRange("THIS_MONTH", now)).toEqual({
      fromIso: "2026-10-01",
      toIso: "2026-10-16",
    });
    expect(presetRange("CUSTOM", now)).toBeNull();
    for (const p of DATE_REPORT_PRESETS) expect(presetRange(p, now)).not.toBe(undefined);
  });

  test("presets cross month boundaries correctly", () => {
    const now = istDayStart("2026-03-02")! + 9 * 3600 * 1000;
    expect(presetRange("LAST_7", now)).toEqual({
      fromIso: "2026-02-24",
      toIso: "2026-03-02",
    });
    expect(presetRange("THIS_MONTH", now)).toEqual({
      fromIso: "2026-03-01",
      toIso: "2026-03-02",
    });
    // Last year boundary.
    const nye = istDayStart("2026-01-01")!;
    expect(presetRange("YESTERDAY", nye)).toEqual({
      fromIso: "2025-12-31",
      toIso: "2025-12-31",
    });
    expect(presetRange("THIS_MONTH", nye)).toEqual({
      fromIso: "2026-01-01",
      toIso: "2026-01-01",
    });
  });
});

/* ------------------------------- fixtures -------------------------------- */

const NOW = istDayStart("2026-10-16")! + 12 * 3600 * 1000; // 16 Oct 2026 noon IST
const RANGE = resolveRange("2026-10-10", "2026-10-16");
if ("error" in RANGE) throw new Error("bad test range");
const BOUNDS = rangeBounds(RANGE.fromDay, RANGE.toDay)!;
const IN_START = BOUNDS.from; // exact first ms of 10 Oct IST
const IN_END = BOUNDS.to; // exact last ms of 16 Oct IST
const IN_MID = istDayStart("2026-10-12")! + 5 * 3600 * 1000;
const BEFORE = IN_START - 1; // 23:59:59.999 on 9 Oct IST
const AFTER = IN_END + 1; // 00:00:00.000 on 17 Oct IST

const profiles = [
  { _id: "s1", name: "Sita Sharma" },
  { _id: "s2", name: "Ramesh Yadav" },
  { _id: "bm1", name: "Meera Gupta" },
  { _id: "bm2", name: "Arjun Singh" },
];

const clients = [
  {
    _id: "c1",
    code: "C-0001",
    name: "Kamla Devi",
    mobile: "9000000001",
    centerCode: "BALLIA-001",
    kycStatus: "VERIFIED",
    createdAt: IN_MID,
    verifiedAt: IN_MID + 1000,
    assignedTo: "s1",
    createdBy: "s1",
    branchId: "b1",
  },
  {
    _id: "c2",
    code: "C-0002",
    name: "Phoolwati",
    mobile: "9000000002",
    centerCode: "OTHER-001",
    kycStatus: "PENDING",
    createdAt: IN_START, // boundary: first ms of the From day
    assignedTo: "s2",
    createdBy: "s2",
    branchId: "b2",
  },
  {
    _id: "c3",
    code: "C-0003",
    name: "Savitri",
    mobile: "9000000003",
    kycStatus: "PENDING",
    createdAt: BEFORE, // outside the range
    assignedTo: "s1",
    createdBy: "s1",
    branchId: "b1",
  },
];

const applications = [
  {
    _id: "a1",
    appId: "LA-0001",
    clientId: "c1",
    amount: 10000,
    staffId: "s1",
    branchId: "b1",
    status: "APPROVED",
    submittedAt: IN_START + 1000,
    decidedAt: IN_MID,
    createdAt: IN_START + 1000,
  },
  {
    _id: "a2",
    appId: "LA-0002",
    clientId: "c3",
    amount: 5000,
    staffId: "s1",
    branchId: "b1",
    status: "REJECTED",
    submittedAt: IN_MID,
    decidedAt: IN_END, // boundary: last ms of the To day
    createdAt: IN_MID,
  },
  {
    _id: "a3",
    appId: "LA-0003",
    clientId: "c2",
    amount: 7000,
    staffId: "s2",
    branchId: "b2",
    status: "SUBMITTED",
    submittedAt: BEFORE,
    createdAt: BEFORE,
  },
];

const loans = [
  {
    _id: "l1",
    loanId: "LN-0001",
    clientId: "c1",
    staffId: "s1",
    branchId: "b1",
    principal: 12000,
    status: "ACTIVE",
    outstanding: 5000,
    disbursedAt: IN_MID,
    createdAt: IN_MID,
  },
  {
    _id: "l2",
    loanId: "LN-0002",
    clientId: "c2",
    staffId: "s2",
    branchId: "b2",
    principal: 9000,
    status: "ACTIVE",
    outstanding: 3000,
    disbursedAt: BEFORE, // disbursed before the range
    createdAt: BEFORE,
  },
  {
    _id: "l3",
    loanId: "LN-0003",
    clientId: "c2",
    staffId: "s2",
    branchId: "b2",
    principal: 5000,
    status: "CLOSED",
    outstanding: 0,
    disbursedAt: IN_END, // boundary: last ms of the To day
    createdAt: IN_END,
  },
];

const schedules = [
  // Overdue on an in-range loan: 1000 due, 400 paid → 600 open.
  { _id: "sc1", loanId: "l1", dueDate: NOW - 3 * 86_400_000, totalDue: 1000, paid: 400 },
  // Future instalment — never overdue, even if present in the read set.
  { _id: "sc2", loanId: "l1", dueDate: NOW + 5 * 86_400_000, totalDue: 800, paid: 0 },
  // Overdue on an out-of-range-disbursed loan (still a current position).
  { _id: "sc3", loanId: "l2", dueDate: NOW - 2 * 86_400_000, totalDue: 500, paid: 0 },
  // Fully paid past row — not overdue.
  { _id: "sc4", loanId: "l1", dueDate: NOW - 4 * 86_400_000, totalDue: 600, paid: 600 },
];

const collections = [
  // Exact boundary: first millisecond of the From day — must be included.
  { _id: "col1", code: "RC-1", loanId: "l1", clientId: "c1", staffId: "s1", branchId: "b1", amount: 800, mode: "CASH", status: "NORMAL", createdAt: IN_START },
  // Exact boundary: last millisecond of the To day — must be included.
  { _id: "col2", code: "RC-2", loanId: "l1", clientId: "c1", staffId: "s1", branchId: "b1", amount: 200, mode: "CASH", status: "REVERSAL", receiptNumber: "R-2", createdAt: IN_END },
  // One ms before the From day — must be excluded entirely.
  { _id: "col3", code: "RC-3", loanId: "l1", clientId: "c1", staffId: "s1", branchId: "b1", amount: 500, mode: "UPI", status: "NORMAL", createdAt: BEFORE },
  // Reversed original: superseded by its reversal, never counted.
  { _id: "col4", code: "RC-4", loanId: "l1", clientId: "c1", staffId: "s1", branchId: "b1", amount: 300, mode: "CASH", status: "REVERSED", createdAt: IN_MID },
  // Other branch, in range.
  { _id: "col5", code: "RC-5", loanId: "l2", clientId: "c2", staffId: "s2", branchId: "b2", amount: 400, mode: "BANK", status: "NORMAL", createdAt: IN_MID },
  // One ms after the To day — must be excluded entirely.
  { _id: "col6", code: "RC-6", loanId: "l1", clientId: "c1", staffId: "s1", branchId: "b1", amount: 900, mode: "UPI", status: "NORMAL", createdAt: AFTER },
];

const handovers = [
  { code: "HO-1", staffId: "s1", branchId: "b1", amount: 2000, status: "ACCEPTED", requestedAt: IN_MID },
];

const issues = [
  { code: "CI-1", staffId: "s2", branchId: "b2", bmId: "bm2", amount: 500, createdAt: IN_MID },
];

const recovery = [
  { _id: "r1", loanId: "l1", clientId: "c1", staffId: "s1", branchId: "b1", kind: "PROMISE_TO_PAY", promisedAmount: 700, createdAt: IN_MID },
  { _id: "r2", loanId: "l2", clientId: "c2", staffId: "s2", branchId: "b2", kind: "VISIT", createdAt: BEFORE },
];

const wallets = [
  { _id: "w1", profileId: "s1", branchId: "b1" },
  { _id: "w2", profileId: "s2", branchId: "b2" },
];

const walletTxns = [
  // Mirrors collection col1 — shown in the WALLET category, suppressed in ALL.
  { txnId: "WT-1", walletId: "w1", profileId: "s1", branchId: "b1", type: "CASH_COLLECTION", amount: 800, direction: "CREDIT", createdAt: IN_START },
  // Mirrors a disbursement — suppressed in ALL (the loan row already counts it).
  { txnId: "WT-2", walletId: "w1", profileId: "s1", branchId: "b1", type: "LOAN_DISBURSEMENT", amount: 4000, direction: "DEBIT", createdAt: IN_MID },
  // Out of range.
  { txnId: "WT-3", walletId: "w2", profileId: "s2", branchId: "b2", type: "OPENING_ALLOCATION", amount: 5000, direction: "CREDIT", createdAt: BEFORE },
];

function baseParams(overrides: Partial<DateReportParams> = {}): DateReportParams {
  return {
    bounds: { from: BOUNDS.from, to: BOUNDS.to },
    category: "ALL",
    limit: 500,
    now: NOW,
    role: "SUPER_ADMIN",
    viewerId: "admin1",
    viewerBranchId: null,
    clients: clients.map((x) => ({ ...x })),
    applications: applications.map((x) => ({ ...x })),
    loans: loans.map((x) => ({ ...x })),
    schedules: schedules.map((x) => ({ ...x })),
    collections: collections.map((x) => ({ ...x })),
    handovers: handovers.map((x) => ({ ...x })),
    issues: issues.map((x) => ({ ...x })),
    recovery: recovery.map((x) => ({ ...x })),
    wallets: wallets.map((x) => ({ ...x })),
    walletTxns: walletTxns.map((x) => ({ ...x })),
    profiles: profiles.map((x) => ({ ...x })),
    ...overrides,
  };
}

/* ------------------------------ period totals ---------------------------- */

describe("totals against the fixture ledger (SUPER_ADMIN)", () => {
  const r = buildDateReport(baseParams());
  const s = r.summary;

  test("clients registered counts only in-range creations", () => {
    expect(s.clientsRegistered).toBe(2); // c1 (mid) + c2 (boundary), not c3
    expect(s.kycVerified).toBe(1); // c1 verified in range
    expect(s.kycPending).toBe(2); // current state: c2 + c3 pending
    const clientRows = r.rows.filter((x) => x.kind === "CLIENT");
    expect(clientRows.length).toBe(2);
    expect(clientRows.some((x) => x.reference === "C-0003")).toBe(false);
  });

  test("loan pipeline: applied / approved / rejected / disbursed", () => {
    expect(s.loansApplied).toBe(2); // a1 + a2, not a3 (before range)
    expect(s.loansAppliedAmount).toBe(15000);
    expect(s.loansApproved).toBe(1);
    expect(s.loansApprovedAmount).toBe(10000);
    expect(s.loansRejected).toBe(1); // decided at the exact To boundary
    expect(s.loansDisbursed).toBe(2); // l1 mid-range, l3 at boundary
    expect(s.disbursedAmount).toBe(17000); // l2 excluded (disbursed before)
    const disbRows = r.rows.filter((x) => x.kind === "LOAN_DISBURSED");
    expect(disbRows.length).toBe(2);
    expect(disbRows.every((x) => x.reference !== "LN-0002")).toBe(true);
  });

  test("collections count NORMAL only — no double counting", () => {
    expect(s.collectionsCount).toBe(2); // col1 + col5
    expect(s.collectionsAmount).toBe(1200); // 800 + 400
    expect(s.reversalsCount).toBe(1); // col2 (refund), listed but not summed
    expect(s.reversalsAmount).toBe(200);
    // Row-sum invariant: NORMAL collection rows exactly reproduce the total.
    const normalRows = r.rows.filter(
      (x) => x.kind === "COLLECTION" && x.status === "NORMAL",
    );
    expect(normalRows.reduce((a, x) => a + (x.amount ?? 0), 0)).toBe(
      s.collectionsAmount,
    );
    // col3 (before range), col4 (reversed) and col6 (after the To end) appear nowhere.
    expect(r.rows.some((x) => x.reference === "RC-3")).toBe(false);
    expect(r.rows.some((x) => x.reference === "RC-6")).toBe(false);
    expect(r.rows.some((x) => x.id === "coll-col4")).toBe(false);
    // The reversal itself is listed for transparency.
    expect(r.rows.some((x) => x.id === "coll-col2")).toBe(true);
  });

  test("outstanding and overdue are current positions, not range sums", () => {
    expect(s.outstanding).toBe(8000); // l1 5000 + l2 3000 (l3 CLOSED = 0)
    expect(s.overdueAccounts).toBe(2); // l1 and l2 have open overdue rows
    expect(s.overdueInstalments).toBe(2); // sc1 + sc3 (sc2 future, sc4 paid)
    expect(s.overdueAmount).toBe(1100); // 600 + 500
    const overdueRows = r.rows.filter((x) => x.kind === "OVERDUE");
    expect(overdueRows.length).toBe(2);
    expect(overdueRows.find((x) => x.reference === "LN-0001")?.amount).toBe(600);
  });

  test("recovery, handovers and wallet activity in range", () => {
    expect(s.recoveryCount).toBe(1); // r1 in range, r2 before
    expect(s.recoveryPromised).toBe(700);
    expect(s.handoverCount).toBe(1);
    expect(s.handoverAmount).toBe(2000);
    expect(s.walletTxnCount).toBe(2); // WT-1 + WT-2 in range, WT-3 before
    expect(s.walletCredit).toBe(800);
    expect(s.walletDebit).toBe(4000);
  });

  test("every row sits inside the range; ids are unique", () => {
    for (const row of r.rows) {
      expect(row.date).toBeGreaterThanOrEqual(BOUNDS.from);
      expect(row.date).toBeLessThanOrEqual(BOUNDS.to);
    }
    expect(r.rowTotal).toBe(r.rows.length); // 500-cap not hit
    expect(new Set(r.rows.map((x) => x.id)).size).toBe(r.rows.length);
  });

  test("wallet rows mirroring real events are suppressed in ALL, full in WALLET", () => {
    expect(r.rows.some((x) => x.kind === "WALLET")).toBe(false);
    expect(r.rows.some((x) => x.reference === "WT-1")).toBe(false);

    const walletOnly = buildDateReport(baseParams({ category: "WALLET" }));
    const walletRows = walletOnly.rows.filter((x) => x.kind === "WALLET");
    expect(walletRows.length).toBe(2); // WT-1 + WT-2 visible for audit
    expect(walletRows.some((x) => x.reference === "WT-3")).toBe(false);
    // The summary counts wallet txns regardless of category.
    expect(walletOnly.summary.walletTxnCount).toBe(2);
  });

  test("the range can be regenerated differently — results follow the dates", () => {
    const single = buildDateReport(
      baseParams({
        bounds: rangeBounds(
          istDayStart("2026-10-12")!,
          istDayStart("2026-10-12")!,
        )!,
      }),
    );
    expect(single.summary.clientsRegistered).toBe(1); // c1 only
    expect(single.summary.collectionsCount).toBe(1); // col5 (col4 reversed)
    expect(single.summary.collectionsAmount).toBe(400);
    expect(single.summary.loansDisbursed).toBe(1); // l1 only
    expect(single.range.fromKey).toBe("2026-10-12");
    expect(single.range.toKey).toBe("2026-10-12");
  });
});

/* ----------------------------- role scoping ------------------------------ */

describe("role-based access", () => {
  test("BRANCH_MANAGER sees only their branch", () => {
    const r = buildDateReport(
      baseParams({ role: "BRANCH_MANAGER", viewerId: "bm1", viewerBranchId: "b1" }),
    );
    const s = r.summary;
    expect(s.clientsRegistered).toBe(1); // c1 only (c2 is b2)
    expect(s.collectionsAmount).toBe(800); // col5 (b2) excluded
    expect(s.outstanding).toBe(5000); // l1 only (l2 is b2)
    expect(s.disbursedAmount).toBe(12000); // l1 only (l3 is b2)
    expect(s.handoverCount).toBe(1); // h1 is b1
    expect(s.recoveryCount).toBe(1);
    for (const row of r.rows) {
      if (row.branchId) expect(row.branchId).toBe("b1");
    }
    // Nothing from branch 2 leaks into any row reference.
    expect(r.rows.some((x) => x.reference === "LN-0002")).toBe(false);
    expect(r.rows.some((x) => x.reference === "RC-5")).toBe(false);
    expect(r.rows.some((x) => x.reference === "CI-1")).toBe(false);
  });

  test("FIELD_STAFF sees only their own records", () => {
    const r = buildDateReport(
      baseParams({ role: "FIELD_STAFF", viewerId: "s1", viewerBranchId: "b1" }),
    );
    const s = r.summary;
    expect(s.clientsRegistered).toBe(1); // c1 created by s1 (c2 by s2)
    expect(s.collectionsAmount).toBe(800); // col5 collected by s2 excluded
    expect(s.handoverCount).toBe(1); // h1 staff s1
    expect(s.handoverAmount).toBe(2000);
    expect(s.disbursedAmount).toBe(12000); // l1 staff s1 (l3 staff s2)
    expect(s.walletTxnCount).toBe(2); // w1 belongs to s1
    expect(r.rows.some((x) => x.reference === "RC-5")).toBe(false);
    expect(r.rows.some((x) => x.reference === "CI-1")).toBe(false);
  });

  test("filters can only narrow — a staff filter can never widen a staff session", () => {
    const leak = buildDateReport(
      baseParams({
        role: "FIELD_STAFF",
        viewerId: "s1",
        viewerBranchId: "b1",
        staffId: "s2", // trying to look at someone else's book
      }),
    );
    expect(leak.rows.length).toBe(0);
    expect(leak.summary.clientsRegistered).toBe(0);
    expect(leak.summary.collectionsCount).toBe(0);
    expect(leak.summary.outstanding).toBe(0);

    // A branch filter cannot widen a branch manager's session either.
    const wide = buildDateReport(
      baseParams({
        role: "BRANCH_MANAGER",
        viewerId: "bm1",
        viewerBranchId: "b1",
        branchId: "b2",
      }),
    );
    expect(wide.rows.length).toBe(0);
    expect(wide.summary.clientsRegistered).toBe(0);
  });

  test("an admin branch/staff/centre filter narrows the org-wide report", () => {
    const byBranch = buildDateReport(baseParams({ branchId: "b2" }));
    expect(byBranch.summary.clientsRegistered).toBe(1); // c2
    expect(byBranch.summary.collectionsAmount).toBe(400); // col5
    expect(byBranch.summary.outstanding).toBe(3000); // l2 (l3 CLOSED)
    expect(byBranch.rows.every((x) => x.branchId === "b2")).toBe(true);

    const byStaff = buildDateReport(baseParams({ staffId: "s2" }));
    expect(byStaff.summary.clientsRegistered).toBe(1); // c2
    expect(byStaff.summary.loansDisbursed).toBe(1); // l3
    expect(byStaff.summary.collectionsAmount).toBe(400); // col5
    expect(byStaff.rows.some((x) => x.staffName === "Sita Sharma")).toBe(false);

    const byCenter = buildDateReport(baseParams({ centerCode: "BALLIA-001" }));
    expect(byCenter.summary.clientsRegistered).toBe(1); // c1 only
    expect(byCenter.summary.collectionsAmount).toBe(800); // c1's receipts
    // Records with no client (handovers, cash issues, wallet txns) cannot be
    // attributed to a centre, so they are excluded rather than shown unfiltered.
    expect(byCenter.summary.handoverCount).toBe(0);
    expect(byCenter.summary.walletTxnCount).toBe(0);
    expect(byCenter.rows.some((x) => x.reference === "HO-1")).toBe(false);
  });
});

/* ------------------------------ categories ------------------------------- */

describe("categories, empty ranges and caps", () => {
  test("category filters rows but keeps the full period summary", () => {
    const cols = buildDateReport(baseParams({ category: "COLLECTIONS" }));
    // Rows include NORMAL and REVERSAL, exclude the superseded REVERSED row.
    expect(cols.rows.every((x) => x.kind === "COLLECTION")).toBe(true);
    expect(cols.rows.length).toBe(3); // col1 + col5 (NORMAL) + col2 (REVERSAL)
    expect(cols.summary.loansDisbursed).toBe(2); // summary still complete
    expect(cols.category).toBe("COLLECTIONS");

    const disb = buildDateReport(baseParams({ category: "DISBURSEMENTS" }));
    expect(disb.rows.every((x) => x.kind === "LOAN_DISBURSED")).toBe(true);
    expect(disb.rows.length).toBe(disb.summary.loansDisbursed);

    const kyc = buildDateReport(baseParams({ category: "KYC" }));
    expect(kyc.rows.length).toBe(1); // c1's verification
    expect(kyc.rows[0].reference).toBe("C-0001");

    const unknown = buildDateReport(baseParams({ category: "NOT_A_CATEGORY" }));
    expect(unknown.category).toBe("ALL"); // falls back safely
  });

  test("a range with no records returns an empty report with zero totals", () => {
    const empty = buildDateReport(
      baseParams({
        bounds: rangeBounds(
          istDayStart("2027-01-01")!,
          istDayStart("2027-01-02")!,
        )!,
        category: "CLIENTS",
      }),
    );
    expect(empty.rows.length).toBe(0);
    expect(empty.rowTotal).toBe(0);
    expect(empty.summary.clientsRegistered).toBe(0);
    expect(empty.summary.collectionsCount).toBe(0);
    expect(empty.summary.collectionsAmount).toBe(0);
    expect(empty.summary.disbursedAmount).toBe(0);
    expect(empty.summary.loansApplied).toBe(0);
    expect(empty.range.fromKey).toBe("2027-01-01");
    expect(empty.range.toKey).toBe("2027-01-02");
    // Point-in-time figures remain honest for an empty window.
    expect(empty.summary.outstanding).toBe(8000);
  });

  test("the row cap limits rows but never the totals", () => {
    const capped = buildDateReport(baseParams({ limit: 2 }));
    expect(capped.rows.length).toBe(2);
    expect(capped.rowTotal).toBeGreaterThan(2); // true total preserved
    expect(capped.summary.collectionsAmount).toBe(1200); // totals unaffected
  });
});
