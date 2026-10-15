import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  AppError,
  logAudit,
  notify,
  requirePermission,
  requireProfile,
} from "../lib/server/convexHelpers";
import {
  baseScheduleRows,
  deriveLoanView,
  disburseLoan,
  eligibilityFor,
  type LoanView,
} from "../lib/server/loanOps";
import { round2, completedMonthsBetween } from "../lib/finance/money";
import type { Frequency, InterestMethod } from "../lib/finance/types";
import { money, requiredString, oneOf } from "../lib/finance/validate";
import { RECOVERY_KINDS } from "../lib/finance/types";

const MONTH_FACTOR: Record<string, number> = {
  WEEKLY: 4.33,
  FORTNIGHTLY: 2.17,
  MONTHLY: 1,
};

async function scopeLoans(
  ctx: { db: any },
  me: Doc<"profiles">,
  opts: { staffId?: string | null; branchId?: string | null; clientId?: string | null } = {},
) {
  let loans: Doc<"loans">[] = await ctx.db.query("loans").collect();
  if (me.role === "FIELD_STAFF") {
    const target = opts.staffId ?? me._id;
    loans = loans.filter((l: Doc<"loans">) => l.staffId === target);
  } else if (me.role === "BRANCH_MANAGER") {
    loans = loans.filter((l: Doc<"loans">) => l.branchId === me.branchId);
  } else if (me.role === "CLIENT") {
    loans = me.clientId
      ? loans.filter((l: Doc<"loans">) => l.clientId === me.clientId)
      : [];
  } else if (opts.branchId) {
    loans = loans.filter((l: Doc<"loans">) => l.branchId === opts.branchId);
  }
  if (opts.staffId && me.role !== "FIELD_STAFF")
    loans = loans.filter((l: Doc<"loans">) => l.staffId === opts.staffId);
  if (opts.clientId) loans = loans.filter((l: Doc<"loans">) => l.clientId === opts.clientId);
  if (opts.branchId && me.role === "FIELD_STAFF") {
    loans = loans.filter((l: Doc<"loans">) => l.branchId === opts.branchId);
  }
  return loans;
}

export const products = query({
  args: { activeOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const all = (await ctx.db.query("loanProducts").collect()).sort((a, b) =>
      a.code.localeCompare(b.code),
    );
    return args.activeOnly === false ? all : all.filter((p) => p.status === "ACTIVE");
  },
});

export const list = query({
  args: {
    status: v.optional(v.string()),
    staffId: v.optional(v.id("profiles")),
    clientId: v.optional(v.id("clients")),
    branchId: v.optional(v.id("branches")),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "view_loans");
    let loans = await scopeLoans(ctx, me, {
      staffId: args.staffId ?? null,
      branchId: args.branchId ?? null,
      clientId: args.clientId ?? null,
    });

    const now = Date.now();
    const allRows = await ctx.db.query("loanSchedules").collect();
    const rowsByLoan = new Map<string, Doc<"loanSchedules">[]>();
    for (const row of allRows) {
      const arr = rowsByLoan.get(row.loanId) ?? [];
      arr.push(row);
      rowsByLoan.set(row.loanId, arr);
    }

    const [clients, profiles, products] = await Promise.all([
      ctx.db.query("clients").collect(),
      ctx.db.query("profiles").collect(),
      ctx.db.query("loanProducts").collect(),
    ]);
    const clientById = new Map(clients.map((c) => [c._id, c]));
    const profileById = new Map(profiles.map((p) => [p._id, p]));
    const productById = new Map(products.map((p) => [p._id, p]));

    let enriched = loans.map((loan) => {
      const rows = (rowsByLoan.get(loan._id) ?? []).sort((a, b) => a.index - b.index);
      const view = deriveLoanView(loan, rows, now);
      return {
        loan,
        view: view as LoanView,
        client: clientById.get(loan.clientId) ?? null,
        staff: profileById.get(loan.staffId) ?? null,
        product: productById.get(loan.productId) ?? null,
        nextDue: rows.find((r) => r.paid < r.totalDue) ?? null,
      };
    });

    if (args.status) {
      const wanted = args.status.toUpperCase();
      enriched = enriched.filter((e) => e.view.displayStatus === wanted);
    }
    const q = (args.search ?? "").trim().toLowerCase();
    if (q) {
      enriched = enriched.filter(
        (e) =>
          e.loan.loanId.toLowerCase().includes(q) ||
          (e.client && (e.client.name.toLowerCase().includes(q) || e.client.code.toLowerCase().includes(q))),
      );
    }
    enriched.sort((a, b) => b.loan.createdAt - a.loan.createdAt);
    if (args.limit) enriched = enriched.slice(0, args.limit);
    return enriched;
  },
});

export const get = query({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "view_loans");
    const loan = await ctx.db.get(loanId);
    if (!loan) throw new AppError("Loan not found.");

    const allowed =
      me.role === "SUPER_ADMIN" ||
      me.role === "ACCOUNTANT" ||
      (me.role === "BRANCH_MANAGER" && loan.branchId === me.branchId) ||
      loan.staffId === me._id ||
      loan.clientId === me.clientId;
    if (!allowed) throw new AppError("This loan is outside your access.");

    const rows = (
      await ctx.db
        .query("loanSchedules")
        .withIndex("by_loan", (q) => q.eq("loanId", loanId))
        .collect()
    ).sort((a, b) => a.index - b.index);

    const [client, product, staff] = await Promise.all([
      ctx.db.get(loan.clientId),
      ctx.db.get(loan.productId),
      ctx.db.get(loan.staffId),
    ]);
    const payments = (await ctx.db.query("collections").collect())
      .filter((c) => c.loanId === loanId && c.status !== "REVERSAL")
      .sort((a, b) => b.createdAt - a.createdAt);
    const receipts = (await ctx.db.query("receipts").collect())
      .filter((r) => r.loanId === loanId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const recovery = (await ctx.db.query("recoveryActivities").collect())
      .filter((r) => r.loanId === loanId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const application = loan.applicationId ? await ctx.db.get(loan.applicationId) : null;
    const journals = (await ctx.db.query("journalEntries").collect()).filter(
      (j) => j.refId === loan.loanId || payments.some((p) => p.code === j.refId),
    );

    const view = deriveLoanView(loan, rows, Date.now());
    const connectedMonthlyIncome = client?.monthlyIncome ?? 0;
    const connectedHouseholdIncome = client?.householdIncome ?? 0;
    const completedMonths = completedMonthsBetween(
      loan.disbursedAt ?? Date.now(),
      Date.now(),
    );
    return {
      loan,
      view,
      client,
      product,
      staff,
      rows,
      payments,
      receipts,
      recovery,
      application,
      journals,
      connectedMonthlyIncome,
      connectedHouseholdIncome,
      completedMonths,
    };
  },
});

/** Loan wizard preview: schedule + totals + policy evaluation. */
export const preview = query({
  args: {
    clientId: v.id("clients"),
    productId: v.id("loanProducts"),
    amount: v.number(),
  },
  handler: async (ctx, { clientId, productId, amount }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "create_loan");
    const client = await ctx.db.get(clientId);
    const product = await ctx.db.get(productId);
    if (!client || !product) throw new AppError("Client or product not found.");
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new AppError("Enter a loan amount.");
    }

    const loans = (await ctx.db.query("loans").collect()).filter(
      (l) => l.clientId === clientId,
    );
    const active = loans.filter((l) => ["ACTIVE", "OVERDUE"].includes(l.status));
    const overdueHistory = loans.filter((l) => l.status === "OVERDUE").length;

    const existingObligations = round2(
      active.reduce(
        (s, l) => s + l.installment * (MONTH_FACTOR[l.frequency] ?? 1),
        0,
      ),
    );
    // Monthly equivalent of the proposed installment:
    const schedulePreview = baseScheduleRows({
      principal: amount,
      interestRate: product.interestRate,
      interestMethod: product.interestMethod as InterestMethod,
      frequency: product.frequency as Frequency,
      tenure: product.tenure,
      disbursedOn: Date.now(),
      graceDays: product.graceDays,
      charges: 0,
    });
    const proposedMonthly = round2(
      (schedulePreview[0]?.totalDue ?? amount) * (MONTH_FACTOR[product.frequency] ?? 1),
    );
    const eligibility = eligibilityFor(
      client,
      product,
      existingObligations,
      proposedMonthly,
      overdueHistory,
      active.length,
    );

    const charges = round2(
      product.processingFee + (amount * product.chargePercent) / 100,
    );
    const rows = baseScheduleRows({
      principal: amount,
      interestRate: product.interestRate,
      interestMethod: product.interestMethod as InterestMethod,
      frequency: product.frequency as Frequency,
      tenure: product.tenure,
      disbursedOn: Date.now(),
      graceDays: product.graceDays,
      charges,
    });

    const inRange = amount >= product.minAmount && amount <= product.maxAmount;
    const rangeIssue = inRange
      ? null
      : {
          level: "BLOCKER" as const,
          message: `Amount must be between ₹${product.minAmount.toLocaleString("en-IN")} and ₹${product.maxAmount.toLocaleString("en-IN")} for ${product.name}.`,
        };

    const totalInterest = round2(rows.reduce((s, r) => s + r.interest, 0));
    const totalPayable = round2(rows.reduce((s, r) => s + r.totalDue, 0));

    return {
      client,
      product,
      amount,
      charges,
      totalInterest,
      totalPayable,
      installment: rows[0]?.totalDue ?? 0,
      regularInstallment: rows[1]?.totalDue ?? rows[0]?.totalDue ?? 0,
      tenure: product.tenure,
      frequency: product.frequency,
      schedule: rows.map((r) => ({
        index: r.index,
        dueDate: r.dueDate,
        principal: r.principal,
        interest: r.interest,
        totalDue: r.totalDue,
      })),
      eligibility: {
        ...eligibility,
        issues: rangeIssue ? [rangeIssue, ...eligibility.issues] : eligibility.issues,
        eligible: eligibility.eligible && !rangeIssue,
      },
      existingObligations,
      proposedMonthly,
      activeLoans: active.length,
    };
  },
});

export const submit = mutation({
  args: {
    clientId: v.id("clients"),
    productId: v.id("loanProducts"),
    amount: v.number(),
    remark: v.optional(v.string()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "create_loan");
    const client = await ctx.db.get(args.clientId);
    const product = await ctx.db.get(args.productId);
    if (!client || !product) throw new AppError("Client or product not found.");
    if (product.status !== "ACTIVE") throw new AppError("This loan product is inactive.");
    const amount = money(args.amount, "amount");
    if (amount < product.minAmount || amount > product.maxAmount) {
      throw new AppError(
        `Amount must be between ₹${product.minAmount.toLocaleString("en-IN")} and ₹${product.maxAmount.toLocaleString("en-IN")}.`,
      );
    }
    if (me.role === "FIELD_STAFF" && client.assignedTo !== me._id) {
      throw new AppError("You can only apply for your own assigned clients.");
    }

    // Server-side policy check — configurable policy is never bypassed.
    const loans = (await ctx.db.query("loans").collect()).filter(
      (l) => l.clientId === args.clientId,
    );
    const active = loans.filter((l) => ["ACTIVE", "OVERDUE"].includes(l.status));
    const existingObligations = round2(
      active.reduce((s, l) => s + l.installment * (MONTH_FACTOR[l.frequency] ?? 1), 0),
    );
    const rowsPreview = baseScheduleRows({
      principal: amount,
      interestRate: product.interestRate,
      interestMethod: product.interestMethod as InterestMethod,
      frequency: product.frequency as Frequency,
      tenure: product.tenure,
      disbursedOn: Date.now(),
      graceDays: product.graceDays,
      charges: 0,
    });
    const proposedMonthly = round2(
      (rowsPreview[0]?.totalDue ?? amount) * (MONTH_FACTOR[product.frequency] ?? 1),
    );
    const eligibility = eligibilityFor(
      client,
      product,
      existingObligations,
      proposedMonthly,
      loans.filter((l) => l.status === "OVERDUE").length,
      active.length,
    );
    if (!eligibility.eligible) {
      throw new AppError(
        eligibility.issues.find((i) => i.level === "BLOCKER")?.message ??
          "Client does not meet lender policy.",
      );
    }

    const now = Date.now();
    const appId = `LA-${String(
      (await ctx.db.query("loanApplications").collect()).reduce(
        (max, a) => Math.max(max, Number(a.appId.split("-")[1] ?? 0)),
        0,
      ) + 1,
    ).padStart(6, "0")}`;

    const applicationId = await ctx.db.insert("loanApplications", {
      appId,
      clientId: args.clientId,
      productId: args.productId,
      amount,
      staffId: me._id,
      branchId: me.branchId!,
      status: "SUBMITTED",
      history: [
        {
          actorId: me._id,
          actorName: me.name,
          role: me.role,
          action: "SUBMITTED",
          remark: args.remark,
          at: now,
        },
      ],
      eligibility,
      submittedAt: now,
      createdAt: now,
    });

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "LOAN_APPLIED",
      entity: "loanApplications",
      entityId: appId,
      after: {
        client: client.name,
        product: product.name,
        amount,
        obligationRatio: eligibility.obligationRatio,
      },
      referenceId: appId,
      branchId: me.branchId,
      device: args.device,
    });

    // Notify branch decision makers.
    const profiles = await ctx.db.query("profiles").collect();
    for (const p of profiles) {
      if (
        (p.role === "BRANCH_MANAGER" || p.role === "SUPER_ADMIN") &&
        p.branchId === me.branchId &&
        p.status === "ACTIVE"
      ) {
        await notify(ctx, p._id, {
          title: "Loan application submitted",
          body: `${client.name} — ₹${amount.toLocaleString("en-IN")} (${product.name}) from ${me.name}.`,
          kind: "APPROVAL",
          link: `/dashboard/approvals`,
        });
      }
    }

    return { ok: true, applicationId, appId };
  },
});

export const decide = mutation({
  args: {
    applicationId: v.id("loanApplications"),
    action: v.string(),
    remark: v.optional(v.string()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, { applicationId, action, remark, device }) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "approve_loan");
    const app = await ctx.db.get(applicationId);
    if (!app) throw new AppError("Application not found.");
    if (!["SUBMITTED", "UNDER_REVIEW"].includes(app.status)) {
      throw new AppError(`Application is ${app.status}.`);
    }
    if (me.role === "BRANCH_MANAGER" && app.branchId !== me.branchId) {
      throw new AppError("Outside your branch.");
    }
    const next = oneOf(action, ["APPROVED", "REJECTED"], "action");
    const now = Date.now();
    const client = await ctx.db.get(app.clientId);
    const product = await ctx.db.get(app.productId);

    if (next === "REJECTED") {
      await ctx.db.patch(applicationId, {
        status: "REJECTED",
        decidedAt: now,
        decisionReason: remark ? requiredString(remark, "remark", 300) : undefined,
        history: [
          ...app.history,
          {
            actorId: me._id,
            actorName: me.name,
            role: me.role,
            action: "REJECTED",
            remark,
            at: now,
          },
        ],
      });
      await logAudit(ctx, {
        actorId: me._id,
        actorName: me.name,
        role: me.role,
        action: "LOAN_REJECTED",
        entity: "loanApplications",
        entityId: app.appId,
        before: { status: "SUBMITTED" },
        after: { status: "REJECTED", remark },
        referenceId: app.appId,
        branchId: app.branchId,
        device,
      });
      await notify(ctx, app.staffId, {
        title: "Application rejected",
        body: `${client?.name ?? "Client"} — ${app.appId}: ${remark ?? "no reason recorded"}`,
        kind: "LOAN",
      });
      return { ok: true, status: "REJECTED" };
    }

    // Re-run policy at approval time.
    if (client && product) {
      const loans = (await ctx.db.query("loans").collect()).filter(
        (l) => l.clientId === app.clientId,
      );
      const active = loans.filter((l) => ["ACTIVE", "OVERDUE"].includes(l.status));
      const existingObligations = round2(
        active.reduce((s, l) => s + l.installment * (MONTH_FACTOR[l.frequency] ?? 1), 0),
      );
      const rowsPreview = baseScheduleRows({
        principal: app.amount,
        interestRate: product.interestRate,
        interestMethod: product.interestMethod as InterestMethod,
        frequency: product.frequency as Frequency,
        tenure: product.tenure,
        disbursedOn: now,
        graceDays: product.graceDays,
        charges: 0,
      });
      const proposedMonthly = round2(
        (rowsPreview[0]?.totalDue ?? app.amount) * (MONTH_FACTOR[product.frequency] ?? 1),
      );
      const eligibility = eligibilityFor(
        client,
        product,
        existingObligations,
        proposedMonthly,
        loans.filter((l) => l.status === "OVERDUE").length,
        active.length,
      );
      if (!eligibility.eligible) {
        throw new AppError(
          eligibility.issues.find((i) => i.level === "BLOCKER")?.message ??
            "Policy check failed at approval.",
        );
      }

      const loanSeq =
        (await ctx.db.query("loans").collect()).reduce(
          (max, l) => Math.max(max, Number(l.loanId.split("-")[1] ?? 0)),
          0,
        ) + 1;
      const loanId = `LN-${String(loanSeq).padStart(6, "0")}`;

      const previewRows = baseScheduleRows({
        principal: app.amount,
        interestRate: product.interestRate,
        interestMethod: product.interestMethod as InterestMethod,
        frequency: product.frequency as Frequency,
        tenure: product.tenure,
        disbursedOn: now,
        graceDays: product.graceDays,
        charges: 0,
      });
      const charges = round2(
        product.processingFee + (app.amount * product.chargePercent) / 100,
      );

      const loanDocId = await ctx.db.insert("loans", {
        loanId,
        applicationId,
        clientId: app.clientId,
        productId: app.productId,
        staffId: app.staffId,
        branchId: app.branchId,
        principal: app.amount,
        interestTotal: round2(previewRows.reduce((s, r) => s + r.interest, 0)),
        charges,
        totalPayable: 0,
        installment: previewRows[0]?.totalDue ?? app.amount,
        frequency: product.frequency,
        tenure: product.tenure,
        interestRate: product.interestRate,
        interestMethod: product.interestMethod,
        status: "APPROVED",
        outstanding: 0,
        paidTotal: 0,
        approvedBy: me._id,
        approvedAt: now,
        overdueDays: 0,
        createdAt: app.createdAt,
      });

      await ctx.db.patch(applicationId, {
        status: "APPROVED",
        decidedAt: now,
        loanId: loanDocId,
        decisionReason: remark,
        history: [
          ...app.history,
          {
            actorId: me._id,
            actorName: me.name,
            role: me.role,
            action: "APPROVED",
            remark,
            at: now,
          },
        ],
      });

      await logAudit(ctx, {
        actorId: me._id,
        actorName: me.name,
        role: me.role,
        action: "LOAN_APPROVED",
        entity: "loanApplications",
        entityId: app.appId,
        before: { status: "SUBMITTED" },
        after: { status: "APPROVED", loanId, amount: app.amount },
        referenceId: loanId,
        branchId: app.branchId,
        device,
      });
      await notify(ctx, app.staffId, {
        title: "Loan approved",
        body: `${loanId} — ₹${app.amount.toLocaleString("en-IN")} for ${client.name}. Ready for disbursement.`,
        kind: "LOAN",
        link: `/dashboard/loans/${loanDocId}`,
      });
      return { ok: true, status: "APPROVED", loanDocId, loanId };
    }

    throw new AppError("Client or product missing for approval.");
  },
});

export const disburse = mutation({
  args: { loanId: v.id("loans"), device: v.optional(v.string()) },
  handler: async (ctx, { loanId, device }) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "disburse_loan");
    const loan = await ctx.db.get(loanId);
    if (!loan) throw new AppError("Loan not found.");
    if (me.role === "BRANCH_MANAGER" && loan.branchId !== me.branchId) {
      throw new AppError("Outside your branch.");
    }

    const { walletDebit } = await disburseLoan(ctx, { loanId, actor: me, device });

    if (loan.applicationId) {
      const app = await ctx.db.get(loan.applicationId);
      if (app && app.status === "APPROVED") {
        await ctx.db.patch(app._id, { status: "DISBURSED" });
      }
    }

    return { ok: true, walletDebit };
  },
});

export const addRecovery = mutation({
  args: {
    loanId: v.id("loans"),
    kind: v.string(),
    notes: v.optional(v.string()),
    promisedAmount: v.optional(v.number()),
    promisedDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "collect_payment");
    const loan = await ctx.db.get(args.loanId);
    if (!loan) throw new AppError("Loan not found.");
    const kind = oneOf(args.kind, RECOVERY_KINDS, "kind");

    const id = await ctx.db.insert("recoveryActivities", {
      loanId: loan._id,
      clientId: loan.clientId,
      staffId: me._id,
      branchId: loan.branchId,
      kind,
      notes: args.notes ? requiredString(args.notes, "notes", 500) : undefined,
      promisedAmount:
        args.promisedAmount !== undefined
          ? money(args.promisedAmount, "promisedAmount")
          : undefined,
      promisedDate: args.promisedDate,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "RECOVERY_ACTIVITY",
      entity: "loans",
      entityId: loan.loanId,
      after: { kind, notes: args.notes },
      referenceId: loan.loanId,
      branchId: loan.branchId,
    });
    return { ok: true, id };
  },
});

export { completedMonthsBetween };
