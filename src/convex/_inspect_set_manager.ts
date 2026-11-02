import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireProfile } from "../lib/server/convexHelpers";

export const setKnpManager = mutation({
  args: {},
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    if (me.role !== "SUPER_ADMIN") throw new Error("admin only");
    const branchId: Id<"branches"> = "ps76hgy5mxg02y17t5q36kncpd8fw23b" as Id<"branches">;
    const managerId: Id<"profiles"> = "p574ae493kw1d8xcwsmqq262498ga2pc" as Id<"profiles">;
    await ctx.db.patch(branchId, { managerId });
    const b = await ctx.db.get(branchId);
    return { ok: true, managerId: (b as any)?.managerId };
  },
});
