/**
 * Server-side input validation primitives shared by all Convex mutations.
 * Domain validation lives here, not in the UI.
 */

import { FREQUENCIES, LOAN_PURPOSES } from "./types";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

/** Rejects values outside a fixed vocabulary. */
export function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(
      `Invalid ${field}: expected one of ${allowed.join(", ")}`,
    );
  }
  return value as T[number];
}

/** Money must be a finite, positive, 2-decimal-rounded amount. */
export function money(
  value: unknown,
  field: string,
  opts: { allowZero?: boolean } = {},
): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new ValidationError(`Invalid ${field}: must be a number`);
  }
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  if (rounded < 0 || (!opts.allowZero && rounded <= 0)) {
    throw new ValidationError(
      `Invalid ${field}: must be ${opts.allowZero ? "non-negative" : "greater than zero"}`,
    );
  }
  return rounded;
}

export function requiredString(value: unknown, field: string, max = 300): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`Invalid ${field}: required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ValidationError(`Invalid ${field}: too long (max ${max})`);
  }
  return trimmed;
}

/** Indian mobile numbers: 10 digits, optionally prefixed with +91. */
export function mobileNumber(value: unknown, field = "mobile"): string {
  const raw = requiredString(value, field, 16).replace(/[\s-]/g, "");
  const digits = raw.replace(/^\+91/, "").replace(/^\+/, "");
  if (!/^[6-9]\d{9}$/.test(digits)) {
    throw new ValidationError(`Invalid ${field}: expected a 10-digit Indian mobile number`);
  }
  return digits;
}

export function optionalString(
  value: unknown,
  field: string,
  max = 300,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, field, max);
}

/**
 * Completed years of age for a date of birth (epoch ms), relative to `now`.
 * Shared by the client form (auto age display) and the backend (re-validation).
 */
export function ageFromDob(dob: number, now: number = Date.now()): number {
  const b = new Date(dob);
  const d = new Date(now);
  let age = d.getFullYear() - b.getFullYear();
  const m = d.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && d.getDate() < b.getDate())) age -= 1;
  return age;
}

/* ------------------ Application-form sub-objects ------------------------ */

/**
 * The four optional blocks on the joining form (loan request, bank account,
 * nominee, references) are validated by the SAME parsers on create and on
 * update, so a direct backend call cannot store anything the form itself
 * would reject. Error messages are identical to the original create-time
 * messages (they surface verbatim as toast text).
 */

export type LoanRequestValue = {
  amountRequested: number;
  purpose: string;
  tenureMonths: number;
  repaymentFrequency: string;
  estimatedInstallment?: number;
};

export function loanRequestValue(
  value: unknown,
  field = "loanRequest",
): LoanRequestValue {
  const lr = (value ?? {}) as Record<string, unknown>;
  return {
    amountRequested: money(lr.amountRequested, `${field}.amountRequested`),
    purpose: oneOf(lr.purpose, LOAN_PURPOSES, `${field}.purpose`),
    tenureMonths: intInRange(lr.tenureMonths, `${field}.tenureMonths`, 1, 120),
    repaymentFrequency: oneOf(
      lr.repaymentFrequency,
      FREQUENCIES,
      `${field}.repaymentFrequency`,
    ),
    estimatedInstallment:
      lr.estimatedInstallment !== undefined && lr.estimatedInstallment !== null
        ? money(lr.estimatedInstallment, `${field}.estimatedInstallment`, {
            allowZero: true,
          })
        : undefined,
  };
}

export type BankAccountValue = {
  accountHolderName: string;
  bankName: string;
  branch: string;
  accountNumber: string;
  ifscCode: string;
};

export function bankAccountValue(
  value: unknown,
  field = "bankAccount",
): BankAccountValue {
  const b = (value ?? {}) as Record<string, unknown>;
  const accountNumber = requiredString(b.accountNumber, `${field}.accountNumber`, 24).replace(
    /\s/g,
    "",
  );
  if (!/^\d{6,20}$/.test(accountNumber)) {
    throw new ValidationError("Bank account number must be 6-20 digits.");
  }
  const ifscCode = requiredString(b.ifscCode, `${field}.ifscCode`, 11).toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
    throw new ValidationError("Invalid IFSC code — expected e.g. SBIN0001234.");
  }
  return {
    accountHolderName: requiredString(
      b.accountHolderName,
      `${field}.accountHolderName`,
      80,
    ),
    bankName: requiredString(b.bankName, `${field}.bankName`, 80),
    branch: requiredString(b.branch, `${field}.branch`, 80),
    accountNumber,
    ifscCode,
  };
}

export type NomineeValue = {
  name: string;
  relationship: string;
  age: number;
  mobile?: string;
  address?: string;
};

export function nomineeValue(value: unknown, field = "nominee"): NomineeValue {
  const n = (value ?? {}) as Record<string, unknown>;
  return {
    name: requiredString(n.name, `${field}.name`, 80),
    relationship: requiredString(n.relationship, `${field}.relationship`, 40),
    age: intInRange(n.age, `${field}.age`, 1, 120),
    mobile: n.mobile ? mobileNumber(n.mobile, `${field}.mobile`) : undefined,
    address: optionalString(n.address, `${field}.address`, 300),
  };
}

export type ReferenceValue = { name: string; mobile: string };

/**
 * Two character-reference rows from the joining form. A row where both
 * fields are blank is dropped; a half-filled row is rejected; at most two
 * rows are kept. Returns `undefined` when nothing usable was provided, so
 * the caller can leave the field unset.
 */
export function referencesValue(
  value: unknown,
  field = "references",
): ReferenceValue[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ValidationError(`Invalid ${field}: expected a list`);
  }
  if (value.length > 2) {
    throw new ValidationError(`Invalid ${field}: at most 2 references`);
  }
  const out: ReferenceValue[] = [];
  value.forEach((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const mobile = typeof r.mobile === "string" ? r.mobile.trim() : "";
    if (!name && !mobile) return; // untouched row — not stored
    if (!name || !mobile) {
      throw new ValidationError(
        `Invalid ${field}[${i}]: both name and mobile are required`,
      );
    }
    out.push({
      name: requiredString(name, `${field}[${i}].name`, 80),
      mobile: mobileNumber(mobile, `${field}[${i}].mobile`),
    });
  });
  return out.length > 0 ? out : undefined;
}

export function intInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new ValidationError(`Invalid ${field}: must be a number`);
  }
  const i = Math.round(n);
  if (i < min || i > max) {
    throw new ValidationError(`Invalid ${field}: must be between ${min} and ${max}`);
  }
  return i;
}
