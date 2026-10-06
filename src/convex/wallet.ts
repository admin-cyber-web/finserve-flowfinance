import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import {
  AppError,
  getWalletByProfile,
  logAudit,
  notify,
  requirePermission,
  requireProfile,
  walletBalance,
  writeWalletTx,
} from "../lib/server/convexHelpers";
import { utilization, walletWarning } from "../lib/finance/wallet";
import { requiredString, money, oneOf } from "../lib/finance/validate";
import type { Id } from "./_generated/dataModel";

/** Own wallet: balance derived from the immutable ledger, never stored. */
export const myWallet = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    if (me.role !== "FIELD_STAFF") return null;
    const wallet = await getWalletByProfile(ctx, me._id);
    if (!wallet) return null;
    const balance = await walletBalance(ctx, wallet._id);
    const txns = await ctx.db
      .query("walletTransactions")
      .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
      .order("desc")
      .take(25);
    return {
      wallet,
      balance,
      limit: wallet.walletLimit,
      utilization: utilization(balance, wallet.walletLimit),
      warning: walletWarning(balance, wallet.walletLimit),
      txns,
    };
  },
});

/**
 * Filterable wallet ledger. Staff see their own; BM/accountant see their
 * branch; admins see everything.
 */
export const transactions = query({
  args: {
    profileId: v.optional(v.id("profiles")),
    limit: v.optional(v.number()),
    type: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    let targetId: Id<"profiles"> | null = args.profileId ?? null;

    if (me.role === "FIELD_STAFF") targetId = me._id;
    else if (me.role === "BRANCH_MANAGER") {
      if (targetId) {
        const target = await ctx.db.get(targetId);
        if (target && target.branchId !== me.branchId) {
          throw new AppError("Outside your branch.");
        }
      } else {
        targetId = me._id;
      }
    }

    const wallet = targetId
      ? await getWalletByProfile(ctx, targetId)
      : null;
    if (!wallet) return [];

    let txns = await ctx.db
      .query("walletTransactions")
      .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
      .order("desc")
      .take(Math.min(args.limit ?? 50, 200));
    if (args.type) txns = txns.filter((t) => t.type === args.type);

    const profiles = await ctx.db.query("profiles").collect();
    const byId = new Map(profiles.map((p) => [p._id, p]));
    return txns.map((t) => ({
      ...t,
      staffName: byId.get(t.profileId)?.name ?? "—",
      createdByName: t.createdBy ? (byId.get(t.createdBy)?.name ?? "—") : "—",
    }));
  },
});

/**
 * Approved adjustment — the only way to move a wallet outside a business
 * transaction. Requires a reason, records who created and who approved it,
 * and appends (never overwrites) the ledger.
 */
export const adjust = mutation({
  args: {
    profileId: v.id("profiles"),
    amount: v.number(),
    direction: v.string(),
    reason: v.string(),
    approvalRef: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "wallet_management");

    const target = await ctx.db.get(args.profileId);
    if (!target) throw new AppError("Staff not found.");
    const wallet = await getWalletByProfile(ctx, args.profileId);
    if (!wallet) throw new AppError("No wallet for this staff member.");
    const direction = oneOf(args.direction, ["CREDIT", "DEBIT"] as const, "direction");
    const amount = money(args.amount, "amount");
    const reason = requiredString(args.reason, "reason", 300);

    const result = await writeWalletTx(ctx, {
      walletId: wallet._id,
      profileId: args.profileId,
      branchId: wallet.branchId,
      type: "APPROVED_ADJUSTMENT",
      amount,
      direction,
      referenceType: "ADJUSTMENT",
      referenceId: args.approvalRef,
      createdBy: me._id,
      approvedBy: me._id,
      remarks: reason,
    });

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "WALLET_ADJUSTED",
      entity: "walletTransactions",
      entityId: String(result.txnId),
      after: { amount, direction, reason, approvalRef: args.approvalRef },
      branchId: wallet.branchId,
    });
    await notify(ctx, args.profileId, {
      title: "Wallet adjusted",
      body: `${direction === "CREDIT" ? "+" : "−"}₹${amount.toLocaleString("en-IN")} — ${reason}`,
      kind: "WALLET",
    });
    return { ok: true, txnId: result.txnId };
  },
});

/** Wallet ledger for a single transaction, including its reversal links. */
export const transactionDetail = query({
  args: { txnId: v.id("walletTransactions") },
  handler: async (ctx, { txnId }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const txn = await ctx.db.get(txnId);
    if (!txn) throw new AppError("Transaction not found.");
    if (
      me.role === "FIELD_STAFF" &&
      txn.profileId !== me._id
    ) {
      throw new AppError("You can only view your own transactions.");
    }
    const staff = await ctx.db.get(txn.profileId);
    const linked = txn.referenceId
      ? await ctx.db
          .query("walletTransactions")
          .withIndex("by_ref", (q) => q.eq("referenceId", txn.referenceId!))
          .collect()
      : [];
    const reversal = txn.reversalOfId ? await ctx.db.get(txn.reversalOfId) : null;
    const reversedBy = (await ctx.db.query("walletTransactions").collect()).filter(
      (t) => t.reversalOfId === txn._id,
    );
    return { txn, staff, linked, reversal, reversedBy };
  },
});
