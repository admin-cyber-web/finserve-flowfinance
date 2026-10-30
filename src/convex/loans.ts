import { v } from "convex/values";
import { query, mutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  AppError,
  logAudit,
  notify,
  requirePermission,
  requireProfile,
} from "../lib/server/convexHelpers";
import {
  FIXED_LOAN_TERMS,
  authorizedCharges,
  fixedScheduleInput,
} from "../lib/server/loanTerms";
import { idQueryMatches } from "../lib/server/idMatch";
import { fmtId } from "../lib/utils";
import {
  archiveLoan,
  baseScheduleRows,
  closeLoan,
  deleteLoanRecord,
  deriveLoanView,
  disburseLoan,
  eligibilityFor,
  settleLoan,
  surrenderLoan,
  type LoanView,
} from "../lib/server/loanOps";
import { resolveBranchForActor } from "../lib/server/centerOps";
import { round2, completedMonthsBetween } from "../lib/finance/money";
import { rowOutstanding } from "../lib/finance/schedule";
import {
  PermissionError,
  ValidationError,
  money,
  requiredString,
  oneOf,
} from "../lib/finance/validate";
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

// NOTE: the loan-product catalogue (loans.products / loans.productSchedules)
// has been removed with the Loan Products feature. Every new loan is priced
// from the fixed backend terms in `lib/server/loanTerms.ts`; nothing on the
// client can supply a rate, frequency, tenure or fee.

export const list = query({
  args: {
    status: v.optional(v.string()),
    staffId: v.optional(v.id("profiles")),
    clientId: v.optional(v.id("clients")),
    branchId: v.optional(v.id("branches")),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "view_loans");
    const loans = await scopeLoans(ctx, me, {
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
        product: loan.productId ? (productById.get(loan.productId) ?? null) : null,
        nextDue: rows.find((r) => rowOutstanding(r) > 0) ?? null,
      };
    });

    // Archived (closed/settled, removed from ordinary screens) loans are
    // hidden by default; the authorized audit view re-includes them.
    const canSeeArchived =
      args.includeArchived === true &&
      (me.role === "SUPER_ADMIN" || me.role === "ACCOUNTANT");
    if (!canSeeArchived) {
      enriched = enriched.filter((e) => !e.loan.archivedAt);
    }

    if (args.status) {
      const wanted = args.status.toUpperCase();
      if (wanted === "ARCHIVED") {
        enriched = canSeeArchived
          ? enriched.filter((e) => !!e.loan.archivedAt)
          : [];
      } else {
        enriched = enriched.filter((e) => e.view.displayStatus === wanted);
      }
    }
    const q = (args.search ?? "").trim().toLowerCase();
    if (q) {
      enriched = enriched.filter(
        (e) =>
          e.loan.loanId.toLowerCase().includes(q) ||
          // Numeric / prefixed / hyphen-less Loan ID forms
          // ("LN-000123", "LN000123", "000123") all resolve.
          idQueryMatches(e.loan.loanId, args.search ?? "") ||
          (e.client &&
            (e.client.name.toLowerCase().includes(q) ||
              e.client.code.toLowerCase().includes(q) ||
              // Numeric / prefixed / hyphen-less Client ID forms.
              idQueryMatches(e.client.code, args.search ?? ""))),
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
      loan.productId ? ctx.db.get(loan.productId) : Promise.resolve(null),
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
    amount: v.number(),
  },
  handler: async (ctx, { clientId, amount }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "create_loan");
    const client = await ctx.db.get(clientId);
    if (!client) throw new AppError("Client not found.");
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
    // ONE backend calculation: the fixed weekly terms (79% reducing,
    // 24 weekly installments) priced by the shared schedule engine.
    const rows = baseScheduleRows(fixedScheduleInput(amount, Date.now()));
    const proposedMonthly = round2(
      (rows[0]?.totalDue ?? amount) *
        (MONTH_FACTOR[FIXED_LOAN_TERMS.frequency] ?? 1),
    );
    const eligibility = eligibilityFor(
      client,
      existingObligations,
      proposedMonthly,
      overdueHistory,
      active.length,
    );

    // No separately authorized fee rule exists → no fee on a new loan.
    const charges = authorizedCharges(amount);

    const totalInterest = round2(rows.reduce((s, r) => s + r.interest, 0));
    const totalPayable = round2(rows.reduce((s, r) => s + r.totalDue, 0));

    return {
      client,
      amount,
      charges,
      netDisbursed: round2(amount - charges),
      totalInterest,
      totalPayable,
      installment: rows[0]?.totalDue ?? 0,
      regularInstallment: rows[1]?.totalDue ?? rows[0]?.totalDue ?? 0,
      tenure: FIXED_LOAN_TERMS.tenure,
      frequency: FIXED_LOAN_TERMS.frequency,
      interestRate: FIXED_LOAN_TERMS.interestRate,
      interestMethod: FIXED_LOAN_TERMS.interestMethod,
      schedule: rows.map((r) => ({
        index: r.index,
        dueDate: r.dueDate,
        principal: r.principal,
        interest: r.interest,
        totalDue: r.totalDue,
      })),
      eligibility,
      existingObligations,
      proposedMonthly,
      activeLoans: active.length,
    };
  },
});

export const submit = mutation({
  args: {
    clientId: v.id("clients"),
    amount: v.number(),
    remark: v.optional(v.string()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "create_loan");
    const client = await ctx.db.get(args.clientId);
    if (!client) throw new AppError("Client not found.");
    // Terms are NEVER client-supplied: the fixed backend terms + the shared
    // engine below are the only source for rate, frequency, tenure and fee.
    const amount = money(args.amount, "amount");
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
    const rowsPreview = baseScheduleRows(fixedScheduleInput(amount, Date.now()));
    const proposedMonthly = round2(
      (rowsPreview[0]?.totalDue ?? amount) *
        (MONTH_FACTOR[FIXED_LOAN_TERMS.frequency] ?? 1),
    );
    const eligibility = eligibilityFor(
      client,
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
    const appId = `LA${String(
      (await ctx.db.query("loanApplications").collect()).reduce(
        (max, a) =>
          Math.max(max, Number(String(a.appId).replace(/\D/g, "") || 0)),
        0,
      ) + 1,
    ).padStart(6, "0")}`;

    // Org-wide admins may have no home branch — resolve one exactly like
    // client onboarding does so single loans always work end-to-end.
    const applicationBranch = me.branchId ?? (await resolveBranchForActor(ctx, me));

    const applicationId = await ctx.db.insert("loanApplications", {
      appId,
      clientId: args.clientId,
      amount,
      staffId: me._id,
      branchId: applicationBranch,
      centerId: client.centerId,
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
        amount,
        terms: `${FIXED_LOAN_TERMS.interestRate}% ${FIXED_LOAN_TERMS.interestMethod} · ${FIXED_LOAN_TERMS.tenure} ${FIXED_LOAN_TERMS.frequency}`,
        obligationRatio: eligibility.obligationRatio,
      },
      referenceId: appId,
      branchId: applicationBranch,
      device: args.device,
    });

    // Notify branch decision makers.
    const profiles = await ctx.db.query("profiles").collect();
    for (const p of profiles) {
      if (
        (p.role === "BRANCH_MANAGER" || p.role === "SUPER_ADMIN") &&
        p.branchId === applicationBranch &&
        p.status === "ACTIVE"
      ) {
        await notify(ctx, p._id, {
          title: "Loan application submitted",
          body: `${client.name} — ₹${amount.toLocaleString("en-IN")} · ${FIXED_LOAN_TERMS.tenure} weekly installments from ${me.name}.`,
          kind: "APPROVAL",
          link: `/dashboard/approvals`,
        });
      }
    }

    return { ok: true, applicationId, appId };
  },
});

/* --------------------- Centre-wise loan disbursement -------------------- */

/** Hard ceiling on one centre-wise batch — mirrors the largest roster the
 * centre report paginates to, and keeps one transaction comfortably small. */
const BATCH_MAX_CLIENTS = 100;

/** Centres the acting user may run a centre-wise batch against (branch
 * scope is enforced here AND again inside the batch mutation). */
/**
 * Centre-wise SEARCH — the only entry into the centre-wise wizard.
 *
 * Nothing is listed by default: the caller must enter a Centre ID
 * (e.g. BALLIA-001), a Client ID (e.g. 000137 / C-000137) or both. The
 * filtering happens HERE on the server, so the browser never receives the
 * full centre or client directory to merely hide. Both IDs together must
 * BOTH match — and the client must belong to the named centre — or the
 * search reports no match, so unrelated records can never appear.
 */
export const centerSearch = query({
  args: {
    /** Centre ID, e.g. BALLIA-001 (case / punctuation tolerant). */
    code: v.optional(v.string()),
    /** Client ID — numeric, prefixed or hyphen-less forms all resolve. */
    clientCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "create_loan");
    const code = (args.code ?? "").trim();
    const clientCode = (args.clientCode ?? "").trim();
    if (!code && !clientCode) {
      throw new AppError("Please enter a Center ID or Client ID to search.");
    }

    // Same branch scoping the old centre list and the roster enforce.
    const inBranch = (branchId: Id<"branches">) =>
      me.role === "SUPER_ADMIN" || !me.branchId || branchId === me.branchId;
    const notFound = { matched: false as const, center: null, client: null };

    const allClients = await ctx.db.query("clients").collect();

    // 1 — the centre, by Centre ID.
    let matchedCenter: Doc<"centers"> | null = null;
    if (code) {
      const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
      matchedCenter =
        (await ctx.db.query("centers")
          .collect())
          .filter((c) => inBranch(c.branchId))
          .find(
            (c) => c.code.toUpperCase().replace(/[^A-Z0-9]/g, "") === norm,
          ) ?? null;
      if (!matchedCenter) return notFound;
    }

    // 2 — the client, by Client ID (same matcher as the client list).
    let matchedClient: Doc<"clients"> | null = null;
    if (clientCode) {
      matchedClient =
        allClients.find(
          (c) =>
            c.status !== "INACTIVE" &&
            inBranch(c.branchId) &&
            idQueryMatches(c.code, clientCode),
        ) ?? null;
      if (!matchedClient) return notFound;
      // Both IDs entered: the client must belong to the named centre —
      // otherwise the two conditions do not both hold.
      if (code && matchedClient.centerId !== matchedCenter!._id) {
        return notFound;
      }
    }

    // Client-only search: surface the client's own centre so the loan
    // workflow (roster → batch) can run against it.
    const centre =
      matchedCenter ??
      (matchedClient?.centerId
        ? await ctx.db.get(matchedClient.centerId)
        : null);

    let activeLoans = 0;
    if (matchedClient) {
      activeLoans = (await ctx.db.query("loans").collect()).filter(
        (l) =>
          l.clientId === matchedClient!._id &&
          ["ACTIVE", "OVERDUE"].includes(l.status),
      ).length;
    }

    return {
      matched: true as const,
      center: centre
        ? {
            _id: centre._id,
            code: centre.code,
            name: centre.name,
            village: centre.village,
            clientCount: allClients.filter((cl) => cl.centerId === centre._id)
              .length,
          }
        : null,
      client: matchedClient
        ? {
            _id: matchedClient._id,
            code: matchedClient.code,
            name: matchedClient.name,
            village: matchedClient.village,
            kycStatus: matchedClient.kycStatus,
            status: matchedClient.status,
            activeLoans,
            centerId: matchedClient.centerId,
          }
        : null,
    };
  },
});

/**
 * Roster of a centre for the centre-wise disbursement wizard: every client
 * linked to the centre, with the SAME server-side checks the single-loan
 * flow runs (active-loan exposure, overdue history, KYC, pending duplicate
 * applications, product terms and the income/obligation policy). Ineligible
 * members come back with `blockers` explaining why — the wizard never hides
 * them, and never lets them into a batch.
 */
export const centerRoster = query({
  args: {
    centerId: v.id("centers"),
    /**
     * Optional principal. Without it the roster still lists the centre's
     * members (so a Centre-ID search shows them immediately) but skips the
     * income/obligation scoring — `scored: false` tells the wizard to hold
     * selection until an amount is entered. Submission always re-checks the
     * policy server-side with the real amount.
     */
    amount: v.optional(v.number()),
    /** Narrow the roster to specific members (Client-ID search). */
    onlyClientIds: v.optional(v.array(v.id("clients"))),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "create_loan");
    const center = await ctx.db.get(args.centerId);
    if (!center) throw new AppError("Centre not found.");
    if (me.role !== "SUPER_ADMIN" && me.branchId && center.branchId !== me.branchId) {
      throw new AppError("This centre is outside your branch.");
    }
    // One principal for the whole batch — terms come from the fixed backend
    // configuration, never from a product record or the client.
    const amount =
      args.amount !== undefined ? money(args.amount, "amount") : null;
    const scored = amount !== null;

    const now = Date.now();
    const allLoans = await ctx.db.query("loans").collect();
    const applications = await ctx.db.query("loanApplications").collect();
    let members = (await ctx.db.query("clients").collect()).filter(
      (c) => c.centerId === center._id,
    );
    if (args.onlyClientIds) {
      const only = new Set(args.onlyClientIds);
      members = members.filter((c) => only.has(c._id));
    }
    members = members
      .sort((a, b) => a.code.localeCompare(b.code))
      .slice(0, BATCH_MAX_CLIENTS);

    const rows = members.map((client) => {
      const loans = allLoans.filter((l) => l.clientId === client._id);
      const active = loans.filter((l) => ["ACTIVE", "OVERDUE"].includes(l.status));
      const overdueHistory = loans.filter((l) => l.status === "OVERDUE").length;
      const pendingApp =
        applications.find(
          (a) =>
            a.clientId === client._id &&
            ["SUBMITTED", "UNDER_REVIEW"].includes(a.status),
        ) ?? null;

      const blockers: string[] = [];
      const warnings: string[] = [];
      if (client.status !== "ACTIVE") {
        blockers.push(`Client is ${client.status.toLowerCase()}.`);
      }
      if (client.kycStatus === "REJECTED") {
        blockers.push("KYC documents were rejected — re-verify before lending.");
      }
      if (me.role === "FIELD_STAFF" && client.assignedTo !== me._id) {
        blockers.push(
          "Not assigned to you — field staff can only lend to their own clients.",
        );
      }
      if (pendingApp) {
        blockers.push(
          `Loan application ${pendingApp.appId} is already ${pendingApp.status.toLowerCase()}.`,
        );
      }

      let charges: number | null = null;
      let netDisbursed: number | null = null;
      let installment: number | null = null;
      if (amount !== null) {
        const existingObligations = round2(
          active.reduce(
            (s, l) => s + l.installment * (MONTH_FACTOR[l.frequency] ?? 1),
            0,
          ),
        );
        const rowsPreview = baseScheduleRows(fixedScheduleInput(amount, now));
        const proposedMonthly = round2(
          (rowsPreview[0]?.totalDue ?? amount) *
            (MONTH_FACTOR[FIXED_LOAN_TERMS.frequency] ?? 1),
        );
        const eligibility = eligibilityFor(
          client,
          existingObligations,
          proposedMonthly,
          overdueHistory,
          active.length,
        );
        for (const issue of eligibility.issues) {
          if (issue.level === "BLOCKER") blockers.push(issue.message);
          else warnings.push(issue.message);
        }
        charges = authorizedCharges(amount);
        netDisbursed = round2(amount - charges);
        installment = rowsPreview[0]?.totalDue ?? amount;
      }

      return {
        client: {
          _id: client._id,
          code: client.code,
          name: client.name,
          village: client.village,
          kycStatus: client.kycStatus,
          status: client.status,
        },
        assignedTo: client.assignedTo,
        activeLoans: active.length,
        overdueHistory,
        pendingApplication: pendingApp
          ? { appId: pendingApp.appId, status: pendingApp.status }
          : null,
        amount,
        charges,
        netDisbursed,
        installment,
        blockers,
        warnings,
        eligible: blockers.length === 0,
      };
    });

    return {
      center: {
        _id: center._id,
        code: center.code,
        name: center.name,
        village: center.village,
      },
      amount,
      /** False when no principal was supplied — policy scoring pending. */
      scored,
      terms: FIXED_LOAN_TERMS,
      rows,
      eligibleCount: rows.filter((r) => r.eligible).length,
    };
  },
});

/**
 * Centre-wise loan disbursement — creates ONE SUBMITTED application per
 * selected client through the same policy engine, product terms and
 * duplicate guards as `submit`. It NEVER approves or disburses anything:
 * the batch only feeds the existing approval workflow, so a whole-centre
 * selection can never bypass authorisation, wallet limits or cash controls.
 *
 * Per-client failures are reported, not fatal: eligible members are created
 * even when others in the batch are skipped with a reason.
 */
export const submitCenterBatch = mutation({
  args: {
    centerId: v.id("centers"),
    amount: v.number(),
    clientIds: v.array(v.id("clients")),
    remark: v.optional(v.string()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "create_loan");
    const center = await ctx.db.get(args.centerId);
    if (!center) throw new AppError("Centre not found.");
    if (me.role !== "SUPER_ADMIN" && me.branchId && center.branchId !== me.branchId) {
      throw new AppError("This centre is outside your branch.");
    }
    // Rate, frequency, tenure and fee are fixed backend terms — only the
    // principal is an input, and it is validated here on the server.
    const amount = money(args.amount, "amount");
    // De-duplicate while preserving order; one batch covers one centre.
    const wanted = [...new Set(args.clientIds)];
    if (wanted.length === 0) {
      throw new AppError("Select at least one client for the batch.");
    }
    if (wanted.length > BATCH_MAX_CLIENTS) {
      throw new AppError(
        `A centre-wise batch can cover at most ${BATCH_MAX_CLIENTS} clients.`,
      );
    }

    const now = Date.now();
    const remark = args.remark
      ? requiredString(args.remark, "remark", 300)
      : undefined;
    const branchId = me.branchId ?? center.branchId;
    const created: {
      clientId: Id<"clients">;
      code: string;
      name: string;
      applicationId: Id<"loanApplications">;
      appId: string;
    }[] = [];
    const skipped: {
      clientId: Id<"clients">;
      code: string;
      name: string;
      reason: string;
    }[] = [];

    let appSeq = (await ctx.db.query("loanApplications").collect()).reduce(
      (max, a) =>
        Math.max(max, Number(String(a.appId).replace(/\D/g, "") || 0)),
      0,
    );
    const loansAll = await ctx.db.query("loans").collect();
    const appsAll = await ctx.db.query("loanApplications").collect();

    for (const clientId of wanted) {
      const client = await ctx.db.get(clientId);
      let record: (typeof created)[number] | null = null;
      try {
        if (!client) throw new AppError("Client not found.");
        if (client.centerId !== center._id) {
          throw new AppError(`${fmtId(client.code)} does not belong to this centre.`);
        }
        if (me.role === "FIELD_STAFF" && client.assignedTo !== me._id) {
          throw new AppError("You can only apply for your own assigned clients.");
        }
        if (client.status !== "ACTIVE") {
          throw new AppError(`${fmtId(client.code)} is ${client.status.toLowerCase()}.`);
        }
        if (client.kycStatus === "REJECTED") {
          throw new AppError(
            `${fmtId(client.code)} — KYC rejected; re-verify before lending.`,
          );
        }
        if (
          appsAll.some(
            (a) =>
              a.clientId === clientId &&
              ["SUBMITTED", "UNDER_REVIEW"].includes(a.status),
          )
        ) {
          throw new AppError(
            `${fmtId(client.code)} already has a pending loan application.`,
          );
        }

        // Server-side policy check — identical engine to the single flow.
        const loans = loansAll.filter((l) => l.clientId === clientId);
        const active = loans.filter((l) =>
          ["ACTIVE", "OVERDUE"].includes(l.status),
        );
        const existingObligations = round2(
          active.reduce(
            (s, l) => s + l.installment * (MONTH_FACTOR[l.frequency] ?? 1),
            0,
          ),
        );
        const rowsPreview = baseScheduleRows(
          fixedScheduleInput(amount, Date.now()),
        );
        const proposedMonthly = round2(
          (rowsPreview[0]?.totalDue ?? amount) *
            (MONTH_FACTOR[FIXED_LOAN_TERMS.frequency] ?? 1),
        );
        const eligibility = eligibilityFor(
          client,
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

        appSeq += 1;
        const appId = `LA${String(appSeq).padStart(6, "0")}`;
        const applicationId = await ctx.db.insert("loanApplications", {
          appId,
          clientId,
          amount,
          staffId: me._id,
          branchId,
          centerId: center._id,
          status: "SUBMITTED",
          history: [
            {
              actorId: me._id,
              actorName: me.name,
              role: me.role,
              action: "SUBMITTED",
              remark: `Centre-wise disbursement — ${fmtId(center.code)} · ${center.name}${remark ? ` — ${remark}` : ""}`,
              at: now,
            },
          ],
          eligibility,
          submittedAt: now,
          createdAt: now,
        });
        record = { clientId, code: client.code, name: client.name, applicationId, appId };
      } catch (err) {
        // Partial-batch reporting: one member's failure never rolls back
        // the rest — it is surfaced with its exact reason instead.
        skipped.push({
          clientId,
          code: client?.code ?? "—",
          name: client?.name ?? "Unknown client",
          reason: err instanceof Error ? err.message : "Could not create application.",
        });
      }
      if (record) {
        created.push(record);
        await logAudit(ctx, {
          actorId: me._id,
          actorName: me.name,
          role: me.role,
          action: "LOAN_APPLIED",
          entity: "loanApplications",
          entityId: record.appId,
          after: {
            client: record.name,
            amount,
            terms: `${FIXED_LOAN_TERMS.interestRate}% ${FIXED_LOAN_TERMS.interestMethod} · ${FIXED_LOAN_TERMS.tenure} ${FIXED_LOAN_TERMS.frequency}`,
            center: center.code,
            mode: "CENTRE_WISE_BATCH",
          },
          referenceId: record.appId,
          branchId,
          device: args.device,
        });
      }
    }

    // Notify branch decision makers ONCE for the whole batch.
    if (created.length > 0) {
      const profiles = await ctx.db.query("profiles").collect();
      for (const p of profiles) {
        if (
          (p.role === "BRANCH_MANAGER" || p.role === "SUPER_ADMIN") &&
          p.branchId === branchId &&
          p.status === "ACTIVE"
        ) {
          await notify(ctx, p._id, {
            title: "Centre-wise loan batch submitted",
            body: `${created.length} loan request(s) at ₹${amount.toLocaleString("en-IN")} each — ${center.name} (${fmtId(center.code)}) from ${me.name}.`,
            kind: "APPROVAL",
            link: `/dashboard/approvals`,
          });
        }
      }
    }

    return {
      ok: skipped.length === 0,
      centerCode: center.code,
      centerName: center.name,
      createdCount: created.length,
      skippedCount: skipped.length,
      created,
      skipped,
    };
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

    // Re-run policy AND re-derive the schedule on the server at approval
    // time — approval never trusts a stored or client-supplied figure.
    if (client) {
      const loans = (await ctx.db.query("loans").collect()).filter(
        (l) => l.clientId === app.clientId,
      );
      const active = loans.filter((l) => ["ACTIVE", "OVERDUE"].includes(l.status));
      const existingObligations = round2(
        active.reduce((s, l) => s + l.installment * (MONTH_FACTOR[l.frequency] ?? 1), 0),
      );
      const rowsPreview = baseScheduleRows(
        fixedScheduleInput(app.amount, now),
      );
      const proposedMonthly = round2(
        (rowsPreview[0]?.totalDue ?? app.amount) *
          (MONTH_FACTOR[FIXED_LOAN_TERMS.frequency] ?? 1),
      );
      const eligibility = eligibilityFor(
        client,
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
          (max, l) =>
            Math.max(max, Number(String(l.loanId).replace(/\D/g, "") || 0)),
          0,
        ) + 1;
      const loanId = `LN${String(loanSeq).padStart(6, "0")}`;

      const previewRows = rowsPreview;
      // No separately authorized fee rule → no fee on this loan.
      const charges = authorizedCharges(app.amount);

      const loanDocId = await ctx.db.insert("loans", {
        loanId,
        applicationId,
        clientId: app.clientId,
        staffId: app.staffId,
        branchId: app.branchId,
        // Every loan traces back to the client's centre (centre-wise batches
        // record it at application time; single loans inherit it here).
        centerId: app.centerId ?? client?.centerId,
        principal: app.amount,
        interestTotal: round2(previewRows.reduce((s, r) => s + r.interest, 0)),
        charges,
        totalPayable: 0,
        installment: previewRows[0]?.totalDue ?? app.amount,
        frequency: FIXED_LOAN_TERMS.frequency,
        tenure: FIXED_LOAN_TERMS.tenure,
        interestRate: FIXED_LOAN_TERMS.interestRate,
        interestMethod: FIXED_LOAN_TERMS.interestMethod,
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

    throw new AppError("Client missing for approval.");
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

/* ------------------ SUPER_ADMIN closure operations ---------------------- */

/**
 * Authorization for every sensitive closure operation: the real authenticated
 * profile's role is checked INSIDE the backend mutation — hiding a button in
 * the UI is never the control.
 */
async function requireSuperAdmin(ctx: MutationCtx): Promise<Doc<"profiles">> {
  const me = await requireProfile(ctx);
  if (me.role !== "SUPER_ADMIN") {
    throw new PermissionError(
      "Only a SUPER_ADMIN can perform this operation.",
    );
  }
  if (me.status !== "ACTIVE") {
    throw new PermissionError(
      `Your account is ${me.status.toLowerCase()} — this operation is blocked.`,
    );
  }
  return me;
}

/** Mandatory, meaningful reason for surrender / settlement / deletion. */
function closureReason(value: unknown): string {
  const reason = requiredString(value, "reason", 500);
  if (reason.length < 5) {
    throw new ValidationError(
      "Invalid reason: give a reason of at least 5 characters.",
    );
  }
  return reason;
}

/** SUPER_ADMIN: terminate a loan before its normal completion. */
export const surrender = mutation({
  args: {
    loanId: v.id("loans"),
    reason: v.string(),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireSuperAdmin(ctx);
    return await surrenderLoan(ctx, {
      loanId: args.loanId,
      actor: me,
      reason: closureReason(args.reason),
      device: args.device,
    });
  },
});

/** SUPER_ADMIN: settle a loan — payment vs waiver recorded separately. */
export const settle = mutation({
  args: {
    loanId: v.id("loans"),
    settlementAmount: v.number(),
    mode: v.string(),
    reason: v.string(),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireSuperAdmin(ctx);
    const amount = money(args.settlementAmount, "settlementAmount", {
      allowZero: true,
    });
    const mode = oneOf(args.mode, ["CASH", "UPI", "BANK"], "mode");
    return await settleLoan(ctx, {
      loanId: args.loanId,
      actor: me,
      settlementAmount: amount,
      mode,
      reason: closureReason(args.reason),
      device: args.device,
    });
  },
});

/** SUPER_ADMIN: close a loan whose dues are genuinely cleared. */
export const close = mutation({
  args: {
    loanId: v.id("loans"),
    reason: v.optional(v.string()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireSuperAdmin(ctx);
    return await closeLoan(ctx, {
      loanId: args.loanId,
      actor: me,
      reason: args.reason?.trim() ? closureReason(args.reason) : undefined,
      device: args.device,
    });
  },
});

/** SUPER_ADMIN: archive a closed/settled loan (safe removal). */
export const archive = mutation({
  args: {
    loanId: v.id("loans"),
    reason: v.optional(v.string()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireSuperAdmin(ctx);
    return await archiveLoan(ctx, {
      loanId: args.loanId,
      actor: me,
      reason: args.reason?.trim() ? closureReason(args.reason) : undefined,
      device: args.device,
    });
  },
});

/**
 * SUPER_ADMIN: permanently delete a closed/settled loan ONLY when no
 * financial record references it; otherwise the mutation refuses and points
 * at the archive workflow.
 */
export const deleteClosed = mutation({
  args: {
    loanId: v.id("loans"),
    reason: v.string(),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireSuperAdmin(ctx);
    return await deleteLoanRecord(ctx, {
      loanId: args.loanId,
      actor: me,
      reason: closureReason(args.reason),
      device: args.device,
    });
  },
});

export { completedMonthsBetween };
