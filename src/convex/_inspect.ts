/**
 * Internal verification helpers — NOT exposed to the app.
 *
 * These mutations exist so the verification tests can read/write the
 * deployed database with known identities. They are keepers of the
 * verification story; they are intentionally NOT wired into the UI.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  allocateBranchId,
  buildBranchFields,
  branchIdCodeOf,
  formatBranchId,
} from "../lib/server/branchOps";
import { requireProfile } from "../lib/server/convexHelpers";
import { requiredString } from "../lib/finance/validate";

/** List branches with their creation time for backfill ordering. */
export const branchList = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const rows = await ctx.db.query("branches").collect();
    return rows
      .map((b) => ({
        _id: b._id,
        code: b.code,
        name: b.name,
        status: b.status,
        createdAt: b.createdAt,
        _creationTime: b._creationTime,
        branchIdCode: b.branchIdCode,
      }))
      .sort((a, b) => a._creationTime - b._creationTime);
  },
});

/** Assign branchIdCode to branches that don't have one yet, in creation
 * order starting at 1001. Safe to re-run: only fills missing values. */
export const backfillBranchIds = mutation({
  args: {},
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    if (me.role !== "SUPER_ADMIN") {
      throw new Error("Only SUPER_ADMIN can backfill branch IDs.");
    }

    const rows = await ctx.db.query("branches").collect();
    rows.sort((a, b) => a._creationTime - b._creationTime);

    let next = 1001;
    const assigned: { _id: Id<"branches">; branchIdCode: number }[] = [];

    for (const b of rows) {
      if (b.branchIdCode != null) {
        // Track the highest existing code so we don't reissue it.
        if (b.branchIdCode >= next) next = b.branchIdCode + 1;
        continue;
      }
      const code = next++;
      await ctx.db.patch(b._id, { branchIdCode: code });
      assigned.push({ _id: b._id, branchIdCode: code });
    }

    return {
      assigned,
      highestRemaining: next - 1,
      nextCode: next,
    };
  },
});
