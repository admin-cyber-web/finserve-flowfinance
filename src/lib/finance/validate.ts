/**
 * Server-side input validation primitives shared by all Convex mutations.
 * Domain validation lives here, not in the UI.
 */

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
