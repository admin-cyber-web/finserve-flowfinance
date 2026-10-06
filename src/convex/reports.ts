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
