import { round2 } from "./money";
import { generateSchedule } from "./schedule";
import type { Frequency } from "./types";

/**
 * Recast the OPEN tail of an existing repayment schedule at a new rate.
 *
 * History is never rewritten: installments that have received money (even a
 * partial payment) or that were waived stay exactly as they are. The first
 * untouched installment starts the recast — the outstanding principal of that
 * installment and everything after it is re-amortized at the new annual rate
 * over the same number of remaining installments, on the same due dates.
 *
 * This is what makes a rate correction safe for live loans: collected cash,
 * receipts, the ledger and the paid rows are untouched, while every future
 * installment is priced at the corrected rate and the closing row absorbs the
 * rounding remainder.
 */

export interface RecastRow {
  index: number;
  dueDate: number;
  principal: number;
  interest: number;
  totalDue: number;
  paid: number;
  waived?: number;
  principalBalance?: number;
}

export interface RecastResult<T extends RecastRow> {
  rows: T[];
  /** Index of the first recast installment, or null when nothing was open. */
  recastFromIndex: number | null;
  /** Principal still owed when the recast starts. */
  remainingPrincipal: number;
  remainingInstallments: number;
  /** New whole-rupee installment, or null when nothing was open. */
  installment: number | null;
}

const openOn = (row: RecastRow): number =>
  round2(Math.max(0, row.totalDue - row.paid - (row.waived ?? 0)));

export function recastOpenTail<T extends RecastRow>(
  rows: T[],
  annualRate: number,
  frequency: Frequency,
): RecastResult<T> {
  const sorted = [...rows].sort((a, b) => a.index - b.index);
  const start = sorted.findIndex((row) => row.paid <= 0 && openOn(row) > 0);

  if (start === -1) {
    return {
      rows: sorted,
      recastFromIndex: null,
      remainingPrincipal: 0,
      remainingInstallments: 0,
      installment: null,
    };
  }

  const remainingPrincipal = round2(
    sorted.slice(start).reduce((sum, row) => sum + row.principal, 0),
  );
  const remainingInstallments = sorted.length - start;
  if (remainingPrincipal <= 0) {
    return {
      rows: sorted,
      recastFromIndex: null,
      remainingPrincipal: 0,
      remainingInstallments: 0,
      installment: null,
    };
  }

  // Only the amounts come from the engine — the calendar (due dates and
  // installment indexes) is the one already on the loan.
  const priced = generateSchedule({
    principal: remainingPrincipal,
    annualRate,
    method: "REDUCING",
    frequency,
    tenure: remainingInstallments,
    disbursedOn: sorted[start].dueDate,
    graceDays: 0,
  });

  const recast = sorted.map((row, position) => {
    if (position < start) return row;
    const fresh = priced.rows[position - start];
    const totalDue = round2(fresh.principal + fresh.interest);
    // Every original field is kept — only the priced amounts are replaced.
    return {
      ...row,
      principal: fresh.principal,
      interest: fresh.interest,
      totalDue,
      paid: 0,
      waived: 0,
      remaining: totalDue,
      principalBalance: fresh.principalBalance,
    } as T;
  });

  return {
    rows: recast,
    recastFromIndex: sorted[start].index,
    remainingPrincipal,
    remainingInstallments,
    installment: priced.installment,
  };
}
