import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, TableNames } from "./_generated/dataModel";

const TABLES: TableNames[] = [
  "users",
  "profiles",
  "wallets",
  "walletTransactions",
  "clients",
  "clientGeoPhotos",
  "clientFamilyMembers",
  "clientStaffHistory",
  "clientDocuments",
  "clientNotes",
  "loanApplications",
  "loans",
  "loanSchedules",
  "collections",
  "receipts",
  "cashHandovers",
  "cashIssues",
  "cashClosings",
  "expenses",
  "journalEntries",
  "accountLedgers",
  "centers",
  "groups",
  "groupMembers",
  "meetings",
  "notifications",
  "approvalRequests",
  "recoveryActivities",
  "grievances",
  "devices",
  "counters",
  "auditLogs",
];

export const countProfilesByStaffId = query({
  args: {
    prefix: v.string(),
  },
  handler: async (ctx, args) => {
    const ps = await ctx.db.query("profiles").collect();
    return ps
      .filter((p: Doc<"profiles">) => String(p.staffId ?? "").startsWith(args.prefix))
      .sort((a, b) => String(a.staffId ?? "").localeCompare(String(b.staffId ?? "")))
      .map((p: Doc<"profiles">) => ({
        _id: p._id,
        userId: p.userId,
        email: p.email,
        mobile: p.mobile,
        name: p.name,
        staffId: p.staffId,
        role: p.role,
        branchId: p.branchId,
        status: p.status,
        persona: p.persona,
        clientId: p.clientId,
        permissions: p.permissions,
        createdBy: p.createdBy,
        createdAt: p.createdAt,
        lastLoginAt: p.lastLoginAt,
        twoFactorEnabled: p.twoFactorEnabled,
      }));
  },
});

export const counts = query({
  args: {},
  handler: async (ctx) => {
    const out: { table: string; count: number }[] = [];
    for (const t of TABLES) {
      out.push({ table: t, count: (await ctx.db.query(t).collect()).length });
    }
    return out;
  },
});

export const profileDump = query({
  args: {},
  handler: async (ctx) => {
    const ps = await ctx.db.query("profiles").collect();
    return ps.map((p: Doc<"profiles">) => ({
      _id: p._id,
      userId: p.userId,
      email: p.email,
      mobile: p.mobile,
      name: p.name,
      staffId: p.staffId,
      role: p.role,
      branchId: p.branchId,
      status: p.status,
      persona: p.persona,
      clientId: p.clientId,
      createdBy: p.createdBy,
      createdAt: p.createdAt,
      credentialHash: p.credentialHash,
      twoFactorEnabled: p.twoFactorEnabled,
    }));
  },
});

export const branchesDump = query({
  args: {},
  handler: async (ctx) => {
    const bs = await ctx.db.query("branches").collect();
    return bs.map((b: Doc<"branches">) => ({
      _id: b._id,
      code: b.code,
      name: b.name,
      city: b.city,
      state: b.state,
      status: b.status,
      createdAt: b.createdAt,
    }));
  },
});

export const clientsSample = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cs = await ctx.db.query("clients").collect();
    const n = Math.min(Math.max(((args.limit ?? 10) as number), 1), 50);
    return cs.slice(0, n).map((c) => ({
      _id: c._id,
      code: c.code,
      name: c.name,
      staffId: c.assignedTo,
      branchId: c.branchId,
      kycStatus: c.kycStatus,
      centerCode: c.centerCode,
      centerId: c.centerId,
      status: c.status,
      createdAt: c.createdAt,
    }));
  },
});

export const loansSample = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const ls = await ctx.db.query("loans").collect();
    const n = Math.min(Math.max(((args.limit ?? 10) as number), 1), 20);
    return ls.slice(0, n).map((l) => ({
      _id: l._id,
      loanId: l.loanId,
      clientId: l.clientId,
      productId: l.productId,
      branchId: l.branchId,
      status: l.status,
      principal: l.principal,
      outstanding: l.outstanding,
      overdueDays: l.overdueDays,
      createdAt: l.createdAt,
    }));
  },
});

export const walletTxSample = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const ts = await ctx.db.query("walletTransactions").collect();
    const n = Math.min(Math.max(((args.limit ?? 10) as number), 1), 20);
    return ts.slice(0, n).map((t) => ({
      _id: t._id,
      txnId: t.txnId,
      profileId: t.profileId,
      branchId: t.branchId,
      type: t.type,
      amount: t.amount,
      direction: t.direction,
      referenceType: t.referenceType,
      referenceId: t.referenceId,
      createdAt: t.createdAt,
    }));
  },
});
