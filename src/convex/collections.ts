import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  AppError,
  istDateKey,
  requirePermission,
  requireProfile,
} from "../lib/server/convexHelpers";
import { recordCollection, reverseCollection } from "../lib/server/loanOps";
import { money, oneOf, optionalString, requiredString } from "../lib/finance/validate";
import { PAY_MODES } from "../lib/finance/types";
import { matchCollectionSearch, MatchCollectionSearchInput, overdueDays, round2 } from "../lib/finance/excelReports";
import { rowOutstanding } from "../lib/finance/schedule";

/**
 * Today's collection board for a field staff member (or branch-wide for BM).
 * All numbers are derived from schedules + collections — nothing is stored.
 */
export const today = query({
  args: { profileId: v.optional(v.id("profiles")) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "collect_payment");
    const now = Date.now();
    const todayKey = istDateKey(now);
    const yesterdayKey = istDateKey(now - 86_400_000);

    const targetId =
      me.role === "FIELD_STAFF" ? me._id : (args.profileId ?? null);

    // Loans in scope for this view.
    let loans: Doc<"loans">[] = await ctx.db.query("loans").collect();
    if (me.role === "FIELD_STAFF") loans = loans.filter((l) => l.staffId === me._id);
    else if (me.role === "BRANCH_MANAGER") {
      loans = loans.filter((l) => l.branchId === me.branchId);
      if (targetId) loans = loans.filter((l) => l.staffId === targetId);
    } else if (me.role === "CLIENT") {
      loans = me.clientId ? loans.filter((l) => l.clientId === me.clientId) : [];
    }
    loans = loans.filter((l) => ["ACTIVE", "OVERDUE", "DISBURSED"].includes(l.status));

    const rows = await ctx.db.query("loanSchedules").collect();
    const openRows = rows.filter((r) => rowOutstanding(r) > 0);
    const loansById = new Map(loans.map((l) => [l._id, l]));
    const scopedRows = openRows.filter((r) => loansById.has(r.loanId));

    const clients = await ctx.db.query("clients").collect();
    const clientById = new Map(clients.map((c) => [c._id, c]));

    const collections = (await ctx.db.query("collections").collect()).filter(
      (c) => c.status === "NORMAL" && loans.some((l) => l._id === c.loanId),
    );
    const todayCollections = collections.filter(
      (c) => istDateKey(c.createdAt) === todayKey,
    );

    // Group open rows by client.
    const byClient = new Map<
      Id<"clients">,
      { dueToday: number; overdue: number; overdueDays: number; nextDue: number | null }
    >();
    for (const row of scopedRows) {
      const loan = loansById.get(row.loanId)!;
      const entry = byClient.get(loan.clientId) ?? {
        dueToday: 0,
        overdue: 0,
        overdueDays: 0,
        nextDue: null,
      };
      const remaining = rowOutstanding(row);
      const key = istDateKey(row.dueDate);
      if (key === todayKey || key === yesterdayKey) entry.dueToday += remaining;
      if (row.dueDate < now) {
        entry.overdue += remaining;
        entry.overdueDays = Math.max(
          entry.overdueDays,
          Math.floor((now - row.dueDate) / 86_400_000),
        );
      }
      entry.nextDue = entry.nextDue === null ? row.dueDate : Math.min(entry.nextDue, row.dueDate);
      byClient.set(loan.clientId, entry);
    }

    const dueList = [...byClient.entries()]
      .map(([clientId, stat]) => {
        const client = clientById.get(clientId)!;
        const collectedToday = todayCollections
          .filter((c) => c.clientId === clientId)
          .reduce((s, c) => s + c.amount, 0);
        return {
          clientId,
          code: client.code,
          name: client.name,
          village: client.village,
          mobile: client.mobile,
          kycStatus: client.kycStatus,
          ...stat,
          dueToday: Math.round(stat.dueToday * 100) / 100,
          overdue: Math.round(stat.overdue * 100) / 100,
          collectedToday: Math.round(collectedToday * 100) / 100,
        };
      })
      .filter((c) => c.dueToday > 0 || c.overdue > 0)
      .sort((a, b) => b.overdue - a.overdue || b.dueToday - a.dueToday);

    const expected = Math.round(dueList.reduce((s, c) => s + c.dueToday, 0) * 100) / 100;
    const collected = Math.round(
      todayCollections.reduce((s, c) => s + c.amount, 0) * 100,
    ) / 100;

    return {
      dateKey: todayKey,
      summary: {
        expected,
        collected,
        pending: Math.max(0, Math.round((expected - collected) * 100) / 100),
        dueClients: dueList.filter((c) => c.dueToday > 0).length,
        overdueClients: dueList.filter((c) => c.overdue > 0).length,
        overdueAmount: Math.round(dueList.reduce((s, c) => s + c.overdue, 0) * 100) / 100,
        cashCollected: Math.round(
          todayCollections.filter((c) => c.mode === "CASH").reduce((s, c) => s + c.amount, 0) * 100,
        ) / 100,
        upiCollected: Math.round(
          todayCollections.filter((c) => c.mode === "UPI").reduce((s, c) => s + c.amount, 0) * 100,
        ) / 100,
        bankCollected: Math.round(
          todayCollections.filter((c) => c.mode === "BANK").reduce((s, c) => s + c.amount, 0) * 100,
        ) / 100,
        disbursementToday: loans
          .filter((l) => l.disbursedAt && istDateKey(l.disbursedAt) === todayKey)
          .reduce((s, l) => s + l.principal, 0),
      },
      due: dueList,
      collectedToday: todayCollections
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((c) => ({
          ...c,
          clientName: clientById.get(c.clientId)?.name ?? "—",
        })),
    };
  },
});

/** Capture a payment — server-validated, idempotent, ledger-first. */
export const collect = mutation({
  args: {
    loanId: v.id("loans"),
    amount: v.number(),
    mode: v.string(),
    remarks: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    location: v.optional(v.string()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "collect_payment");
    const mode = oneOf(args.mode, PAY_MODES, "mode");
    const amount = money(args.amount, "amount");

    const result = await recordCollection(ctx, {
      loanId: args.loanId,
      actor: me,
      amount,
      mode,
      remarks: optionalString(args.remarks, "remarks", 300),
      idempotencyKey: args.idempotencyKey,
      location: optionalString(args.location, "location", 120),
      device: args.device,
    });

    return { ok: true, ...result };
  },
});

/** Correction path — never a delete: appends a compensating reversal. */
export const reverse = mutation({
  args: { collectionId: v.id("collections"), reason: v.string() },
  handler: async (ctx, { collectionId, reason }) => {
    const me = await requireProfile(ctx);
    const why = requiredString(reason, "reason", 300);
    const result = await reverseCollection(ctx, {
      collectionId,
      actor: me,
      reason: why,
    });
    return { ok: true, ...result };
  },
});

export const list = query({
  args: {
    clientId: v.optional(v.id("clients")),
    loanId: v.optional(v.id("loans")),
    staffId: v.optional(v.id("profiles")),
    dateFrom: v.optional(v.number()),
    dateTo: v.optional(v.number()),
    mode: v.optional(v.string()),
    includeReversals: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "view_loans");

    let rows: Doc<"collections">[] = await ctx.db.query("collections").collect();
    if (me.role === "FIELD_STAFF") {
      rows = rows.filter((r) => r.staffId === me._id || r.clientId === me.clientId);
    } else if (me.role === "BRANCH_MANAGER") {
      rows = rows.filter((r) => r.branchId === me.branchId);
    } else if (me.role === "CLIENT") {
      rows = me.clientId ? rows.filter((r) => r.clientId === me.clientId) : [];
    }
    if (args.staffId) rows = rows.filter((r) => r.staffId === args.staffId);
    if (args.clientId) rows = rows.filter((r) => r.clientId === args.clientId);
    if (args.loanId) rows = rows.filter((r) => r.loanId === args.loanId);
    if (args.mode) rows = rows.filter((r) => r.mode === args.mode);
    if (args.dateFrom) rows = rows.filter((r) => r.createdAt >= args.dateFrom!);
    if (args.dateTo) rows = rows.filter((r) => r.createdAt <= args.dateTo! + 86_399_999);
    if (!args.includeReversals) {
      rows = rows.filter((r) => r.status !== "REVERSAL");
    }
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (args.limit) rows = rows.slice(0, args.limit);

    const [clients, loans, profiles] = await Promise.all([
      ctx.db.query("clients").collect(),
      ctx.db.query("loans").collect(),
      ctx.db.query("profiles").collect(),
    ]);
    const clientById = new Map(clients.map((c) => [c._id, c]));
    const loanById = new Map(loans.map((l) => [l._id, l]));
    const profileById = new Map(profiles.map((p) => [p._id, p]));

    return rows.map((r) => ({
      ...r,
      clientName: clientById.get(r.clientId)?.name ?? "—",
      clientCode: clientById.get(r.clientId)?.code ?? "—",
      loanId: loanById.get(r.loanId)?.loanId ?? "—",
      staffName: profileById.get(r.staffId)?.name ?? "—",
    }));
  },
});

export const receipt = query({
  args: { number: v.string() },
  handler: async (ctx, { number }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const receiptDoc = await ctx.db
      .query("receipts")
      .withIndex("by_number", (q) => q.eq("number", number))
      .unique();
    if (!receiptDoc) throw new AppError("Receipt not found.");

    const allowed =
      me.role === "SUPER_ADMIN" ||
      me.role === "ACCOUNTANT" ||
      receiptDoc.staffId === me._id ||
      receiptDoc.clientId === me.clientId ||
      (me.role === "BRANCH_MANAGER" && receiptDoc.branchId === me.branchId) ||
      (me.role === "FIELD_STAFF" && receiptDoc.branchId === me.branchId);
    if (!allowed) throw new AppError("Receipt is outside your access.");

    const [client, loan, staff, branch, collection] = await Promise.all([
      ctx.db.get(receiptDoc.clientId),
      ctx.db.get(receiptDoc.loanId),
      ctx.db.get(receiptDoc.staffId),
      ctx.db.get(receiptDoc.branchId),
      ctx.db.get(receiptDoc.collectionId),
    ]);
    const rows = (
      await ctx.db
        .query("loanSchedules")
        .withIndex("by_loan", (q) => q.eq("loanId", receiptDoc.loanId))
        .collect()
    ).sort((a, b) => a.index - b.index);
    const overdueAmount = rows
      .filter((r) => rowOutstanding(r) > 0 && r.dueDate < Date.now())
      .reduce((s, r) => s + rowOutstanding(r), 0);

    return {
      receipt: receiptDoc,
      collection,
      client,
      loan,
      staff,
      branch,
      nextDue: rows.find((r) => rowOutstanding(r) > 0) ?? null,
      overdueAmount: Math.round(overdueAmount * 100) / 100,
    };
  },
});

export const receipts = query({
  args: {
    clientId: v.optional(v.id("clients")),
    staffId: v.optional(v.id("profiles")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    let rows = await ctx.db.query("receipts").collect();
    if (me.role === "FIELD_STAFF") rows = rows.filter((r) => r.staffId === me._id);
    else if (me.role === "BRANCH_MANAGER") rows = rows.filter((r) => r.branchId === me.branchId);
    else if (me.role === "CLIENT")
      rows = me.clientId ? rows.filter((r) => r.clientId === me.clientId) : [];
    if (args.clientId) rows = rows.filter((r) => r.clientId === args.clientId);
    if (args.staffId) rows = rows.filter((r) => r.staffId === args.staffId);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (args.limit) rows = rows.slice(0, args.limit);

    const [clients, collections] = await Promise.all([
      ctx.db.query("clients").collect(),
      ctx.db.query("collections").collect(),
    ]);
    const clientById = new Map(clients.map((c) => [c._id, c]));
    const collectionById = new Map(collections.map((c) => [c._id, c]));

    return rows.map((r) => ({
      ...r,
      clientName: clientById.get(r.clientId)?.name ?? "—",
      status: collectionById.get(r.collectionId)?.status ?? "NORMAL",
    }));
  },
});

/**
 * Collection screen — open loans with money due as of today (IST), one row
 * per loan:
 *
 *   arrear   = unpaid remainder of installments overdue as of today
 *   totalDue = unpaid remainder of everything due on or before today
 *              (arrear ⊆ totalDue — never double counted)
 *
 * Searchable by group name, group ID and LAN (loan account number). Saving a
 * payment does NOT happen here — the screen posts through `collections.collect`,
 * which owns validation, idempotency (duplicate prevention), the wallet
 * ledger, receipts, the journal entry and the schedule/loan roll-forward.
 */
export const dueList = query({
  args: {
    q: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { q, limit }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "collect_payment");

    const now = Date.now();
    const [loans, schedules, clients, groups] = await Promise.all([
      ctx.db.query("loans").collect(),
      ctx.db
        .query("loanSchedules")
        .withIndex("by_due", (r) => r.lte("dueDate", now))
        .collect(),
      ctx.db.query("clients").collect(),
      ctx.db.query("groups").collect(),
    ]);

    // Same scope rules as every money screen: staff see their own book,
    // branch managers their branch, admins the whole book. Payments are only
    // ever posted against loans the backend itself re-checks.
    const openStatuses = ["ACTIVE", "OVERDUE", "DISBURSED"];
    const scopedLoans = loans.filter(
      (l) =>
        openStatuses.includes(l.status) &&
        (me.role === "FIELD_STAFF"
          ? l.staffId === me._id
          : me.role === "BRANCH_MANAGER"
            ? l.branchId === me.branchId
            : true),
    );

    const schedulesByLoan = new Map<string, typeof schedules>();
    for (const s of schedules) {
      const list = schedulesByLoan.get(s.loanId);
      if (list) list.push(s);
      else schedulesByLoan.set(s.loanId, [s]);
    }
    const clientById = new Map(clients.map((c) => [c._id, c]));
    const groupByCode = new Map(groups.map((g) => [g.code, g]));

    const rows: {
      loanPk: string;
      loanId: string;
      clientCode: string;
      customerName: string;
      groupId: string;
      groupName: string;
      arrear: number;
      totalDue: number;
    }[] = [];
    for (const loan of scopedLoans) {
      let arrear = 0;
      let totalDue = 0;
      for (const s of schedulesByLoan.get(loan._id) ?? []) {
        const rem = rowOutstanding(s);
        if (rem <= 0) continue;
        if (s.dueDate <= now) totalDue += rem;
        if (overdueDays(s.dueDate, now) >= 1) arrear += rem;
      }
      arrear = round2(arrear);
      totalDue = round2(totalDue);
      if (totalDue <= 0) continue; // nothing to collect against today
      const client = clientById.get(loan.clientId);
      const groupCode = client?.groupCode;
      const group = groupCode ? groupByCode.get(groupCode) : undefined;
      rows.push({
        loanPk: loan._id,
        loanId: loan.loanId,
        clientCode: client?.code ?? "—",
        customerName: client?.name ?? "—",
        groupId: groupCode ?? "—",
        groupName: group?.name ?? "",
        arrear,
        totalDue,
      });
    }

    // Search with group name / group ID / LAN ID — case-insensitive.
    const sorted = [...rows].sort(
      (a, b) =>
        b.arrear - a.arrear || b.totalDue - a.totalDue || a.loanId.localeCompare(b.loanId),
    );
    return matchCollectionSearch(sorted, q).slice(0, limit ?? 200);
  },
});
