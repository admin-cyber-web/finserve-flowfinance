/**
 * Client Statement engine — pure logic behind the Reports → Statement screen.
 *
 * Follows the same discipline as `excelReports.ts` / `dateReport.ts`: no DOM,
 * no Convex, no React, so every figure is unit-testable with `bun test`. The
 * Convex `reports.statementSearch` / `reports.statement` queries only join
 * documents and pass them in here.
 *
 * Ground rules (nothing invented, nothing double counted):
 *   • Every figure comes from the stored `loans`, `loanSchedules`,
 *     `collections` and `receipts` ledgers. Missing data renders as `null`
 *     and the UI prints "Not Available" — never a guess.
 *   • Outstanding uses the SAME definition as the rest of the app
 *     (`loanOps.disburseLoan` / `recordCollection`):
 *         outstanding = Σ max(0, totalDue − paid)   over the schedule
 *     The full receivable (Σ totalDue, charges financed into the first
 *     installment) is booked at disbursement and every counted payment
 *     reduces it one-for-one.
 *   • Counted payments are `status === "NORMAL"` collections only — the same
 *     rule the Collection Report uses. A reversed original (status REVERSED)
 *     and its compensating REVERSAL entry net to zero: the original has
 *     already left the counted total, so the reversal never moves the
 *     balance again. Both rows still appear in the ledger, transparently.
 *   • The running balance is computed as receivable − cumulative counted
 *     payments, so the final row ALWAYS equals the stored loan.outstanding.
 *   • "No Upcoming Dues" is only ever emitted when the actual schedule has
 *     no open row — the next due date is read off the earliest unpaid
 *     installment, never extrapolated from the calendar.
 */

import { DAY_MS, IST_OFFSET_MS } from "./dateReport";
import { overdueDays, round2 } from "./excelReports";
import { LOAN_PURPOSE_LABELS, type LoanPurpose } from "./types";

/* ------------------------------- Inputs ---------------------------------- */

export interface StatementScheduleRow {
  _id: string;
  index: number;
  dueDate: number;
  principal: number;
  interest: number;
  totalDue: number;
  paid: number;
}

export interface StatementCollection {
  _id: string;
  code: string;
  createdAt: number;
  amount: number;
  principalPortion: number;
  interestPortion: number;
  mode: string;
  status: string; // NORMAL | REVERSED | REVERSAL
  reversalOfId?: string;
  receiptNumber?: string;
  staffId: string;
  remarks?: string;
}

export interface StatementReceipt {
  _id: string;
  collectionId?: string;
  number: string;
  amount: number;
  createdAt: number;
  outstandingAfter?: number;
}

export interface StatementLoan {
  _id: string;
  loanId: string; // LAN / Loan ID, e.g. LN-000123
  clientId: string;
  productId: string;
  staffId: string;
  branchId: string;
  applicationId?: string;
  principal: number; // sanctioned amount
  charges: number;
  totalPayable: number;
  installment: number;
  frequency: string;
  tenure: number;
  interestRate: number;
  interestMethod: string;
  status: string;
  outstanding: number;
  paidTotal: number;
  disbursedAt?: number;
  approvedAt?: number;
  createdAt: number; // application date
  schedule: StatementScheduleRow[];
  collections: StatementCollection[];
  receipts: StatementReceipt[];
  /** From loanApplications — the amount the client asked for. */
  requestedAmount?: number;
  /** From loanApplications.loanRequest.purpose. */
  purpose?: string;
}

/* ----------------------------- ID search --------------------------------- */

export interface SearchableClient {
  _id: string;
  code: string; // Client ID / Customer ID, e.g. C-000128
  name: string;
  mobile?: string;
}

export interface StatementMatch {
  clientId: string;
  code: string;
  name: string;
  mobile?: string;
  loanIds: string[]; // LANs on file for this client
  /** How the query matched — surfaced so staff can trust the hit. */
  matchedOn: "CLIENT_ID" | "LAN";
}

/**
 * Resolve a free-text identifier (Client ID / Customer ID / LAN ID / Loan ID)
 * to client candidates. Exact, case-insensitive matches on the stored codes
 * only — a client is never returned because a query merely resembles it. An
 * ambiguous query (e.g. a LAN that exists twice) returns every exact
 * candidate so the caller picks; nothing is silently chosen.
 */
export function resolveClientMatches(
  clients: SearchableClient[],
  loansByClient: Record<string, string[]>,
  query: string,
): StatementMatch[] {
  const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");
  const needle = norm(query);
  if (!needle) return [];

  const byId = new Map<string, StatementMatch>();
  const push = (match: StatementMatch) => {
    if (!byId.has(match.clientId)) byId.set(match.clientId, match);
  };

  for (const c of clients) {
    const loanIds = loansByClient[c._id] ?? [];
    if (norm(c.code) === needle) {
      push({ clientId: c._id, code: c.code, name: c.name, mobile: c.mobile, loanIds, matchedOn: "CLIENT_ID" });
      continue;
    }
    if (loanIds.some((l) => norm(l) === needle)) {
      push({ clientId: c._id, code: c.code, name: c.name, mobile: c.mobile, loanIds, matchedOn: "LAN" });
    }
  }
  return [...byId.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/* ------------------------------- Ledger ---------------------------------- */

export type LedgerType =
  | "DISBURSEMENT"
  | "INSTALLMENT_DUE"
  | "PAYMENT"
  | "REVERSAL";

export interface StatementLedgerRow {
  /** React key + de-dup guard — one per stored event. */
  id: string;
  date: number;
  type: LedgerType;
  /** Receipt number / LAN / installment no. shown in the reference column. */
  reference: string;
  /** Installment component that fell due on this date, if any. */
  due: number | null;
  /** Amount paid (or refunded, for a reversal) — display value. */
  paid: number | null;
  principalPart: number | null;
  interestPart: number | null;
  /** Running outstanding AFTER this row; computed, never guessed. */
  balanceAfter: number;
  mode: string | null;
  staffId: string | null;
  status: string;
  counted: boolean; // true = moves the money total / balance
  remarks: string | null;
  sortKey: number;
}

export interface StatementFilters {
  /** Inclusive epoch-ms bounds; omit either for full history. */
  fromMs?: number | null;
  toMs?: number | null;
}

const inBounds = (t: number, f: StatementFilters): boolean => {
  if (f.fromMs != null && t < f.fromMs) return false;
  if (f.toMs != null && t > f.toMs) return false;
  return true;
};

/** A collection that counts toward money received (Collection Report rule). */
function isCountedPayment(c: StatementCollection): boolean {
  return c.status === "NORMAL" && !c.reversalOfId;
}

/* ------------------------------ Per-loan --------------------------------- */

export interface LoanStatementSummary {
  /** Outstanding at the start of the selected period (0 for full history). */
  openingBalance: number;
  /** Receivable opened by a disbursement inside the period. */
  disbursementInPeriod: number;
  /** Sanctioned cash disbursed (memo — equals principal when disbursed). */
  disbursedAmount: number;
  /** Installments scheduled inside the period (memo — demand, not balance). */
  totalDues: number;
  /** Successful payments inside the period (counted only). */
  totalPaid: number;
  /** Reversed payments inside the period (memo — already excluded). */
  adjustments: number;
  /** opening + disbursementInPeriod − totalPaid — reconciles exactly. */
  closingOutstanding: number;
  /** Lifetime figures, independent of the period filter. */
  lifetimePaid: number;
  lifetimeReversed: number;
}

export interface LoanRepaymentStatus {
  nextDueDate: number | null;
  nextDueAmount: number | null;
  currentArrears: number;
  overdueDays: number;
  totalOverdueAmount: number;
  totalPaidToDate: number;
  outstanding: number;
  lastPaymentDate: number | null;
  lastPaymentAmount: number | null;
  installmentsPaid: number;
  installmentsDue: number;
  installmentsRemaining: number;
  upcoming: {
    loanId: string;
    index: number;
    dueDate: number;
    amount: number;
    paid: number;
    remaining: number;
  }[];
}

export interface LoanStatementResult {
  loanId: string;
  ledger: StatementLedgerRow[];
  summary: LoanStatementSummary;
  repayment: LoanRepaymentStatus;
}

/**
 * Chronological ledger + reconciled summary + repayment status for ONE loan.
 *
 * The running balance is built over the FULL ledger (so a date-filtered view
 * still shows true balances) and only then filtered for display. The last
 * balance always equals the stored `loan.outstanding`.
 */
export function buildLoanStatement(
  loan: StatementLoan,
  filters: StatementFilters = {},
  nowMs: number = Date.now(),
): LoanStatementResult {
  /* --- Receivable: Σ schedule totalDue (charges are financed in row 1). --- */
  const receivable = round2(loan.schedule.reduce((s, r) => s + r.totalDue, 0));
  const counted = loan.collections
    .filter(isCountedPayment)
    .sort((a, b) => a.createdAt - b.createdAt);

  /* ----------------------- Full ledger with balance ---------------------- */
  // Rows are collected first, sorted chronologically, THEN the running
  // balance is walked in date order — so an installment due after several
  // payments shows the balance as of ITS date, not as of push order.
  type PendingRow = StatementLedgerRow;
  const full: PendingRow[] = [];

  if (loan.disbursedAt != null) {
    full.push({
      id: `disb-${loan._id}`,
      date: loan.disbursedAt,
      type: "DISBURSEMENT",
      reference: loan.loanId,
      due: null,
      paid: null,
      principalPart: null,
      interestPart: null,
      balanceAfter: 0, // assigned by the walk below
      mode: null,
      staffId: loan.staffId,
      status: "DISBURSED",
      counted: true,
      remarks: `Sanctioned ₹${loan.principal.toLocaleString("en-IN")}${loan.charges > 0 ? ` · charges ₹${loan.charges.toLocaleString("en-IN")} financed` : ""}`,
      sortKey: loan.disbursedAt,
    });
  }

  for (const s of loan.schedule) {
    full.push({
      id: `due-${loan._id}-${s._id}`,
      date: s.dueDate,
      type: "INSTALLMENT_DUE",
      reference: `Inst ${s.index}/${loan.tenure}`,
      due: s.totalDue,
      paid: null,
      principalPart: null,
      interestPart: null,
      balanceAfter: 0,
      mode: null,
      staffId: null,
      status: s.paid >= s.totalDue ? "PAID" : s.paid > 0 ? "PARTIAL" : "OPEN",
      counted: false,
      remarks: null,
      sortKey: s.dueDate,
    });
  }

  for (const c of loan.collections) {
    const isReversal = c.status === "REVERSAL";
    const counts = isCountedPayment(c);
    full.push({
      id: `pay-${loan._id}-${c._id}`,
      date: c.createdAt,
      type: isReversal ? "REVERSAL" : "PAYMENT",
      reference: c.receiptNumber ?? c.code,
      due: null,
      paid: c.amount,
      principalPart: counts ? c.principalPortion : null,
      interestPart: counts ? c.interestPortion : null,
      balanceAfter: 0,
      mode: c.mode,
      staffId: c.staffId,
      status: c.status,
      counted: counts,
      remarks:
        c.remarks ??
        (isReversal
          ? `Refund of ${c.reversalOfId ? "reversed payment" : "payment"}`
          : c.status === "REVERSED"
            ? "Reversed — excluded from totals"
            : null),
      sortKey: c.createdAt,
    });
  }

  // Same-instant tiebreak: the disbursement opens the account, a demand
  // notice lands before the payment that settles it, and a refund follows
  // the payment it reverses.
  const TYPE_ORDER: Record<LedgerType, number> = {
    DISBURSEMENT: 0,
    INSTALLMENT_DUE: 1,
    PAYMENT: 2,
    REVERSAL: 3,
  };
  full.sort(
    (a, b) =>
      a.date - b.date ||
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      a.sortKey - b.sortKey,
  );
  let balance = 0;
  for (const r of full) {
    if (r.type === "DISBURSEMENT") balance = receivable;
    else if (r.type === "PAYMENT" && r.counted) {
      balance = round2(balance - (r.paid ?? 0));
    }
    r.balanceAfter = balance;
  }
  const ledger = full.filter((r) => inBounds(r.date, filters));

  /* ------------------------------ Summary -------------------------------- */
  const paidBefore = round2(
    counted
      .filter((c) => filters.fromMs != null && c.createdAt < filters.fromMs)
      .reduce((s, c) => s + c.amount, 0),
  );
  const openingBalance =
    filters.fromMs != null ? round2(Math.max(0, receivable - paidBefore)) : 0;
  const disbursementInPeriod =
    loan.disbursedAt != null && inBounds(loan.disbursedAt, filters) ? receivable : 0;
  const totalPaid = round2(
    counted.filter((c) => inBounds(c.createdAt, filters)).reduce((s, c) => s + c.amount, 0),
  );
  const totalDues = round2(
    loan.schedule.filter((r) => inBounds(r.dueDate, filters)).reduce((s, r) => s + r.totalDue, 0),
  );
  const adjustments = round2(
    loan.collections
      .filter((c) => c.status === "REVERSAL" && inBounds(c.createdAt, filters))
      .reduce((s, c) => s + c.amount, 0),
  );
  const lifetimePaid = round2(counted.reduce((s, c) => s + c.amount, 0));
  const lifetimeReversed = round2(
    loan.collections.filter((c) => c.status === "REVERSAL").reduce((s, c) => s + c.amount, 0),
  );
  const closingOutstanding = round2(
    openingBalance + disbursementInPeriod - totalPaid,
  );

  /* --------------------------- Repayment status -------------------------- */
  const openRows = loan.schedule
    .filter((r) => r.paid < r.totalDue)
    .sort((a, b) => a.index - b.index);
  const next = openRows[0] ?? null;
  const overdueRows = openRows.filter((r) => r.dueDate < nowMs);
  const totalOverdueAmount = round2(
    overdueRows.reduce((s, r) => s + (r.totalDue - r.paid), 0),
  );
  const last = counted[counted.length - 1] ?? null;

  return {
    loanId: loan.loanId,
    ledger,
    summary: {
      openingBalance,
      disbursementInPeriod,
      disbursedAmount: loan.disbursedAt != null ? loan.principal : 0,
      totalDues,
      totalPaid,
      adjustments,
      closingOutstanding,
      lifetimePaid,
      lifetimeReversed,
    },
    repayment: {
      nextDueDate: next?.dueDate ?? null,
      nextDueAmount: next ? round2(next.totalDue - next.paid) : null,
      currentArrears: totalOverdueAmount,
      overdueDays: overdueRows.length
        ? Math.max(...overdueRows.map((r) => overdueDays(r.dueDate, nowMs)))
        : 0,
      totalOverdueAmount,
      totalPaidToDate: lifetimePaid,
      outstanding: round2(
        loan.schedule.reduce((s, r) => s + Math.max(0, r.totalDue - r.paid), 0),
      ),
      lastPaymentDate: last?.createdAt ?? null,
      lastPaymentAmount: last ? round2(last.amount) : null,
      installmentsPaid: loan.schedule.filter((r) => r.paid >= r.totalDue).length,
      installmentsDue: overdueRows.length,
      installmentsRemaining: openRows.length,
      upcoming: openRows.map((r) => ({
        loanId: loan.loanId,
        index: r.index,
        dueDate: r.dueDate,
        amount: r.totalDue,
        paid: r.paid,
        remaining: round2(r.totalDue - r.paid),
      })),
    },
  };
}

/* ----------------------------- Combined ---------------------------------- */

export interface CombinedStatementResult {
  /** Always null — this is the all-loans view of one client. */
  loanId: null;
  ledger: StatementLedgerRow[];
  summary: {
    openingBalance: number;
    disbursementInPeriod: number;
    totalDues: number;
    totalPaid: number;
    adjustments: number;
    closingOutstanding: number;
  };
  repayment: {
    nextDueDate: number | null;
    nextDueAmount: number | null;
    totalOverdueAmount: number;
    overdueDays: number;
    totalPaidToDate: number;
    outstanding: number;
    installmentsPaid: number;
    installmentsRemaining: number;
    lastPaymentDate: number | null;
    lastPaymentAmount: number | null;
    upcoming: {
      loanId: string;
      index: number;
      dueDate: number;
      amount: number;
      paid: number;
      remaining: number;
    }[];
  };
}

/**
 * Combined statement across every loan of a client — the union of the
 * per-loan ledgers, de-duplicated by row id and merged chronologically.
 * Money figures are summed per loan (never re-derived), so the combined
 * closing equals the client's true total outstanding across loans.
 */
export function buildCombinedStatement(
  loans: StatementLoan[],
  filters: StatementFilters = {},
  nowMs: number = Date.now(),
): CombinedStatementResult {
  const parts = loans.map((l) => buildLoanStatement(l, filters, nowMs));
  const seen = new Set<string>();
  const ledger: StatementLedgerRow[] = [];
  for (const part of parts) {
    for (const row of part.ledger) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      ledger.push(row);
    }
  }
  ledger.sort((a, b) => a.date - b.date || a.sortKey - b.sortKey);

  const sum = <T>(arr: T[], pick: (x: T) => number) =>
    round2(arr.reduce((s, x) => s + pick(x), 0));
  const repayments = parts.map((p) => p.repayment);
  const upcoming = repayments
    .flatMap((r) => r.upcoming)
    .sort((a, b) => a.dueDate - b.dueDate || a.loanId.localeCompare(b.loanId));

  // Earliest upcoming installment across the client's loans.
  let earliest: { dueDate: number; amount: number } | null = null;
  for (const r of repayments) {
    if (r.nextDueDate == null || r.nextDueAmount == null) continue;
    if (!earliest || r.nextDueDate < earliest.dueDate) {
      earliest = { dueDate: r.nextDueDate, amount: r.nextDueAmount };
    }
  }
  let latestPayment: { date: number; amount: number } | null = null;
  for (const r of repayments) {
    if (r.lastPaymentDate == null || r.lastPaymentAmount == null) continue;
    if (!latestPayment || r.lastPaymentDate > latestPayment.date) {
      latestPayment = { date: r.lastPaymentDate, amount: r.lastPaymentAmount };
    }
  }

  return {
    loanId: null,
    ledger,
    summary: {
      openingBalance: sum(parts, (p) => p.summary.openingBalance),
      disbursementInPeriod: sum(parts, (p) => p.summary.disbursementInPeriod),
      totalDues: sum(parts, (p) => p.summary.totalDues),
      totalPaid: sum(parts, (p) => p.summary.totalPaid),
      adjustments: sum(parts, (p) => p.summary.adjustments),
      closingOutstanding: sum(parts, (p) => p.summary.closingOutstanding),
    },
    repayment: {
      nextDueDate: earliest?.dueDate ?? null,
      nextDueAmount: earliest?.amount ?? null,
      totalOverdueAmount: sum(repayments, (r) => r.totalOverdueAmount),
      overdueDays: Math.max(0, ...repayments.map((r) => r.overdueDays)),
      totalPaidToDate: sum(repayments, (r) => r.totalPaidToDate),
      outstanding: sum(repayments, (r) => r.outstanding),
      installmentsPaid: sum(repayments, (r) => r.installmentsPaid),
      installmentsRemaining: sum(repayments, (r) => r.installmentsRemaining),
      lastPaymentDate: latestPayment?.date ?? null,
      lastPaymentAmount: latestPayment?.amount ?? null,
      upcoming,
    },
  };
}

/* ------------------------------- Labels ---------------------------------- */

export const LEDGER_TYPE_LABELS: Record<LedgerType, string> = {
  DISBURSEMENT: "Disbursement",
  INSTALLMENT_DUE: "Installment due",
  PAYMENT: "Payment received",
  REVERSAL: "Reversal",
};

/** Human loan-purpose label from the stored application, or null. */
export function loanPurposeLabel(purpose?: string): string | null {
  if (!purpose) return null;
  const key = purpose.toUpperCase() as LoanPurpose;
  return LOAN_PURPOSE_LABELS[key] ?? purpose;
}
