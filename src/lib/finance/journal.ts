import { round2 } from "./money";

/**
 * Double-entry journal templates.
 *
 * Every financial event in FinServe produces balanced journal entries. No
 * balance is ever edited directly — only new entries are appended.
 *
 *   Loan disbursement : Loan Receivable Dr / Cash Cr
 *   Cash collection   : Cash Dr / Loan Receivable Cr (principal)
 *                             / Interest Income Cr (interest)
 *   UPI/Bank collect  : Bank Dr / Loan Receivable Cr + Interest Income Cr
 *   Cash handover     : BM cash Dr / Staff cash Cr
 *   Cash issue        : Staff cash Dr / BM cash Cr
 *   Expense           : Expense Dr / Cash Cr
 */

export interface AccountDef {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  normalSide: "DEBIT" | "CREDIT";
}

export const ACCOUNTS: AccountDef[] = [
  { code: "1010", name: "Cash in Hand — Field Staff", type: "ASSET", normalSide: "DEBIT" },
  { code: "1015", name: "Cash in Hand — Branch / BM", type: "ASSET", normalSide: "DEBIT" },
  { code: "1020", name: "Bank Account", type: "ASSET", normalSide: "DEBIT" },
  { code: "1100", name: "Loan Receivable", type: "ASSET", normalSide: "DEBIT" },
  { code: "1200", name: "Advance to Staff", type: "ASSET", normalSide: "DEBIT" },
  { code: "2010", name: "Suspense / Clearing", type: "LIABILITY", normalSide: "CREDIT" },
  { code: "4000", name: "Interest Income", type: "INCOME", normalSide: "CREDIT" },
  { code: "4010", name: "Processing Fee Income", type: "INCOME", normalSide: "CREDIT" },
  { code: "4020", name: "Other Approved Charges", type: "INCOME", normalSide: "CREDIT" },
  { code: "5000", name: "Operating Expenses", type: "EXPENSE", normalSide: "DEBIT" },
];

export const ACCOUNT_MAP: Record<string, AccountDef> = Object.fromEntries(
  ACCOUNTS.map((a) => [a.code, a]),
);

export interface JournalLine {
  code: string;
  debit: number;
  credit: number;
}

export interface JournalEntrySpec {
  memo: string;
  refType: string;
  refId: string;
  lines: JournalLine[];
}

const dr = (code: string, amount: number): JournalLine => ({
  code,
  debit: round2(amount),
  credit: 0,
});
const cr = (code: string, amount: number): JournalLine => ({
  code,
  debit: 0,
  credit: round2(amount),
});

export function totals(lines: JournalLine[]) {
  return {
    debit: round2(lines.reduce((s, l) => s + l.debit, 0)),
    credit: round2(lines.reduce((s, l) => s + l.credit, 0)),
  };
}

/** Guards the accounting equation before an entry is ever written. */
export function isBalanced(lines: JournalLine[]): boolean {
  const { debit, credit } = totals(lines);
  return Math.abs(debit - credit) < 0.005 && debit > 0;
}

/** Disbursal: principal (+ fee if deducted) moves from cash to receivable. */
export function disbursementEntry(p: {
  principal: number;
  fee?: number;
  cashSource: "staff" | "bank";
  memo: string;
  refId: string;
}): JournalEntrySpec {
  const fee = round2(p.fee ?? 0);
  const cashAccount = p.cashSource === "staff" ? "1010" : "1020";
  const lines: JournalLine[] = [
    dr("1100", p.principal),
    cr(cashAccount, round2(p.principal - fee)),
  ];
  if (fee > 0) lines.push(cr("4010", fee));
  return {
    memo: p.memo,
    refType: "DISBURSEMENT",
    refId: p.refId,
    lines,
  };
}

/** Repayment allocation: principal + interest from cash or bank. */
export function collectionEntry(p: {
  principal: number;
  interest: number;
  mode: "CASH" | "UPI" | "BANK";
  memo: string;
  refId: string;
}): JournalEntrySpec {
  const cashAccount =
    p.mode === "CASH" ? "1010" : p.mode === "UPI" ? "1020" : "1020";
  const lines: JournalLine[] = [];
  const total = round2(p.principal + p.interest);
  lines.push(dr(cashAccount, total));
  if (p.principal > 0) lines.push(cr("1100", p.principal));
  if (p.interest > 0) lines.push(cr("4000", p.interest));
  return { memo: p.memo, refType: "COLLECTION", refId: p.refId, lines };
}

/** Staff → BM cash handover. */
export function handoverEntry(p: {
  amount: number;
  memo: string;
  refId: string;
}): JournalEntrySpec {
  return {
    memo: p.memo,
    refType: "CASH_HANDOVER",
    refId: p.refId,
    lines: [dr("1015", p.amount), cr("1010", p.amount)],
  };
}

/** BM → staff working cash issue (wallet refill). */
export function issueEntry(p: {
  amount: number;
  memo: string;
  refId: string;
}): JournalEntrySpec {
  return {
    memo: p.memo,
    refType: "CASH_ISSUE",
    refId: p.refId,
    lines: [dr("1010", p.amount), cr("1015", p.amount)],
  };
}

/** Approved expense paid from staff cash. */
export function expenseEntry(p: {
  amount: number;
  memo: string;
  refId: string;
}): JournalEntrySpec {
  return {
    memo: p.memo,
    refType: "EXPENSE",
    refId: p.refId,
    lines: [dr("5000", p.amount), cr("1010", p.amount)],
  };
}
