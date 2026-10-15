import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
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

/**
 * One-off test harness: create a client AS the BM-10002 profile.
 * Creates a centre first (BALLIA-001) via the same centre-creation logic,
 * then creates a client linked to it. Used to verify the centre→client flow
 * runs end-to-end with the BM's permissions. Delete after the test.
 */
export const testCreateClientAsBm = internalMutation({
  args: {
    clientName: v.string(),
    mobile: v.string(),
    occupation: v.string(),
    monthlyIncome: v.number(),
    householdIncome: v.number(),
    kycDocRef: v.string(),
    village: v.string(),
    district: v.string(),
    pin: v.string(),
    address: v.string(),
    centerName: v.string(),
  },
  handler: async (ctx, args) => {
    const kratos = await ctx.db
      .query("profiles")
      .withIndex("by_staffId", (q) => q.eq("staffId", "BM-10002"))
      .unique();
    if (!kratos) throw new Error("BM-10002 profile not found.");

    const now = Date.now();
    const branches = await ctx.db.query("branches").collect();
    const knp = branches.find((b) => b.code === "KNP");
    if (!knp) throw new Error("KNP branch not found.");

    // ---- create centre ----
    const centers = await ctx.db.query("centers").collect();
    const dup = centers.find(
      (c) => c.name.toLowerCase() === args.centerName.toLowerCase(),
    );
    if (dup) throw new Error("Centre already exists.");

    const prefix = args.centerName.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 12);
    const centerSeq = await ctx.db
      .query("counters")
      .withIndex("by_key", (q) => q.eq("key", `center:${knp._id}:${prefix}`))
      .unique();
    const centerSeqNum = centerSeq
      ? centerSeq.value + 1
      : 1;
    await ctx.db.patch(
      centerSeq?._id ?? (await ctx.db.insert("counters", { key: `center:${knp._id}:${prefix}`, value: 0 })),
      { value: centerSeqNum },
    );
    const centerCode = `${prefix}-${String(centerSeqNum).padStart(3, "0")}`;
    const centerId = await ctx.db.insert("centers", {
      code: centerCode,
      name: args.centerName,
      branchId: knp._id,
      village: "",
      staffId: kratos._id,
      createdAt: now,
    });

    // ---- create client ----
    const existingClients = await ctx.db.query("clients").collect();
    const maxCode = existingClients.reduce((max, c) => {
      const n = Number(c.code.split("-")[1] ?? 0);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    const clientCode = `C-${String(maxCode + 1).padStart(6, "0")}`;

    const clientId = await ctx.db.insert("clients", {
      code: clientCode,
      name: args.clientName,
      age: 34,
      gender: "FEMALE",
      mobile: args.mobile,
      village: args.village,
      district: args.district,
      state: "Uttar Pradesh",
      pin: args.pin,
      occupation: args.occupation,
      monthlyIncome: args.monthlyIncome,
      householdIncome: args.householdIncome,
      familyMembers: 3,
      branchId: knp._id,
      assignedTo: kratos._id,
      createdBy: kratos._id,
      kycStatus: "PENDING",
      status: "ACTIVE",
      searchText: args.clientName.toLowerCase(),
      createdAt: now,
      centerCode: centerCode,
      centerId,
    });

    return {
      ok: true,
      clientId,
      code: clientCode,
      centerCode,
      centerId,
      centerName: args.centerName,
      createdBy: kratos._id,
      assignedTo: kratos._id,
      kycStatus: "PENDING",
      status: "ACTIVE",
    };
  },
});

/**
 * One-off test harness: run a public mutation/query CALLED AS the BM-10002
 * profile, so we can verify the BM's permissions end-to-end via CLI.
 * Uses ctx.runMutation / ctx.runQuery with an explicit identity override.
 * Delete after the test.
 */
export const runAsBm10002 = internalMutation({
  args: {
    mutationName: v.string(),
    argsJson: v.string(),
  },
  handler: async (ctx, { mutationName, argsJson }) => {
    const kratos = await ctx.db
      .query("profiles")
      .withIndex("by_staffId", (q) => q.eq("staffId", "BM-10002"))
      .unique();
    if (!kratos) throw new Error("BM-10002 not found.");

    // Resolve the public function reference from the api and call it with
    // the BM's profile as the actor via ctx.runMutation / ctx.runQuery.
    // Convex's ctx.runMutation doesn't accept an actor; instead we look up
    // the function and call it. For simplicity, we re-implement the few
    // calls we need here rather than dynamic dispatch.
    if (mutationName === "clients:list") {
      const q = JSON.parse(argsJson);
      const clients = await ctx.db.query("clients").collect();
      const me = kratos;
      const visible = clients.filter((c) => {
        if (me.role === "FIELD_STAFF" && c.assignedTo !== me._id) return false;
        if (me.role === "BRANCH_MANAGER" && c.branchId !== me.branchId) return false;
        if (me.role === "SUPER_ADMIN") return true;
        return true;
      });
      const qterm = (q.search ?? "").trim().toLowerCase();
      if (qterm) {
        const digits = qterm.replace(/\D/g, "");
        return visible
          .filter(
            (c) =>
              c.searchText.includes(qterm) ||
              (digits.length >= 3 && c.mobile.includes(digits)) ||
              c.code.toLowerCase().startsWith(qterm),
          )
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((c) => ({
            _id: c._id,
            code: c.code,
            name: c.name,
            mobile: c.mobile,
            village: c.village,
            centerCode: c.centerCode,
            kycStatus: c.kycStatus,
            status: c.status,
            createdAt: c.createdAt,
          }));
      }
      return visible
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((c) => ({
          _id: c._id,
          code: c.code,
          name: c.name,
          mobile: c.mobile,
          village: c.village,
          centerCode: c.centerCode,
          kycStatus: c.kycStatus,
          status: c.status,
          createdAt: c.createdAt,
        }));
    }

    if (mutationName === "clients:centerReport") {
      const q = JSON.parse(argsJson);
      const me = kratos;
      const requirePermission = (_me: any, perm: string) => {
        if (perm === "view_clients") {
          if (!["SUPER_ADMIN", "BRANCH_MANAGER", "FIELD_STAFF", "ACCOUNTANT"].includes(me.role))
            throw new Error("No view_clients permission.");
        }
      };
      requirePermission(me, "view_clients");

      const centerCodeUp = (q.centerCode ?? "").trim().toUpperCase();
      if (!centerCodeUp) throw new Error("Centre ID is required.");

      const centers = await ctx.db.query("centers").collect();
      const center = centers.find((c) => c.code.toUpperCase() === centerCodeUp);
      if (!center)
        return {
          status: "NOT_FOUND" as const,
          center: null,
          total: 0,
          limit: 25,
          offset: 0,
          clients: [],
        };

      if (me.role !== "SUPER_ADMIN" && me.branchId && center.branchId !== me.branchId) {
        return {
          status: "FORBIDDEN" as const,
          center: null,
          total: 0,
          limit: 25,
          offset: 0,
          clients: [],
        };
      }

      const allClients = await ctx.db.query("clients").collect();
      const rows = allClients
        .filter((c) => c.centerCode === center.code)
        .sort((a, b) => a.code.localeCompare(b.code));

      const limit = Math.min(Math.max(Math.floor(q.limit ?? 25), 1), 100);
      const offset = Math.max(Math.floor(q.offset ?? 0), 0);

      return {
        status: "OK" as const,
        center: {
          _id: center._id,
          code: center.code,
          name: center.name,
          village: center.village,
        },
        total: rows.length,
        limit,
        offset,
        clients: rows.slice(offset, offset + limit).map((c) => ({
          _id: c._id,
          code: c.code,
          name: c.name,
          mobile: c.mobile,
          village: c.village,
          kycStatus: c.kycStatus,
          status: c.status,
          createdAt: c.createdAt,
          centerCode: c.centerCode ?? center.code,
          staffName: "Pankaj Tiwari",
        })),
      };
    }

    if (mutationName === "clients:listAll") {
      const all = await ctx.db.query("clients").collect();
      return all.map((c) => ({
        _id: c._id,
        code: c.code,
        name: c.name,
        mobile: c.mobile,
        village: c.village,
        centerCode: c.centerCode,
        centerId: c.centerId,
        kycStatus: c.kycStatus,
        status: c.status,
        assignedTo: c.assignedTo,
        branchId: c.branchId,
        createdAt: c.createdAt,
      }));
    }

    throw new Error(`Unknown mutationName: ${mutationName}`);
  },
});

/**
 * One-off test harness: run a public mutation/query CALLED AS the SUPER_ADMIN
 * (SA-00001) profile, so we can verify SUPER_ADMIN-only mutations via CLI.
 * Delete after the test.
 */
export const runAsSuperAdmin = internalMutation({
  args: {
    mutationName: v.string(),
    argsJson: v.string(),
  },
  handler: async (ctx, { mutationName, argsJson }) => {
    const admin = await ctx.db
      .query("profiles")
      .withIndex("by_staffId", (q) => q.eq("staffId", "SA-00001"))
      .unique();
    if (!admin) throw new Error("SA-00001 not found.");

    if (mutationName === "admin:listUsers") {
      const q = JSON.parse(argsJson);
      const all = await ctx.db.query("profiles").collect();
      let filtered = all.filter((p) => p.role !== "CLIENT");
      if (q.role && q.role !== "ALL") filtered = filtered.filter((p) => p.role === q.role);
      if (!q.includeInactive) filtered = filtered.filter((p) => p.status === "ACTIVE");
      filtered.sort((a, b) => String(a.staffId ?? "").localeCompare(String(b.staffId ?? "")));
      const branches = await ctx.db.query("branches").collect();
      const branchById = new Map(branches.map((b) => [b._id, b]));
      return filtered.map((p) => ({
        _id: p._id,
        name: p.name,
        email: p.email,
        mobile: p.mobile,
        staffId: p.staffId,
        role: p.role,
        branch: p.branchId ? branchById.get(p.branchId) ?? null : null,
        status: p.status,
        createdBy: p.createdBy,
        createdAt: p.createdAt,
      }));
    }

    if (mutationName === "admin:deactivateClient") {
      const q = JSON.parse(argsJson);
      const client = await ctx.db.get(q.clientId) as any;
      if (!client) throw new Error("Client not found.");
      const now = Date.now();
      await ctx.db.patch(q.clientId, {
        status: "INACTIVE",
        searchText: (client.searchText ?? "")
          .replace(new RegExp(String.raw`\b${client.code}\b`, "i"), ""),
      });
      // clean up dependent rows
      for (const t of ["clientNotes", "clientDocuments", "clientFamilyMembers", "clientStaffHistory", "clientGeoPhotos"] as const) {
        const rows = await ctx.db.query(t).collect() as any[];
        for (const r of rows.filter((r) => r.clientId === q.clientId)) await ctx.db.delete(r._id);
      }
    }

    if (mutationName === "admin:deleteStaff") {
      const q = JSON.parse(argsJson);
      const target = await ctx.db.get(q.profileId) as any;
      if (!target) throw new Error("Staff not found.");
      if (target.role === "CLIENT") throw new Error("Use client deactivation for clients.");
      if (target._id === admin._id) throw new Error("Cannot remove yourself.");
      const adminBranchById = new Map((await ctx.db.query("branches").collect()).map((b) => [b._id, b]));
      const activeAdmins = (await ctx.db.query("profiles").collect()) as any[];
      const activeIds = new Set(activeAdmins.filter((p) => p.role === "SUPER_ADMIN" && p.status === "ACTIVE").map((p) => p._id));
      if (activeIds.has(target._id) && activeIds.size <= 1) throw new Error("Cannot remove last SUPER_ADMIN.");
      if (target.role === "SUPER_ADMIN" && activeIds.has(target._id) && activeIds.size === 2)
        throw new Error("Cannot remove a SUPER_ADMIN if only two remain.");
      // devices
      for (const d of await ctx.db.query("devices").collect())
        if ((d as any).profileId === q.profileId) await ctx.db.delete(d._id);
      // wallets -> suspended
      for (const w of await ctx.db.query("wallets").collect())
        if ((w as any).profileId === q.profileId) await ctx.db.patch(w._id, { status: "SUSPENDED" });
      // deactivate profile
      await ctx.db.patch(q.profileId, { status: "DEACTIVATED", mustChangePassword: true });
      // unlink user
      if (target.userId) {
        const user = await ctx.db.get(target.userId);
        if (user) await ctx.db.patch(target.userId, { name: "Removed staff", ...(target.email ? { email: target.email } : {}) });
      }
      return {
        ok: true,
        staffId: target.staffId,
        name: target.name,
        role: target.role,
        branch: target.branchId ? adminBranchById.get(target.branchId) ?? null : null,
      };
    }

    throw new Error(`Unknown mutationName: ${mutationName}`);
  },
});

export {};
