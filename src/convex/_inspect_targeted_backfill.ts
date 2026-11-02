import { mutation } from "./_generated/server";
import { requireProfile } from "../lib/server/convexHelpers";

/** Assign explicit branchIdCode values to existing branches for the spec.
 * Order: KNP=1001, LKO=1002, VNS=1003, BLW=1004.
 *
 * KNP is the first branch in the spec (Branch ID 1001 = KNP) and has the
 * oldest creation timestamp (tied with LKO). We make KNP=1001 so the spec
 * example ('Branch 1001 = KNP') holds.
 */
export const backfillBranchIdsSpec = mutation({
  args: {},
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    if (me.role !== "SUPER_ADMIN") {
      throw new Error("Only SUPER_ADMIN can run this.");
    }

    const map: Record<string, number> = {
      // KNP first (oldest, spec branch 1001)
      "ps76hgy5mxg02y17t5q36kncpd8fw23b": 1001,
      // LKO second
      "ps7f8gp7yzzqa01cc2xtn49q2n8fx25k": 1002,
      // VNS third
      "ps75tepws4zbys3zntp2v4hmkn8fwp1t": 1003,
      // BLW fourth (currently active, used by Pankaj/Raushan/test FS)
      "ps78wn6a0jrp5jxwy6pms9w4ts8h5756": 1004,
    };

    const results: { id: string; code: string; branchIdCode: number }[] = [];
    for (const [_id, branchIdCode] of Object.entries(map)) {
      const id = _id as any;
      const b = await ctx.db.get(id);
      if (!b || !("code" in b)) {
        results.push({ id: _id, code: "NOT_FOUND", branchIdCode });
        continue;
      }
      const branch = b as any;
      await ctx.db.patch(id, { branchIdCode });
      results.push({ id: _id, code: branch.code, branchIdCode });
    }

    // set next branch code to 1005
    const counter = await ctx.db
      .query("counters")
      .withIndex("by_key", (q) => q.eq("key", "branchId"))
      .unique();
    if (!counter) {
      await ctx.db.insert("counters", { key: "branchId", value: 1005 });
    } else if (counter.value < 1005) {
      await ctx.db.patch(counter._id, { value: 1005 });
    }

    return { updated: results };
  },
});
