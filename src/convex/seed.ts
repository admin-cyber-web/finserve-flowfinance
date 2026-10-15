import { v } from "convex/values";
import { mutation } from "./_generated/server";

/**
 * Demo seeding is permanently disabled.
 *
 * These mutations used to run `seedOrg` / `seedActivity` from
 * `src/lib/server/seed.ts` (that file has been removed). They are kept only
 * as no-ops so that any stale client bundle that still calls them can never
 * recreate demo users, clients, loans, wallets or transactions. They perform
 * no reads and no writes.
 */
export const seedOrgPhase = mutation({
  args: {},
  handler: async () => {
    return { ok: true, disabled: true, skipped: true };
  },
});

export const seedActivityPhase = mutation({
  args: {},
  handler: async () => {
    return { ok: true, disabled: true, skipped: true };
  },
});

/** Read-only check — reports whether any workspace data exists. */
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
