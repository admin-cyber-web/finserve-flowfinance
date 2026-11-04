import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  AppError,
  istDateKey,
  logAudit,
  notify,
  requirePermission,
  requireProfile,
  requireRole,
  writeJournal,
  writeWalletTx,
} from "../lib/server/convexHelpers";
import {
  expenseEntry,
  handoverEntry,
  issueEntry,
} from "../lib/finance/journal";
import { evaluateClosing } from "../lib/finance/cash";
import { fmtId } from "../lib/utils";
import { money, requiredString, optionalString, oneOf } from "../lib/finance/validate";

const DAY = 86_400_000;

/** Today's cash components — derived entirely from the wallet ledger. */
export const dayBook = query({
  args: { profileId: v.optional(v.id("profiles")), dateKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "cash_handover");
    const now = Date.now();
    const dateKey = args.dateKey ?? istDateKey(now);

    const targetId = me.role === "FIELD_STAFF" ? me._id : (args.profileId ?? null);
    const wallets = await ctx.db.query("wallets").collect();
    const profiles = await ctx.db.query("profiles").collect();
    const profileById = new Map(profiles.map((p) => [p._id, p]));

    const inScope = wallets.filter((w) => {
      if (me.role === "SUPER_ADMIN" || me.role === "ACCOUNTANT") return true;
      if (me.role === "BRANCH_MANAGER") return w.branchId === me.branchId;
      return w.profileId === me._id;
    });

    const targetWallet = targetId
      ? inScope.find((w) => w.profileId === targetId)
      : inScope.length === 1
        ? inScope[0]
        : null;

    if (!targetWallet) {
      return {
        dateKey,
        wallets: inScope.map((w) => ({
          walletId: w._id,
          profileId: w.profileId,
          staffName: profileById.get(w.profileId)?.name ?? "—",
        })),
        day: null,
        closings: [],
      };
    }

    const txns = await ctx.db
      .query("walletTransactions")
      .withIndex("by_wallet", (q) => q.eq("walletId", targetWallet._id))
      .collect();

    const balance = txns.reduce((s, t) => {
      if (t.direction === "CREDIT") return s + t.amount;
      if (t.direction === "DEBIT") return s - t.amount;
      return s;
    }, 0);

    const onDate = txns.filter((t) => istDateKey(t.createdAt) === dateKey);
    const sumOf = (types: string[]) =>
      Math.round(
        onDate
          .filter((t) => types.includes(t.type))
          .reduce((s, t) => s + t.amount, 0) * 100,
      ) / 100;

    const cashReceived = sumOf(["CASH_ISSUE"]);
    const cashCollections = sumOf(["CASH_COLLECTION"]);
    const disbursement = sumOf(["LOAN_DISBURSEMENT"]);
    const handover = sumOf(["CASH_HANDOVER"]);
    const expenses = sumOf(["EXPENSE"]);
    const adjustments = Math.round(
      onDate
        .filter((t) => t.type === "APPROVED_ADJUSTMENT" || t.type === "REVERSAL")
        .reduce(
          (s, t) =>
            s + (t.direction === "CREDIT" ? t.amount : t.direction === "DEBIT" ? -t.amount : 0),
          0,
        ) * 100,
    ) / 100;

    const netToday =
      cashReceived + cashCollections - disbursement - handover - expenses + adjustments;
    const opening = Math.round((balance - netToday) * 100) / 100;

    const evaluation = evaluateClosing(
      { opening, cashReceived, cashCollections, disbursement, handover, expenses },
      balance,
    );

    const closings = (await ctx.db.query("cashClosings").collect())
      .filter((c) => c.profileId === targetWallet.profileId)
      .sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));

    return {
      dateKey,
      wallets: inScope.map((w) => ({
        walletId: w._id,
        profileId: w.profileId,
        staffName: profileById.get(w.profileId)?.name ?? "—",
      })),
      day: {
        walletId: targetWallet._id,
        profileId: targetWallet.profileId,
        staffName: profileById.get(targetWallet.profileId)?.name ?? "—",
        walletLimit: targetWallet.walletLimit,
        opening,
        cashReceived,
        cashCollections,
        disbursement,
        handover,
        expenses,
        adjustments,
        expected: evaluation.expected,
        balance,
        todayTxns: onDate.sort((a, b) => b.createdAt - a.createdAt),
      },
      closings,
    };
  },
});

/* ------------------------- Branch counter cash ---------------------------- */

/**
 * Chart-of-accounts codes used by the branch cash view.
 *
 *   1010 — Cash in Hand, Field Staff
 *   1015 — Cash in Hand, Branch / BM   ← the branch counter
 *   1020 — Bank Account
 *
 * Every figure below is a read of the immutable double-entry journal. Nothing
 * is stored, nothing is editable and no amount is ever assumed: each 1015
 * rupee is counted once, in exactly one bucket (in: handovers / other,
 * out: issues / expenses / bank deposits / other), so the same money can
 * never be counted twice.
 */
const STAFF_CASH_CODE = "1010";
const COUNTER_CASH_CODE = "1015";
const BANK_CODE = "1020";

type JournalDoc = Doc<"journalEntries">;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Debit or credit amount for one account code inside an entry. */
function amountOn(entry: JournalDoc, code: string, side: "debit" | "credit"): number {
  return entry.lines
    .filter((l) => l.code === code)
    .reduce((s, l) => s + l[side], 0);
}

interface CashWindow {
  /** Counter cash at the start of the window. */
  opening: number;
  /** Everything that came into the counter during the window. */
  received: number;
  /** Part of `received` that arrived as accepted staff handovers. */
  handoversIn: number;
  /** Part of `received` from any other authorised counter entry. */
  otherIn: number;
  /** Counter cash issued to field staff wallets. */
  issuedToStaff: number;
  /** Approved expenses paid from the counter. */
  expenses: number;
  /** Counter cash transferred out to the bank. */
  bankDeposits: number;
  /** Any other authorised counter outflow. */
  otherOut: number;
  netChange: number;
  /** Counter cash at the end of the window (matches the ledger). */
  closing: number;
  /** Cash actually paid out to clients (all funding sources). */
  disbursedToClients: number;
  disbursementCount: number;
  /** Cash repayments received from clients (UPI/bank excluded). */
  cashCollections: number;
  cashCollectionCount: number;
  /** opening + buckets must equal closing — false means a ledger anomaly. */
  reconciled: boolean;
}

function emptyWindow(opening: number): CashWindow {
  return {
    opening,
    received: 0,
    handoversIn: 0,
    otherIn: 0,
    issuedToStaff: 0,
    expenses: 0,
    bankDeposits: 0,
    otherOut: 0,
    netChange: 0,
    closing: opening,
    disbursedToClients: 0,
    disbursementCount: 0,
    cashCollections: 0,
    cashCollectionCount: 0,
    reconciled: true,
  };
}

/** Adds one journal entry to a window — each line lands in one bucket only. */
function applyEntry(window: CashWindow, entry: JournalDoc): void {
  const counterIn = amountOn(entry, COUNTER_CASH_CODE, "debit");
  const counterOut = amountOn(entry, COUNTER_CASH_CODE, "credit");

  if (counterIn > 0) {
    window.received += counterIn;
    if (entry.refType === "CASH_HANDOVER") window.handoversIn += counterIn;
    else window.otherIn += counterIn;
  }

  if (counterOut > 0) {
    const toBank = amountOn(entry, BANK_CODE, "debit");
    if (entry.refType === "CASH_ISSUE") window.issuedToStaff += counterOut;
    else if (entry.refType === "EXPENSE") window.expenses += counterOut;
    else if (toBank > 0 || /BANK/i.test(entry.refType)) window.bankDeposits += counterOut;
    else window.otherOut += counterOut;
  }

  // Disbursal: cash (staff wallet / counter) or bank leaves the branch and the
  // client receives it. The receivable debit is NOT the cash that moved when a
  // processing fee was deducted, so the paid-out cash legs are used instead.
  if (entry.refType === "DISBURSEMENT") {
    const paidOut =
      amountOn(entry, STAFF_CASH_CODE, "credit") +
      counterOut +
      amountOn(entry, BANK_CODE, "credit");
    if (paidOut > 0) {
      window.disbursedToClients += paidOut;
      window.disbursementCount += 1;
    }
  }

  // Cash repayment only — UPI/bank collections settle into the bank account
  // and must never be reported as counter cash.
  if (entry.refType === "COLLECTION") {
    const cashIn = amountOn(entry, STAFF_CASH_CODE, "debit") + counterIn;
    if (cashIn > 0) {
      window.cashCollections += cashIn;
      window.cashCollectionCount += 1;
    }
  }
}

function finaliseWindow(window: CashWindow, closing: number, opening: number): CashWindow {
  const netChange = r2(closing - opening);
  const out = r2(
    window.issuedToStaff +
      window.expenses +
      window.bankDeposits +
      window.otherOut,
  );
  const fromBuckets = r2(window.received - out);
  return {
    ...window,
    opening: r2(opening),
    received: r2(window.received),
    handoversIn: r2(window.handoversIn),
    otherIn: r2(window.otherIn),
    issuedToStaff: r2(window.issuedToStaff),
    expenses: r2(window.expenses),
    bankDeposits: r2(window.bankDeposits),
    otherOut: r2(window.otherOut),
    netChange,
    closing: r2(closing),
    disbursedToClients: r2(window.disbursedToClients),
    cashCollections: r2(window.cashCollections),
    reconciled: Math.abs(netChange - fromBuckets) < 0.005,
  };
}

interface BranchCashRow {
  branchId: string | null;
  code: string;
  name: string;
  counter: number;
  staffCash: number;
  bank: number;
  totalCash: number;
  today: CashWindow;
  month: CashWindow;
  entries: number;
}

/**
 * Branch counter cash, straight from the journal ledger.
 *
 * Scope is enforced server-side: a Branch Manager only ever receives their own
 * branch; SUPER_ADMIN / ACCOUNTANT receive every authorised branch plus a
 * per-branch breakdown. Nothing is derived from handover rows, wallet limits
 * or any stored balance — only posted journal entries.
 */
export const branchCash = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    if (!["SUPER_ADMIN", "BRANCH_MANAGER", "ACCOUNTANT"].includes(me.role)) {
      throw new AppError("Branch cash is only visible to branch and finance managers.");
    }

    const now = Date.now();
    const todayKey = istDateKey(now);
    const monthStartKey = `${todayKey.slice(0, 7)}-01`;

    const allBranches = await ctx.db.query("branches").collect();
    const orgWide = me.role === "SUPER_ADMIN" || me.role === "ACCOUNTANT";
    const visibleBranches = orgWide
      ? allBranches
      : allBranches.filter((b) => b._id === me.branchId);

    if (!orgWide && visibleBranches.length === 0) {
      return {
        generatedAt: now,
        todayKey,
        monthKey: todayKey.slice(0, 7),
        orgWide: false,
        branches: [],
        totals: emptyBranchRow(null, "No branch linked"),
        entryCount: 0,
      };
    }

    const visibleIds = new Set(visibleBranches.map((b) => b._id));
    const entries = (await ctx.db.query("journalEntries").collect())
      .filter((e) => e.createdAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt);
    const scoped = entries.filter((e) => e.branchId && visibleIds.has(e.branchId));
    const unassigned = orgWide ? entries.filter((e) => !e.branchId) : [];

    const rows: BranchCashRow[] = visibleBranches.map((branch) =>
      buildBranchRow(
        branch._id,
        branch.code,
        branch.name,
        scoped.filter((e) => e.branchId === branch._id),
        todayKey,
        monthStartKey,
      ),
    );

    if (unassigned.length > 0) {
      rows.push(
        buildBranchRow(null, "—", "Unassigned ledger entries", unassigned, todayKey, monthStartKey),
      );
    }

    rows.sort((a, b) => a.name.localeCompare(b.name));

    const totals = rows.reduce(
      (acc, row) => mergeRows(acc, row),
      emptyBranchRow(null, orgWide ? "All branches" : (rows[0]?.name ?? "—")),
    );

    return {
      generatedAt: now,
      todayKey,
      monthKey: todayKey.slice(0, 7),
      orgWide,
      branches: rows.map((row) => ({ ...row, isAggregate: false })),
      totals: { ...totals, isAggregate: true },
      entryCount: scoped.length + unassigned.length,
    };
  },
});

function emptyBranchRow(branchId: Id<"branches"> | null, name: string): BranchCashRow {
  return {
    branchId,
    code: "—",
    name,
    counter: 0,
    staffCash: 0,
    bank: 0,
    totalCash: 0,
    today: emptyWindow(0),
    month: emptyWindow(0),
    entries: 0,
  };
}

/** Builds one branch's counter / staff / bank picture from its journal rows. */
function buildBranchRow(
  branchId: Id<"branches"> | null,
  code: string,
  name: string,
  entries: JournalDoc[],
  todayKey: string,
  monthStartKey: string,
): BranchCashRow {
  let counter = 0;
  let staffCash = 0;
  let bank = 0;
  let openingToday = 0;
  let openingMonth = 0;
  const today = emptyWindow(0);
  const month = emptyWindow(0);

  for (const entry of entries) {
    const key = entry.dateKey || istDateKey(entry.createdAt);
    counter += amountOn(entry, COUNTER_CASH_CODE, "debit") - amountOn(entry, COUNTER_CASH_CODE, "credit");
    staffCash += amountOn(entry, STAFF_CASH_CODE, "debit") - amountOn(entry, STAFF_CASH_CODE, "credit");
    bank += amountOn(entry, BANK_CODE, "debit") - amountOn(entry, BANK_CODE, "credit");

    if (key < todayKey) {
      openingToday +=
        amountOn(entry, COUNTER_CASH_CODE, "debit") - amountOn(entry, COUNTER_CASH_CODE, "credit");
    }
    if (key < monthStartKey) {
      openingMonth +=
        amountOn(entry, COUNTER_CASH_CODE, "debit") - amountOn(entry, COUNTER_CASH_CODE, "credit");
    }
    if (key === todayKey) applyEntry(today, entry);
    if (key >= monthStartKey) applyEntry(month, entry);
  }

  return {
    branchId,
    code,
    name,
    counter: r2(counter),
    staffCash: r2(staffCash),
    bank: r2(bank),
    totalCash: r2(counter + staffCash),
    today: finaliseWindow(today, counter, openingToday),
    month: finaliseWindow(month, counter, openingMonth),
    entries: entries.length,
  };
}

function mergeRows(a: BranchCashRow, b: BranchCashRow): BranchCashRow {
  const add = (x: number, y: number) => r2(x + y);
  const mergeWindow = (x: CashWindow, y: CashWindow): CashWindow => ({
    opening: add(x.opening, y.opening),
    received: add(x.received, y.received),
    handoversIn: add(x.handoversIn, y.handoversIn),
    otherIn: add(x.otherIn, y.otherIn),
    issuedToStaff: add(x.issuedToStaff, y.issuedToStaff),
    expenses: add(x.expenses, y.expenses),
    bankDeposits: add(x.bankDeposits, y.bankDeposits),
    otherOut: add(x.otherOut, y.otherOut),
    netChange: add(x.netChange, y.netChange),
    closing: add(x.closing, y.closing),
    disbursedToClients: add(x.disbursedToClients, y.disbursedToClients),
    disbursementCount: x.disbursementCount + y.disbursementCount,
    cashCollections: add(x.cashCollections, y.cashCollections),
    cashCollectionCount: x.cashCollectionCount + y.cashCollectionCount,
    reconciled: x.reconciled && y.reconciled,
  });

  return {
    branchId: null,
    code: a.code,
    name: a.name,
    counter: add(a.counter, b.counter),
    staffCash: add(a.staffCash, b.staffCash),
    bank: add(a.bank, b.bank),
    totalCash: add(a.totalCash, b.totalCash),
    today: mergeWindow(a.today, b.today),
    month: mergeWindow(a.month, b.month),
    entries: a.entries + b.entries,
  };
}

/** Staff submits the day's closing; shortages require an explanation. */
export const submitClosing = mutation({
  args: {
    actual: v.number(),
    explanation: v.optional(v.string()),
    profileId: v.optional(v.id("profiles")),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "cash_handover");
    const now = Date.now();
    const dateKey = istDateKey(now);

    const targetId = me.role === "FIELD_STAFF" ? me._id : (args.profileId ?? me._id);
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_profile", (q) => q.eq("profileId", targetId))
      .unique();
    if (!wallet) throw new AppError("No wallet found for this profile.");
    if (!wallet.branchId) throw new AppError("Wallet has no branch.");

    const txns = await ctx.db
      .query("walletTransactions")
      .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
      .collect();
    const balance = txns.reduce((s, t) => {
      if (t.direction === "CREDIT") return s + t.amount;
      if (t.direction === "DEBIT") return s - t.amount;
      return s;
    }, 0);

    const onDate = txns.filter((t) => istDateKey(t.createdAt) === dateKey);
    const sumOf = (types: string[]) =>
      onDate.filter((t) => types.includes(t.type)).reduce((s, t) => s + t.amount, 0);
    const cashReceived = sumOf(["CASH_ISSUE"]);
    const cashCollections = sumOf(["CASH_COLLECTION"]);
    const disbursement = sumOf(["LOAN_DISBURSEMENT"]);
    const handover = sumOf(["CASH_HANDOVER"]);
    const expenses = sumOf(["EXPENSE"]);
    const netToday = cashReceived + cashCollections - disbursement - handover - expenses;
    const opening = Math.round((balance - netToday) * 100) / 100;

    const actual = money(args.actual, "actual cash", { allowZero: true });
    const evaluation = evaluateClosing(
      { opening, cashReceived, cashCollections, disbursement, handover, expenses },
      actual,
    );

    if (!evaluation.matches) {
      const explanation = optionalString(args.explanation, "explanation", 500);
      if (!explanation) {
        throw new AppError(
          `Difference of ₹${evaluation.difference.toLocaleString("en-IN")} detected — an explanation is required before submission.`,
        );
      }
    }

    const existing = (await ctx.db.query("cashClosings").collect()).find(
      (c) => c.profileId === targetId && c.dateKey === dateKey,
    );
    const status = evaluation.matches ? "APPROVED" : "PENDING";
    const payload = {
      profileId: targetId,
      branchId: wallet.branchId,
      dateKey,
      opening,
      cashReceived,
      cashCollections,
      disbursement,
      handover,
      expenses,
      expected: evaluation.expected,
      actual,
      difference: evaluation.difference,
      explanation: optionalString(args.explanation, "explanation", 500),
      status,
      updatedAt: now,
    };

    let closingId: Id<"cashClosings">;
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      closingId = existing._id;
    } else {
      closingId = await ctx.db.insert("cashClosings", {
        ...payload,
        createdAt: now,
      });
    }

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "CASH_CLOSED",
      entity: "cashClosings",
      entityId: `${dateKey}:${me.staffId}`,
      after: {
        expected: evaluation.expected,
        actual,
        difference: evaluation.difference,
        status,
      },
      branchId: wallet.branchId,
      device: args.device,
    });

    if (!evaluation.matches) {
      await ctx.db.insert("approvalRequests", {
        kind: "CASH_SHORTAGE",
        refId: `CLOSING:${me.staffId}:${dateKey}`,
        branchId: wallet.branchId,
        requestedBy: me._id,
        amount: Math.abs(evaluation.difference),
        summary: `Cash ${evaluation.difference < 0 ? "shortage" : "excess"} ₹${Math.abs(evaluation.difference).toLocaleString("en-IN")} — ${me.name} (${dateKey})`,
        status: "PENDING",
        createdAt: now,
      });
      const profiles = await ctx.db.query("profiles").collect();
      for (const p of profiles) {
        if (p.role === "BRANCH_MANAGER" && p.branchId === wallet.branchId && p.status === "ACTIVE") {
          await notify(ctx, p._id, {
            title: "Cash shortage report",
            body: `${me.name} reported a ${evaluation.difference < 0 ? "shortage" : "surplus"} of ₹${Math.abs(evaluation.difference).toLocaleString("en-IN")} for ${dateKey}.`,
            kind: "CASH",
            link: "/dashboard/cash",
          });
        }
      }
    }

    return { ok: true, closingId, ...evaluation, status };
  },
});

export const decideClosing = mutation({
  args: { closingId: v.id("cashClosings"), action: v.string(), remark: v.optional(v.string()) },
  handler: async (ctx, { closingId, action, remark }) => {
    const me = await requireProfile(ctx);
    requireRole(me, "BRANCH_MANAGER", "SUPER_ADMIN");
    const closing = await ctx.db.get(closingId);
    if (!closing) throw new AppError("Closing not found.");
    if (closing.status !== "PENDING") throw new AppError("Already decided.");
    if (me.role === "BRANCH_MANAGER" && closing.branchId !== me.branchId) {
      throw new AppError("Outside your branch.");
    }
    const next = oneOf(action, ["APPROVED", "REJECTED"], "action");
    if (next === "APPROVED" && closing.difference !== 0 && !closing.explanation) {
      throw new AppError("Explanation required before approving a shortage.");
    }

    await ctx.db.patch(closingId, { status: next, approvedBy: me._id });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: `CLOSING_${next}`,
      entity: "cashClosings",
      entityId: `${closing.dateKey}`,
      before: { status: "PENDING" },
      after: { status: next, remark, difference: closing.difference },
      branchId: closing.branchId,
    });
    await notify(ctx, closing.profileId, {
      title: `Closing ${next.toLowerCase()}`,
      body: `Cash closing for ${closing.dateKey} was ${next.toLowerCase()} by ${me.name}.${remark ? ` ${remark}` : ""}`,
      kind: "CASH",
    });

    // Clear the matching approval request.
    const reqs = (await ctx.db.query("approvalRequests").collect()).filter(
      (r) => r.kind === "CASH_SHORTAGE" && r.status === "PENDING",
    );
    for (const req of reqs) {
      if (req.requestedBy === closing.profileId) {
        await ctx.db.patch(req._id, {
          status: next,
          decidedBy: me._id,
          decidedAt: Date.now(),
          remark,
        });
      }
    }
    return { ok: true };
  },
});

export const closings = query({
  args: { status: v.optional(v.string()), profileId: v.optional(v.id("profiles")) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    let rows = await ctx.db.query("cashClosings").collect();
    if (me.role === "FIELD_STAFF") rows = rows.filter((r) => r.profileId === me._id);
    else if (me.role === "BRANCH_MANAGER") rows = rows.filter((r) => r.branchId === me.branchId);
    if (args.profileId) rows = rows.filter((r) => r.profileId === args.profileId);
    if (args.status) rows = rows.filter((r) => r.status === args.status);
    const profiles = await ctx.db.query("profiles").collect();
    const byId = new Map(profiles.map((p) => [p._id, p]));
    return rows
      .sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1))
      .map((r) => ({ ...r, staffName: byId.get(r.profileId)?.name ?? "—" }));
  },
});

/* ------------------------------ Handovers -------------------------------- */

export const requestHandover = mutation({
  args: { amount: v.number(), remarks: v.optional(v.string()), device: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "cash_handover");
    if (me.role !== "FIELD_STAFF") throw new AppError("Only field staff hand over cash.");
    const amount = money(args.amount, "amount");
    if (!me.branchId) throw new AppError("No branch assigned.");

    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_profile", (q) => q.eq("profileId", me._id))
      .unique();

    const code = `CH${String(
      (await ctx.db.query("cashHandovers").collect()).reduce(
        (max, h) =>
          Math.max(max, Number(String(h.code).replace(/\D/g, "") || 0)),
        0,
      ) + 1,
    ).padStart(5, "0")}`;

    const id = await ctx.db.insert("cashHandovers", {
      code,
      staffId: me._id,
      branchId: me.branchId,
      amount,
      status: "REQUESTED",
      remarks: optionalString(args.remarks, "remarks", 300),
      requestedAt: Date.now(),
    });

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "HANDOVER_REQUESTED",
      entity: "cashHandovers",
      entityId: code,
      after: { amount },
      referenceId: code,
      branchId: me.branchId,
      device: args.device,
    });

    const profiles = await ctx.db.query("profiles").collect();
    for (const p of profiles) {
      if (p.role === "BRANCH_MANAGER" && p.branchId === me.branchId && p.status === "ACTIVE") {
        await notify(ctx, p._id, {
          title: "Cash handover requested",
          body: `${me.name} wants to hand over ₹${amount.toLocaleString("en-IN")}.`,
          kind: "HANDOVER",
          link: "/dashboard/cash",
        });
      }
    }
    void wallet;
    return { ok: true, id, code };
  },
});

export const decideHandover = mutation({
  args: {
    handoverId: v.id("cashHandovers"),
    action: v.string(),
    rejectReason: v.optional(v.string()),
  },
  handler: async (ctx, { handoverId, action, rejectReason }) => {
    const me = await requireProfile(ctx);
    requireRole(me, "BRANCH_MANAGER", "SUPER_ADMIN");
    const handover = await ctx.db.get(handoverId);
    if (!handover) throw new AppError("Handover not found.");
    if (handover.status !== "REQUESTED") throw new AppError("Already decided.");
    if (me.role === "BRANCH_MANAGER" && handover.branchId !== me.branchId) {
      throw new AppError("Outside your branch.");
    }
    const now = Date.now();
    const next = oneOf(action, ["ACCEPTED", "REJECTED"], "action");

    if (next === "REJECTED") {
      await ctx.db.patch(handoverId, {
        status: "REJECTED",
        resolvedAt: now,
        resolvedBy: me._id,
        rejectReason: optionalString(rejectReason, "rejectReason", 300),
      });
      await logAudit(ctx, {
        actorId: me._id,
        actorName: me.name,
        role: me.role,
        action: "HANDOVER_REJECTED",
        entity: "cashHandovers",
        entityId: handover.code,
        before: { status: "REQUESTED" },
        after: { status: "REJECTED", rejectReason },
        branchId: handover.branchId,
      });
      await notify(ctx, handover.staffId, {
        title: "Handover rejected",
        body: `${fmtId(handover.code)}: ${rejectReason ?? "no reason provided"}`,
        kind: "HANDOVER",
      });
      return { ok: true, status: "REJECTED" };
    }

    // Acceptance moves cash in the ledger — never a balance edit.
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_profile", (q) => q.eq("profileId", handover.staffId))
      .unique();
    if (!wallet) throw new AppError("Staff wallet not found.");

    const written = await writeWalletTx(ctx, {
      walletId: wallet._id,
      profileId: handover.staffId,
      branchId: handover.branchId,
      type: "CASH_HANDOVER",
      amount: handover.amount,
      direction: "DEBIT",
      referenceType: "HANDOVER",
      referenceId: handover.code,
      idempotencyKey: `handover:${handover.code}`,
      createdBy: handover.staffId,
      approvedBy: me._id,
      remarks: handover.remarks ?? "Cash accepted by BM",
      createdAt: now,
    });

    await writeJournal(
      ctx,
      handoverEntry({
        amount: handover.amount,
        memo: `Cash handover ${fmtId(handover.code)} — accepted by ${me.name}`,
        refId: handover.code,
      }),
      { branchId: handover.branchId, createdBy: me._id, createdAt: now },
    );

    await ctx.db.patch(handoverId, {
      status: "ACCEPTED",
      resolvedAt: now,
      resolvedBy: me._id,
      bmId: me._id,
    });

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "HANDOVER_ACCEPTED",
      entity: "cashHandovers",
      entityId: handover.code,
      before: { status: "REQUESTED" },
      after: {
        status: "ACCEPTED",
        amount: handover.amount,
        balanceAfter: written.balanceAfter,
      },
      referenceId: handover.code,
      branchId: handover.branchId,
    });
    await notify(ctx, handover.staffId, {
      title: "Handover accepted",
      body: `₹${handover.amount.toLocaleString("en-IN")} received by ${me.name}. Wallet balance ₹${written.balanceAfter.toLocaleString("en-IN")}.`,
      kind: "HANDOVER",
    });

    return { ok: true, status: "ACCEPTED", balanceAfter: written.balanceAfter };
  },
});

export const handovers = query({
  args: { status: v.optional(v.string()), staffId: v.optional(v.id("profiles")) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    let rows = await ctx.db.query("cashHandovers").collect();
    if (me.role === "FIELD_STAFF") rows = rows.filter((r) => r.staffId === me._id);
    else if (me.role === "BRANCH_MANAGER") rows = rows.filter((r) => r.branchId === me.branchId);
    if (args.staffId) rows = rows.filter((r) => r.staffId === args.staffId);
    if (args.status) rows = rows.filter((r) => r.status === args.status);
    rows.sort((a, b) => b.requestedAt - a.requestedAt);

    const [profiles, wallets] = await Promise.all([
      ctx.db.query("profiles").collect(),
      ctx.db.query("wallets").collect(),
    ]);
    const byId = new Map(profiles.map((p) => [p._id, p]));
    const walletByProfile = new Map(wallets.map((w) => [w.profileId, w]));

    return rows.map((r) => {
      const wallet = walletByProfile.get(r.staffId);
      return {
        ...r,
        staffName: byId.get(r.staffId)?.name ?? "—",
        staffIdCode: byId.get(r.staffId)?.staffId ?? "—",
        walletLimit: wallet?.walletLimit ?? null,
      };
    });
  },
});

/* --------------------------------- Issues -------------------------------- */

export const issueCash = mutation({
  args: {
    staffId: v.id("profiles"),
    amount: v.number(),
    remarks: v.optional(v.string()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "wallet_management");
    requireRole(me, "BRANCH_MANAGER", "SUPER_ADMIN");
    const staff = await ctx.db.get(args.staffId);
    if (!staff) throw new AppError("Staff not found.");
    if (me.role === "BRANCH_MANAGER" && staff.branchId !== me.branchId) {
      throw new AppError("Outside your branch.");
    }
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_profile", (q) => q.eq("profileId", args.staffId))
      .unique();
    if (!wallet) throw new AppError("Staff has no wallet.");
    const amount = money(args.amount, "amount");
    const now = Date.now();

    const code = `CI${String(
      (await ctx.db.query("cashIssues").collect()).reduce(
        (max, i) =>
          Math.max(max, Number(String(i.code).replace(/\D/g, "") || 0)),
        0,
      ) + 1,
    ).padStart(5, "0")}`;

    await ctx.db.insert("cashIssues", {
      code,
      staffId: args.staffId,
      branchId: staff.branchId!,
      bmId: me._id,
      amount,
      remarks: optionalString(args.remarks, "remarks", 300),
      createdAt: now,
    });

    const written = await writeWalletTx(ctx, {
      walletId: wallet._id,
      profileId: args.staffId,
      branchId: wallet.branchId,
      type: "CASH_ISSUE",
      amount,
      direction: "CREDIT",
      referenceType: "ISSUE",
      referenceId: code,
      idempotencyKey: `issue:${code}`,
      createdBy: me._id,
      approvedBy: me._id,
      remarks: args.remarks,
      createdAt: now,
    });

    await writeJournal(
      ctx,
      issueEntry({ amount, memo: `Cash issue ${code} — ${staff.name}`, refId: code }),
      { branchId: wallet.branchId, createdBy: me._id, createdAt: now },
    );

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "CASH_ISSUED",
      entity: "cashIssues",
      entityId: code,
      after: { amount, staff: staff.name, balanceAfter: written.balanceAfter },
      referenceId: code,
      branchId: wallet.branchId,
      device: args.device,
    });
    await notify(ctx, args.staffId, {
      title: "Working cash issued",
      body: `₹${amount.toLocaleString("en-IN")} issued by ${me.name}. Available ₹${written.balanceAfter.toLocaleString("en-IN")}.`,
      kind: "WALLET",
    });

    return { ok: true, code, balanceAfter: written.balanceAfter };
  },
});

export const issues = query({
  args: { staffId: v.optional(v.id("profiles")) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    let rows = await ctx.db.query("cashIssues").collect();
    if (me.role === "FIELD_STAFF") rows = rows.filter((r) => r.staffId === me._id);
    else if (me.role === "BRANCH_MANAGER") rows = rows.filter((r) => r.branchId === me.branchId);
    if (args.staffId) rows = rows.filter((r) => r.staffId === args.staffId);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const profiles = await ctx.db.query("profiles").collect();
    const byId = new Map(profiles.map((p) => [p._id, p]));
    return rows.map((r) => ({
      ...r,
      staffName: byId.get(r.staffId)?.name ?? "—",
      bmName: byId.get(r.bmId)?.name ?? "—",
    }));
  },
});

/* ------------------------------- Expenses -------------------------------- */

export const submitExpense = mutation({
  args: {
    amount: v.number(),
    category: v.string(),
    remarks: v.string(),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "cash_handover");
    if (!me.branchId) throw new AppError("No branch assigned.");
    const amount = money(args.amount, "amount");
    const category = requiredString(args.category, "category", 60);
    const remarks = requiredString(args.remarks, "remarks", 300);

    if (args.idempotencyKey) {
      const existing = (await ctx.db.query("expenses").collect()).find(
        (e) => e.idempotencyKey === args.idempotencyKey,
      );
      if (existing) return { ok: true, duplicate: true };
    }

    const code = `EX${String(
      (await ctx.db.query("expenses").collect()).reduce(
        (max, e) =>
          Math.max(max, Number(String(e.code).replace(/\D/g, "") || 0)),
        0,
      ) + 1,
    ).padStart(5, "0")}`;

    await ctx.db.insert("expenses", {
      code,
      profileId: me._id,
      branchId: me.branchId,
      amount,
      category,
      remarks,
      status: "PENDING",
      idempotencyKey: args.idempotencyKey,
      createdAt: Date.now(),
    });
    await ctx.db.insert("approvalRequests", {
      kind: "EXPENSE",
      refId: code,
      branchId: me.branchId,
      requestedBy: me._id,
      amount,
      summary: `Expense ₹${amount.toLocaleString("en-IN")} — ${category} (${me.name})`,
      status: "PENDING",
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "EXPENSE_SUBMITTED",
      entity: "expenses",
      entityId: code,
      after: { amount, category, remarks },
      branchId: me.branchId,
    });
    const profiles = await ctx.db.query("profiles").collect();
    for (const p of profiles) {
      if (p.role === "BRANCH_MANAGER" && p.branchId === me.branchId && p.status === "ACTIVE") {
        await notify(ctx, p._id, {
          title: "Expense approval needed",
          body: `${me.name} — ₹${amount.toLocaleString("en-IN")} (${category}).`,
          kind: "APPROVAL",
          link: "/dashboard/cash",
        });
      }
    }
    return { ok: true, code };
  },
});

export const decideExpense = mutation({
  args: { expenseId: v.id("expenses"), action: v.string(), remark: v.optional(v.string()) },
  handler: async (ctx, { expenseId, action, remark }) => {
    const me = await requireProfile(ctx);
    requireRole(me, "BRANCH_MANAGER", "SUPER_ADMIN");
    const expense = await ctx.db.get(expenseId);
    if (!expense) throw new AppError("Expense not found.");
    if (expense.status !== "PENDING") throw new AppError("Already decided.");
    if (me.role === "BRANCH_MANAGER" && expense.branchId !== me.branchId) {
      throw new AppError("Outside your branch.");
    }
    const now = Date.now();
    const next = oneOf(action, ["APPROVED", "REJECTED"], "action");

    await ctx.db.patch(expenseId, { status: next, approvedBy: me._id });

    if (next === "APPROVED") {
      const wallet = await ctx.db
        .query("wallets")
        .withIndex("by_profile", (q) => q.eq("profileId", expense.profileId))
        .unique();
      if (!wallet) throw new AppError("Staff wallet not found.");
      await writeWalletTx(ctx, {
        walletId: wallet._id,
        profileId: expense.profileId,
        branchId: expense.branchId,
        type: "EXPENSE",
        amount: expense.amount,
        direction: "DEBIT",
        referenceType: "EXPENSE",
        referenceId: expense.code,
        idempotencyKey: `expense:${expense.code}`,
        createdBy: expense.profileId,
        approvedBy: me._id,
        remarks: expense.remarks,
        createdAt: now,
      });
      await writeJournal(
        ctx,
        expenseEntry({
          amount: expense.amount,
          memo: `Approved expense ${fmtId(expense.code)} — ${expense.category}`,
          refId: expense.code,
        }),
        { branchId: expense.branchId, createdBy: me._id, createdAt: now },
      );
    }

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: `EXPENSE_${next}`,
      entity: "expenses",
      entityId: expense.code,
      before: { status: "PENDING" },
      after: { status: next, remark },
      branchId: expense.branchId,
    });
    await notify(ctx, expense.profileId, {
      title: `Expense ${next.toLowerCase()}`,          body: `${fmtId(expense.code)} — ₹${expense.amount.toLocaleString("en-IN")}: ${next.toLowerCase()} by ${me.name}.`,
      kind: "SYSTEM",
    });

    const reqs = (await ctx.db.query("approvalRequests").collect()).filter(
      (r) => r.kind === "EXPENSE" && r.refId === expense.code && r.status === "PENDING",
    );
    for (const req of reqs) {
      await ctx.db.patch(req._id, {
        status: next,
        decidedBy: me._id,
        decidedAt: now,
        remark,
      });
    }
    return { ok: true };
  },
});

export const expenses = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    let rows = await ctx.db.query("expenses").collect();
    if (me.role === "FIELD_STAFF") rows = rows.filter((r) => r.profileId === me._id);
    else if (me.role === "BRANCH_MANAGER") rows = rows.filter((r) => r.branchId === me.branchId);
    if (args.status) rows = rows.filter((r) => r.status === args.status);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const profiles = await ctx.db.query("profiles").collect();
    const byId = new Map(profiles.map((p) => [p._id, p]));
    return rows.map((r) => ({ ...r, staffName: byId.get(r.profileId)?.name ?? "—" }));
  },
});
