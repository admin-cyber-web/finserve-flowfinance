import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Display form of an application business ID — hyphens removed:
 * `BM-10002 → BM10002`, `C-000137 → C000137`, `LN-000002 → LN000002`,
 * `RCPT-261006-0007 → RCPT2610060007`, `257510 → 257510`.
 *
 * Pass ONLY identifier fields (staffId, code, loanId, appId, receipt number,
 * txn/entry ids, handover/issue/expense codes, ledger references). Never
 * pass names, addresses, remarks or dates — hyphens inside ordinary text
 * must stay untouched.
 */
export function fmtId(value: string | null | undefined): string {
  if (!value) return "";
  // A bare institution-local date (YYYY-MM-DD) is a date, not an ID.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  // Compound references such as "CLOSING:ST-10008:2026-10-30" — de-hyphenate
  // the ID segments only; date segments keep their hyphens.
  if (value.includes(":")) {
    return value
      .split(":")
      .map((seg) => (/^\d{4}-\d{2}-\d{2}/.test(seg) ? seg : seg.replace(/-/g, "")))
      .join(":");
  }
  return value.replace(/-/g, "");
}

/**
 * "NOT_VERIFIED" → "Not Verified" — turns a vocabulary code (snake/upper
 * case, e.g. loan purpose or office-use status) into a display label.
 */
export function sentenceCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/(^|\s)([a-z])/g, (_, prefix, char) => `${prefix}${char.toUpperCase()}`);
}
