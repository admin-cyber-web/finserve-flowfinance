import { query } from "./_generated/server";

/** TEMPORARY inspection query — removed before delivery. */
export const inspect = query({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.db.query("profiles").collect();
    const branches = await ctx.db.query("branches").collect();
    const users = await ctx.db.query("users").collect();
    const codes = await ctx.db
      .query("authVerificationCodes")
      .collect();
    return {
      branches: branches.map((b) => ({ id: b._id, name: b.name })),
      users: users.map((u) => ({ email: u.email ?? null, name: u.name ?? null })),
      profiles: profiles.map((p) => ({
        email: p.email ?? null,
        name: p.name,
        role: p.role,
        status: p.status,
        staffId: p.staffId,
        userId: p.userId ?? null,
        branchId: p.branchId ?? null,
      })),
      codes: codes.map((c) => ({
        provider: c.provider,
        code: c.code,
        expirationTime: c.expirationTime,
      })),
    };
  },
});
