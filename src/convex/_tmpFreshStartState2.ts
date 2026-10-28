import { internalQuery } from "./_generated/server";

/** TEMPORARY (delete after use): dump auth users, centres, wallets, journal refs. */
export const dump = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [users, centers, wallets, journals, collections, notifications] =
      await Promise.all([
        ctx.db.query("users").collect(),
        ctx.db.query("centers").collect(),
        ctx.db.query("wallets").collect(),
        ctx.db.query("journalEntries").collect(),
        ctx.db.query("collections").collect(),
        ctx.db.query("notifications").collect(),
      ]);
    return {
      users: users.map((u) => ({
        id: u._id, name: u.name, email: u.email, role: u.role, isAnonymous: u.isAnonymous,
      })),
      centers: centers.map((c) => ({
        id: c._id, code: c.code, name: c.name, branchId: c.branchId, village: c.village,
      })),
      wallets: wallets.map((w) => ({
        id: w._id, profileId: w.profileId, branchId: w.branchId, limit: w.walletLimit, status: w.status,
      })),
      journalRefs: journals.map((j) => ({ entryId: j.entryId, refType: j.refType, refId: j.refId })),
      collectionCount: collections.length,
      notifications: notifications.map((n) => ({ title: n.title, kind: n.kind })),
    };
  },
});
