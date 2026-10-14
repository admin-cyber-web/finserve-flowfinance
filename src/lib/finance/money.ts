/** Indian-format currency helpers. Pure, isomorphic (server + browser). */

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inrPaise = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ₹4,00,000 — Indian digit grouping, no decimals unless asked. */
export function formatINR(value: number, opts: { paise?: boolean } = {}): string {
  if (!Number.isFinite(value)) return "₹0";
  const negative = value < 0;
  const abs = Math.abs(value);
  const body = opts.paise ? inrPaise.format(abs) : inr.format(abs);
  return `${negative ? "−" : ""}₹${body}`;
}

/** ₹2.75L / ₹1.2Cr for tight spaces (dashboard cards). */
export function formatINRCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_00_00_000) return `₹${(value / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `₹${(value / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000) return `₹${(value / 1_000).toFixed(1)}K`;
  return formatINR(value);
}

/** "1,200" / "₹1,200" / "1.2e5" → 1200. Returns NaN when unparseable. */
export function parseAmount(raw: string): number {
  if (typeof raw !== "string") return NaN;
  const cleaned = raw.replace(/[₹,\s_]/g, "");
  if (cleaned === "" || cleaned === "-") return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/** Round to 2 decimals (paise) — the precision used across the ledger. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Percentage with 1 decimal, clamped at 0 for negative numerators. */
export function percent(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, round2((part / whole) * 100)));
}

/** Safe divide used by dashboards (returns 0 instead of Infinity/NaN). */
export function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return numerator / denominator;
}

/** Completed, full calendar months between two epoch ms timestamps.
 * The count advances only when the day-of-month of `end` is at or past the
 * day-of-month of `start`, so a mid-month disbursement does not claim a full
 * month until the same day of a later month has elapsed. Returns 0 when
 * `end` is on or before `start`.
 */
export function completedMonthsBetween(startMs: number, endMs: number): number {
  const d0 = new Date(startMs);
  const d1 = new Date(endMs);
  if (d1.getTime() <= d0.getTime()) return 0;
  let months = (d1.getFullYear() - d0.getFullYear()) * 12 + (d1.getMonth() - d0.getMonth());
  if (d1.getDate() < d0.getDate()) months -= 1;
  return Math.max(0, months);
}
