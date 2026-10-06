import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { seedActivity, seedOrg } from "../lib/server/seed";

/**
 * Demo dataset — idempotent and atomic. `seedOrg` must succeed before
 * `seedActivity`; the dashboard runs them in order once per browser.
 */
export const seedOrgPhase = mutation({
  args: {},
  handler: async (ctx) => {
    const result = await seedOrg(ctx);
    return { ok: true, ...result };
  },
});

export const seedActivityPhase = mutation({
  args: {},
  handler: async (ctx) => {
    const result = await seedActivity(ctx);
    return { ok: true, ...result };
  },
});

export const isSeeded = mutation({
  args: { phase: v.union(v.literal("org"), v.literal("activity")) },
  handler: async (ctx, { phase }) => {
    if (phase === "org") {
      const branches = await ctx.db.query("branches").collect();
      return { present: branches.length > 0 };
    }
    const loans = await ctx.db.query("loans").collect();
    return { present: loans.length > 0 };
  },
});
