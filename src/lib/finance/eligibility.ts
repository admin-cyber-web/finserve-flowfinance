import { round2 } from "./money";

/**
 * Eligibility / policy engine.
 *
 * Configurable lender policy — never bypassed. The proposed obligation is
 * checked against household income using the product's maximum obligation
 * ratio. Warnings are surfaced verbatim in the loan wizard and re-checked on
 * the server before a loan can be approved.
 */

export interface EligibilityInput {
  householdIncome: number;
  monthlyIncome?: number;
  /** EMIs the client already pays on other loans. */
  existingObligations: number;
  /** Installment of the loan being proposed right now. */
  proposedObligation: number;
  /** Product policy: max total obligations as % of household income. */
  maxObligationRatio: number;
  /** Number of past loans with an overdue installment ever. */
  overdueHistory?: number;
  activeLoans?: number;
}

export interface EligibilityIssue {
  level: "POLICY WARNING" | "BLOCKER";
  message: string;
}

export interface EligibilityResult {
  totalObligation: number;
  obligationRatio: number; // % of household income
  issues: EligibilityIssue[];
  /** False when at least one BLOCKER applies — server refuses approval. */
  eligible: boolean;
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const household = Math.max(0, input.householdIncome);
  const existing = Math.max(0, input.existingObligations);
  const proposed = Math.max(0, input.proposedObligation);
  const total = round2(existing + proposed);
  const ratioPct = household > 0 ? round2((total / household) * 100) : 100;

  const issues: EligibilityIssue[] = [];

  if (household <= 0) {
    issues.push({
      level: "BLOCKER",
      message: "Household income is required before eligibility can be assessed.",
    });
  }

  if (ratioPct > input.maxObligationRatio) {
    issues.push({
      level: "POLICY WARNING",
      message:
        `Household income ₹${household.toLocaleString("en-IN")} − existing obligations ₹${existing.toLocaleString("en-IN")}` +
        ` − new proposed obligation ₹${proposed.toLocaleString("en-IN")} = ₹${total.toLocaleString("en-IN")}` +
        ` (${ratioPct}% of income). Policy limit is ${input.maxObligationRatio}%.`,
    });
  }

  if (ratioPct > 70) {
    issues.push({
      level: "BLOCKER",
      message:
        "Total obligations exceed 70% of household income — lender policy does not permit disbursement.",
    });
  }

  if ((input.overdueHistory ?? 0) > 0) {
    issues.push({
      level: "POLICY WARNING",
      message: `Client has an overdue history (${input.overdueHistory} past overdue installment${input.overdueHistory === 1 ? "" : "s"}). Manual review required.`,
    });
  }

  if (input.activeLoans && input.activeLoans >= 3) {
    issues.push({
      level: "POLICY WARNING",
      message: "Client already holds 3 or more active loans — review exposure before approving.",
    });
  }

  return {
    totalObligation: total,
    obligationRatio: ratioPct,
    issues,
    eligible: !issues.some((i) => i.level === "BLOCKER"),
  };
}
