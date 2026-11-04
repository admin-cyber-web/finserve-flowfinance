/**
 * Centre meeting schedule — the meeting day and first meeting date an Admin
 * or Branch Manager picks MANUALLY on the New Loan screen, plus the display
 * helpers that keep the weekday visible everywhere a due date is shown.
 *
 * Pure (no DOM, no Convex imports) so the browser, the Convex backend and the
 * reports all share one definition of "which weekday is this business date".
 * Business dates are institution-local (IST, UTC+05:30) — the same clock
 * `istDateKey` uses for every other date key in the system.
 */

export const MEETING_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export type MeetingDay = (typeof MEETING_DAYS)[number];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** True for one of the seven selectable meeting days. */
export function isMeetingDay(value: unknown): value is MeetingDay {
  return (
    typeof value === "string" &&
    (MEETING_DAYS as readonly string[]).includes(value)
  );
}

/** Weekday name of an institution-local calendar date. */
export function istWeekday(ts: number): MeetingDay {
  return WEEKDAY_NAMES[new Date(ts + IST_OFFSET_MS).getUTCDay()] as MeetingDay;
}

/** "Monday, 09 November 2026" — detail panels and confirmations. */
export function formatMeetingDate(ts?: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts + IST_OFFSET_MS);
  return `${WEEKDAY_NAMES[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, "0")} ${
    MONTH_NAMES[d.getUTCMonth()]
  } ${d.getUTCFullYear()}`;
}

/** "Mon, 09 Nov 2026" — tables, cards and lists. */
export function formatMeetingDateShort(ts?: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts + IST_OFFSET_MS);
  return `${WEEKDAY_NAMES[d.getUTCDay()].slice(0, 3)}, ${String(
    d.getUTCDate(),
  ).padStart(2, "0")} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Weekday of a stored date, falling back to "—" when it is missing. */
export function weekdayOf(ts?: number | null): string {
  return ts ? istWeekday(ts) : "—";
}

/** `YYYY-MM-DD` (IST) for a native date input. */
export function toDateInputValue(ts?: number | null): string {
  if (!ts) return "";
  return new Date(ts + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Start of day (00:00 IST) for a `YYYY-MM-DD` date-input value, i.e. the exact
 * instant saved on the loan. Returns null for malformed or impossible dates
 * (2026-02-31 is rejected, not silently rolled over).
 */
export function fromDateInputValue(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const probe = new Date(utc);
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return utc - IST_OFFSET_MS;
}

/** Shift a stored business date by whole days (keeps it at IST midnight). */
export function addDays(ts: number, days: number): number {
  return ts + days * DAY_MS;
}

/**
 * A manually selected first meeting date must be a real calendar date within
 * a sane lending horizon — it is never derived from "today" automatically.
 */
export function isValidMeetingDate(
  ts: unknown,
  now: number = Date.now(),
): ts is number {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
  // Must be a whole business day (00:00 IST) — never a stray time of day.
  if ((ts + IST_OFFSET_MS) % DAY_MS !== 0) return false;
  return ts >= now - 10 * 365 * DAY_MS && ts <= now + 10 * 365 * DAY_MS;
}
