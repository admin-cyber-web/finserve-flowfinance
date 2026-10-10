import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  AppError,
  logAudit,
  notify,
  requirePermission,
  requireProfile,
  walletBalance,
} from "../lib/server/convexHelpers";
import { istDateKey } from "../lib/server/convexHelpers";
import { utilization } from "../lib/finance/wallet";
import { PERMISSIONS } from "../lib/finance/permissions";

const DAY = 86_400_000;

/** Role-scoped organisation dashboard (admin = org, BM = branch, staff = self). */
export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "view_loans");
    const now = Date.now();
    const todayKey = istDateKey(now);

    const [loans, clients, profiles, wallets, collections, handovers, issues, closings, applications, requests] =
      await Promise.all([
        ctx.db.query("loans").collect(),
        ctx.db.query("clients").collect(),
        ctx.db.query("profiles").collect(),
        ctx.db.query("wallets").collect(),
        ctx.db.query("collections").collect(),
        ctx.db.query("cashHandovers").collect(),
        ctx.db.query("cashIssues").collect(),
        ctx.db.query("cashClosings").collect(),
        ctx.db.query("loanApplications").collect(),
        ctx.db.query("approvalRequests").collect(),
      ]);

    const branchFilter = (b: { branchId?: Id<"branches"> }) =>
      me.role === "SUPER_ADMIN" || me.role === "ACCOUNTANT"
        ? true
        : me.role === "BRANCH_MANAGER"
          ? b.branchId === me.branchId
          : b.branchId === me.branchId;
    const ownStaff = me.role === "FIELD_STAFF";

    const myLoans = ownStaff ? loans.filter((l) => l.staffId === me._id) : loans.filter(branchFilter);
    const myCollections = ownStaff
      ? collections.filter((c) => c.staffId === me._id)
      : collections.filter((c) => branchFilter(c));

    const activeLoans = myLoans.filter((l) => ["ACTIVE", "OVERDUE", "DISBURSED"].includes(l.status));
    const overdueLoans = myLoans.filter((l) => l.status === "OVERDUE");
    const outstanding = Math.round(activeLoans.reduce((s, l) => s + l.outstanding, 0) * 100) / 100;
    const overdue = Math.round(overdueLoans.reduce((s, l) => s + l.outstanding, 0) * 100) / 100;

    const todayCollections = myCollections.filter(
      (c) => c.status === "NORMAL" && istDateKey(c.createdAt) === todayKey,
    );
    const todayDisbursed = myLoans.filter(
      (l) => l.disbursedAt && istDateKey(l.disbursedAt) === todayKey,
    );

    // Staff wallets in scope.
    const scopedWallets = wallets.filter((w) =>
      ownStaff ? w.profileId === me._id : branchFilter(w),
    );
    const walletBalances: { profileId: Id<"profiles">; balance: number; limit: number }[] = [];
    for (const w of scopedWallets) {
      const balance = await walletBalance(ctx, w._id);
      walletBalances.push({ profileId: w.profileId, balance, limit: w.walletLimit });
    }
    const cashWithStaff = Math.round(
      walletBalances.reduce((s, w) => s + w.balance, 0) * 100,
    ) / 100;

    // Branch cash + bank from the double-entry ledger.
    const journals = await ctx.db.query("journalEntries").collect();
    const accountBalance = (code: string) =>
      Math.round(
        journals
          .filter((j) => branchFilter(j))
          .flatMap((j) => j.lines)
          .filter((l) => l.code === code)
          .reduce((s, l) => s + l.debit - l.credit, 0) * 100,
      ) / 100;
    const cashWithBM = accountBalance("1015");
    const bankBalance = accountBalance("1020");

    // 14-day trends.
    const dayKeys: string[] = [];
    for (let i = 13; i >= 0; i--) dayKeys.push(istDateKey(now - i * DAY));
    const collectionTrend = dayKeys.map((key) => ({
      key,
      label: key.slice(8) + "/" + key.slice(5, 7),
      amount: Math.round(
        myCollections
          .filter((c) => c.status === "NORMAL" && istDateKey(c.createdAt) === key)
          .reduce((s, c) => s + c.amount, 0) * 100,
      ) / 100,
    }));
    const disbursementTrend = dayKeys.map((key) => ({
      key,
      label: key.slice(8) + "/" + key.slice(5, 7),
      amount:
        Math.round(
          myLoans
            .filter((l) => l.disbursedAt && istDateKey(l.disbursedAt) === key)
            .reduce((s, l) => s + l.principal, 0) * 100,
        ) / 100,
    }));
    const portfolioTrend = dayKeys.map((key, i) => ({
      key,
      label: key.slice(8) + "/" + key.slice(5, 7),
      // Cumulative disbursed − cumulative recovered up to that day.
      amount:
        Math.round(
          (myLoans
            .filter((l) => l.disbursedAt && istDateKey(l.disbursedAt) <= key)
            .reduce((s, l) => s + l.principal, 0) -
            myCollections
              .filter((c) => c.status === "NORMAL" && istDateKey(c.createdAt) <= key)
              .reduce((s, c) => s + c.principalPortion, 0)) * 100,
        ) / 100 + (i === 0 ? 0 : 0),
    }));

    // Branch + staff performance.
    const branches = await ctx.db.query("branches").collect();
    const branchPerformance = branches
      .filter((b) => (me.role === "SUPER_ADMIN" || me.role === "ACCOUNTANT" ? true : b._id === me.branchId))
      .map((b) => ({
        branch: b,
        portfolio: Math.round(
          loans.filter((l) => l.branchId === b._id && ["ACTIVE", "OVERDUE"].includes(l.status))
            .reduce((s, l) => s + l.outstanding, 0) * 100,
        ) / 100,
        collectionToday: Math.round(
          collections
            .filter((c) => c.branchId === b._id && c.status === "NORMAL" && istDateKey(c.createdAt) === todayKey)
            .reduce((s, c) => s + c.amount, 0) * 100,
        ) / 100,
        clients: clients.filter((c) => c.branchId === b._id).length,
        overdue: Math.round(
          loans.filter((l) => l.branchId === b._id && l.status === "OVERDUE")
            .reduce((s, l) => s + l.outstanding, 0) * 100,
        ) / 100,
      }));

    const staffPerformance = profiles
      .filter((p) => p.role === "FIELD_STAFF" && (ownStaff ? p._id === me._id : branchFilter(p)))
      .map((p) => ({
        profile: p,
        collectedToday: Math.round(
          collections
            .filter((c) => c.staffId === p._id && c.status === "NORMAL" && istDateKey(c.createdAt) === todayKey)
            .reduce((s, c) => s + c.amount, 0) * 100,
        ) / 100,
        disbursed: Math.round(
          loans.filter((l) => l.staffId === p._id).reduce((s, l) => s + l.principal, 0) * 100,
        ) / 100,
        outstanding: Math.round(
          loans
            .filter((l) => l.staffId === p._id && ["ACTIVE", "OVERDUE"].includes(l.status))
            .reduce((s, l) => s + l.outstanding, 0) * 100,
        ) / 100,
        overdue: loans.filter((l) => l.staffId === p._id && l.status === "OVERDUE").length,
        activeClients: clients.filter((c) => c.assignedTo === p._id).length,
        wallet: walletBalances.find((w) => w.profileId === p._id) ?? null,
      }));

    // Alerts.
    const lowWallets = walletBalances.filter((w) => utilization(w.balance, w.limit) <= 15);
    const pendingClosings = closings.filter(
      (c) => c.status === "PENDING" && branchFilter(c),
    );
    const pendingApplications = applications.filter(
      (a) => a.status === "SUBMITTED" && branchFilter(a),
    );
    const pendingHandovers = handovers.filter(
      (h) => h.status === "REQUESTED" && branchFilter(h),
    );
    const pendingExpensesRequests = requests.filter(
      (r) => r.status === "PENDING" && branchFilter(r),
    );

    const alerts: { kind: string; title: string; body: string; tone: "bad" | "warn" | "info"; link?: string }[] = [];
    // Group pending closings per branch: multiple pending closings (same
    // amount, different days/staff) used to render as identical repeated
    // alert rows on the dashboard. One aggregated alert keeps every pending
    // closing visible without repeating the same line.
    const closingGroups = new Map<string, { total: number; count: number; dates: string[] }>();
    for (const c of pendingClosings) {
      if (c.difference === 0) continue;
      const key = c.branchId ?? "org";
      const group = closingGroups.get(key) ?? { total: 0, count: 0, dates: [] as string[] };
      group.total += c.difference;
      group.count += 1;
      if (!group.dates.includes(c.dateKey)) group.dates.push(c.dateKey);
      closingGroups.set(key, group);
    }
    for (const group of closingGroups.values()) {
      alerts.push({
        kind: "CASH_SHORTAGE",
        tone: "bad",
        title: `Cash ${group.total < 0 ? "shortage" : "excess"} ₹${Math.abs(group.total).toLocaleString("en-IN")}${
          group.count > 1 ? ` across ${group.count} closings` : ""
        }`,
        body: `${group.dates.sort().join(", ")} closing${group.count > 1 ? "s" : ""} await review.`,
        link: "/dashboard/cash",
      });
    }
    if (pendingApplications.length) {
      alerts.push({
        kind: "APPROVAL",
        tone: "warn",
        title: `${pendingApplications.length} loan approval${pendingApplications.length > 1 ? "s" : ""} pending`,
        body: "Applications waiting for a decision.",
        link: "/dashboard/approvals",
      });
    }
    if (lowWallets.length) {
      alerts.push({
        kind: "WALLET",
        tone: "warn",
        title: `${lowWallets.length} wallet${lowWallets.length > 1 ? "s" : ""} running low`,
        body: "Utilisation at or below 15% of the approved limit.",
        link: "/dashboard/staff",
      });
    }
    if (overdueLoans.length >= 3) {
      alerts.push({
        kind: "OVERDUE",
        tone: "bad",
        title: `Overdue spike — ${overdueLoans.length} loans`,
        body: `₹${overdue.toLocaleString("en-IN")} past due across the book.`,
        link: "/dashboard/overdue",
      });
    }
    const largeTxns = collections.filter(
      (c) => c.status === "NORMAL" && c.amount >= 50000 && branchFilter(c),
    );
    if (largeTxns.length) {
      alerts.push({
        kind: "SUSPICIOUS",
        tone: "info",
        title: `${largeTxns.length} large transaction${largeTxns.length > 1 ? "s" : ""} (≥ ₹50,000)`,
        body: "Flagged for review in Reports → Transaction ledger.",
        link: "/dashboard/reports",
      });
    }

    return {
      role: me.role,
      stats: {
        portfolio: outstanding,
        outstanding,
        overdue,
        activeClients: clients.filter(
          (c) => c.status === "ACTIVE" && (ownStaff ? c.assignedTo === me._id : branchFilter(c)),
        ).length,
        activeLoans: activeLoans.length,
        todayCollection: Math.round(
          todayCollections.reduce((s, c) => s + c.amount, 0) * 100,
        ) / 100,
        todayDisbursement: Math.round(
          todayDisbursed.reduce((s, l) => s + l.principal, 0) * 100,
        ) / 100,
        totalStaff: profiles.filter(
          (p) => p.role !== "CLIENT" && (ownStaff ? p._id === me._id : branchFilter(p)),
        ).length,
        cashWithStaff,
        cashWithBM,
        bankBalance,
        overdueLoans: overdueLoans.length,
      },
      trends: { collectionTrend, disbursementTrend, portfolioTrend },
      branchPerformance,
      staffPerformance,
      wallets: walletBalances,
      alerts,
      pending: {
        loans: pendingApplications.length,
        handovers: pendingHandovers.length,
        closings: pendingClosings.length,
        requests: pendingExpensesRequests.length,
        total:
          pendingApplications.length +
          pendingHandovers.length +
          pendingClosings.length +
          pendingExpensesRequests.length,
      },
    };
  },
});

/** Aggregated approval queue across loans, handovers, closings, expenses. */
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
        subtitle: `${byId.get(c.profileId)?.name ?? "—"} — difference ₹${c.difference.toLocaleString("en-IN")}`,
        amount: Math.abs(c.difference),
        at: c.updatedAt,
        requestedBy: byId.get(c.profileId)?.name ?? "—",
        link: "/dashboard/cash",
      });
    }
    for (const r of requests) {
      if (r.status !== "PENDING" || !branchOk(r.branchId)) continue;
      items.push({
        id: r._id,
        kind: r.kind,
        refId: r.refId ?? undefined,
        title: r.summary,
        subtitle: r.kind === "WALLET_LIMIT" ? "Wallet limit change" : r.kind,
        amount: r.amount ?? null,
        at: r.createdAt,
        requestedBy: byId.get(r.requestedBy)?.name ?? "—",
        link: r.kind === "WALLET_LIMIT" ? "/dashboard/staff" : "/dashboard/cash",
      });
    }
    for (const e of expenses) {
      if (e.status !== "PENDING" || !branchOk(e.branchId)) continue;
      items.push({
        id: e._id,
        kind: "EXPENSE",
        refId: e.code,
        title: `Expense ${e.code}`,
        subtitle: `${e.category} — ${e.remarks.slice(0, 60)}`,
        amount: e.amount,
        at: e.createdAt,
        requestedBy: byId.get(e.profileId)?.name ?? "—",
        link: "/dashboard/cash",
      });
    }

    items.sort((a, b) => b.at - a.at);
    return items;
  },
});

/** Generic approval decisions (wallet limit, expense requests, shortages). */
export const decideRequest = mutation({
  args: {
    requestId: v.id("approvalRequests"),
    action: v.string(),
    remark: v.optional(v.string()),
  },
  handler: async (ctx, { requestId, action, remark }) => {
    const me = await requireProfile(ctx);
    if (me.role !== "SUPER_ADMIN" && me.role !== "BRANCH_MANAGER") {
      throw new AppError("Only BM/Admin can decide approvals.");
    }
    const req = await ctx.db.get(requestId);
    if (!req) throw new AppError("Request not found.");
    if (req.status !== "PENDING") throw new AppError("Already decided.");
    if (me.role === "BRANCH_MANAGER" && req.branchId !== me.branchId) {
      throw new AppError("Outside your branch.");
    }
    const now = Date.now();
    const next = action === "APPROVED" ? "APPROVED" : "REJECTED";

    await ctx.db.patch(requestId, {
      status: next,
      decidedBy: me._id,
      decidedAt: now,
      remark,
    });

    // Wallet-limit approvals actually change the approved limit.
    if (req.kind === "WALLET_LIMIT" && next === "APPROVED" && req.refId && req.amount) {
      const staff = await ctx.db
        .query("profiles")
        .withIndex("by_staffId", (q) => q.eq("staffId", req.refId!))
        .unique();
      const wallet = staff
        ? await ctx.db
            .query("wallets")
            .withIndex("by_profile", (q) => q.eq("profileId", staff._id))
            .unique()
        : null;
      if (wallet) {
        await ctx.db.patch(wallet._id, { walletLimit: req.amount });
        await logAudit(ctx, {
          actorId: me._id,
          actorName: me.name,
          role: me.role,
          action: "WALLET_LIMIT_CHANGED",
          entity: "wallets",
          entityId: req.refId,
          before: { walletLimit: wallet.walletLimit },
          after: { walletLimit: req.amount },
          referenceId: req.refId,
          branchId: req.branchId,
        });
        if (staff) {
          await notify(ctx, staff._id, {
            title: "Wallet limit approved",
            body: `Your working limit is now ₹${req.amount.toLocaleString("en-IN")}.`,
            kind: "WALLET",
          });
        }
      }
    }

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: `APPROVAL_${next}`,
      entity: "approvalRequests",
      entityId: req.refId ?? requestId,
      before: { status: "PENDING" },
      after: { status: next, remark, kind: req.kind },
      branchId: req.branchId,
    });
    await notify(ctx, req.requestedBy, {
      title: `${req.kind.replace(/_/g, " ").toLowerCase()} ${next.toLowerCase()}`,
      body: `${req.summary}${remark ? ` — ${remark}` : ""}`,
      kind: "APPROVAL",
    });
    return { ok: true, status: next };
  },
});

/* --------------------------------- Audit --------------------------------- */

export const auditLogs = query({
  args: {
    limit: v.optional(v.number()),
    entity: v.optional(v.string()),
    action: v.optional(v.string()),
    actorId: v.optional(v.id("profiles")),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "audit_logs");

    let rows = await ctx.db
      .query("auditLogs")
      .withIndex("by_created")
      .order("desc")
      .take(Math.min(args.limit ?? 100, 500));
    if (me.role === "BRANCH_MANAGER") rows = rows.filter((r) => r.branchId === me.branchId);
    if (args.entity) rows = rows.filter((r) => r.entity === args.entity);
    if (args.action) rows = rows.filter((r) => r.action === args.action);
    if (args.actorId) rows = rows.filter((r) => r.actorId === args.actorId);
    const q = (args.search ?? "").toLowerCase();
    if (q) {
      rows = rows.filter(
        (r) =>
          r.action.toLowerCase().includes(q) ||
          r.actorName.toLowerCase().includes(q) ||
          (r.entityId ?? "").toLowerCase().includes(q) ||
          (r.referenceId ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  },
});

/* ------------------------------ Notifications ---------------------------- */

export const notifications = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const rows = (
      await ctx.db
        .query("notifications")
        .withIndex("by_profile", (q) => q.eq("profileId", me._id))
        .order("desc")
        .take(args.limit ?? 30)
    );
    return {
      rows,
      unread: rows.filter((r) => !r.read).length,
    };
  },
});

export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const n = await ctx.db.get(notificationId);
    if (!n || n.profileId !== me._id) throw new AppError("Notification not found.");
    await ctx.db.patch(notificationId, { read: true });
    return { ok: true };
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_profile", (q) => q.eq("profileId", me._id))
      .collect();
    for (const n of rows) {
      if (!n.read) await ctx.db.patch(n._id, { read: true });
    }
    return { ok: true, count: rows.length };
  },
});

/* ----------------------------- Global search ----------------------------- */

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

/* ------------------------------ Money trail ------------------------------ */

interface TrailNode {
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  amount?: number;
}

/**
 * Traces a rupee through the system: Admin → Staff Wallet → Loan → Client →
 * Repayment → Collection → Cash Handover → BM → Branch/Bank, forwards or in
 * reverse (the same edges, rendered from the other end).
 */
export const moneyTrail = query({
  args: { kind: v.string(), id: v.string(), direction: v.optional(v.string()) },
  handler: async (ctx, { kind, id, direction }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "audit_logs");

    const nodes: TrailNode[] = [];
    const edges: { from: string; to: string; label: string }[] = [];
    const push = (n: TrailNode) => {
      if (!nodes.some((x) => x.id === n.id)) nodes.push(n);
    };

    const [profiles, clients, loans, collections, receipts, journals] =
      await Promise.all([
        ctx.db.query("profiles").collect(),
        ctx.db.query("clients").collect(),
        ctx.db.query("loans").collect(),
        ctx.db.query("collections").collect(),
        ctx.db.query("receipts").collect(),
        ctx.db.query("journalEntries").collect(),
      ]);

    let seedLoanId: string | null = null;
    let seedCollectionCode: string | null = null;

    if (kind === "collection") {
      const c = collections.find((x) => x.code === id);
      if (!c) throw new AppError("Collection not found.");
      seedCollectionCode = c.code;
      seedLoanId = (loans.find((l) => l._id === c.loanId) ?? {}).loanId ?? null;
    } else if (kind === "loan") {
      seedLoanId = id;
    } else if (kind === "walletTxn") {
      const txn = await ctx.db
        .query("walletTransactions")
        .withIndex("by_ref", (q) => q.eq("referenceId", id))
        .first();
      if (txn?.referenceType === "COLLECTION") seedCollectionCode = txn.referenceId ?? null;
      if (txn?.referenceType === "LOAN") seedLoanId = txn.referenceId ?? null;
      if (txn) {
        push({
          id: `wt:${txn.txnId}`,
          kind: "WALLET_TXN",
          title: txn.txnId,
          subtitle: `${txn.type} · ${txn.direction} · balance ₹${txn.balanceAfter.toLocaleString("en-IN")}`,
          amount: txn.amount,
        });
      }
    } else if (kind === "receipt") {
      const r = receipts.find((x) => x.number === id);
      if (r) {
        seedCollectionCode = collections.find((c) => c._id === r.collectionId)?.code ?? null;
        const loan = loans.find((l) => l._id === r.loanId);
        seedLoanId = loan?.loanId ?? null;
      }
    }

    const loan = seedLoanId ? loans.find((l) => l.loanId === seedLoanId) : undefined;
    const collection = seedCollectionCode
      ? collections.find((c) => c.code === seedCollectionCode)
      : undefined;

    if (loan) {
      const client = clients.find((c) => c._id === loan.clientId);
      const staff = profiles.find((p) => p._id === loan.staffId);
      const branch = await ctx.db.get(loan.branchId);

      push({ id: "admin", kind: "ADMIN", title: "Organisation treasury", subtitle: "Sanctioned limits & disbursement pool" });
      push({
        id: `wallet:${staff?._id}`,
        kind: "WALLET",
        title: `Staff wallet — ${staff?.name ?? "—"}`,
        subtitle: staff?.staffId ?? "",
        amount: undefined,
      });
      push({
        id: `loan:${loan.loanId}`,
        kind: "LOAN",
        title: loan.loanId,
        subtitle: `Principal ₹${loan.principal.toLocaleString("en-IN")} · ${loan.status}`,
        amount: loan.principal,
      });
      push({
        id: `client:${client?._id}`,
        kind: "CLIENT",
        title: client?.name ?? "Client",
        subtitle: `${client?.code ?? ""} · ${client?.village ?? ""}`,
      });
      push({
        id: `branch:${branch?._id}`,
        kind: "BRANCH",
        title: `Branch — ${branch?.name ?? "—"}`,
        subtitle: "Cash & bank settlement",
      });

      edges.push({ from: "admin", to: `wallet:${staff?._id}`, label: "working cash issued" });
      edges.push({ from: `wallet:${staff?._id}`, to: `loan:${loan.loanId}`, label: "disbursement" });
      edges.push({ from: `loan:${loan.loanId}`, to: `client:${client?._id}`, label: "principal to client" });
    }

    if (collection && loan) {
      const staff = profiles.find((p) => p._id === collection.staffId);
      const receipt = receipts.find((r) => r.collectionId === collection._id);
      push({
        id: `coll:${collection.code}`,
        kind: "COLLECTION",
        title: `Repayment ${collection.code}`,
        subtitle: `${collection.mode} · ${collection.status}`,
        amount: collection.amount,
      });
      push({
        id: `receipt:${receipt?.number}`,
        kind: "RECEIPT",
        title: `Receipt ${receipt?.number ?? "—"}`,
        subtitle: `Outstanding after ₹${(receipt?.outstandingAfter ?? 0).toLocaleString("en-IN")}`,
      });
      const walletTxn = collection.walletTxnId
        ? await ctx.db.get(collection.walletTxnId)
        : null;
      if (walletTxn) {
        push({
          id: `wt:${walletTxn.txnId}`,
          kind: "WALLET_TXN",
          title: walletTxn.txnId,
          subtitle: `${walletTxn.type} · balance after ₹${walletTxn.balanceAfter.toLocaleString("en-IN")}`,
          amount: walletTxn.amount,
        });
      }

      edges.push({
        from: `client:${clients.find((c) => c._id === collection.clientId)?._id}`,
        to: `coll:${collection.code}`,
        label: `${collection.mode.toLowerCase()} repayment`,
      });
      edges.push({
        from: `coll:${collection.code}`,
        to: `wallet:${staff?._id}`,
        label: collection.mode === "CASH" ? "cash credited to wallet" : "settled to bank",
      });
      edges.push({
        from: `coll:${collection.code}`,
        to: `receipt:${receipt?.number}`,
        label: "receipt issued",
      });

      // Collection → staff wallet → branch/BM → organisation treasury.
      const branchId = loans.find((l) => l._id === collection.loanId)?.branchId ?? loan?.branchId;
      const branchDoc = branchId ? await ctx.db.get(branchId) : null;
      if (branchId) {
        push({
          id: `branch:${branchId}`,
          kind: "BRANCH",
          title: `Branch — ${branchDoc?.name ?? "—"}`,
          subtitle: "Cash & bank settlement",
        });
        edges.push({
          from: `wallet:${staff?._id}`,
          to: `branch:${branchId}`,
          label: collection.mode === "CASH" ? "cash handover to BM" : "settled into bank",
        });
        edges.push({
          from: `branch:${branchId}`,
          to: "admin",
          label: "branch cash / bank deposit",
        });
      }
      void seedLoanId;
    }

    // Journal backing entries for anything we found.
    const journalRefs = [
      ...(loan ? [loan.loanId] : []),
      ...(collection ? [collection.code] : []),
    ];
    const linkedJournals = journals.filter((j) => journalRefs.includes(j.refId));
    for (const j of linkedJournals) {
      push({
        id: `je:${j.entryId}`,
        kind: "JOURNAL",
        title: j.entryId,
        subtitle: `${j.memo} · Dr ${j.lines.reduce((s, l) => s + l.debit, 0).toLocaleString("en-IN")} / Cr ${j.lines
          .reduce((s, l) => s + l.credit, 0)
          .toLocaleString("en-IN")}`,
      });
      edges.push({
        from: `je:${j.entryId}`,
        to: collection ? `coll:${collection.code}` : `loan:${loan?.loanId}`,
        label: "double entry",
      });
    }

    // Reversal links on the collection.
    if (collection) {
      const reversals = collections.filter((c) => c.reversalOfId === collection._id);
      for (const rev of reversals) {
        push({
          id: `coll:${rev.code}`,
          kind: "COLLECTION",
          title: `Reversal ${rev.code}`,
          subtitle: rev.status,
          amount: rev.amount,
        });
        edges.push({
          from: `coll:${collection.code}`,
          to: `coll:${rev.code}`,
          label: "reversed by",
        });
      }
      if (collection.reversalOfId) {
        const original = collections.find((c) => c._id === collection.reversalOfId);
        if (original) {
          push({
            id: `coll:${original.code}`,
            kind: "COLLECTION",
            title: `Original ${original.code}`,
            subtitle: original.status,
            amount: original.amount,
          });
          edges.push({
            from: `coll:${original.code}`,
            to: `coll:${collection.code}`,
            label: "reversal of",
          });
        }
      }
    }

    const reversed = direction === "reverse";
    return {
      nodes,
      edges: reversed
        ? edges.map((e) => ({ from: e.to, to: e.from, label: e.label })).reverse()
        : edges,
      direction: reversed ? "reverse" : "forward",
    };
  },
});

/* ------------------------------- Permissions ----------------------------- */

export const permissionCatalog = query({
  args: {},
  handler: async (ctx) => {
    await requireProfile(ctx, { allowInactive: true });
    return PERMISSIONS;
  },
});

export const grievanceList = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const rows = await ctx.db.query("grievances").collect();
    const filtered = rows.filter((g) =>
      me.role === "FIELD_STAFF" ? false : me.role === "BRANCH_MANAGER" ? true : true,
    );
    const clients = await ctx.db.query("clients").collect();
    return filtered
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => ({ ...g, client: clients.find((c) => c._id === g.clientId) ?? null }));
  },
});
