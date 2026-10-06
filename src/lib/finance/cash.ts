import { round2 } from "./money";

/**
 * Daily cash closing formula (spec §21):
 *
 *   Opening Cash
 * + Cash Received From BM
 * + Cash Collections
 * − Loan Disbursement
 * − Cash Handover
 * − Approved Expenses
 * = Expected Cash
 *
 * Difference = Actual − Expected → non-zero requires an explanation and BM
 * approval. There is never a "set balance" operation.
 */

export interface CashClosingInput {
  opening: number;
  cashReceived: number;
  cashCollections: number;
  disbursement: number;
  handover: number;
  expenses: number;
}

export interface CashClosingResult {
  expected: number;
  actual: number;
  difference: number;
  matches: boolean;
}

export function expectedCash(input: CashClosingInput): number {
  return round2(
    input.opening +
      input.cashReceived +
      input.cashCollections -
      input.disbursement -
      input.handover -
      input.expenses,
  );
}

export function evaluateClosing(
  input: CashClosingInput,
  actual: number,
): CashClosingResult {
  const expected = expectedCash(input);
  const difference = round2(actual - expected);
  return {
    expected,
    actual: round2(actual),
    difference,
    matches: Math.abs(difference) < 0.01,
  };
}
