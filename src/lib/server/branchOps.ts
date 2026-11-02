/**
 * Branch ID sequence helpers.
 *
 * Branch IDs are a backend-managed numeric serial starting at 1001 and
 * incrementing for every new branch. They are NEVER supplied by the frontend
 * and are never reused — even if a branch is later deactivated or deleted.
 *
 * Allocation is atomic within a Convex mutation: the global counter row
 * (key "branchId") is read, the next value is computed, and both the counter
 * patch and the new branch insert happen in the same mutation. Convex
 * serialises mutation commits (OCC with automatic retry), so concurrent
 * branch creation cannot hand out the same Branch ID — a conflicting commit
 * retries and picks up the next value.
 *
 * The counter stores the LAST allocated value. On first use it does not
 * exist, so the first allocation returns FIRST_BRANCH_ID (1001) and writes
 * the counter at 1001. Each subsequent call returns counter.value + 1.
 */

import type { Mtx } from "./convexHelpers";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { AppError } from "./convexHelpers";
import { requiredString, optionalString } from "../finance/validate";
import { v } from "convex/values";

/** Branch status vocabulary. */
export const BRANCH_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

/** Default branch status when none is supplied. */
export const DEFAULT_BRANCH_STATUS: BranchStatus = "ACTIVE";

/** Build a backend predicate that matches exactly one branch status. */
export function branchStatusValidator() {
  return v.union(...BRANCH_STATUSES.map((s) => v.literal(s)));
}

/** Resolve the branch a staff actor operates in (mirrors clients.create).
 *
 * For an org-wide SUPER_ADMIN with no home branch, defaults to the oldest
 * ACTIVE branch so backend flows (centre creation, client onboarding, loan
 * submission) are never blocked by bootstrap ordering.
 */
export async function resolveBranchForActor(
  ctx: Mtx,
  me: Doc<"profiles">,
): Promise<Id<"branches">> {
  if (me.branchId) return me.branchId;
  if (me.role === "SUPER_ADMIN") {
    const branches = (await ctx.db.query("branches").collect()).filter(
      (b) => b.status === "ACTIVE",
    );
    branches.sort((a, b) => a._creationTime - b._creationTime);
    if (!branches[0]) {
      throw new AppError(
        "No active branch exists yet — create a branch before creating centres.",
      );
    }
    return branches[0]._id;
  }
  throw new AppError("Your profile has no branch assigned.");
}

/** The current Branch ID (numeric) for a branch record, if one has been
 *  allocated. Existing branches may not have one yet — backfill assigns it. */
export function branchIdCodeOf(b: Doc<"branches"> | null): number | null {
  if (!b) return null;
  return b.branchIdCode ?? null;
}

/** Allocate the next per-branch client serial and persist it.
 *
 * Counter key: `clientSerial:<branchIdCode>`. Each branch has its own
 * independent serial starting at 1, so two branches never collide.
 *
 * The counter is created on first use and incremented atomically within the
 * calling mutation. Convex serialises mutation commits, so concurrent client
 * creation in the same branch cannot hand out the same serial.
 */
export async function allocateClientSerial(
  ctx: Mtx,
  branchIdCode: number,
): Promise<number> {
  const key = `clientSerial:${branchIdCode}`;
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

  const next = counter ? counter.value + 1 : 1;
  if (counter) {
    await ctx.db.patch(counter._id, { value: next });
  } else {
    await ctx.db.insert("counters", { key, value: next });
  }

  return next;
}

/** Allocate the next per-branch loan serial and persist it.
 *
 * Counter key: `loanSerial:<branchIdCode>`. Independent per branch, starting
 * at 1. Same concurrency safety as `allocateClientSerial`.
 */
export async function allocateLoanSerial(
  ctx: Mtx,
  branchIdCode: number,
): Promise<number> {
  const key = `loanSerial:${branchIdCode}`;
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

  const next = counter ? counter.value + 1 : 1;
  if (counter) {
    await ctx.db.patch(counter._id, { value: next });
  } else {
    await ctx.db.insert("counters", { key, value: next });
  }

  return next;
}

/** Validate that the caller is allowed to create a branch.
 * Only SUPER_ADMIN-equivalent accounts (including the Pankaj grant) may
 * create or edit branches. */
export function requireBranchAdmin(me: Doc<"profiles">): void {
  if (me.role !== "SUPER_ADMIN") {
    throw new AppError("Only SUPER_ADMIN can manage branches.");
  }
}

/** Build a new branch record's fields from the admin's form input.
 * Branch ID is allocated by the backend; the frontend may not supply it. */
export async function buildBranchFields(
  ctx: Mtx,
  name: string,
  city: string,
  state: string,
  status?: BranchStatus,
  address?: string,
  contactNumber?: string,
): Promise<{
  code: string;
  name: string;
  city: string;
  state: string;
  status: BranchStatus;
  address?: string;
  contactNumber?: string;
  branchIdCode: number;
}> {
  const branchIdCode = await allocateBranchId(ctx);
  return {
    code: `BR${branchIdCode}`, // internal reference code (legacy compatible)
    name: requiredString(name, "name", 120),
    city: requiredString(city, "city", 80),
    state: requiredString(state, "state", 80),
    status: status ?? DEFAULT_BRANCH_STATUS,
    address: address && address.trim() ? optionalString(address, "address", 300) : undefined,
    contactNumber: contactNumber && contactNumber.trim() ? optionalString(contactNumber, "contactNumber", 20) : undefined,
    branchIdCode,
  };
}

/** Pick a Branch Manager candidate for a branch.
 *
 * Returns profiles that:
 *  - have role BRANCH_MANAGER (or SUPER_ADMIN acting as admin),
 *  - are ACTIVE,
 *  - belong to the same branch (for staff-side assignment).
 *
 * For branch creation, the admin may pick any ACTIVE BM (or themselves if
 * they are a BM in the branch being created).
 */
export async function branchManagerCandidates(
  ctx: Mtx,
  branchId: Id<"branches"> | undefined,
): Promise<Doc<"profiles">[]> {
  const all = await ctx.db.query("profiles").collect();
  return all
    .filter(
      (p) =>
        (p.role === "BRANCH_MANAGER" || p.role === "SUPER_ADMIN") &&
        p.status === "ACTIVE",
    )
    .filter((p) => !branchId || p.branchId === branchId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reset the branch ID counter to a specific value (admin only).
 * Used only for testing — never exposed in the UI. */
export async function resetBranchIdCounter(ctx: Mtx, value: number): Promise<void> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", "branchId"))
    .unique();
  if (counter) {
    await ctx.db.patch(counter._id, { value });
  } else {
    await ctx.db.insert("counters", { key: "branchId", value });
  }
}

/** The first Branch ID issued by this system. */
export const FIRST_BRANCH_ID = 1001;

/** Allocate the next globally-unique Branch ID and persist the counter. */
export async function allocateBranchId(ctx: Mtx): Promise<number> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", "branchId"))
    .unique();

  // The counter stores the LAST allocated value. Allocate the next value,
  // starting at FIRST_BRANCH_ID (1001) on first use.
  const next = counter
    ? Math.max(counter.value + 1, FIRST_BRANCH_ID)
    : FIRST_BRANCH_ID;

  if (counter) {
    await ctx.db.patch(counter._id, { value: next });
  } else {
    await ctx.db.insert("counters", { key: "branchId", value: next });
  }

  return next;
}

/** Format a Branch ID for display (no leading zeros — it is a real number). */
export function formatBranchId(code: number | undefined | null): string {
  if (code == null) return "";
  return String(code);
}

/** Format a branch-scoped human-readable sequence number for display,
 *  expanding the serial width as the branch grows without ever truncating. */
export function formatBranchSerial(n: number): string {
  // Start at 2 digits; grow as needed so we never truncate or duplicate.
  const width = n <= 99 ? 2 : Math.max(2, Math.ceil(Math.log10(n + 1)));
  return String(n).padStart(width, "0");
}

/** Build a branch-scoped client code: C + BranchID(4) + serial. */
export function buildClientCode(branchIdCode: number, serial: number): string {
  return `C${String(branchIdCode).padStart(4, "0")}${formatBranchSerial(serial)}`;
}

/** Build a branch-scoped loan code: LN + BranchID(4) + serial. */
export function buildLoanCode(branchIdCode: number, serial: number): string {
  return `LN${String(branchIdCode).padStart(4, "0")}${formatBranchSerial(serial)}`;
}
