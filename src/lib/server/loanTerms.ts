import { PERIODS_PER_YEAR, type Frequency, type InterestMethod } from "../finance/types";

/**
 * THE terms of every newly created loan.
 *
 * There is no loan-product catalogue any more: these terms live on the
 * server, are written onto each loan at approval, and are re-validated by the
 * backend at creation, approval and disbursement. The frontend never sends an
 * interest rate, frequency, tenure or installment — it only sends the client
 * and the requested principal, so it can never override what follows.
 *
 *   Annual nominal rate .... 78.5% p.a.
 *   Method ................. reducing balance (interest on the outstanding)
 *   Frequency .............. weekly
 *   Tenure ................. 24 installments = 24 weeks
 *
 * WEEKLY RATE CONVENTION: the nominal annual rate is divided by the number
 * of periods per year used by the schedule engine
 * (`PERIODS_PER_YEAR.WEEKLY` = 52), i.e.
 *
 *     weekly rate r = 78.5% / 52 = 1.509615...% per week
 *
 * On ₹15,000 over 24 weekly installments this prices the annuity at ₹749.70,
 * which the engine rounds to a ₹750 whole-rupee installment — the amount the
 * field actually collects.
 *
 * The same `PERIODS_PER_YEAR` value feeds `generateSchedule`, so the rate,
 * the amortization and every preview/EMI shown to the user share one
 * convention. Monthly logic is never used to price a weekly loan (the
 * monthly-equivalent figure exists only for obligation-ratio policy checks).
 */
export const FIXED_LOAN_TERMS = {
  /** Annual nominal interest rate, in percent per annum. */
  interestRate: 78.5,
  interestMethod: "REDUCING" as InterestMethod,
  frequency: "WEEKLY" as Frequency,
  /** Number of installments — 24 weekly periods = 24 weeks of tenure. */
  tenure: 24,
  /** Days of grace after each weekly due date (none by default). */
  graceDays: 0,
  /** Policy: maximum total obligations as a % of household income. */
  maxObligationRatio: 50,
} as const;

/** Periodic (weekly) interest rate in percent — 78.5 / 52. */
export const WEEKLY_RATE_PCT =
  FIXED_LOAN_TERMS.interestRate / PERIODS_PER_YEAR[FIXED_LOAN_TERMS.frequency];

/**
 * The exact schedule input used by every backend calculation for a new loan
 * (creation, approval, disbursement, preview, statement) so no call site can
 * drift from the fixed terms.
 *
 * `anchorOn` is the date the repayment schedule hangs off: the schedule engine
 * puts the first installment exactly one repayment period after it. For a new
 * loan this is the manually selected FIRST MEETING DATE (weekly meetings →
 * installments on the same weekday); only when a loan has no first meeting
 * date (legacy records) does it fall back to the disbursement moment. The
 * interest, principal split, tenure and installment amount are untouched —
 * only the calendar anchor moves.
 */
export function fixedScheduleInput(principal: number, anchorOn: number) {
  return {
    principal,
    interestRate: FIXED_LOAN_TERMS.interestRate,
    interestMethod: FIXED_LOAN_TERMS.interestMethod,
    frequency: FIXED_LOAN_TERMS.frequency,
    tenure: FIXED_LOAN_TERMS.tenure,
    disbursedOn: anchorOn,
    graceDays: FIXED_LOAN_TERMS.graceDays,
    // The fee is never financed into the schedule — principal + reducing-
    // balance interest only.
    charges: 0,
  };
}

/**
 * Processing fee for a new loan.
 *
 * The old product-specific fees (4% / ₹300 / ₹400 …) are gone with the
 * catalogue, and this system has no separately authorized fee rule, so a new
 * loan carries NO fee until one exists. Should a fee rule be authorised
 * later, it is implemented here — the single server-side place — and flows
 * through `charges` on the application/loan, the disbursement journal (fee
 * income) and every screen automatically, exactly once.
 */
export function authorizedCharges(amount: number): number {
  void amount;
  return 0;
}
