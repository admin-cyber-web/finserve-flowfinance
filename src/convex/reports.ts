import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { AppError, istDateKey, requirePermission, requireProfile, walletBalance } from "../lib/server/convexHelpers";
import { deriveBalance } from "../lib/finance/wallet";
import { buildDateReport, rangeBounds, resolveRange } from "../lib/finance/dateReport";
import {
  buildCollectionRows,
  buildDisbursementRows,
  buildDueDateRows,
  buildOverdueRows,
  type CollectionFacts,
  type LoanFacts,
  type ScheduleFacts,
} from "../lib/finance/excelReports";
import {
  buildCombinedStatement,
  buildLoanStatement,
  loanPurposeLabel,
  resolveClientMatches,
  type StatementLoan,
} from "../lib/finance/statement";
import { deriveLoanView } from "../lib/server/loanOps";

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

/* --------------------------- Date-wise report ---------------------------- */

/**
 * The query behind the "Date Range" tab: From/To dates in the institution's
 * local day (IST), inclusive on both ends, resolved to real records from the
 * ledgers. Authentication, permission and role scope are enforced here — the
 * client only ever renders what this query returns, and the date range is
 * applied on the backend, not just in the UI.
 *
 * Indexes used: `collections.by_created` and `walletTransactions.by_created`
 * (range reads — these tables are only ever filtered by createdAt) and
 * `loanSchedules.by_due` (overdue = unpaid rows due before now). The rest are
 * small tables collected whole because KYC/outstanding figures need current
 * state, not only in-range rows.
 */
export const dateReport = query({
  args: {
    fromDay: v.string(), // YYYY-MM-DD, institution-local (IST)
    toDay: v.string(),
    category: v.optional(v.string()), // ALL | CLIENTS | KYC | LOANS | DISBURSEMENTS | COLLECTIONS | OVERDUE | RECOVERY | HANDOVER | WALLET
    branchId: v.optional(v.id("branches")),
    staffId: v.optional(v.id("profiles")),
    centerCode: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "reports");

    const range = resolveRange(args.fromDay, args.toDay);
    if ("error" in range) throw new AppError(range.error);
    const bounds = rangeBounds(range.fromDay, range.toDay);
    if (!bounds) throw new AppError("Invalid date range.");
    const now = Date.now();

    // Branch scope: a BRANCH_MANAGER is pinned to their own branch; staff and
    // branch filters can only narrow a SUPER_ADMIN / ACCOUNTANT view — they
    // can never widen it (the engine re-checks this per record as well).
    let branchFilter: string | null = args.branchId ?? null;
    if (me.role === "BRANCH_MANAGER") {
      if (branchFilter && branchFilter !== me.branchId) {
        throw new AppError("You can only report on your own branch.");
      }
      branchFilter = me.branchId ?? null;
    }
    const staffFilter: string | null = args.staffId ?? null;

    const [
      clients,
      applications,
      loans,
      collections,
      handovers,
      issues,
      recovery,
      wallets,
      walletTxns,
      schedules,
      profiles,
      branches,
      centers,
    ] = await Promise.all([
      ctx.db.query("clients").collect(),
      ctx.db.query("loanApplications").collect(),
      ctx.db.query("loans").collect(),
      ctx.db
        .query("collections")
        .withIndex("by_created", (q) =>
          q.gte("createdAt", bounds.from).lte("createdAt", bounds.to),
        )
        .collect(),
      ctx.db.query("cashHandovers").collect(),
      ctx.db.query("cashIssues").collect(),
      ctx.db.query("recoveryActivities").collect(),
      ctx.db.query("wallets").collect(),
      ctx.db
        .query("walletTransactions")
        .withIndex("by_created", (q) =>
          q.gte("createdAt", bounds.from).lte("createdAt", bounds.to),
        )
        .collect(),
      ctx.db
        .query("loanSchedules")
        .withIndex("by_due", (q) => q.lt("dueDate", now))
        .collect(),
      ctx.db.query("profiles").collect(),
      ctx.db.query("branches").collect(),
      ctx.db.query("centers").collect(),
    ]);

    // Centre filter — resolved against the centres table so only real,
    // in-scope centre IDs can ever match.
    let centerFilter: string | null = null;
    const rawCenter = args.centerCode?.trim() ?? "";
    if (rawCenter) {
      const wanted = rawCenter.toUpperCase();
      const center = centers.find((c) => c.code.toUpperCase() === wanted);
      if (!center) {
        throw new AppError(`No centre exists with ID ${rawCenter}.`);
      }
      centerFilter = center.code;
    }

    const report = buildDateReport({
      bounds,
      category: args.category ?? "ALL",
      limit: args.limit ?? 500,
      now,
      role: me.role,
      viewerId: me._id,
      viewerBranchId: me.branchId ?? null,
      branchId: branchFilter,
      staffId: staffFilter,
      centerCode: centerFilter,
      clients,
      applications,
      loans,
      schedules,
      collections,
      handovers,
      issues,
      recovery,
      wallets,
      walletTxns,
      profiles,
    });

    // Filter options the viewer is actually allowed to use.
    const inBranchScope = (b: { _id: typeof branches[number]["_id"] }) =>
      me.role === "BRANCH_MANAGER" || me.role === "FIELD_STAFF"
        ? b._id === me.branchId
        : true;
    const branchOpts = branches
      .filter(inBranchScope)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => ({ id: b._id, name: b.name, code: b.code }));
    const staffOpts = (
      me.role === "FIELD_STAFF"
        ? []
        : me.role === "BRANCH_MANAGER"
          ? profiles.filter((p) => p.branchId === me.branchId)
          : profiles
    )
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ id: p._id, name: p.name, role: p.role, branchId: p.branchId ?? null }));
    const centerOpts = centers
      .filter((c) => {
        if (me.role === "FIELD_STAFF") return c.staffId === me._id;
        if (me.role === "BRANCH_MANAGER") return c.branchId === me.branchId;
        return true;
      })
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((c) => ({ code: c.code, name: c.name, branchId: c.branchId }));

    return {
      ...report,
      filterOptions: {
        branches: branchOpts,
        staff: staffOpts,
        centers: centerOpts,
      },
    };
  },
});

/**
 * The four Excel reports behind the Reports screen — one institution-local
 * date range, four row sets:
 *
 *   1. Disbursement Report     loans disbursed inside the range
 *   2. Collection Report       successful payments inside the range
 *   3. Due Date Collection     loans with an installment due inside the range
 *   4. Overdue Report          arrears as of the To date, bucketed 1-7 / 8-15 /
 *                              16-22 days (each rupee in at most one bucket)
 *
 * All scoping is server-side: BRANCH_MANAGER is pinned to their own branch,
 * FIELD_STAFF only sees loans assigned to them, and an explicit branchId can
 * only narrow a SUPER_ADMIN / ACCOUNTANT view. Collections are counted from
 * the NORMAL rows of the collection ledger only — reversed payments and
 * their compensating entries are excluded by the row builder, so no rupee is
 * ever counted twice, and wallet transactions are never consulted.
 */
export const rangeReports = query({
  args: {
    fromDay: v.string(), // YYYY-MM-DD, institution-local (IST)
    toDay: v.string(),
    branchId: v.optional(v.id("branches")),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "reports");

    const range = resolveRange(args.fromDay, args.toDay);
    if ("error" in range) throw new AppError(range.error);
    const bounds = rangeBounds(range.fromDay, range.toDay);
    if (!bounds) throw new AppError("Invalid date range.");

    let branchFilter: string | null = args.branchId ?? null;
    if (me.role === "BRANCH_MANAGER") {
      if (branchFilter && branchFilter !== me.branchId) {
        throw new AppError("You can only report on your own branch.");
      }
      branchFilter = me.branchId ?? null;
    }
    const staffFilter: string | null = me.role === "FIELD_STAFF" ? me._id : null;

    const [loans, clients, groups, schedules, collections] = await Promise.all([
      ctx.db.query("loans").collect(),
      ctx.db.query("clients").collect(),
      ctx.db.query("groups").collect(),
      // Everything that could be due on or before the end of the To date —
      // arrears of earlier installments ride along so the Due Date and
      // Overdue rows can be computed without a second read.
      ctx.db
        .query("loanSchedules")
        .withIndex("by_due", (q) => q.lte("dueDate", bounds.to))
        .collect(),
      ctx.db
        .query("collections")
        .withIndex("by_created", (q) =>
          q.gte("createdAt", bounds.from).lte("createdAt", bounds.to),
        )
        .collect(),
    ]);

    const clientById = new Map(clients.map((c) => [c._id, c]));
    const groupByCode = new Map(groups.map((g) => [g.code, g]));
    const scopedLoans = loans.filter(
      (l) =>
        (!branchFilter || l.branchId === branchFilter) &&
        (!staffFilter || l.staffId === staffFilter),
    );
    const loanById = new Map(scopedLoans.map((l) => [l._id, l]));

    const facts = (loan: Doc<"loans">): LoanFacts => {
      const client = clientById.get(loan.clientId);
      const groupCode = client?.groupCode;
      const group = groupCode ? groupByCode.get(groupCode) : undefined;
      return {
        loanPk: loan._id,
        loanId: loan.loanId,
        clientCode: client?.code ?? "—",
        customerName: client?.name ?? "—",
        groupId: groupCode ?? "—",
        groupName: group?.name ?? groupCode ?? "—",
        disbursedAt: loan.disbursedAt,
        principal: loan.principal,
        tenure: loan.tenure,
        installment: loan.installment,
      };
    };

    const scheduleFacts: ScheduleFacts[] = [];
    for (const s of schedules) {
      const loan = loanById.get(s.loanId);
      if (!loan) continue; // outside the viewer's scope
      scheduleFacts.push({
        ...facts(loan),
        dueDate: s.dueDate,
        totalDue: s.totalDue,
        paid: s.paid,
      });
    }

    const collectionFacts: CollectionFacts[] = [];
    for (const c of collections) {
      const loan = loanById.get(c.loanId);
      if (!loan) continue;
      collectionFacts.push({
        ...facts(loan),
        collectionId: c._id,
        status: c.status,
        reversalOfId: c.reversalOfId,
        paidAt: c.createdAt,
        paidAmount: c.amount,
      });
    }

    return {
      range: { fromKey: range.fromDay, toKey: range.toDay },
      disbursement: buildDisbursementRows(scopedLoans.map(facts), bounds),
      collection: buildCollectionRows(collectionFacts, bounds),
      dueDateCollection: buildDueDateRows(scheduleFacts, bounds),
      overdue: buildOverdueRows(scheduleFacts, bounds),
    };
  },
});

/* ------------------------------ Statement -------------------------------- */

/**
 * Mask an identity number for display: every character except the last four
 * becomes `X`, regrouped in fours (1234 5678 9012 → XXXX XXXX 9012). Only the
 * SUPER_ADMIN role ever receives the unmasked value, and only from the
 * `statement` query below — never from this file's search.
 */
function maskIdValue(value?: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, "");
  if (compact.length === 0) return null;
  const tail = compact.slice(-4);
  const masked = `${"X".repeat(Math.max(0, compact.length - 4))}${tail}`;
  return masked.replace(/(\S{4})(?=\S)/g, "$1 ").trim();
}

/**
 * Statement search — resolve a Client ID / Customer ID / LAN ID / Loan ID to
 * the right client record. Exact, case-insensitive matches on the stored
 * codes only, and every exact candidate is returned so an ambiguous query
 * never silently picks someone else's record. Scoped exactly like the four
 * range reports: staff → own clients/loans, BM → own branch, admin and
 * accountant → organisation-wide.
 */
export const statementSearch = query({
  args: { q: v.string() },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "reports");

    const [allClients, allLoans] = await Promise.all([
      ctx.db.query("clients").collect(),
      ctx.db.query("loans").collect(),
    ]);

    const clients = allClients.filter((c) => {
      if (me.role === "BRANCH_MANAGER") return c.branchId === me.branchId;
      if (me.role === "FIELD_STAFF") return c.assignedTo === me._id || c.createdBy === me._id;
      if (me.role === "CLIENT") return me.clientId === c._id;
      return true;
    });
    const scopedIds = new Set(clients.map((c) => c._id));
    const loansByClient: Record<string, string[]> = {};
    for (const l of allLoans) {
      if (!scopedIds.has(l.clientId)) continue;
      if (me.role === "BRANCH_MANAGER" && l.branchId !== me.branchId) continue;
      const arr = loansByClient[l.clientId] ?? [];
      arr.push(l.loanId);
      loansByClient[l.clientId] = arr;
    }

    const matches = resolveClientMatches(clients, loansByClient, args.q);
    return {
      query: args.q.trim(),
      matches: matches.map((m) => ({
        clientId: m.clientId as string,
        code: m.code,
        name: m.name,
        mobileMasked: maskIdValue(m.mobile),
        loanIds: m.loanIds,
        matchedOn: m.matchedOn,
      })),
    };
  },
});

/**
 * Complete client statement — client details, loan details, next due date
 * and the chronological ledger — built from the same stored ledgers the
 * four range reports use. Backend-enforced role/branch scoping; identity
 * numbers are masked unless the viewer is a SUPER_ADMIN. If `loanDbId` is
 * omitted the combined statement across ALL of the client's loans is
 * returned; if given it must belong to this client or the query refuses.
 */
export const statement = query({
  args: {
    clientId: v.id("clients"),
    loanDbId: v.optional(v.id("loans")),
    fromDay: v.optional(v.string()), // YYYY-MM-DD, institution-local (IST)
    toDay: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "reports");

    const client = await ctx.db.get(args.clientId);
    if (!client) throw new AppError("Client not found.");
    // Role/branch scope — the same rule the range reports apply.
    const allowed =
      me.role === "SUPER_ADMIN" ||
      me.role === "ACCOUNTANT" ||
      (me.role === "BRANCH_MANAGER" && client.branchId === me.branchId) ||
      (me.role === "FIELD_STAFF" &&
        (client.assignedTo === me._id || client.createdBy === me._id)) ||
      (me.role === "CLIENT" && me.clientId === client._id);
    if (!allowed) throw new AppError("This client is outside your access.");

    // Period filter — full history when omitted, IST day bounds otherwise.
    let filters: { fromMs: number; toMs: number } | null = null;
    if (args.fromDay != null || args.toDay != null) {
      if (args.fromDay == null || args.toDay == null) {
        throw new AppError("Pick both From and To dates, or neither for full history.");
      }
      const range = resolveRange(args.fromDay, args.toDay);
      if ("error" in range) throw new AppError(range.error);
      const bounds = rangeBounds(range.fromDay, range.toDay);
      if (!bounds) throw new AppError("Invalid date range.");
      filters = { fromMs: bounds.from, toMs: bounds.to };
    }

    /* --------------------------- Loan documents -------------------------- */
    let loans = (await ctx.db.query("loans").withIndex("by_client", (q) =>
      q.eq("clientId", client._id),
    ).collect()).filter(
      (l) => me.role !== "BRANCH_MANAGER" || l.branchId === me.branchId,
    );
    if (args.loanDbId) {
      const picked = loans.find((l) => l._id === args.loanDbId);
      if (!picked) throw new AppError("That loan does not belong to this client.");
      loans = [picked];
    }
    loans = [...loans].sort((a, b) => a.createdAt - b.createdAt);

    const statementLoans: StatementLoan[] = [];
    const loanViews: ReturnType<typeof deriveLoanView>[] = [];
    const loanProducts: ({ name: string } | null)[] = [];
    const now = Date.now();
    for (const loan of loans) {
      const [schedule, collections, receipts, application, product] =
        await Promise.all([
          ctx.db
            .query("loanSchedules")
            .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
            .collect(),
          ctx.db
            .query("collections")
            .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
            .collect(),
          ctx.db
            .query("receipts")
            .withIndex("by_client", (q) => q.eq("clientId", client._id))
            .collect(),
          loan.applicationId ? ctx.db.get(loan.applicationId) : null,
          ctx.db.get(loan.productId),
        ]);
      statementLoans.push({
        ...loan,
        schedule: schedule
          .sort((a, b) => a.index - b.index)
          .map((r) => ({
            _id: r._id,
            index: r.index,
            dueDate: r.dueDate,
            principal: r.principal,
            interest: r.interest,
            totalDue: r.totalDue,
            paid: r.paid,
          })),
        collections: collections.map((c) => ({
          _id: c._id,
          code: c.code,
          createdAt: c.createdAt,
          amount: c.amount,
          principalPortion: c.principalPortion,
          interestPortion: c.interestPortion,
          mode: c.mode,
          status: c.status,
          reversalOfId: c.reversalOfId,
          receiptNumber: c.receiptNumber,
          staffId: c.staffId,
          remarks: c.remarks,
        })),
        receipts: receipts
          .filter((r) => r.loanId === loan._id)
          .map((r) => ({
            _id: r._id,
            collectionId: r.collectionId,
            number: r.number,
            amount: r.amount,
            createdAt: r.createdAt,
            outstandingAfter: r.outstandingAfter,
          })),
        requestedAmount: application?.amount,
        // Loan purpose lives on the client's joining-form application.
        purpose: client.loanRequest?.purpose
          ? (loanPurposeLabel(client.loanRequest.purpose) ?? undefined)
          : undefined,
      });
      loanViews.push(deriveLoanView(loan, schedule, now));
      loanProducts.push(product ? { name: product.name } : null);
    }

    const statementFilter = filters
      ? { fromMs: filters.fromMs, toMs: filters.toMs }
      : {};
    const combined =
      statementLoans.length > 1
        ? buildCombinedStatement(statementLoans, statementFilter, now)
        : null;
    const perLoan = statementLoans.map((l) =>
      buildLoanStatement(l, statementFilter, now),
    );

    /* ------------------------- Joined display facts ----------------------- */
    const [centers, groups, branch, profiles] = await Promise.all([
      ctx.db.query("centers").collect(),
      ctx.db.query("groups").collect(),
      ctx.db.get(client.branchId),
      ctx.db.query("profiles").collect(),
    ]);
    const profileById = new Map(profiles.map((p) => [p._id, p]));
    const center = client.centerId
      ? centers.find((c) => c._id === client.centerId)
      : centers.find((c) => c.code === client.centerCode);
    const group = client.groupCode
      ? groups.find((g) => g.code === client.groupCode)
      : undefined;
    // Client photo — the applicant's own geo-tagged capture (never the
    // co-applicant's), served from private storage via a signed URL.
    const geoPhotos = await ctx.db
      .query("clientGeoPhotos")
      .withIndex("by_client", (q) => q.eq("clientId", client._id))
      .collect();
    const ownPhoto = geoPhotos
      .filter((p) => !p.coApplicant)
      .sort((a, b) => b.uploadedAt - a.uploadedAt)[0];
    const photoUrl = ownPhoto
      ? await ctx.storage.getUrl(ownPhoto.storageId)
      : null;

    // Identity numbers: masked for everyone; full values for SUPER_ADMIN.
    const revealAllowed = me.role === "SUPER_ADMIN";
    const aadhaar =
      client.kycDocType === "AADHAAR" ||
      client.kycDocuments?.includes("AADHAAR")
        ? (client.kycDocRef ?? null)
        : null;
    const pan = client.panNumber ?? null;
    const voter = client.voterId ?? null;

    return {
      generatedAt: now,
      period:
        filters != null
          ? { fromKey: istDateKey(filters.fromMs), toKey: istDateKey(filters.toMs) }
          : null,
      revealAllowed,
      client: {
        _id: client._id,
        code: client.code,
        name: client.name,
        mobileMasked: maskIdValue(client.mobile),
        age: client.age,
        gender: client.gender,
        address: client.address ?? null,
        village: client.village ?? null,
        district: client.district ?? null,
        state: client.state ?? null,
        pin: client.pin ?? null,
        maternalHomeAddress: client.maternalHomeAddress ?? null,
        husbandName: client.husbandName ?? client.fatherName ?? null,
        fatherName: client.applicantFatherName ?? null,
        occupation: client.occupation ?? null,
        monthlyIncome: client.monthlyIncome,
        householdIncome: client.householdIncome,
        kycStatus: client.kycStatus,
        kycDocType: client.kycDocType ?? null,
        aadhaarMasked: maskIdValue(aadhaar),
        aadhaar: revealAllowed ? aadhaar : null,
        panMasked: maskIdValue(pan),
        pan: revealAllowed ? pan : null,
        voterMasked: maskIdValue(voter),
        voter: revealAllowed ? voter : null,
        photoUrl,
        center: center
          ? { code: center.code, name: center.name }
          : client.centerCode
            ? { code: client.centerCode, name: null }
            : null,
        group: group ? { code: group.code, name: group.name } : null,
        branch: branch ? { code: branch.code, name: branch.name } : null,
        createdAt: client.createdAt,
        registeredBy: profileById.get(client.createdBy)
          ? {
              name: profileById.get(client.createdBy)!.name,
              role: profileById.get(client.createdBy)!.role,
              profileId: client.createdBy,
            }
          : null,
        assignedOfficer: profileById.get(client.assignedTo)
          ? { name: profileById.get(client.assignedTo)!.name, profileId: client.assignedTo }
          : null,
      },
      loans: statementLoans.map((l, i) => {
        const rep = perLoan[i].repayment;
        const sum = perLoan[i].summary;
        const view = loanViews[i];
        const principalPaid = round2Sum(
          l.collections
            .filter((c) => c.status === "NORMAL" && !c.reversalOfId)
            .map((c) => c.principalPortion),
        );
        return {
          _id: l._id,
          loanId: l.loanId,
          status: l.status,
          displayStatus: view.displayStatus,
          product: loanProducts[i],
          requestedAmount: l.requestedAmount ?? null,
          sanctionedAmount: l.principal,
          charges: l.charges,
          disbursedAmount: l.disbursedAt != null ? l.principal : null,
          disbursedAt: l.disbursedAt ?? null,
          approvedAt: l.approvedAt ?? null,
          appliedAt: l.createdAt,
          tenure: l.tenure,
          frequency: l.frequency,
          installment: l.installment,
          interestRate: l.interestRate,
          interestMethod: l.interestMethod,
          purpose: l.purpose ?? null,
          firstInstallmentDate: l.schedule[0]?.dueDate ?? null,
          lastInstallmentDate: l.schedule[l.schedule.length - 1]?.dueDate ?? null,
          totalPayable: round2Sum(l.schedule.map((r) => r.totalDue)),
          totalPaid: sum.lifetimePaid,
          outstandingPrincipal: round2Sum(
            l.schedule.map((r) => r.principal),
          ) - principalPaid,
          outstanding: rep.outstanding,
          nextDueDate: rep.nextDueDate,
          overdueAmount: rep.totalOverdueAmount,
        };
      }),
      selected: combined ?? {
        loanId: perLoan[0]?.loanId ?? null,
        ledger: perLoan[0]?.ledger ?? [],
        summary: perLoan[0]?.summary ?? null,
        repayment: perLoan[0]?.repayment ?? null,
      },
      combinedAvailable: combined != null,
      staffNames: Object.fromEntries(
        profiles.map((p) => [p._id, p.name]),
      ),
    };
  },
});

/** Sum a list of numbers, rounded to paise. */
function round2Sum(values: number[]): number {
  return Math.round((values.reduce((s, n) => s + n, 0) + Number.EPSILON) * 100) / 100;
}
