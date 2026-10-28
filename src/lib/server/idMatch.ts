/**
 * ID matching for the simplified numeric staff/client IDs.
 *
 * Stored IDs are numeric (0002, 000137) — or a legacy prefixed form kept on
 * the profile (BM-10002). Searches and sign-in must accept every natural way
 * of typing an ID:
 *
 *   - the numeric ID without a prefix ("0002", "10002")
 *   - the existing ID with its prefix and hyphen ("BM-10002", "C-000137")
 *   - the existing ID with its prefix but no hyphen ("BM10002", "C000137")
 *
 * Staff and client matching stay in their own namespace — each search only
 * ever compares a query against its own entity's IDs, so a staff member and
 * a client sharing a numeric component can never be confused.
 */

/** Remove every non-alphanumeric character and upper-case: "BM-10002" -> "BM10002". */
const strip = (s: string): string => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Digits only: "C-000137" -> "000137". */
const digits = (s: string): string => String(s ?? "").replace(/\D/g, "");

/**
 * Strict match used where a query must resolve to ONE stored identifier
 * (statement search, exact lookups): equal after stripping punctuation, or
 * identical digit strings ("C-000137" ≡ "000137" ≡ "C000137").
 */
export function idExactMatches(stored: string, query: string): boolean {
  const s = String(stored ?? "").trim();
  const q = String(query ?? "").trim();
  if (!q) return false;
  if (strip(s) === strip(q)) return true;
  const sd = digits(s);
  const qd = digits(q);
  return sd.length > 0 && sd === qd;
}

/**
 * List-search match: everything `idExactMatches` accepts, plus a fully
 * numeric query compared by value so typing "137" or "2" still finds
 * "000137" / "0002". A minimum of 3 digits keeps one-character queries from
 * matching half the directory.
 */
export function idQueryMatches(stored: string, query: string): boolean {
  const s = String(stored ?? "").trim();
  const q = String(query ?? "").trim();
  if (!q) return false;
  if (idExactMatches(s, q)) return true;
  const sd = digits(s);
  const qd = digits(q);
  if (sd.length === 0 || qd.length === 0) return false;

  const qLetters = strip(q).replace(/[0-9]/g, "");
  if (qLetters) {
    // The query carries letters ("BM-10002", "LN-000001") — it may only
    // match an identifier with the SAME prefix and number, so a loan ID can
    // never resolve to a staff number or vice versa.
    const sLetters = strip(s).replace(/[0-9]/g, "");
    return (
      qLetters === sLetters && Number(qd) === Number(sd)
    );
  }

  // Purely numeric query ("000137", "137", "0002"): compare by value so
  // the displayed number is found with or without leading zeros. A 3-digit
  // minimum stops single characters from matching half the directory.
  if (qd.length < 3) return false;
  return Number(qd) === Number(sd);
}

/**
 * True when a profile's staff ID or any of its legacy prefixed IDs matches
 * the identifier a user typed (used by sign-in and staff search).
 */
export function staffIdMatches(
  staffId: string,
  legacyStaffIds: string[] | undefined,
  query: string,
): boolean {
  if (idQueryMatches(staffId, query)) return true;
  return (legacyStaffIds ?? []).some((legacy) => idQueryMatches(legacy, query));
}
