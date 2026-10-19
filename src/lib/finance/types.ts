/**
 * FinServe domain vocabulary.
 *
 * Single source of truth for roles, statuses and transaction types used by
 * BOTH the Convex backend (validation) and the UI (labels / tones). Nothing in
 * here knows about React or about Convex documents.
 */

/* ----------------------------- Roles & status ---------------------------- */

export const FS_ROLES = [
  "SUPER_ADMIN",
  "BRANCH_MANAGER",
  "FIELD_STAFF",
  "ACCOUNTANT",
  "CLIENT",
] as const;
export type FsRole = (typeof FS_ROLES)[number];

export const ROLE_LABELS: Record<FsRole, string> = {
  SUPER_ADMIN: "Super Admin",
  BRANCH_MANAGER: "Branch Manager",
  FIELD_STAFF: "Field Staff",
  ACCOUNTANT: "Accountant",
  CLIENT: "Client",
};

export const USER_STATUSES = [
  "ACTIVE",
  "SUSPENDED",
  "BLOCKED",
  "DEACTIVATED",
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const KYC_STATUS = ["PENDING", "VERIFIED", "REJECTED"] as const;
export type KycStatus = (typeof KYC_STATUS)[number];

export const DOC_STATUS = [
  "UPLOADED",
  "PENDING_VERIFICATION",
  "VERIFIED",
  "REJECTED",
] as const;
export type DocStatus = (typeof DOC_STATUS)[number];

/* ------------------------------ Loan domain ------------------------------ */

export const LOAN_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "DISBURSED",
  "ACTIVE",
  "OVERDUE",
  "SURRENDERED",
  "SETTLED",
  "CLOSED",
  "WRITTEN_OFF",
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const SCHEDULE_STATUSES = [
  "PAID",
  "PARTIAL",
  "PENDING",
  "OVERDUE",
  "WAIVED",
] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const FREQUENCIES = ["WEEKLY", "FORTNIGHTLY", "MONTHLY"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** Loan purpose declared on the client application (informational). */
export const LOAN_PURPOSES = [
  "BUSINESS",
  "AGRICULTURE",
  "EDUCATION",
  "MEDICAL",
  "HOUSEHOLD",
  "OTHER",
] as const;
export type LoanPurpose = (typeof LOAN_PURPOSES)[number];

export const LOAN_PURPOSE_LABELS: Record<LoanPurpose, string> = {
  BUSINESS: "Business",
  AGRICULTURE: "Agriculture",
  EDUCATION: "Education",
  MEDICAL: "Medical",
  HOUSEHOLD: "Household",
  OTHER: "Other",
};

/** "For office use only" vocabularies — never auto-set to a pass value. */
export const OFFICE_VERIFICATION = ["VERIFIED", "NOT_VERIFIED"] as const;
export const OFFICE_KYC = ["COMPLETE", "INCOMPLETE"] as const;
export const OFFICE_CREDIT = ["RECOMMENDED", "NOT_RECOMMENDED"] as const;

export const INTEREST_METHODS = ["FLAT", "REDUCING"] as const;
export type InterestMethod = (typeof INTEREST_METHODS)[number];

export const PAY_MODES = ["CASH", "UPI", "BANK"] as const;
export type PayMode = (typeof PAY_MODES)[number];

/** Periods per year used by every schedule calculation. */
export const PERIODS_PER_YEAR: Record<Frequency, number> = {
  WEEKLY: 52,
  FORTNIGHTLY: 26,
  MONTHLY: 12,
};

export const DAYS_PER_PERIOD: Record<Frequency, number> = {
  WEEKLY: 7,
  FORTNIGHTLY: 14,
  MONTHLY: 30,
};

/* ----------------------------- Wallet ledger ----------------------------- */

export const WALLET_TX_TYPES = [
  "OPENING_ALLOCATION",
  "LOAN_DISBURSEMENT",
  "CASH_COLLECTION",
  "UPI_COLLECTION",
  "BANK_COLLECTION",
  "CASH_HANDOVER",
  "CASH_ISSUE",
  "APPROVED_ADJUSTMENT",
  "REVERSAL",
  "EXPENSE",
] as const;
export type WalletTxType = (typeof WALLET_TX_TYPES)[number];

export const TX_DIRECTIONS = ["CREDIT", "DEBIT", "NONE"] as const;
export type TxDirection = (typeof TX_DIRECTIONS)[number];

/**
 * How each wallet transaction type moves the *available* balance by default.
 * UPI / BANK collections settle into the bank account, not the cash wallet,
 * so they are recorded on the wallet ledger with direction NONE: visible for
 * audit, but they never inflate cash availability.
 */
export const WALLET_TX_EFFECT: Record<WalletTxType, TxDirection> = {
  OPENING_ALLOCATION: "CREDIT",
  LOAN_DISBURSEMENT: "DEBIT",
  CASH_COLLECTION: "CREDIT",
  UPI_COLLECTION: "NONE",
  BANK_COLLECTION: "NONE",
  CASH_HANDOVER: "DEBIT",
  CASH_ISSUE: "CREDIT",
  APPROVED_ADJUSTMENT: "CREDIT", // direction overridden per transaction
  REVERSAL: "CREDIT", // direction mirrors the original transaction
  EXPENSE: "DEBIT",
};

export const WALLET_TX_LABELS: Record<WalletTxType, string> = {
  OPENING_ALLOCATION: "Opening allocation",
  LOAN_DISBURSEMENT: "Loan disbursed",
  CASH_COLLECTION: "Cash collected",
  UPI_COLLECTION: "UPI collected",
  BANK_COLLECTION: "Bank collected",
  CASH_HANDOVER: "Cash handover",
  CASH_ISSUE: "Cash issued",
  APPROVED_ADJUSTMENT: "Approved adjustment",
  REVERSAL: "Reversal",
  EXPENSE: "Expense",
};

/* --------------------------- Cash management ----------------------------- */

export const HANDOVER_STATUSES = [
  "REQUESTED",
  "ACCEPTED",
  "REJECTED",
] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];

export const CLOSING_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type ClosingStatus = (typeof CLOSING_STATUSES)[number];

export const EXPENSE_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const RECOVERY_KINDS = [
  "VISIT",
  "CONTACT",
  "PROMISE_TO_PAY",
  "PARTIAL_PAYMENT",
  "PAYMENT_RECEIVED",
  "ESCALATION",
  "GRIEVANCE",
] as const;
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

export const OVERDUE_BUCKETS = ["0-7", "8-30", "31-60", "60+"] as const;
export type OverdueBucket = (typeof OVERDUE_BUCKETS)[number];

export function bucketFor(daysPastDue: number): OverdueBucket {
  if (daysPastDue <= 7) return "0-7";
  if (daysPastDue <= 30) return "8-30";
  if (daysPastDue <= 60) return "31-60";
  return "60+";
}

/* ------------------------------- Labels ---------------------------------- */

/** Flat status colour tones (Neobrutalist palette classes). */
export type Tone = "ok" | "warn" | "bad" | "info" | "idle" | "hot";

export const STATUS_TONES: Record<string, Tone> = {
  ACTIVE: "ok",
  PAID: "ok",
  APPROVED: "ok",
  DISBURSED: "ok",
  VERIFIED: "ok",
  ACCEPTED: "ok",
  CLOSED: "info",
  SUBMITTED: "info",
  UNDER_REVIEW: "info",
  PENDING: "warn",
  PARTIAL: "warn",
  REQUESTED: "warn",
  UPLOADED: "warn",
  PENDING_VERIFICATION: "warn",
  OVERDUE: "bad",
  REJECTED: "bad",
  BLOCKED: "bad",
  DEACTIVATED: "bad",
  SUSPENDED: "bad",
  WRITTEN_OFF: "bad",
  SURRENDERED: "warn",
  SETTLED: "ok",
  WAIVED: "info",
  DRAFT: "idle",
};

export const LOAN_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  DISBURSED: "Disbursed",
  ACTIVE: "Active",
  OVERDUE: "Overdue",
  SURRENDERED: "Surrendered",
  SETTLED: "Settled",
  CLOSED: "Closed",
  WRITTEN_OFF: "Written off",
};

export const RECOVERY_LABELS: Record<RecoveryKind, string> = {
  VISIT: "Field visit",
  CONTACT: "Contact attempt",
  PROMISE_TO_PAY: "Promise to pay",
  PARTIAL_PAYMENT: "Partial payment",
  PAYMENT_RECEIVED: "Payment received",
  ESCALATION: "Escalation",
  GRIEVANCE: "Grievance",
};

export const BUCKET_LABELS: Record<OverdueBucket, string> = {
  "0-7": "0–7 days",
  "8-30": "8–30 days",
  "31-60": "31–60 days",
  "60+": "60+ days",
};

export function completedMonthsSince(disbursementEpochMs: number | null | undefined, nowMs: number): number {
  if (!disbursementEpochMs) return 0;
  const d0 = new Date(disbursementEpochMs);
  const d1 = new Date(nowMs);
  return (d1.getFullYear() - d0.getFullYear()) * 12 + (d1.getMonth() - d0.getMonth());
}
