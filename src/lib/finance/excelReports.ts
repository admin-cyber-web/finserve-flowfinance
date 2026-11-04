/**
 * Row builders for the four Excel-style reports on the Reports screen:
 *
 *   1. Disbursement Report     — loans disbursed inside the date range
 *   2. Collection Report       — successful payments inside the date range
 *   3. Due Date Collection     — loans with an installment due in the range
 *   4. Overdue Report          — overdue arrears as of the To date, bucketed
 *
 * Everything here is pure (no React, no Convex) so the date scoping, MOB,
 * arrear and bucket maths can be unit-tested directly with `bun test`.
 * The Convex query only joins documents and passes them in.
 *
 * Day arithmetic is institution-local (IST): a due date is "overdue" from the
 * next IST calendar day, never a few hours after its due timestamp.
 */

import { DAY_MS, IST_OFFSET_MS } from "./dateReport";
import { rowOutstanding } from "./schedule";
import { idQueryMatches } from "../server/idMatch";

export interface DateBounds {
  from: number; // start of the From date (IST), inclusive
  to: number; // end of the To date (IST), inclusive
}

/** Facts about a loan + its client + its group, already joined by the query. */
export interface LoanFacts {
  loanPk: string; // loans._id — used only for grouping/sorting
  loanId: string; // LAN, e.g. LN-000123
  clientCode: string; // Client ID, e.g. C-000128
  customerName: string;
  groupId: string; // group code, "—" when the client is in no group
  groupName: string;
  disbursedAt?: number;
  principal: number;
  tenure: number;
  installment: number;
  /** Manually selected centre meeting schedule (absent on legacy loans). */
  centerMeetingDay?: string;
  firstMeetingDate?: number;
}

export interface CollectionFacts extends LoanFacts {
  collectionId: string;
  status: string; // NORMAL | REVERSED | REVERSAL
  reversalOfId?: string;
  paidAt: number;
  paidAmount: number;
}

export interface ScheduleFacts extends LoanFacts {
  dueDate: number;
  totalDue: number;
  paid: number;
  /** Settlement waiver on the row — reduces arrears without being cash. */
  waived?: number;
}

/** The ten columns every one of the four reports starts with. */
export interface CommonReportRow {
  sr: number;
  clientCode: string;
  loanId: string;
  groupName: string;
  groupId: string;
  customerName: string;
  disbursedAt: number | null;
  loanAmount: number;
  tenure: number;
  emi: number;
}

export interface DisbursementRow extends CommonReportRow {
  disbursedAt: number;
}

export interface CollectionRow extends CommonReportRow {
  mob: number | null;
  paidAt: number;
  paidAmount: number;
}

export interface DueDateRow extends CommonReportRow {
  mob: number | null;
  arrear: number;
  arrearDays: number;
  totalDueAmount: number;
  /** Centre meeting day chosen for this loan (— when not recorded). */
  centerMeetingDay: string;
  /** First installment falling due inside the range — shown with weekday. */
  nextDueDate: number;
}

export interface OverdueRow extends CommonReportRow {
  bkt1: number; // 1–7 days overdue
  bkt2: number; // 8–15 days overdue
  bkt3: number; // 16–22 days overdue
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Start of the IST calendar day containing `ms`. */
export function istDayStartMs(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/**
 * Whole IST calendar days between the due date and the reference moment.
 * 0 = due today (not overdue), 1 = due yesterday, …
 */
export function overdueDays(dueDate: number, asOf: number): number {
  return Math.round((istDayStartMs(asOf) - istDayStartMs(dueDate)) / DAY_MS);
}

/**
 * Months on book — completed calendar months from disbursement to `refMs`.
 * Returns `null` when the loan has no disbursement date (never 0 by guess).
 */
export function mobMonths(disbursedAt: number | undefined, refMs: number): number | null {
  if (disbursedAt === undefined) return null;
  if (refMs <= disbursedAt) return 0;
  const a = new Date(disbursedAt);
  const b = new Date(refMs);
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) months -= 1; // not a complete month yet
  return Math.max(0, months);
}

/** Unpaid remainder of one installment — never negative, waived-aware. */
function remainder(row: { totalDue: number; paid: number; waived?: number }): number {
  return rowOutstanding(row);
}

/**
 * Overdue buckets of the Overdue Report: [1–7], [8–15], [16–22] days.
 * Returns `null` for "not due yet" (0 days) and for arrears older than 22
 * days — the Excel sheet caps at 22, so those amounts are deliberately NOT
 * spread across the three buckets (a rupee can only ever land in one bucket
 * and older arrears stay visible in the Overdue & Recovery module, which has
 * its own 0-7 / 8-30 / 31-60 / 60+ buckets).
 */
export function bucketIndex(days: number): 0 | 1 | 2 | null {
  if (days >= 1 && days <= 7) return 0;
  if (days >= 8 && days <= 15) return 1;
  if (days >= 16 && days <= 22) return 2;
  return null;
}

function commonRow(facts: LoanFacts, sr: number): CommonReportRow {
  return {
    sr,
    clientCode: facts.clientCode,
    loanId: facts.loanId,
    groupName: facts.groupName,
    groupId: facts.groupId,
    customerName: facts.customerName,
    disbursedAt: facts.disbursedAt ?? null,
    loanAmount: facts.principal,
    tenure: facts.tenure,
    emi: facts.installment,
  };
}

/* ---------------------------- 1. Disbursement ---------------------------- */

export function buildDisbursementRows(
  loans: LoanFacts[],
  bounds: DateBounds,
): DisbursementRow[] {
  return loans
    .filter(
      (l) =>
        l.disbursedAt !== undefined &&
        l.disbursedAt >= bounds.from &&
        l.disbursedAt <= bounds.to,
    )
    .sort(
      (a, b) =>
        (a.disbursedAt ?? 0) - (b.disbursedAt ?? 0) ||
        a.loanId.localeCompare(b.loanId),
    )
    .map((l, i) => ({ ...commonRow(l, i + 1), disbursedAt: l.disbursedAt! }));
}

/* ------------------------------ 2. Collection ---------------------------- */

/**
 * One row per SUCCESSFUL payment in the range. Only `NORMAL` collections are
 * counted: a reversed payment (status REVERSED) and its compensating entry
 * (status REVERSAL) are both skipped, so no rupee is ever counted twice —
 * and wallet transactions are never read here (the collection ledger is the
 * single source of truth).
 */
export function buildCollectionRows(
  rows: CollectionFacts[],
  bounds: DateBounds,
): CollectionRow[] {
  return rows
    .filter(
      (r) =>
        r.status === "NORMAL" &&
        !r.reversalOfId &&
        r.paidAt >= bounds.from &&
        r.paidAt <= bounds.to,
    )
    .sort((a, b) => a.paidAt - b.paidAt || a.loanId.localeCompare(b.loanId))
    .map((r, i) => ({
      ...commonRow(r, i + 1),
      mob: mobMonths(r.disbursedAt, r.paidAt),
      paidAt: r.paidAt,
      paidAmount: round2(r.paidAmount),
    }));
}

/* --------------------------- 3. Due Date Collection ---------------------- */

/**
 * One row per loan that has at least one installment DUE inside the range.
 * The input must carry every schedule of the loan up to the To date so that:
 *   - Arrear          = unpaid remainder of installments overdue as of To date
 *   - Arrear Days     = IST days since the OLDEST such overdue installment
 *   - Total Due       = unpaid remainder of everything due on/before To date
 *                       (arrear ⊆ total due — never double counted)
 *   - MOB             = completed months from disbursement to the To date
 */
export function buildDueDateRows(
  rows: ScheduleFacts[],
  bounds: DateBounds,
): DueDateRow[] {
  const asOf = bounds.to;
  const byLoan = new Map<string, ScheduleFacts[]>();
  for (const row of rows) {
    const list = byLoan.get(row.loanPk);
    if (list) list.push(row);
    else byLoan.set(row.loanPk, [row]);
  }

  const out: { firstDue: number; row: DueDateRow }[] = [];
  for (const list of byLoan.values()) {
    const inWindow = list.filter(
      (s) => s.dueDate >= bounds.from && s.dueDate <= bounds.to,
    );
    if (inWindow.length === 0) continue;

    const overdueRows = list.filter(
      (s) => remainder(s) > 0 && overdueDays(s.dueDate, asOf) >= 1,
    );
    const arrear = round2(overdueRows.reduce((s, r) => s + remainder(r), 0));
    const arrearDays = overdueRows.length
      ? Math.max(...overdueRows.map((r) => overdueDays(r.dueDate, asOf)))
      : 0;
    const totalDueAmount = round2(
      list
        .filter((s) => s.dueDate <= asOf)
        .reduce((s, r) => s + remainder(r), 0),
    );

    const facts = list[0];
    out.push({
      firstDue: Math.min(...inWindow.map((s) => s.dueDate)),
      row: {
        ...commonRow(facts, 0), // sr assigned after sorting
        mob: mobMonths(facts.disbursedAt, asOf),
        arrear,
        arrearDays,
        totalDueAmount,
        centerMeetingDay: facts.centerMeetingDay ?? "—",
        nextDueDate: Math.min(...inWindow.map((s) => s.dueDate)),
      },
    });
  }

  return out
    .sort(
      (a, b) =>
        a.firstDue - b.firstDue || a.row.loanId.localeCompare(b.row.loanId),
    )
    .map((entry, i) => ({ ...entry.row, sr: i + 1 }));
}

/** Collection board search — case-insensitive Group Name / Group ID / LAN.
 *
 * Single shared helper, so both the [Collection] screen and this project's
 * tests assert the exact match rule without re-implementing it. Returns every
 * row whose groupName, groupId or loanId contains `q`; blank or absent query
 * returns the full list.
 */
export interface MatchCollectionSearchInput {
  groupName: string;
  groupId: string;
  loanId: string;
}

export function matchCollectionSearch(
  rows: readonly MatchCollectionSearchInput[],
  q: string | undefined,
): readonly MatchCollectionSearchInput[] {
  const needle = (q ?? "").trim().toLowerCase();
  if (!needle) return rows;
  const out: MatchCollectionSearchInput[] = [];
  for (const row of rows) {
    if (
      row.groupName.toLowerCase().includes(needle) ||
      row.groupId.toLowerCase().includes(needle) ||
      row.loanId.toLowerCase().includes(needle) ||
      // "LN-000123", "LN000123" and "000123" all resolve to the loan.
      idQueryMatches(row.loanId, q ?? "")
    )
      out.push(row);
  }
  return out;
}
/* ------------------------------ 4. Overdue ------------------------------- */

/**
 * One row per loan with overdue money as of the To date, with the arrears
 * partitioned into the sheet's three buckets. Each unpaid installment
 * contributes to AT MOST ONE bucket (see `bucketIndex`), so the three bucket
 * columns never overlap; arrears older than 22 days land in no bucket.
 */
export function buildOverdueRows(
  rows: ScheduleFacts[],
  bounds: DateBounds,
): OverdueRow[] {
  const asOf = bounds.to;
  const byLoan = new Map<string, ScheduleFacts[]>();
  for (const row of rows) {
    const list = byLoan.get(row.loanPk);
    if (list) list.push(row);
    else byLoan.set(row.loanPk, [row]);
  }

  const out: { maxDays: number; row: OverdueRow }[] = [];
  for (const list of byLoan.values()) {
    const overdueRows = list.filter(
      (s) => remainder(s) > 0 && overdueDays(s.dueDate, asOf) >= 1,
    );
    if (overdueRows.length === 0) continue;

    const buckets = [0, 0, 0];
    let maxDays = 0;
    for (const r of overdueRows) {
      const days = overdueDays(r.dueDate, asOf);
      if (days > maxDays) maxDays = days;
      const idx = bucketIndex(days);
      if (idx !== null) buckets[idx] = round2(buckets[idx] + remainder(r));
    }

    out.push({
      maxDays,
      row: {
        ...commonRow(list[0], 0), // sr assigned after sorting
        bkt1: buckets[0],
        bkt2: buckets[1],
        bkt3: buckets[2],
      },
    });
  }

  // Most overdue first.
  return out
    .sort((a, b) => b.maxDays - a.maxDays || a.row.loanId.localeCompare(b.row.loanId))
    .map((entry, i) => ({ ...entry.row, sr: i + 1 }));
}
