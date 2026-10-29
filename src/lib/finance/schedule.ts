import { PERIODS_PER_YEAR, type Frequency, type InterestMethod } from "./types";
import { round2 } from "./money";

/**
 * Repayment schedule engine.
 *
 * Supports flat and reducing-balance interest across weekly, fortnightly and
 * monthly frequencies. Nothing is hard-coded to one product formula: every
 * input comes from the loan product + application.
 */

export interface ScheduleInput {
  principal: number;
  /** Annual interest rate in percent (e.g. 18 for 18% p.a.). */
  annualRate: number;
  method: InterestMethod;
  frequency: Frequency;
  /** Number of installments. */
  tenure: number;
  /** Epoch ms of the disbursement date. */
  disbursedOn: number;
  /** Days before the first installment falls due. */
  graceDays?: number;
}

export interface ScheduleRow {
  index: number;
  dueDate: number;
  principal: number;
  interest: number;
  totalDue: number;
  paid: number;
  remaining: number;
  /** Outstanding principal AFTER this installment — declines to 0 by the last row. */
  principalBalance: number;
}

export interface ScheduleResult {
  rows: ScheduleRow[];
  totalInterest: number;
  totalPayable: number;
  /** Per-installment amount (equal installments; last one absorbs rounding). */
  installment: number;
  method: InterestMethod;
  frequency: Frequency;
  tenure: number;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Declining principal balance per row: the balance AFTER this installment is
 * paid — the principal of every later installment. The last row closes at 0,
 * and Σ principal always equals the receivable (the last row's rounding
 * absorber is included automatically), for flat and reducing rows alike.
 */
export function withPrincipalBalance(rows: ScheduleRow[]): ScheduleRow[] {
  let balance = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    rows[i].principalBalance = balance;
    balance = round2(balance + rows[i].principal);
  }
  return rows;
}

export function addPeriods(
  from: number,
  frequency: Frequency,
  count: number,
): number {
  if (frequency === "MONTHLY") {
    const d = new Date(from);
    const day = d.getDate();
    d.setMonth(d.getMonth() + count);
    // Guard against month-end rollover (31 Jan + 1 month → 28 Feb not 3 Mar).
    if (d.getDate() !== day) d.setDate(0);
    return d.getTime();
  }
  const days = frequency === "WEEKLY" ? 7 * count : 14 * count;
  return from + days * DAY;
}

export function nextDueDate(from: number, frequency: Frequency): number {
  return addPeriods(from, frequency, 1);
}

/** Build the full repayment schedule for a loan. */
export function generateSchedule(input: ScheduleInput): ScheduleResult {
  const { principal, annualRate, method, frequency, tenure } = input;
  const periods = PERIODS_PER_YEAR[frequency];
  const graceDays = Math.max(0, Math.round(input.graceDays ?? 0));
  // First installment falls due one repayment period after disbursement,
  // pushed further out by any grace period the product grants.
  const firstDue = addPeriods(input.disbursedOn, frequency, 1) + graceDays * DAY;

  const rows: ScheduleRow[] = [];

  if (method === "FLAT") {
    // Flat: interest on the original principal for the whole tenure.
    const totalInterest = round2(
      (principal * annualRate * (tenure / periods)) / 100,
    );
    const totalPayable = round2(principal + totalInterest);
    const installment = round2(totalPayable / tenure);
    let principalLeft = principal;
    let interestLeft = totalInterest;

    for (let i = 1; i <= tenure; i++) {
      const isLast = i === tenure;
      const p = isLast ? round2(principalLeft) : round2((principal * 1) / tenure);
      const it = isLast
        ? round2(interestLeft)
        : round2((totalInterest * 1) / tenure);
      principalLeft = round2(principalLeft - p);
      interestLeft = round2(interestLeft - it);
      rows.push({
        index: i,
        dueDate: addPeriods(firstDue, frequency, i - 1),
        principal: p,
        interest: it,
        totalDue: round2(p + it),
        paid: 0,
        remaining: round2(p + it),
        principalBalance: 0, // back-filled below
      });
    }
    return {
      rows: withPrincipalBalance(rows),
      totalInterest,
      totalPayable,
      installment,
      method,
      frequency,
      tenure,
    };
  }

  // Reducing balance: classic annuity amortization.
  const r = annualRate / 100 / periods;
  let balance = principal;
  const installment =
    r === 0
      ? round2(principal / tenure)
      : round2(
          (principal * r) / (1 - Math.pow(1 + r, -tenure)),
        );
  let totalInterest = 0;

  for (let i = 1; i <= tenure; i++) {
    const isLast = i === tenure;
    const interest = round2(balance * r);
    let p = isLast
      ? round2(balance)
      : round2(installment - interest);
    if (isLast && round2(balance + interest) < installment) {
      p = round2(balance);
    }
    const totalDue = isLast ? round2(p + interest) : installment;
    balance = round2(balance - p);
    totalInterest = round2(totalInterest + interest);
    rows.push({
      index: i,
      dueDate: addPeriods(firstDue, frequency, i - 1),
      principal: p,
      interest,
      totalDue,
      paid: 0,
      remaining: totalDue,
      principalBalance: 0, // back-filled below
    });
  }

  const totalPayable = round2(principal + totalInterest);
  return {
    rows: withPrincipalBalance(rows),
    totalInterest,
    totalPayable,
    installment,
    method,
    frequency,
    tenure,
  };
}

/**
 * What is still OPEN on one installment: due minus cash received minus any
 * amount waived by an approved settlement. This is the single definition of
 * "remaining on a row" used by collections, reports, views and the
 * statement engine — a waived rupee closes the row but is never counted as
 * money received.
 */
export function rowOutstanding(row: {
  totalDue: number;
  paid: number;
  waived?: number;
}): number {
  return round2(Math.max(0, row.totalDue - row.paid - (row.waived ?? 0)));
}

/** Re-derive PAID / PARTIAL / PENDING / OVERDUE for a row. */
export function scheduleRowStatus(
  row: { totalDue: number; paid: number; dueDate: number },
  now: number,
): "PAID" | "PARTIAL" | "PENDING" | "OVERDUE" {
  if (row.paid >= row.totalDue && row.totalDue > 0) return "PAID";
  if (row.paid > 0) return now > row.dueDate ? "OVERDUE" : "PARTIAL";
  return now > row.dueDate ? "OVERDUE" : "PENDING";
}
