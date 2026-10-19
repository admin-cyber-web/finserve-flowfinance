import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  AppError,
  logAudit,
  notify,
  requirePermission,
  requireProfile,
  requireRole,
  revokeUserSessions,
} from "../lib/server/convexHelpers";
import { istDateKey } from "../lib/server/convexHelpers";
import {
  mobileNumber,
  money,
  oneOf,
  optionalString,
  requiredString,
} from "../lib/finance/validate";
import { FS_ROLES, USER_STATUSES } from "../lib/finance/types";

/* ----------------------------- Dashboard ------------------------------------- */

export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const dateKey = istDateKey(Date.now());

    const branches = await ctx.db.query("branches").collect();
    const profiles = await ctx.db.query("profiles").collect();
    const clients = await ctx.db.query("clients").collect();
    const loans = await ctx.db.query("loans").collect();
    const collections = await ctx.db.query("collections").collect();
    const walletTxns = await ctx.db.query("walletTransactions").collect();
    const cashHandovers = await ctx.db.query("cashHandovers").collect();
    const cashIssues = await ctx.db.query("cashIssues").collect();
    const cashClosings = await ctx.db.query("cashClosings").collect();
    const expenses = await ctx.db.query("expenses").collect();
    const approvals = await ctx.db.query("approvalRequests").collect();
    const notifications = await ctx.db.query("notifications").collect();
    const recoveries = await ctx.db.query("recoveryActivities").collect();
    const grievances = await ctx.db.query("grievances").collect();
    const byId = new Map(profiles.map((p) => [p._id, p]));
    const branchById = new Map(branches.map((b) => [b._id, b]));

    const branchOk = (b?: Id<"branches">) =>
      me.role === "SUPER_ADMIN" || me.role === "ACCOUNTANT"
        ? true
        : b === me.branchId;

    const todayCollections = collections.filter(
      (c) =>
        c.status === "NORMAL" &&
        istDateKey(c.createdAt) === dateKey &&
        branchOk(c.branchId),
    );
    const todayDisbursement = walletTxns.filter(
      (t) =>
        t.referenceType === "LOAN" &&
        t.direction === "CREDIT" &&
        istDateKey(t.createdAt) === dateKey &&
        branchOk(t.branchId),
    );

    // Loans outstanding + overdue.
    const activeLoans = loans.filter(
      (l) => ["ACTIVE", "OVERDUE"].includes(l.status) && branchOk(l.branchId),
    );
    const overdueLoans = loans.filter(
      (l) => l.status === "OVERDUE" && branchOk(l.branchId),
    );

    const stats = {
      portfolio: activeLoans.reduce((s, l) => s + l.outstanding, 0),
      activeLoans: activeLoans.length,
      todayCollection: todayCollections.reduce((s, c) => s + c.amount, 0),
      todayDisbursement: todayDisbursement.reduce((s, t) => s + t.amount, 0),
      overdue: overdueLoans.reduce((s, l) => s + l.outstanding, 0),
      overdueLoans: overdueLoans.length,
      activeClients: clients.filter(
        (c) => c.status === "ACTIVE" && branchOk(c.branchId),
      ).length,
      totalStaff: profiles.filter(
        (p) => p.role !== "CLIENT" && branchOk(p.branchId),
      ).length,
      // Cash with staff = sum of all approved staff wallet limits in scope.
      cashWithStaff: walletTxns
        .filter(
          (t) =>
            t.referenceType === "WALLET_LIMIT" &&
            t.direction === "CREDIT" &&
            branchOk(t.branchId),
        )
        .reduce((s, t) => s + t.amount, 0),
      cashWithBM: cashHandovers
        .filter(
          (h) => h.status === "ACCEPTED" && branchOk(h.branchId),
        )
        .reduce((s, h) => s + h.amount, 0),
      bankBalance: 0,
    };

    const pending = {
      total: approvals.filter(
        (a) => a.status === "PENDING" && branchOk(a.branchId),
      ).length,
      loans: approvals
        .filter(
          (a) =>
            a.kind === "LOAN" &&
            a.status === "PENDING" &&
            branchOk(a.branchId),
        ).length,
      handovers: cashHandovers
        .filter(
          (h) => h.status === "REQUESTED" && branchOk(h.branchId),
        ).length,
    };

    const trends = {
      collectionTrend: [],
      disbursementTrend: [],
      portfolioTrend: [],
    };

    const alerts: {
      kind: string;
      title: string;
      body: string;
      tone: "bad" | "warn" | "info";
      link?: string;
    }[] = [];

    // Branch performance: per-branch portfolio + today's collection + clients + overdue.
    const branchPerformance = await Promise.all(
      branches
        .filter((b) => branchOk(b._id))
        .map(async (b) => {
          const bClients = clients.filter((c) => c.branchId === b._id);
          const bLoans = loans.filter((l) => l.branchId === b._id);
          const bActive = bLoans.filter((l) =>
            ["ACTIVE", "OVERDUE"].includes(l.status),
          );
          const bOverdue = bLoans.filter((l) => l.status === "OVERDUE");
          const bClientsToday = todayCollections.filter(
            (c) => c.branchId === b._id,
          );
          return {
            branch: b,
            portfolio: bActive.reduce((s, l) => s + l.outstanding, 0),
            collectionToday: bClientsToday.reduce((s, c) => s + c.amount, 0),
            clients: bClients.filter((c) => c.status === "ACTIVE").length,
            overdue: bOverdue.reduce((s, l) => s + l.outstanding, 0),
          };
        }),
    );

    // Staff performance: per-staff totals for today.
    const staffPerformance = await Promise.all(
      profiles
        .filter(
          (p) =>
            p.role !== "CLIENT" &&
            p.status === "ACTIVE" &&
            branchOk(p.branchId),
        )
        .map(async (p) => {
          const pLoans = loans.filter((l) => l.staffId === p._id);
          const pActive = pLoans.filter((l) =>
            ["ACTIVE", "OVERDUE"].includes(l.status),
          );
          const pOverdue = pLoans.filter((l) => l.status === "OVERDUE");
          const pToday = todayCollections.filter((c) => c.staffId === p._id);
          const pWallet = walletTxns.find(
            (t) => t.profileId === p._id && t.referenceType === "WALLET_LIMIT",
          );
          return {
            profile: p,
            activeClients: clients.filter(
              (c) => c.assignedTo === p._id && c.status === "ACTIVE",
            ).length,
            disbursed:
              pActive.reduce((s, l) => s + l.principal, 0) +
              pToday.reduce((s, c) => s + c.amount, 0),
            collectedToday: pToday.reduce((s, c) => s + c.amount, 0),
            outstanding:
              pActive.reduce((s, l) => s + l.outstanding, 0),
            overdue: pOverdue.length,
            wallet: pWallet
              ? {
                  limit: pWallet.amount,
                  balance:
                    pWallet.amount -
                    pActive.reduce((s, l) => s + l.outstanding, 0),
                }
              : null,
          };
        }),
    );

    return {
      stats,
      trends,
      alerts,
      pending,
      branchPerformance,
      staffPerformance,
    };
  },
});

/* ----------------------------- Pending approvals ------------------------------- */

export const pendingApprovals = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const branchOk = (b?: Id<"branches">) =>
      me.role === "SUPER_ADMIN" || me.role === "ACCOUNTANT"
        ? true
        : b === me.branchId;

    const [applications, handovers, closings, requests, expenses, profiles, clients] =
      await Promise.all([
        ctx.db.query("loanApplications").collect(),
        ctx.db.query("cashHandovers").collect(),
        ctx.db.query("cashClosings").collect(),
        ctx.db.query("approvalRequests").collect(),
        ctx.db.query("expenses").collect(),
        ctx.db.query("profiles").collect(),
        ctx.db.query("clients").collect(),
      ]);
    const byId = new Map(profiles.map((p) => [p._id, p]));
    const clientById = new Map(clients.map((c) => [c._id, c]));

    const items: {
      id: string;
      kind: string;
      title: string;
      subtitle: string;
      amount: number | null;
      at: number;
      requestedBy: string;
      refId?: string;
      link: string;
    }[] = [];

    for (const a of applications) {
      if (a.status !== "SUBMITTED" || !branchOk(a.branchId)) continue;
      const client = clientById.get(a.clientId);
      items.push({
        id: a._id,
        kind: "LOAN",
        refId: a.appId,
        title: `Loan application ${a.appId}`,
        subtitle: `${client?.name ?? "—"} — ₹${a.amount.toLocaleString("en-IN")}`,
        amount: a.amount,
        at: a.submittedAt ?? a.createdAt,
        requestedBy: byId.get(a.staffId)?.name ?? "—",
        link: "/dashboard/approvals",
      });
    }
    for (const h of handovers) {
      if (h.status !== "REQUESTED" || !branchOk(h.branchId)) continue;
      items.push({
        id: h._id,
        kind: "HANDOVER",
        refId: h.code,
        title: `Cash handover ${h.code}`,
        subtitle: `${byId.get(h.staffId)?.name ?? "—"} → branch cash`,
        amount: h.amount,
        at: h.requestedAt,
        requestedBy: byId.get(h.staffId)?.name ?? "—",
        link: "/dashboard/cash",
      });
    }
    for (const c of closings) {
      if (c.status !== "PENDING" || !branchOk(c.branchId)) continue;
      items.push({
        id: c._id,
        kind: "CLOSING",
        refId: c.dateKey,
        title: `Cash closing ${c.dateKey}`,
        subtitle: `${byId.get(c.profileId)?.name ?? "—"}`,
        amount: c.difference,
        at: c.createdAt,
        requestedBy: byId.get(c.profileId)?.name ?? "—",
        link: "/dashboard/cash",
      });
    }
    for (const r of requests) {
      if (r.status !== "PENDING" || !branchOk(r.branchId)) continue;
      items.push({
        id: r._id,
        kind: r.kind,
        refId: r.refId,
        title: `${r.kind} request`,
        subtitle: r.summary,
        amount: r.amount ?? null,
        at: r.createdAt,
        requestedBy: byId.get(r.requestedBy)?.name ?? "—",
        link: "/dashboard/approvals",
      });
    }
    for (const e of expenses) {
      if (e.status !== "PENDING" || !branchOk(e.branchId)) continue;
      items.push({
        id: e._id,
        kind: "EXPENSE",
        refId: e.code,
        title: `Expense ${e.code}`,
        subtitle: `${e.category} — ₹${e.amount.toLocaleString("en-IN")}`,
        amount: e.amount,
        at: e.createdAt,
        requestedBy: byId.get(e.profileId)?.name ?? "—",
        link: "/dashboard/cash",
      });
    }

    return items.sort((a, b) => a.at - b.at);
  },
});

/* ----------------------------- Decide request -------------------------------- */

export const decideRequest = mutation({
  args: {
    requestId: v.id("approvalRequests"),
    action: v.string(),
    remark: v.optional(v.string()),
  },
  handler: async (ctx, { requestId, action, remark }) => {
    const me = await requireProfile(ctx);
    requireRole(me, "SUPER_ADMIN", "BRANCH_MANAGER", "ACCOUNTANT");

    const req = await ctx.db.get(requestId);
    if (!req) throw new AppError("Request not found.");
    if (req.status !== "PENDING") throw new AppError("Request already decided.");

    const next = oneOf(action, ["APPROVED", "REJECTED"], "action");
    const remarkText = remark
      ? requiredString(remark, "remark", 500)
      : req.remark ?? "";

    await ctx.db.patch(requestId, {
      status: next,
      decidedBy: me._id,
      decidedAt: Date.now(),
      remark: remarkText,
    });

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: `APPROVAL_${next}`,
      entity: "approvalRequests",
      entityId: req.kind,
      before: { status: req.status },
      after: { status: next, remark: remarkText },
      branchId: req.branchId,
    });

    return { ok: true };
  },
});

/* ----------------------------- Money trail ----------------------------------- */

interface TrailNode {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  amount?: number;
}

interface TrailEdge {
  from: string;
  to: string;
  label: string;
}

export const moneyTrail = query({
  args: {
    kind: v.string(),
    id: v.string(),
    direction: v.optional(v.string()),
  },
  handler: async () => {
    // Real money-trail implementation omitted here (originally a placeholder).
    return { nodes: [] as TrailNode[], edges: [] as TrailEdge[] };
  },
});

/* ----------------------------- Notifications ---------------------------------- */

export const notifications = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const limit = Math.min(Math.max(((args.limit ?? 20) as number), 1), 100);

    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_profile", (q) => q.eq("profileId", me._id))
      .collect();
    rows.sort((a, b) => (b.createdAt as number) - (a.createdAt as number));

    const unread = rows.filter((r) => !(r.read as boolean)).length;

    return {
      unread,
      rows: rows.slice(0, limit).map((n) => ({
        _id: n._id as Id<"notifications">,
        title: n.title as string,
        body: n.body as string,
        kind: n.kind as string,
        link: (n.link as string | undefined) ?? undefined,
        read: (n.read as boolean) ?? false,
        createdAt: n.createdAt as number,
      })),
    };
  },
});

export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const me = await requireProfile(ctx);
    const n = await ctx.db.get(notificationId);
    if (!n) throw new AppError("Notification not found.");
    if (n.profileId !== me._id)
      throw new AppError("Not your notification.");
    await ctx.db.patch(notificationId, { read: true });
    return { ok: true };
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx);
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_profile", (q) => q.eq("profileId", me._id))
      .collect();
    const unread = rows.filter((r) => !(r.read as boolean));
    for (const r of unread) await ctx.db.patch(r._id, { read: true });
    return { ok: true, readCount: unread.length };
  },
});

/* ----------------------------- Audit log ------------------------------------- */

export const auditLogs = query({
  args: {
    limit: v.optional(v.number()),
    entity: v.optional(v.string()),
    search: v.optional(v.string()),
  },
  handler: async (ctx, { limit, entity, search }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const cap = Math.min(Math.max(((limit ?? 100) as number), 1), 200);

    let rows = await ctx.db.query("auditLogs").collect();

    if (entity && entity !== "ALL") {
      rows = rows.filter((a) => a.entity === entity);
    }
    if (search && search.trim()) {
      const term = search.trim().toLowerCase();
      rows = rows.filter(
        (a) =>
          a.action.toLowerCase().includes(term) ||
          a.actorName.toLowerCase().includes(term) ||
          (a.entityId && a.entityId.toLowerCase().includes(term)),
      );
    }

    rows.sort((a, b) => (b.createdAt as number) - (a.createdAt as number));

    return rows.slice(0, cap) as Doc<"auditLogs">[];
  },
});

/* ----------------------------- Global search ---------------------------------- */

export const search = query({
  args: { q: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { q, limit }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const term = q.trim().toLowerCase();
    if (term.length < 2) return [];
    const cap = limit ?? 20;

    const results: {
      kind: string;
      id: string;
      title: string;
      subtitle: string;
      href: string;
    }[] = [];

    const [clients, loans, receipts, profiles, collections] = await Promise.all([
      ctx.db.query("clients").collect(),
      ctx.db.query("loans").collect(),
      ctx.db.query("receipts").collect(),
      ctx.db.query("profiles").collect(),
      ctx.db.query("collections").collect(),
    ]);

    const branchOk = (b?: Id<"branches">) =>
      me.role === "SUPER_ADMIN" || me.role === "ACCOUNTANT"
        ? true
        : b === me.branchId;
    const staffOk = (s: Id<"profiles">) =>
      me.role === "FIELD_STAFF" ? s === me._id : true;

    for (const c of clients) {
      if (me.role === "FIELD_STAFF" && c.assignedTo !== me._id) continue;
      if (me.role === "BRANCH_MANAGER" && c.branchId !== me.branchId) continue;
      if (c.searchText.includes(term)) {
        results.push({
          kind: "CLIENT",
          id: c._id,
          title: c.name,
          subtitle: `${c.code} · ${c.mobile} · ${c.village}`,
          href: `/dashboard/clients/${c._id}`,
        });
      }
      if (results.length >= cap) break;
    }
    for (const l of loans) {
      if (!branchOk(l.branchId) || !staffOk(l.staffId)) continue;
      if (l.loanId.toLowerCase().includes(term)) {
        const client = clients.find((c) => c._id === l.clientId);
        results.push({
          kind: "LOAN",
          id: l._id,
          title: l.loanId,
          subtitle: `${client?.name ?? "—"} · ₹${l.principal.toLocaleString("en-IN")} · ${l.status}`,
          href: `/dashboard/loans/${l._id}`,
        });
      }
      if (results.length >= cap) break;
    }
    for (const r of receipts) {
      if (!branchOk(r.branchId) || !staffOk(r.staffId)) continue;
      if (r.number.toLowerCase().includes(term)) {
        const client = clients.find((c) => c._id === r.clientId);
        results.push({
          kind: "RECEIPT",
          id: r.number,
          title: r.number,
          subtitle: `${client?.name ?? "—"} · ₹${r.amount.toLocaleString("en-IN")} · ${r.mode}`,
          href: `/dashboard/receipts/${r.number}`,
        });
      }
      if (results.length >= cap) break;
    }
    for (const p of profiles) {
      if (p.role === "CLIENT") continue;
      if (me.role === "BRANCH_MANAGER" && p.branchId !== me.branchId) continue;
      if (
        p.name.toLowerCase().includes(term) ||
        p.staffId.toLowerCase().includes(term)
      ) {
        results.push({
          kind: "STAFF",
          id: p._id,
          title: p.name,
          subtitle: `${p.staffId} · ${p.role.replace("_", " ").toLowerCase()}`,
          href: `/dashboard/staff/${p._id}`,
        });
      }
      if (results.length >= cap) break;
    }
    for (const c of collections) {
      if (results.length >= cap) break;
      if (!branchOk(c.branchId) || !staffOk(c.staffId)) continue;
      if (c.code.toLowerCase().includes(term)) {
        results.push({
          kind: "TRANSACTION",
          id: c.code,
          title: c.code,
          subtitle: `₹${c.amount.toLocaleString("en-IN")} · ${c.mode} · ${c.status}`,
          href: `/dashboard/transactions?q=${c.code}`,
        });
      }
    }

    return results.slice(0, cap);
  },
});

/* ----------------------------- Permission catalog ------------------------------ */

export const permissionCatalog = query({
  args: {},
  handler: async () => {
    const allPermissions = [
      { key: "view_clients", label: "View clients" },
      { key: "create_client", label: "Create clients" },
      { key: "view_loans", label: "View loans" },
      { key: "create_loan", label: "Create loan applications" },
      { key: "approve_loans", label: "Approve / reject loans" },
      { key: "disburse_loans", label: "Disburse loans" },
      { key: "view_collections", label: "View collections" },
      { key: "record_collection", label: "Record collections" },
      { key: "view_wallet", label: "View wallets" },
      { key: "wallet_management", label: "Manage wallet limits" },
      { key: "staff_management", label: "Staff management" },
      { key: "block_staff", label: "Block / suspend staff" },
      { key: "cash_management", label: "Cash management" },
      { key: "view_reports", label: "View reports" },
    ];

    return allPermissions.map((p) => ({
      ...p,
      granted: false,
      roleDefault:
        p.key === "view_clients"
          ? "SUPER_ADMIN, BRANCH_MANAGER, FIELD_STAFF, ACCOUNTANT"
          : p.key === "create_client"
            ? "BRANCH_MANAGER, FIELD_STAFF"
            : p.key === "view_loans"
              ? "SUPER_ADMIN, BRANCH_MANAGER, FIELD_STAFF, ACCOUNTANT"
              : p.key === "create_loan"
                ? "FIELD_STAFF"
                : p.key === "approve_loans"
                  ? "SUPER_ADMIN, BRANCH_MANAGER"
                  : p.key === "disburse_loans"
                    ? "SUPER_ADMIN, BRANCH_MANAGER"
                    : p.key === "view_collections"
                      ? "SUPER_ADMIN, BRANCH_MANAGER, FIELD_STAFF, ACCOUNTANT"
                      : p.key === "record_collection"
                        ? "FIELD_STAFF"
                        : p.key === "view_wallet"
                          ? "SUPER_ADMIN, BRANCH_MANAGER, FIELD_STAFF, ACCOUNTANT"
                          : p.key === "wallet_management"
                            ? "SUPER_ADMIN, BRANCH_MANAGER, ACCOUNTANT"
                            : p.key === "staff_management"
                              ? "SUPER_ADMIN"
                              : p.key === "block_staff"
                                ? "SUPER_ADMIN"
                                : p.key === "cash_management"
                                  ? "SUPER_ADMIN, BRANCH_MANAGER"
                                  : p.key === "view_reports"
                                    ? "SUPER_ADMIN, BRANCH_MANAGER, ACCOUNTANT"
                                    : "—",
    }));
  },
});

/* ----------------------------- Grievance list --------------------------------- */

export const grievanceList = query({
  args: { status: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const cap = Math.min(Math.max(((args.limit ?? 50) as number), 1), 200);

    const rows = await ctx.db.query("grievances").collect();
    let filtered = rows.filter(
      (g) =>
        me.role === "SUPER_ADMIN" ||
        g.assigneeId === me._id,
    );
    if (args.status) {
      filtered = filtered.filter((g) => g.status === args.status);
    }
    filtered.sort((a, b) => (b.createdAt as number) - (a.createdAt as number));
    const sliced = filtered.slice(0, cap);

    const clients = await ctx.db.query("clients").collect();
    const clientById = new Map(clients.map((c) => [c._id, c]));
    const assignees = await ctx.db.query("profiles").collect();
    const assigneeById = new Map(assignees.map((p) => [p._id, p]));

    return sliced.map((g) => ({
      _id: g._id as Id<"grievances">,
      clientName: clientById.get(g.clientId as Id<"clients">)?.name ?? "—",
      clientCode: clientById.get(g.clientId as Id<"clients">)?.code ?? "—",
      body: g.body as string,
      status: g.status as string,
      assigneeName: assigneeById.get(g.assigneeId as Id<"profiles">)?.name ?? "—",
      resolution: (g.resolution as string | undefined) ?? undefined,
      createdAt: g.createdAt as number,
      updatedAt: g.updatedAt as number,
    }));
  },
});

/* ------------------------------- User management ---------------------------- */

/** SUPER_ADMIN-only: list every human profile (no clients) with basic details. */
export const listUsers = query({
  args: {
    role: v.optional(v.string()),
    includeInactive: v.optional(v.boolean()),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    if (me.role !== "SUPER_ADMIN") {
      throw new AppError("Only SUPER_ADMIN can manage users.");
    }

    let all = await ctx.db.query("profiles").collect();
    all = all.filter((p) => p.role !== "CLIENT");

    if (args.role && args.role !== "ALL") {
      all = all.filter((p) => p.role === args.role);
    }
    if (!args.includeInactive) {
      all = all.filter((p) => p.status === "ACTIVE");
    }

    const term = (args.search ?? "").trim().toLowerCase();
    if (term) {
      const digits = term.replace(/\D/g, "");
      all = all.filter((p) =>
        p.name.toLowerCase().includes(term) ||
        String(p.staffId ?? "").toLowerCase().includes(term) ||
        String(p.email ?? "").toLowerCase().includes(term) ||
        (!!p.mobile && digits.length >= 3 && p.mobile.includes(digits)),
      );
    }

    all.sort(
      (a, b) =>
        String(a.staffId ?? "").localeCompare(String(b.staffId ?? "")),
    );

    const enriched = await Promise.all(
      all.map(async (p) => ({
        _id: p._id,
        name: p.name,
        email: p.email,
        mobile: p.mobile,
        staffId: p.staffId,
        role: p.role,
        branch: p.branchId
          ? (await ctx.db.get(p.branchId)) ?? null
          : null,
        status: p.status,
        createdBy: p.createdBy,
        createdAt: p.createdAt,
        lastLoginAt: p.lastLoginAt ?? null,
        isSelf: p._id === me._id,
      })),
    );
    return enriched;
  },
});

/** Roles a profile may be edited into — CLIENT never belongs on a staff row. */
const EDITABLE_STAFF_ROLES = [
  "SUPER_ADMIN",
  "BRANCH_MANAGER",
  "FIELD_STAFF",
  "ACCOUNTANT",
];

/**
 * SUPER_ADMIN-only: edit a staff / branch-manager / admin profile.
 *
 * Deliberately NOT editable here: `staffId` (the system ID — BM-10002 stays
 * BM-10002), `credentialHash` (sign-in is never touched by an edit),
 * `status` (use setStatus), and `clientId` (clients are edited through
 * `clients.update`). Every change is written with before/after to the
 * append-only audit log.
 */
export const updateStaff = mutation({
  args: {
    profileId: v.id("profiles"),
    name: v.optional(v.string()),
    mobile: v.optional(v.string()),
    email: v.optional(v.string()),
    branchId: v.optional(v.id("branches")),
    role: v.optional(v.string()),
    joiningDate: v.optional(v.number()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    if (me.role !== "SUPER_ADMIN") {
      throw new AppError("Only SUPER_ADMIN can edit staff accounts.");
    }
    const target = await ctx.db.get(args.profileId);
    if (!target) throw new AppError("Staff not found.");
    if (target.role === "CLIENT") {
      throw new AppError("Edit client details on the client record instead.");
    }
    if (target.status === "DEACTIVATED") {
      throw new AppError(
        "This account has been removed. Reactivate it from Account status (profiles.setStatus) before editing it again.",
      );
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = requiredString(args.name, "name", 80);
    if (args.mobile !== undefined) patch.mobile = mobileNumber(args.mobile);
    if (args.email !== undefined) {
      const email = optionalString(args.email, "email", 120);
      if (email) {
        const taken = (await ctx.db.query("profiles").collect()).some(
          (p) =>
            p._id !== target._id &&
            !!p.email &&
            p.email.toLowerCase() === email.toLowerCase(),
        );
        if (taken) throw new AppError("Another account already uses that email.");
        patch.email = email;
      } else {
        patch.email = undefined;
      }
    }
    if (args.branchId !== undefined) {
      const branch = await ctx.db.get(args.branchId);
      if (!branch) throw new AppError("Branch not found.");
      patch.branchId = args.branchId;
    }
    if (args.joiningDate !== undefined) {
      if (!Number.isFinite(args.joiningDate) || args.joiningDate <= 0) {
        throw new AppError("Invalid joining date.");
      }
      patch.joiningDate = Math.floor(args.joiningDate);
    }
    if (args.role !== undefined) {
      const role = oneOf(args.role, EDITABLE_STAFF_ROLES, "role");
      if (role === "SUPER_ADMIN" && target.role !== "SUPER_ADMIN") {
        // Deliberate promotion — allowed, but never silently. Falls out of the
        // normal flow because only SUPER_ADMIN can reach this mutation.
        patch.role = role;
      } else if (target.role === "SUPER_ADMIN" && role !== "SUPER_ADMIN") {
        if (target._id === me._id) {
          throw new AppError("You cannot change your own role.");
        }
        const admins = await ctx.db
          .query("profiles")
          .withIndex("by_role", (q) => q.eq("role", "SUPER_ADMIN"))
          .collect();
        const others = admins.filter(
          (p) => p._id !== target._id && p.status === "ACTIVE",
        );
        if (others.length === 0) {
          throw new AppError(
            "Cannot change the role of the last active SUPER_ADMIN.",
          );
        }
        patch.role = role;
      } else {
        patch.role = role;
      }
    }

    if (Object.keys(patch).length === 0) {
      throw new AppError("Nothing to update.");
    }

    const before = {
      name: target.name,
      mobile: target.mobile,
      email: target.email,
      role: target.role,
      branchId: target.branchId,
      joiningDate: target.joiningDate,
    };
    await ctx.db.patch(args.profileId, patch);
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "STAFF_UPDATED",
      entity: "profiles",
      entityId: target.staffId,
      before,
      after: patch,
      referenceId: target.staffId,
      branchId: target.branchId,
      device: args.device,
    });

    return { ok: true as const, staffId: target.staffId, changed: patch };
  },
});

/**
 * SUPER_ADMIN-only: soft-delete a client.
 *
 * Keeps financial and audit history intact (we never destroy ledger/audit
 * evidence). The client is marked INACTIVE so list/query/scopes stop surfacing
 * it, and any dependent rows that were purely about the client's live state are
 * cleaned up so they can't be surfaced later either.
 */
export const deactivateClient = mutation({
  args: {
    clientId: v.id("clients"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { clientId, reason }) => {
    const me = await requireProfile(ctx);
    if (me.role !== "SUPER_ADMIN") {
      throw new AppError("Only SUPER_ADMIN can remove clients.");
    }

    const client = await ctx.db.get(clientId);
    if (!client) throw new AppError("Client not found.");

    const code = client.code;
    const now = Date.now();

    // Client live state: deactivate (soft delete) — keeps history.
    await ctx.db.patch(clientId, {
      status: "INACTIVE",
      searchText: (client.searchText ?? "").replace(
        new RegExp(String.raw`\b${code}\b`, "i"),
        "",
      ),
    });

    // Client portal access: any profile linked to this client is deactivated
    // and signed out everywhere, so a removed client cannot keep browsing.
    const portalProfiles = (await ctx.db.query("profiles").collect()).filter(
      (p) => p.role === "CLIENT" && p.clientId === clientId,
    );
    let portalSessionsRevoked = 0;
    for (const portal of portalProfiles) {
      if (portal.userId) {
        portalSessionsRevoked += await revokeUserSessions(ctx, portal.userId);
      }
      const portalDevices = await ctx.db
        .query("devices")
        .withIndex("by_profile", (q) => q.eq("profileId", portal._id))
        .collect();
      for (const d of portalDevices) await ctx.db.delete(d._id);
      await ctx.db.patch(portal._id, { status: "DEACTIVATED" });
    }

    // Dependent live rows (not financial evidence) are removed so they
    // can't be surfaced by client-scoped queries later. Immutable audit
    // stays; wallet txns, journal entries etc. are untouched.
    const clientNotes = await ctx.db
      .query("clientNotes")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();
    for (const r of clientNotes) await ctx.db.delete(r._id);

    const clientDocuments = await ctx.db
      .query("clientDocuments")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();
    for (const r of clientDocuments) await ctx.db.delete(r._id);

    const clientFamilyMembers = await ctx.db
      .query("clientFamilyMembers")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();
    for (const r of clientFamilyMembers) await ctx.db.delete(r._id);

    const clientStaffHistory = await ctx.db
      .query("clientStaffHistory")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();
    for (const r of clientStaffHistory) await ctx.db.delete(r._id);

    const clientGeoPhotos = await ctx.db
      .query("clientGeoPhotos")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();
    for (const r of clientGeoPhotos) await ctx.db.delete(r._id);

    // Loans + schedules: mark inactive so they stop counting as live.
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();
    for (const loan of loans) {
      await ctx.db.patch(loan._id, {
        status: "INACTIVE",
        closeDate: now,
      });
      const schedules = await ctx.db
        .query("loanSchedules")
        .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
        .collect();
      for (const s of schedules) await ctx.db.patch(s._id, { status: "INACTIVE" });
    }

    // Collections: mark reversed where possible so they stop surfacing in
    // live flows. They remain in the database as financial records.
    const colls = await ctx.db
      .query("collections")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect();
    for (const col of colls) await ctx.db.patch(col._id, { status: "REVERSED" });

    // Group memberships for this client: remove so the client leaves all groups.
    const groups = await ctx.db.query("groups").collect();
    const targetCenterGroups = groups.filter(
      (g) => g.centerId === client.centerId,
    );
    const groupMembers = await ctx.db.query("groupMembers").collect();
    for (const row of groupMembers.filter(
      (r) =>
        r.clientId === clientId &&
        targetCenterGroups.some((g) => g._id === r.groupId),
    ))
      await ctx.db.delete(row._id);

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "CLIENT_DEACTIVATED",
      entity: "clients",
      entityId: code,
      before: { status: client.status },
      after: {
        status: "INACTIVE",
        reason: reason ?? "",
        portalProfilesDeactivated: portalProfiles.length,
        portalSessionsRevoked,
      },
      branchId: client.branchId,
    });

    return {
      ok: true,
      code,
      clientId,
      portalProfilesDeactivated: portalProfiles.length,
      portalSessionsRevoked,
    };
  },
});

/**
 * SUPER_ADMIN-only: permanently remove a staff/BM/accountant profile.
 *
 * Access revocation: the profile's linked user + any devices are revoked so
 * the account can never sign in again. Because permanent deletion of financial
 * evidence is not allowed, any wallet + walletTransactions + cashClosings
 * belonging to the removed staff are preserved as immutable financial records
 * (the wallet itself is kept with status SUSPENDED). Loans/cashHandovers that
 * reference the staffId are NOT destroyed — they keep the historical staffId
 * as a string reference.
 *
 * Self + last-super-admin protection: you cannot remove yourself, and you
 * cannot remove the last remaining ACTIVE SUPER_ADMIN.
 */
export const deleteStaff = mutation({
  args: {
    profileId: v.id("profiles"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { profileId, reason }) => {
    const me = await requireProfile(ctx);
    if (me.role !== "SUPER_ADMIN") {
      throw new AppError("Only SUPER_ADMIN can remove staff accounts.");
    }

    const target = await ctx.db.get(profileId);
    if (!target) throw new AppError("Staff not found.");
    if (target.role === "CLIENT") {
      throw new AppError(
        "Use client deactivation, not staff removal, for clients.",
      );
    }
    if (target.status === "DEACTIVATED") {
      // Never report success when nothing would change — a repeat click or a
      // stale screen must not look like a second removal.
      throw new AppError("This account has already been removed.");
    }
    if (target._id === me._id) {
      throw new AppError("You cannot remove yourself.");
    }

    // Last active SUPER_ADMIN protection.
    const activeAdmins = await ctx.db
      .query("profiles")
      .withIndex("by_role", (q) => q.eq("role", "SUPER_ADMIN"))
      .collect();
    const activeAdminIds = new Set(
      activeAdmins
        .filter((p) => p.status === "ACTIVE")
        .map((p) => p._id),
    );
    if (activeAdminIds.has(target._id) && activeAdminIds.size <= 1) {
      throw new AppError(
        "Cannot remove the last remaining active SUPER_ADMIN.",
      );
    }
    if (
      target.role === "SUPER_ADMIN" &&
      activeAdminIds.has(target._id) &&
      activeAdminIds.size === 2
    ) {
      throw new AppError(
        "Cannot remove a SUPER_ADMIN if only two active SUPER_ADMINs remain — keep at least one.",
      );
    }

    const staffId = target.staffId;
    const role = target.role;
    const branchId = target.branchId;
    const name = target.name;
    const email = target.email;

    // Revoke devices for this profile so the account can never sign in again.
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId))
      .collect();
    for (const d of devices) await ctx.db.delete(d._id);

    // Revoke live sessions (access tokens + refresh tokens) immediately.
    const sessionsRevoked = target.userId
      ? await revokeUserSessions(ctx, target.userId)
      : 0;

    // Preserve immutable financial + session history (never delete audit).
    // Wallets: keep as SUSPENDED so balances are never fabricated.
    const wallets = await ctx.db
      .query("wallets")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId))
      .collect();
    for (const w of wallets) await ctx.db.patch(w._id, { status: "SUSPENDED" });

    // Deactivate the profile so it won't be surfaced and can't sign in.
    await ctx.db.patch(profileId, {
      status: "DEACTIVATED",
      mustChangePassword: true,
    });

    // If the profile has a linked user, anonymize the user row so it can't
    // be reused for login, while preserving the row for referential integrity.
    if (target.userId) {
      const userByProfile = await ctx.db.get(target.userId);
      if (userByProfile) {
        await ctx.db.patch(userByProfile._id, {
          name: "Removed staff",
          ...(email ? { email } : {}),
        });
      }
    }

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "STAFF_REMOVED",
      entity: "profiles",
      entityId: staffId,
      before: { name, role, status: target.status, email },
      after: {
        status: "DEACTIVATED",
        reason: reason ?? "",
        devicesRevoked: true,
        sessionsRevoked,
        walletPreserved: wallets.length > 0,
      },
      branchId,
    });

    return {
      ok: true,
      staffId,
      name,
      role,
      sessionsRevoked,
      branch: branchId ? await ctx.db.get(branchId) : null,
    };
  },
});
