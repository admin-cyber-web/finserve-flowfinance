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

    const code = `CH-${String(
      (await ctx.db.query("cashHandovers").collect()).reduce(
        (max, h) => Math.max(max, Number(h.code.split("-")[1] ?? 0)),
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
        body: `${handover.code}: ${rejectReason ?? "no reason provided"}`,
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
        memo: `Cash handover ${handover.code} — accepted by ${me.name}`,
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

    const code = `CI-${String(
      (await ctx.db.query("cashIssues").collect()).reduce(
        (max, i) => Math.max(max, Number(i.code.split("-")[1] ?? 0)),
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

    const code = `EX-${String(
      (await ctx.db.query("expenses").collect()).reduce(
        (max, e) => Math.max(max, Number(e.code.split("-")[1] ?? 0)),
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
          memo: `Approved expense ${expense.code} — ${expense.category}`,
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
      title: `Expense ${next.toLowerCase()}`,
      body: `${expense.code} — ₹${expense.amount.toLocaleString("en-IN")}: ${next.toLowerCase()} by ${me.name}.`,
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
