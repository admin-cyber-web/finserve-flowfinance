import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { AppError, istDateKey, requirePermission, requireProfile, walletBalance } from "../lib/server/convexHelpers";
import { deriveBalance } from "../lib/finance/wallet";

/**
 * One reusable report engine behind every report in the Reports section.
 * Rows come from the immutable ledgers; totals are computed server-side so
 * every figure on screen is traceable back to a transaction.
 */
export const run = query({
  args: {
    dateFrom: v.optional(v.number()),
    dateTo: v.optional(v.number()),
    branchId: v.optional(v.id("branches")),
    staffId: v.optional(v.id("profiles")),
    clientId: v.optional(v.id("clients")),
    loanId: v.optional(v.id("loans")),
    type: v.optional(v.string()), // ALL | COLLECTION | WALLET | HANDOVER | EXPENSE | DISBURSEMENT
    mode: v.optional(v.string()), // CASH | UPI | BANK
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "reports");
    const now = Date.now();
    const from = args.dateFrom ?? now - 30 * 86_400_000;
    const to = (args.dateTo ?? now) + 86_399_999;

    const [collections, wallets, txns, handovers, expenses, issues, loans, clients, profiles] =
      await Promise.all([
        ctx.db.query("collections").collect(),
        ctx.db.query("wallets").collect(),
        ctx.db.query("walletTransactions").collect(),
        ctx.db.query("cashHandovers").collect(),
        ctx.db.query("expenses").collect(),
        ctx.db.query("cashIssues").collect(),
        ctx.db.query("loans").collect(),
        ctx.db.query("clients").collect(),
        ctx.db.query("profiles").collect(),
      ]);

    const clientById = new Map(clients.map((c) => [c._id, c]));
    const loanById = new Map(loans.map((l) => [l._id, l]));
    const profileById = new Map(profiles.map((p) => [p._id, p]));

    // Scope: staff → own, BM → branch, admin/accountant → org (or filters).
    const walletIds = wallets
      .filter((w) => {
        if (me.role === "FIELD_STAFF") return w.profileId === me._id;
        if (me.role === "BRANCH_MANAGER") return w.branchId === me.branchId;
        return true;
      })
      .filter((w) => (args.staffId ? w.profileId === args.staffId : true))
      .filter((w) => (args.branchId ? w.branchId === args.branchId : true));
    const walletIdSet = new Set(walletIds.map((w) => w._id));
    const profileSet = new Set(walletIds.map((w) => w.profileId));

    const inRange = (t: number) => t >= from && t <= to;
    const scopeCollection = (c: Doc<"collections">) => {
      if (me.role === "FIELD_STAFF" && c.staffId !== me._id) return false;
      if (me.role === "BRANCH_MANAGER" && c.branchId !== me.branchId) return false;
      if (args.staffId && c.staffId !== args.staffId) return false;
      if (args.branchId && c.branchId !== args.branchId) return false;
      if (args.clientId && c.clientId !== args.clientId) return false;
      if (args.loanId && c.loanId !== args.loanId) return false;
      if (args.mode && c.mode !== args.mode) return false;
      if (args.status && c.status !== args.status) return false;
      return true;
    };

    interface Row {
      id: string;
      date: number;
      kind: string;
      type: string;
      mode: string | null;
      amount: number;
      direction: "IN" | "OUT" | "NONE";
      party: string;
      reference: string;
      status: string;
      staffName: string;
      branchId?: string;
    }
    const rows: Row[] = [];
    const type = args.type ?? "ALL";

    if (type === "ALL" || type === "COLLECTION") {
      for (const c of collections) {
        if (!inRange(c.createdAt) || !scopeCollection(c)) continue;
        rows.push({
          id: c.code,
          date: c.createdAt,
          kind: "COLLECTION",
          type: c.mode === "CASH" ? "Cash collection" : c.mode === "UPI" ? "UPI collection" : "Bank collection",
          mode: c.mode,
          amount: c.amount,
          direction: c.status === "REVERSAL" ? "OUT" : "IN",
          party: clientById.get(c.clientId)?.name ?? "—",
          reference: c.receiptNumber ?? c.code,
          status: c.status,
          staffName: profileById.get(c.staffId)?.name ?? "—",
          branchId: c.branchId,
        });
      }
    }

    if (type === "ALL" || type === "WALLET" || type === "DISBURSEMENT") {
      for (const t of txns) {
        if (!walletIdSet.has(t.walletId)) continue;
        if (!inRange(t.createdAt)) continue;
        if (args.staffId && t.profileId !== args.staffId) continue;
        if (type === "DISBURSEMENT" && t.type !== "LOAN_DISBURSEMENT") continue;
        if (type === "WALLET" && t.type === "LOAN_DISBURSEMENT") continue;
        if (type === "ALL" && t.type === "LOAN_DISBURSEMENT" && t.direction !== "DEBIT") continue;
        rows.push({
          id: t.txnId,
          date: t.createdAt,
          kind: "WALLET",
          type: t.type.replace(/_/g, " ").toLowerCase(),
          mode: null,
          amount: t.amount,
          direction: t.direction === "CREDIT" ? "IN" : t.direction === "DEBIT" ? "OUT" : "NONE",
          party: profileById.get(t.profileId)?.name ?? "—",
          reference: t.referenceId ?? t.txnId,
          status: "POSTED",
          staffName: profileById.get(t.profileId)?.name ?? "—",
          branchId: t.branchId,
        });
      }
    }

    if (type === "ALL" || type === "HANDOVER") {
      for (const h of handovers) {
        if (!inRange(h.requestedAt)) continue;
        if (me.role === "FIELD_STAFF" && h.staffId !== me._id) continue;
        if (me.role === "BRANCH_MANAGER" && h.branchId !== me.branchId) continue;
        if (args.staffId && h.staffId !== args.staffId) continue;
        if (args.branchId && h.branchId !== args.branchId) continue;
        rows.push({
          id: h.code,
          date: h.requestedAt,
          kind: "HANDOVER",
          type: "cash handover",
          mode: "CASH",
          amount: h.amount,
          direction: h.status === "ACCEPTED" ? "OUT" : "NONE",
          party: profileById.get(h.staffId)?.name ?? "—",
          reference: h.code,
          status: h.status,
          staffName: profileById.get(h.staffId)?.name ?? "—",
          branchId: h.branchId,
        });
      }
      for (const i of issues) {
        if (!inRange(i.createdAt)) continue;
        if (me.role === "BRANCH_MANAGER" && i.branchId !== me.branchId) continue;
        if (args.staffId && i.staffId !== args.staffId) continue;
        rows.push({
          id: i.code,
          date: i.createdAt,
          kind: "HANDOVER",
          type: "cash issue",
          mode: "CASH",
          amount: i.amount,
          direction: "IN",
          party: profileById.get(i.staffId)?.name ?? "—",
          reference: i.code,
          status: "ISSUED",
          staffName: profileById.get(i.bmId)?.name ?? "—",
          branchId: i.branchId,
        });
      }
    }

    if (type === "ALL" || type === "EXPENSE") {
      for (const e of expenses) {
        if (!inRange(e.createdAt) || e.status !== "APPROVED") continue;
        if (me.role === "FIELD_STAFF" && e.profileId !== me._id) continue;
        if (me.role === "BRANCH_MANAGER" && e.branchId !== me.branchId) continue;
        if (args.staffId && e.profileId !== args.staffId) continue;
        rows.push({
          id: e.code,
          date: e.createdAt,
          kind: "EXPENSE",
          type: e.category,
          mode: "CASH",
          amount: e.amount,
          direction: "OUT",
          party: profileById.get(e.profileId)?.name ?? "—",
          reference: e.code,
          status: e.status,
          staffName: profileById.get(e.profileId)?.name ?? "—",
          branchId: e.branchId,
        });
      }
    }

    rows.sort((a, b) => b.date - a.date);
    const capped = args.limit ? rows.slice(0, args.limit) : rows;

    // Totals — the "Rahul ne 1 Oct se 5 Oct tak…" answer.
    const cashCollected = rows
      .filter((r) => r.kind === "COLLECTION" && r.mode === "CASH" && r.direction === "IN")
      .reduce((s, r) => s + r.amount, 0);
    const upiCollected = rows
      .filter((r) => r.kind === "COLLECTION" && r.mode === "UPI" && r.direction === "IN")
      .reduce((s, r) => s + r.amount, 0);
    const bankCollected = rows
      .filter((r) => r.kind === "COLLECTION" && r.mode === "BANK" && r.direction === "IN")
      .reduce((s, r) => s + r.amount, 0);
    const disbursed = rows
      .filter((r) => r.kind === "WALLET" && r.type === "loan disbursed")
      .reduce((s, r) => s + r.amount, 0);
    const handoverOut = rows
      .filter((r) => r.kind === "HANDOVER" && r.type === "cash handover" && r.status === "ACCEPTED")
      .reduce((s, r) => s + r.amount, 0);
    const handoverIn = rows
      .filter((r) => r.kind === "HANDOVER" && r.type === "cash issue")
      .reduce((s, r) => s + r.amount, 0);
    const expensesTotal = rows
      .filter((r) => r.kind === "EXPENSE")
      .reduce((s, r) => s + r.amount, 0);

    // Closing wallet balance at the end of the range (derived, never stored).
    let closingWallet: number | null = null;
    if (walletIds.length === 1) {
      const w = walletIds[0];
      const wtxns = txns.filter((t) => t.walletId === w._id && t.createdAt <= to);
      closingWallet = deriveBalance(
        wtxns.map((t) => ({ type: t.type, amount: t.amount, direction: t.direction })),
      );
    } else if (walletIds.length > 1) {
      closingWallet = 0;
      for (const w of walletIds) {
        const wtxns = txns.filter((t) => t.walletId === w._id && t.createdAt <= to);
        closingWallet += deriveBalance(
          wtxns.map((t) => ({ type: t.type, amount: t.amount, direction: t.direction })),
        );
      }
      closingWallet = Math.round(closingWallet * 100) / 100;
    }

    return {
      range: { from, to, fromKey: istDateKey(from), toKey: istDateKey(to) },
      rows: capped,
      totals: {
        rowCount: rows.length,
        cashCollected: Math.round(cashCollected * 100) / 100,
        upiCollected: Math.round(upiCollected * 100) / 100,
        bankCollected: Math.round(bankCollected * 100) / 100,
        collected: Math.round((cashCollected + upiCollected + bankCollected) * 100) / 100,
        disbursed: Math.round(disbursed * 100) / 100,
        handoverOut: Math.round(handoverOut * 100) / 100,
        handoverIn: Math.round(handoverIn * 100) / 100,
        expenses: Math.round(expensesTotal * 100) / 100,
        closingWallet,
      },
    };
  },
});

/** Staff wallet report — every wallet with a ledger-derived balance. */
export const wallets = query({
  args: { branchId: v.optional(v.id("branches")) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "reports");
    let all = await ctx.db.query("wallets").collect();
    if (me.role === "BRANCH_MANAGER") all = all.filter((w) => w.branchId === me.branchId);
    else if (me.role === "FIELD_STAFF") all = all.filter((w) => w.profileId === me._id);
    if (args.branchId) all = all.filter((w) => w.branchId === args.branchId);

    const profiles = await ctx.db.query("profiles").collect();
    const branches = await ctx.db.query("branches").collect();
    const byId = new Map(profiles.map((p) => [p._id, p]));

    const out = [];
    for (const w of all) {
      const balance = await walletBalance(ctx, w._id);
      const profile = byId.get(w.profileId);
      out.push({
        wallet: w,
        profile,
        branch: branches.find((b) => b._id === w.branchId) ?? null,
        balance,
        utilization: w.walletLimit ? Math.round((balance / w.walletLimit) * 10000) / 100 : 0,
      });
    }
    return out;
  },
});

/** Accounting books: cash book, bank book, journal, trial balance. */
export const books = query({
  args: {
    book: v.string(), // CASH | BANK | JOURNAL | TRIAL_BALANCE | INCOME | EXPENSE | RECEIVABLE
    dateFrom: v.optional(v.number()),
    dateTo: v.optional(v.number()),
    branchId: v.optional(v.id("branches")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "accounting");

    let entries = (await ctx.db.query("journalEntries").collect()).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    const from = args.dateFrom ?? 0;
    const to = (args.dateTo ?? Date.now()) + 86_399_999;
    entries = entries.filter(
      (e) => e.createdAt >= from && e.createdAt <= to && (!args.branchId || e.branchId === args.branchId),
    );

    const codesForBook: Record<string, string[]> = {
      CASH: ["1010", "1015"],
      BANK: ["1020"],
      INCOME: ["4000", "4010", "4020"],
      EXPENSE: ["5000"],
      RECEIVABLE: ["1100"],
    };

    if (args.book === "TRIAL_BALANCE") {
      const ledger = (await ctx.db.query("accountLedgers").collect()).sort((a, b) =>
        a.code.localeCompare(b.code),
      );
      const rows = ledger.map((a) => {
        let debit = 0;
        let credit = 0;
        for (const e of entries) {
          for (const line of e.lines) {
            if (line.code === a.code) {
              debit += line.debit;
              credit += line.credit;
            }
          }
        }
        return {
          account: a,
          debit: Math.round(debit * 100) / 100,
          credit: Math.round(credit * 100) / 100,
          balance: Math.round((a.normalSide === "DEBIT" ? debit - credit : credit - debit) * 100) / 100,
        };
      });
      const totalDebit = Math.round(rows.reduce((s, r) => s + r.debit, 0) * 100) / 100;
      const totalCredit = Math.round(rows.reduce((s, r) => s + r.credit, 0) * 100) / 100;
      return { book: args.book, rows, totals: { totalDebit, totalCredit, balanced: totalDebit === totalCredit } };
    }

    if (args.book === "JOURNAL") {
      const rows = entries.slice(0, args.limit ?? 200).map((e) => ({
        entryId: e.entryId,
        dateKey: e.dateKey,
        createdAt: e.createdAt,
        memo: e.memo,
        refType: e.refType,
        refId: e.refId,
        lines: e.lines,
        debit: Math.round(e.lines.reduce((s, l) => s + l.debit, 0) * 100) / 100,
        credit: Math.round(e.lines.reduce((s, l) => s + l.credit, 0) * 100) / 100,
      }));
      return { book: args.book, rows, totals: null };
    }

    const codes = codesForBook[args.book] ?? [];
    if (!codes.length) throw new AppError("Unknown book.");

    // Running balance rows for a ledger account book.
    const ascending = [...entries].sort((a, b) => a.createdAt - b.createdAt);
    let running = 0;
    const rows = ascending
      .map((e) => {
        const lines = e.lines.filter((l) => codes.includes(l.code));
        if (!lines.length) return null;
        const debit = lines.reduce((s, l) => s + l.debit, 0);
        const credit = lines.reduce((s, l) => s + l.credit, 0);
        const delta = debit - credit;
        running += delta;
        return {
          entryId: e.entryId,
          dateKey: e.dateKey,
          createdAt: e.createdAt,
          memo: e.memo,
          refType: e.refType,
          refId: e.refId,
          debit: Math.round(debit * 100) / 100,
          credit: Math.round(credit * 100) / 100,
          balance: Math.round(running * 100) / 100,
        };
      })
      .filter(Boolean)
      .reverse()
      .slice(0, args.limit ?? 200);

    return {
      book: args.book,
      rows,
      totals: {
        debit: Math.round(rows.reduce((s, r) => s + r!.debit, 0) * 100) / 100,
        credit: Math.round(rows.reduce((s, r) => s + r!.credit, 0) * 100) / 100,
        closingBalance: running,
      },
    };
  },
});

/**
 * Portfolio overview — real counts and balances for the viewer's scope.
 * Every figure is derived from the existing loan / schedule / collection
 * records using the same business rules the rest of the app uses (NORMAL
 * collections count as repaid; `dueDate < now` is overdue).
 */
export const overview = query({
  args: {
    branchId: v.optional(v.id("branches")),
    staffId: v.optional(v.id("profiles")),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "reports");
    const now = Date.now();

    const [clients, loans, schedules, collections] = await Promise.all([
      ctx.db.query("clients").collect(),
      ctx.db.query("loans").collect(),
      ctx.db.query("loanSchedules").collect(),
      ctx.db.query("collections").collect(),
    ]);

    // Scope: staff → own assigned clients + own loans; BM → branch;
    // admin/accountant → org (or the explicit filter, if visible).
    let scopedClients = clients;
    let scopedLoans = loans;
    if (me.role === "FIELD_STAFF") {
      scopedClients = clients.filter((c) => c.assignedTo === me._id);
      scopedLoans = loans.filter((l) => l.staffId === me._id);
    } else if (me.role === "BRANCH_MANAGER") {
      if (args.branchId && args.branchId !== me.branchId) {
        throw new AppError("You can only view reports for your own branch.");
      }
      scopedClients = clients.filter((c) => c.branchId === me.branchId);
      scopedLoans = loans.filter((l) => l.branchId === me.branchId);
    } else if (me.role === "CLIENT") {
      scopedClients = me.clientId
        ? clients.filter((c) => c._id === me.clientId)
        : [];
      scopedLoans = me.clientId
        ? loans.filter((l) => l.clientId === me.clientId)
        : [];
    }
    if (args.branchId) {
      scopedClients = scopedClients.filter((c) => c.branchId === args.branchId);
      scopedLoans = scopedLoans.filter((l) => l.branchId === args.branchId);
    }
    if (args.staffId) {
      if (me.role === "FIELD_STAFF" && args.staffId !== me._id) {
        throw new AppError("You can only view your own report.");
      }
      scopedClients = scopedClients.filter((c) => c.assignedTo === args.staffId);
      scopedLoans = scopedLoans.filter((l) => l.staffId === args.staffId);
    }

    const active = scopedLoans.filter((l) =>
      ["ACTIVE", "OVERDUE"].includes(l.status),
    );
    const closed = scopedLoans.filter((l) => l.status === "CLOSED");
    const activeIds = new Set(active.map((l) => l._id));
    const scopeIds = new Set(scopedLoans.map((l) => l._id));

    const totalDisbursed = scopedLoans
      .filter((l) => l.disbursedAt)
      .reduce((s, l) => s + l.principal, 0);
    const outstanding = Math.round(
      active.reduce((s, l) => s + l.outstanding, 0) * 100,
    ) / 100;
    // Repayments: NORMAL collections against this scope's loans (reversals
    // and reversal collections are excluded — same rule as Client 360°).
    const totalRepaid = Math.round(
      collections
        .filter((c) => scopeIds.has(c.loanId) && c.status === "NORMAL")
        .reduce((s, c) => s + c.amount, 0) * 100,
    ) / 100;

    // Instalments — open rows of scoped loans. "Due" counts everything open
    // that is due on or before now; "overdue" is the strictly past-due subset
    // using the app's existing `dueDate < now` rule.
    const scopeSchedules = schedules.filter((s) => scopeIds.has(s.loanId));
    const open = scopeSchedules.filter((s) => s.paid < s.totalDue);
    const dueRows = open.filter((s) => s.dueDate <= now);
    const overdueRows = open.filter((s) => s.dueDate < now);
    const sum = (rows: typeof open) =>
      Math.round(rows.reduce((s, r) => s + (r.totalDue - r.paid), 0) * 100) / 100;
    const nextDue = open
      .filter((s) => s.dueDate >= now)
      .sort((a, b) => a.dueDate - b.dueDate)[0] ?? null;

    return {
      totalClients: scopedClients.length,
      activeLoans: active.length,
      totalLoans: scopedLoans.length,
      closedLoans: closed.length,
      totalDisbursed: Math.round(totalDisbursed * 100) / 100,
      totalRepaid,
      outstanding,
      instalmentsDue: dueRows.length,
      dueAmount: sum(dueRows),
      overdueInstalments: overdueRows.length,
      overdueAmount: sum(overdueRows),
      nextDueDate: nextDue?.dueDate ?? null,
      nextDueAmount: nextDue ? Math.round((nextDue.totalDue - nextDue.paid) * 100) / 100 : null,
      activeLoanIds: activeIds.size,
    };
  },
});

/**
 * Staff-wise and branch-manager-wise report.
 *
 * Attribution comes only from fields the database actually records:
 *   • clients.createdBy   → who registered the client
 *   • clients.assignedTo  → who the client is assigned to now
 *   • loans.staffId        → staff associated with the loan
 *   • loans.disbursedAt    → disbursement date (disbursedBy for who did it)
 *   • collections.staffId  → who collected the repayment
 * Nothing is inferred or invented.
 */
export const staffReport = query({
  args: {
    dateFrom: v.optional(v.number()),
    dateTo: v.optional(v.number()),
    branchId: v.optional(v.id("branches")),
    staffId: v.optional(v.id("profiles")),
    managerId: v.optional(v.id("profiles")),
    loanStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "reports");
    const now = Date.now();
    const from = args.dateFrom ?? 0;
    const to = (args.dateTo ?? now) + 86_399_999;
    const inRange = (t: number | undefined) => t !== undefined && t >= from && t <= to;

    // Branch scoping — a BM may only ever see their own branch, even when a
    // branch filter is passed explicitly.
    let branchFilter = args.branchId ?? null;
    if (me.role === "BRANCH_MANAGER") {
      if (!me.branchId) {
        throw new AppError("Your profile has no branch assigned.");
      }
      if (branchFilter && branchFilter !== me.branchId) {
        throw new AppError("You can only view reports for your own branch.");
      }
      branchFilter = me.branchId;
    }
    if (
      me.role === "FIELD_STAFF" &&
      ((args.branchId && args.branchId !== me.branchId) ||
        (args.staffId && args.staffId !== me._id))
    ) {
      throw new AppError("You can only view your own report.");
    }

    const [clients, loans, collections, profiles, branches] = await Promise.all([
      ctx.db.query("clients").collect(),
      ctx.db.query("loans").collect(),
      ctx.db.query("collections").collect(),
      ctx.db.query("profiles").collect(),
      ctx.db.query("branches").collect(),
    ]);
    const branchById = new Map(branches.map((b) => [b._id, b]));

    // Who may this viewer see at all? Staff see only themselves; BMs see
    // their own branch's people; admins/accountants see everyone.
    let visible = profiles.filter(
      (p) =>
        p.status === "ACTIVE" &&
        ["SUPER_ADMIN", "BRANCH_MANAGER", "FIELD_STAFF", "ACCOUNTANT"].includes(p.role),
    );
    if (me.role === "FIELD_STAFF") {
      visible = visible.filter((p) => p._id === me._id);
    } else if (me.role === "BRANCH_MANAGER") {
      visible = visible.filter(
        (p) => p.branchId === me.branchId || p._id === me._id,
      );
    }
    if (branchFilter) visible = visible.filter((p) => p.branchId === branchFilter);

    const optionOf = (p: Doc<"profiles">) => ({
      profileId: p._id,
      name: p.name,
      role: p.role,
      systemId: p.staffId,
      branchName: p.branchId
        ? (branchById.get(p.branchId)?.name ?? "—")
        : "—",
    });
    const staffOptions = visible
      .filter((p) => p.role === "FIELD_STAFF")
      .map(optionOf)
      .sort((a, b) => a.name.localeCompare(b.name));
    const managerOptions = visible
      .filter((p) => p.role === "BRANCH_MANAGER")
      .map(optionOf)
      .sort((a, b) => a.name.localeCompare(b.name));
    const branchOptions = branches
      .filter((b) =>
        me.role === "BRANCH_MANAGER"
          ? b._id === me.branchId
          : !branchFilter || b._id === branchFilter,
      )
      .map((b) => ({ branchId: b._id, name: b.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const matches = (p: Doc<"profiles">) => {
      if (p.role === "FIELD_STAFF" && args.staffId && p._id !== args.staffId) return false;
      if (p.role === "BRANCH_MANAGER" && args.managerId && p._id !== args.managerId) return false;
      return true;
    };

    // Pre-filter the underlying rows once per attribution source.
    const clientsByCreator = new Map<string, number>();
    const clientsByAssignee = new Map<string, number>();
    for (const c of clients) {
      if (branchFilter && c.branchId !== branchFilter) continue;
      if (me.role === "BRANCH_MANAGER" && c.branchId !== me.branchId) continue;
      if (me.role === "FIELD_STAFF" && c.assignedTo !== me._id && c.createdBy !== me._id)
        continue;
      if (inRange(c.createdAt)) {
        clientsByCreator.set(c.createdBy, (clientsByCreator.get(c.createdBy) ?? 0) + 1);
      }
      clientsByAssignee.set(c.assignedTo, (clientsByAssignee.get(c.assignedTo) ?? 0) + 1);
    }

    const loanMatchesStatus = (l: Doc<"loans">) =>
      !args.loanStatus || args.loanStatus === "ALL" || l.status === args.loanStatus;
    const loansByStaff = new Map<string, Doc<"loans">[]>();
    const branchLoans = new Map<string, Doc<"loans">[]>();
    for (const l of loans) {
      if (branchFilter && l.branchId !== branchFilter) continue;
      if (me.role === "BRANCH_MANAGER" && l.branchId !== me.branchId) continue;
      if (me.role === "FIELD_STAFF" && l.staffId !== me._id) continue;
      if (!loanMatchesStatus(l)) continue;
      const arr = loansByStaff.get(l.staffId) ?? [];
      arr.push(l);
      loansByStaff.set(l.staffId, arr);
      const barr = branchLoans.get(l.branchId) ?? [];
      barr.push(l);
      branchLoans.set(l.branchId, barr);
    }

    const collectedByStaff = new Map<string, { amount: number; count: number }>();
    const collectedByBranch = new Map<string, { amount: number; count: number }>();
    for (const c of collections) {
      if (!inRange(c.createdAt) || c.status !== "NORMAL") continue;
      if (branchFilter && c.branchId !== branchFilter) continue;
      if (me.role === "BRANCH_MANAGER" && c.branchId !== me.branchId) continue;
      if (me.role === "FIELD_STAFF" && c.staffId !== me._id) continue;
      const s = collectedByStaff.get(c.staffId) ?? { amount: 0, count: 0 };
      s.amount += c.amount;
      s.count += 1;
      collectedByStaff.set(c.staffId, s);
      const b = collectedByBranch.get(c.branchId) ?? { amount: 0, count: 0 };
      b.amount += c.amount;
      b.count += 1;
      collectedByBranch.set(c.branchId, b);
    }

    const round = (n: number) => Math.round(n * 100) / 100;

    const staffRows = visible
      .filter((p) => p.role === "FIELD_STAFF" && matches(p))
      .map((p) => {
        const theirs = loansByStaff.get(p._id) ?? [];
        const disbursed = theirs
          .filter((l) => inRange(l.disbursedAt))
          .reduce((s, l) => s + l.principal, 0);
        const collected = collectedByStaff.get(p._id) ?? { amount: 0, count: 0 };
        const activeLoans = theirs.filter((l) =>
          ["ACTIVE", "OVERDUE"].includes(l.status),
        );
        return {
          ...optionOf(p),
          clientsRegistered: clientsByCreator.get(p._id) ?? 0,
          clientsAssigned: clientsByAssignee.get(p._id) ?? 0,
          loans: theirs.length,
          activeLoans: activeLoans.length,
          outstanding: round(activeLoans.reduce((s, l) => s + l.outstanding, 0)),
          disbursedAmount: round(disbursed),
          repaymentsCount: collected.count,
          repaymentsCollected: round(collected.amount),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const managerRows = visible
      .filter((p) => p.role === "BRANCH_MANAGER" && matches(p))
      .map((p) => {
        const branchId = p.branchId;
        const branchLoanRows = branchId ? (branchLoans.get(branchId) ?? []) : [];
        const disbursed = branchLoanRows
          .filter((l) => inRange(l.disbursedAt))
          .reduce((s, l) => s + l.principal, 0);
        const collected = branchId
          ? (collectedByBranch.get(branchId) ?? { amount: 0, count: 0 })
          : { amount: 0, count: 0 };
        const activeLoans = branchLoanRows.filter((l) =>
          ["ACTIVE", "OVERDUE"].includes(l.status),
        );
        const branchClientCount = branchId
          ? clients.filter((c) => c.branchId === branchId).length
          : 0;
        return {
          ...optionOf(p),
          branchId,
          clients: branchClientCount,
          clientsRegistered: clientsByCreator.get(p._id) ?? 0,
          loans: branchLoanRows.length,
          activeLoans: activeLoans.length,
          outstanding: round(activeLoans.reduce((s, l) => s + l.outstanding, 0)),
          disbursedAmount: round(disbursed),
          repaymentsCount: collected.count,
          repaymentsCollected: round(collected.amount),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      range: { from, to },
      staffRows,
      managerRows,
      staffOptions,
      managerOptions,
      branchOptions,
      totals: {
        // Staff-wise and branch-wise figures are returned separately: a
        // branch manager's totals already contain that branch's staff
        // activity, so summing the two levels would double-count.
        staff: {
          registeredClients: staffRows.reduce((s, r) => s + r.clientsRegistered, 0),
          assignedClients: staffRows.reduce((s, r) => s + r.clientsAssigned, 0),
          loans: staffRows.reduce((s, r) => s + r.loans, 0),
          disbursed: round(staffRows.reduce((s, r) => s + r.disbursedAmount, 0)),
          collected: round(staffRows.reduce((s, r) => s + r.repaymentsCollected, 0)),
        },
        branch: {
          clients: managerRows.reduce((s, r) => s + r.clients, 0),
          loans: managerRows.reduce((s, r) => s + r.loans, 0),
          disbursed: round(managerRows.reduce((s, r) => s + r.disbursedAmount, 0)),
          collected: round(managerRows.reduce((s, r) => s + r.repaymentsCollected, 0)),
        },
      },
    };
  },
});

/**
 * Upcoming instalment due dates — the stored repayment schedule only.
 * Fixed 30-day window from now; rows are the real `loanSchedules` entries
 * (actual weekly/fortnightly/monthly dates as recorded, never assumed).
 */
export const upcoming = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "reports");
    const now = Date.now();
    const from = now;
    const to = now + 30 * 86_400_000;

    const [loans, schedules, clients, profiles] = await Promise.all([
      ctx.db.query("loans").collect(),
      ctx.db.query("loanSchedules").collect(),
      ctx.db.query("clients").collect(),
      ctx.db.query("profiles").collect(),
    ]);
    const clientById = new Map(clients.map((c) => [c._id, c]));
    const profileById = new Map(profiles.map((p) => [p._id, p]));

    // Same scope rules as `overview`.
    let scoped = loans.filter((l) => ["ACTIVE", "OVERDUE"].includes(l.status));
    if (me.role === "FIELD_STAFF") {
      scoped = scoped.filter((l) => l.staffId === me._id);
    } else if (me.role === "BRANCH_MANAGER") {
      scoped = scoped.filter((l) => l.branchId === me.branchId);
    } else if (me.role === "CLIENT") {
      scoped = me.clientId ? scoped.filter((l) => l.clientId === me.clientId) : [];
    }
    const loanById = new Map(scoped.map((l) => [l._id, l]));
    const scopedIds = new Set(loanById.keys());

    const matching = schedules
      .filter(
        (s) =>
          scopedIds.has(s.loanId) &&
          s.paid < s.totalDue &&
          s.dueDate >= from &&
          s.dueDate <= to,
      )
      .sort((a, b) => a.dueDate - b.dueDate);
    const totalAmount = Math.round(
      matching.reduce((s, r) => s + (r.totalDue - r.paid), 0) * 100,
    ) / 100;
    const weeklyCount = matching.filter(
      (r) => loanById.get(r.loanId)?.frequency === "WEEKLY",
    ).length;

    const rows = matching.slice(0, args.limit ?? 200).map((r) => {
      const loan = loanById.get(r.loanId)!;
      const client = clientById.get(loan.clientId);
      return {
        scheduleId: r._id,
        index: r.index,
        dueDate: r.dueDate,
        amount: Math.round((r.totalDue - r.paid) * 100) / 100,
        principal: r.principal,
        interest: r.interest,
        status: r.status,
        loanId: loan.loanId,
        frequency: loan.frequency,
        clientName: client?.name ?? "—",
        clientCode: client?.code ?? "—",
        staffName: profileById.get(loan.staffId)?.name ?? "—",
      };
    });

    return {
      window: { from, to },
      rows,
      totalCount: matching.length,
      totalAmount,
      weeklyCount,
    };
  },
});

/** Overdue / recovery book with ageing buckets. */
export const overdue = query({
  args: { branchId: v.optional(v.id("branches")), bucket: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "reports");
    const now = Date.now();

    let loans: Doc<"loans">[] = await ctx.db.query("loans").collect();
    if (me.role === "FIELD_STAFF") loans = loans.filter((l) => l.staffId === me._id);
    else if (me.role === "BRANCH_MANAGER") loans = loans.filter((l) => l.branchId === me.branchId);
    if (args.branchId) loans = loans.filter((l) => l.branchId === args.branchId);

    const [clients, profiles, schedules] = await Promise.all([
      ctx.db.query("clients").collect(),
      ctx.db.query("profiles").collect(),
      ctx.db.query("loanSchedules").collect(),
    ]);
    const clientById = new Map(clients.map((c) => [c._id, c]));
    const profileById = new Map(profiles.map((p) => [p._id, p]));

    const rows: {
      loanId: string;
      loanDbId: string;
      clientName: string;
      clientCode: string;
      outstanding: number;
      overdueAmount: number;
      daysOverdue: number;
      bucket: string;
      staffName: string;
      lastPayment: number | null;
      village: string;
    }[] = [];

    for (const loan of loans) {
      if (!["ACTIVE", "OVERDUE"].includes(loan.status)) continue;
      const own = schedules.filter((s) => s.loanId === loan._id);
      const overdueRows = own.filter((s) => s.paid < s.totalDue && s.dueDate < now);
      if (!overdueRows.length) continue;
      const overdueAmount = overdueRows.reduce((s, r) => s + (r.totalDue - r.paid), 0);
      const daysOverdue = Math.floor(
        (now - Math.min(...overdueRows.map((r) => r.dueDate))) / 86_400_000,
      );
      const bucket =
        daysOverdue <= 7 ? "0-7" : daysOverdue <= 30 ? "8-30" : daysOverdue <= 60 ? "31-60" : "60+";
      if (args.bucket && bucket !== args.bucket) continue;
      const client = clientById.get(loan.clientId);
      rows.push({
        loanId: loan.loanId,
        loanDbId: loan._id,
        clientName: client?.name ?? "—",
        clientCode: client?.code ?? "—",
        village: client?.village ?? "—",
        outstanding: loan.outstanding,
        overdueAmount: Math.round(overdueAmount * 100) / 100,
        daysOverdue,
        bucket,
        staffName: profileById.get(loan.staffId)?.name ?? "—",
        lastPayment: loan.lastPaymentAt ?? null,
      });
    }
    rows.sort((a, b) => b.daysOverdue - a.daysOverdue);

    const buckets = {
      "0-7": { count: 0, amount: 0 },
      "8-30": { count: 0, amount: 0 },
      "31-60": { count: 0, amount: 0 },
      "60+": { count: 0, amount: 0 },
    };
    for (const r of rows) {
      buckets[r.bucket as keyof typeof buckets].count += 1;
      buckets[r.bucket as keyof typeof buckets].amount =
        Math.round(
          (buckets[r.bucket as keyof typeof buckets].amount + r.overdueAmount) * 100,
        ) / 100;
    }

    return { rows, buckets };
  },
});
