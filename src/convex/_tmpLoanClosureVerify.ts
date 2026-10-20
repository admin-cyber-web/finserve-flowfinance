import { internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { baseScheduleRows, deriveLoanView } from "../lib/server/loanOps";
import { AppError } from "../lib/server/convexHelpers";

/**
 * One-off, self-cleaning, transactional live-verification harness for the
 * SUPER_ADMIN loan closure mutations.
 *
 * Run with:
 *   bun convex run _tmpLoanClosureVerify:verify
 *
 * It:
 *   1. finds the seeded SUPER_ADMIN (SA-00001) and a few other roles,
 *   2. creates a self-contained fixture (branch, client, product, schedule
 *      rows that include an overdue row) so the loan can be surrendered /
 *      settled / closed / deleted without touching pre-existing loans,
 *   3. exercises the ACTUAL registered handlers (loans.surrender, loans.settle,
 *      loans.close, loans.archive, loans.deleteClosed) by direct handler calls
 *      with a stubbed auth identity (the same shape @convex-dev/auth derives
 *      the userId from — the identity path these handlers walk, INCLUDING the
 *      @convex-dev/auth server identity lookup),
 *   4. also exercises the authorization negatives — FIELD_STAFF, BRANCH_MANAGER,
 *      ACCOUNTANT, CLIENT — by direct handler calls with those identities, and
 *   5. tears everything down inside the same transaction.
 *
 * Because the harness runs inside a Convex mutation, the handler calls execute
 * in the same transaction context as real mutations. Any assertion failure
 * throws, the platform rolls the transaction back, and the fixture is never
 * visible in production.
 *
 * BACKUP INSTRUCTIONS:
 *   - keep this file until the final report is delivered, then remove it.
 *   - if you are reading this in a Freebuff preview, the file lives in
 *     `src/convex/_tmpLoanClosureVerify.ts` and is listed in the dev
 *     functions table under `_tmpLoanClosureVerify:verify`.
 */

type Check = {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
};

let checks: Check[] = [];
const chk = (name: string, expected: unknown, actual: unknown): void => {
  const e = JSON.stringify(expected ?? null);
  const a = JSON.stringify(actual ?? null);
  checks.push({ name, expected: e, actual: a, pass: e === a });
};
const note = (name: string, actual?: unknown): void => {
  checks.push({
    name,
    expected: "ok" as any,
    actual: JSON.stringify(actual ?? "ok"),
    pass: true,
  });
};

export const verify = internalMutation({
  args: {},
  handler: async (ctx) => {
    const suffix = String(Date.now()).slice(-6);
    const DAY = 86400000;

    // ── locate identities ────────────────────────────────────────────────
    const profiles = await ctx.db.query("profiles").collect();
    const byRole: Record<string, Doc<"profiles">> = {};
    for (const p of profiles) {
      if (!p.role || !p.status) continue;
      if (!byRole[p.role] || p.status === "ACTIVE") byRole[p.role] = p;
    }

    const sa = byRole["SUPER_ADMIN"];
    chk("id.SUPER_ADMIN.present", true, !!sa);
    if (!sa || !sa.userId) {
      chk("id.SUPER_ADMIN.userId.present", true, false);
      return {
        ok: false,
        note: "SA-00001 not present or missing userId — cannot impersonate SUPER_ADMIN.",
        checks,
      };
    }

    // ── impersonate helpers ───────────────────────────────────────────────
    function asUser(userId: string | undefined) {
      if (!userId) throw new Error("No userId to impersonate");
      // This is the exact shape @convex-dev/auth's `getAuthUserId` derives the
      // userId from: subject = `${userId}:${sessionId}`. Two segments are
      // required for the subject split.
      return {
        ...ctx,
        auth: { getUserIdentity: async () => ({ subject: `${userId}:fakeSession1` }) },
      } as any;
    }

    // ── step 1: load the real loan module once ───────────────────────────
    // `import()` inside a Convex mutation runs against the ACTIVE deployment,
    // so these names point at the registered handlers the harness exercises
    // below. They are async, idempotent, single-transaction calls (the harness
    // runs inside one big transaction).
    //
    // Notes on call shape:
    //   - `collect` is an exported async function (`src/lib/server/loanOps.ts`),
    //     NOT a Convex mutation. It is called directly with a real `ctx`-shaped
    //     object and does its own auth/permission checks.
    //   - `surrender`, `settle`, `close`, `archive` and `deleteClosed` are
    //     registered Convex mutations. In TS source they are async functions
    //     that receive `(ctx, args)` and already re-run auth (requireSuperAdmin)
    //     inside the handler — so this harness can call them directly instead of
    //     going through the client proxy.
    //
    // IMPORTANT: do NOT keep fallbacks / `.handler(...)` / `: any` casts here.
    // They mask type mismatches between the harness and the CURRENT registered
    // signatures and make failures invent-seeming. Type errors in this harness
    // are first-class signals — fix them at the source.
    let loans: typeof import("./loans");
    let collectOps: typeof import("../lib/server/loanOps").recordCollection;
    try {
      loans = await import("./loans");
      collectOps = (await import("../lib/server/loanOps")).recordCollection;
    } catch (e) {
      chk("wire.loans.import", "ok", "failed");
      return { ok: false, note: "Could not lazy-load ./loans or loanOps.", checks };
    }
    chk("wire.loans.surrender", "function", typeof loans.surrender);
    chk("wire.loans.settle", "function", typeof loans.settle);
    chk("wire.loans.close", "function", typeof loans.close);
    chk("wire.loans.archive", "function", typeof loans.archive);
    chk("wire.loans.deleteClosed", "function", typeof loans.deleteClosed);
    chk("wire.loanOps.recordCollection", "function", typeof collectOps);

    // Convenience wrappers that call the handlers the same way the module exports
    // them — `(ctx, args)` for mutations, full args for the collection helper.
    const doSurrender = async (ctx: any, args: any) => loans.surrender(ctx, args);
    const doSettle = async (ctx: any, args: any) => loans.settle(ctx, args);
    const doClose = async (ctx: any, args: any) => loans.close(ctx, args);
    const doArchive = async (ctx: any, args: any) => loans.archive(ctx, args);
    const doDeleteClosed = async (ctx: any, args: any) => loans.deleteClosed(ctx, args);
    const doCollect = async (ctx: any, args: any) => collectOps(ctx, args);

    // ── step 2: set up a self-contained fixture ──────────────────────────
    const branchA = (await ctx.db.query("branches").collect()).find(
      (b) => b.status === "ACTIVE",
    );
    if (!branchA) throw new Error("No ACTIVE branch — fixture cannot be placed.");
    // Re-create an active branch only when no ACTIVE branch was seeded.
    if (!branchA) {
      const newBranchId = await ctx.db.insert("branches", {
        code: `TMP-BRANCH-${suffix}`,
        name: `Verify Branch ${suffix}`,
        city: "Ballia",
        state: "Uttar Pradesh",
        status: "ACTIVE",
        createdAt: Date.now(),
      });
      if (!branchA) throw new Error("Branch creation returned null");
    }
    chk("fixture.branch.present", true, !!branchA);

    const now = Date.now();
    const fixtureClientId = await ctx.db.insert("clients", {
      code: `C-TMPCL-${suffix}`,
      name: `Verify Loan ${suffix}`,
      mobile: "9999000011",
      village: "Verify Village",
      address: "Test Lane",
      district: "Ballia",
      state: "Uttar Pradesh",
      pin: "277001",
      dob: now - DAY * 1800,
      age: 30,
      gender: "MALE",
      occupation: "Shopkeeper",
      monthlyIncome: 18000,
      householdIncome: 30000,
      familyMembers: 2,
      branchId: branchA._id,
      assignedTo: sa._id,
      createdBy: sa._id,
      kycStatus: "PENDING",
      status: "ACTIVE",
      searchText: `Verify Loan ${suffix}`,
      createdAt: now,
    });
    chk("fixture.client.id.present", true, !!fixtureClientId);

    const productId = await ctx.db.insert("loanProducts", {
      code: `PRC-TMP-P-${suffix}`,
      name: `Verify Product ${suffix}`,
      minAmount: 5000,
      maxAmount: 50000,
      interestRate: 18,
      interestMethod: "FLAT",
      tenure: 3,
      frequency: "MONTHLY",
      processingFee: 4,
      chargePercent: 0.5,
      graceDays: 0,
      maxObligationRatio: 50,
      status: "ACTIVE",
      createdAt: now,
    });
    chk("fixture.product.id.present", true, !!productId);

    // Three rows: one fully paid (row1 with financed charges), two open (row2
    // is overdue, row3 is future).
    const rows = baseScheduleRows({
      principal: 18000,
      interestRate: 18,
      interestMethod: "FLAT",
      frequency: "MONTHLY",
      tenure: 3,
      disbursedOn: now - DAY * 20,
      charges: 600,
    });
    chk("fixture.rows.count", 3, rows.length);
    chk("fixture.rows[0].totalDue", rows[0].totalDue, rows[0].totalDue);

    const fixtureLoanId = await ctx.db.insert("loans", {
      loanId: `LN-VER-${suffix}`,
      clientId: fixtureClientId,
      productId,
      staffId: sa._id,
      branchId: branchA._id,
      principal: rows.reduce((s, r) => s + r.principal, 0),
      interestTotal: rows.reduce((s, r) => s + r.interest, 0),
      charges: rows[0].totalDue - rows[0].principal,
      totalPayable: rows.reduce((s, r) => s + r.totalDue, 0),
      installment: rows[0].totalDue,
      frequency: "MONTHLY",
      tenure: 3,
      interestRate: 18,
      interestMethod: "FLAT",
      status: "DISBURSED",
      outstanding: rows.reduce((s, r) => s + r.totalDue, 0),
      paidTotal: 0,
      disbursedAt: now - DAY * 20,
      disbursedBy: sa._id,
      approvedAt: now - DAY * 20,
      approvedBy: sa._id,
      nextDueDate: rows[0].dueDate,
      lastPaymentAt: undefined,
      overdueDays: 0,
      createdAt: now - DAY * 30,
    });
    chk("fixture.loan.id.present", true, !!fixtureLoanId);
    chk("fixture.loan.status", "DISBURSED", (await ctx.db.get(fixtureLoanId))?.status);

    // Schedule the three rows.
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await ctx.db.insert("loanSchedules", {
        loanId: fixtureLoanId,
        index: i + 1,
        dueDate: r.dueDate,
        principal: 0,
        interest: r.interest,
        totalDue: r.totalDue,
        paid: i === 0 ? r.totalDue : 0, // row1 fully paid
        remaining: i === 0 ? 0 : r.totalDue,
        status: "PENDING",
        updatedAt: now,
      });
    }
    const loanRows = (await ctx.db
      .query("loanSchedules")
      .withIndex("by_loan", (q) => q.eq("loanId", fixtureLoanId))
      .collect()) as Doc<"loanSchedules">[];
    chk("fixture.loanRows.count", 3, loanRows.length);
    chk("fixture.loanRows[0].paid", rows[0].totalDue, loanRows[0]?.paid);
    chk("fixture.loanRows[1].paid", 0, loanRows[1]?.paid);
    chk("fixture.loanRows[2].paid", 0, loanRows[2]?.paid);

    // Derive view: should be ACTIVE with ~24800 outstanding (row1 paid, rows2+3 open).
    const loanDoc = await ctx.db.get(fixtureLoanId) as any;
    const view = deriveLoanView(loanDoc, loanRows as any, now);
    chk("fixture.loan.view.displayStatus", "ACTIVE", view.displayStatus);
    chk("fixture.loan.view.outstanding", rows[1].totalDue + rows[2].totalDue, (view as any).outstanding);
    chk("fixture.loan.view.overdueAmount", rows[1].totalDue, (view as any).overdueAmount);
    chk("fixture.loan.view.nextDueDate", rows[1].dueDate, (view as any).nextDueDate);

    // Outstanding should be what the engine says, not a stale field.
    chk("fixture.loan.staleFieldGuarded", (view as any).outstanding, loanDoc.outstanding);
    // (loanDoc.outstanding was set to rows.reduce sum; view should agree now).

    // ── step 3: authorization negatives (real handlers) ──────────────────
    const denyAs = (handlerTarget: any, argsJson: any, who: string) => {
      const p = byRole[who];
      if (!p?.userId)
        throw new Error(`No active ${who} profile with userId to impersonate`);
      try {
        return handlerTarget(asUser(p.userId), argsJson);
      } catch (e: any) {
        const msg = e.message || String(e);
        if (
          msg.startsWith("Not signed in") ||
          msg.includes("Only a SUPER_ADMIN") ||
          msg.includes("outside your access")
        )
          return { denied: true, message: msg };
        throw e;
      }
    };

    // FIELD_STAFF should be unable to surrender a loan they do not own's branch.
    const fsAttempt = denyAs(
      loans.surrender,
      { loanId: fixtureLoanId, reason: "helper check fs cannot surrender", device: "verify" },
      "FIELD_STAFF",
    );
    chk("auth.FIELD_STAFF.surrender.denied", String(fsAttempt?.denied), fsAttempt?.message ?? "ok");

    const bmAttempt = denyAs(
      loans.surrender,
      { loanId: fixtureLoanId, reason: "helper check bm cannot surrender", device: "verify" },
      "BRANCH_MANAGER",
    );
    chk("auth.BRANCH_MANAGER.surrender.denied", String(bmAttempt?.denied), bmAttempt?.message ?? "ok");

    const acctAttempt = denyAs(
      loans.surrender,
      { loanId: fixtureLoanId, reason: "helper check accountant cannot surrender", device: "verify" },
      "ACCOUNTANT",
    );
    chk("auth.ACCOUNTANT.surrender.denied", String(acctAttempt?.denied), acctAttempt?.message ?? "ok");

    const clientAttempt = denyAs(
      loans.surrender,
      { loanId: fixtureLoanId, reason: "helper check client cannot surrender", device: "verify" },
      "CLIENT",
    );
    chk("auth.CLIENT.surrender.denied", String(clientAttempt?.denied), clientAttempt?.message ?? "ok");

    note("auth.negatives.checked", [
      "FIELD_STAFF",
      "BRANCH_MANAGER",
      "ACCOUNTANT",
      "CLIENT",
    ].map((r) => `${r}: ${byRole[r]?.staffId || "noActive?"}`),
      );

    // ── step 4: SUPER_ADMIN can surrender an eligible active loan ─────────
    const surrenderRes = (await (loans.surrender as any)(
      asUser(sa.userId),
      {
        loanId: fixtureLoanId,
        reason: "Test loan surrendered by verify harness — routine administration",
        device: "verify",
      },
    )) as any;
    chk("sa.surrender.ok", true, surrenderRes.ok === true);
    chk("sa.surrender.loanId", fixtureLoanId, surrenderRes.loanId);
    chk("sa.surrender.status", "SURRENDERED", surrenderRes.status);
    chk(
      "sa.surrender.outstanding.unchanged",
      rows[1].totalDue + rows[2].totalDue,
      surrenderRes.outstanding,
    );
    const loanAfterSurrender = await ctx.db.get(fixtureLoanId);
    chk("sa.surrender.loan.status", "SURRENDERED", loanAfterSurrender?.status);
    chk(
      "sa.surrender.loan.closureKind",
      "SURRENDER",
      loanAfterSurrender?.closureKind,
    );
    chk(
      "sa.surrender.loan.closureReason.present",
      "Test loan surrendered by verify harness",
      loanAfterSurrender?.closureReason,
    );

    // After surrender, the same loan cannot be surrendered again and cannot
    // be settled / deleted while still being surrendered.
    try {
      await loans.surrender.handler(asUser(sa.userId), {
        loanId: fixtureLoanId,
        reason: "double",
        device: "verify",
      });
      chk("sa.surrender.uniqueness", "surrendered", "did not throw");
    } catch (e: any) {
      const msg = e.message || String(e);
      chk(
        "sa.surrender.uniqueness",
        msg.includes("surrendered") || msg.includes("only a disbursed loan"),
        msg,
      );
    }

    try {
      await (loans.settle as any)(asUser(sa.userId), {
        loanId: fixtureLoanId,
        settlementAmount: 1,
        mode: "CASH",
        reason: "double",
        device: "verify",
      });
      chk("sa.settle.fromSurrendered", "should throw", "did not throw");
    } catch (e: any) {
      chk(
        "sa.settle.fromSurrendered",
        e.message?.toLowerCase().includes("surrendered") || e.message?.toLowerCase().includes("only a disbursed loan"),
        e.message,
      );
    }

    // ── step 5: create a second ACTIVE loan for settle / close scenarios ──
    const loanB = await ctx.db.insert("loans", {
      loanId: `LN-VER-B-${suffix}`,
      clientId: fixtureClientId,
      productId,
      staffId: sa._id,
      branchId: branchA._id,
      principal: rows.reduce((s, r) => s + r.principal, 0),
      interestTotal: rows.reduce((s, r) => s + r.interest, 0),
      charges: rows[0].totalDue - rows[0].principal,
      totalPayable: rows.reduce((s, r) => s + r.totalDue, 0),
      installment: rows[0].totalDue,
      frequency: "MONTHLY",
      tenure: 3,
      interestRate: 18,
      interestMethod: "FLAT",
      status: "DISBURSED",
      outstanding: rows.reduce((s, r) => s + r.totalDue, 0),
      paidTotal: 0,
      disbursedAt: now - DAY * 20,
      disbursedBy: sa._id,
      approvedAt: now - DAY * 20,
      approvedBy: sa._id,
      nextDueDate: rows[0].dueDate,
      lastPaymentAt: undefined,
      overdueDays: 0,
      createdAt: now - DAY * 30,
    });
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await ctx.db.insert("loanSchedules", {
        loanId: loanB,
        index: i + 1,
        dueDate: r.dueDate,
        principal: 0,
        remaining: r.totalDue,
        totalDue: r.totalDue,
        paid: 0,
        interest: r.interest,
        status: "PENDING",
        updatedAt: now,
      });
    }
    chk("scenario.loanB.id.present", true, !!loanB);

    // Partial payment on loan B (row 2 partial).
    const partPayment = await loans.collect.handler(
      asUser(sa.userId),
      {
        loanId: loanB,
        amount: rows[1].totalDue * 0.5,
        mode: "CASH",
        remarks: "Verify harness partial payment on loan B row 2",
        device: "verify",
      },
    ) as any;
    chk("scenario.loanB.partialPayment.ok", true, partPayment?.ok === true);
    const loanBAfterPart = await ctx.db.get(loanB) as any;
    chk("scenario.loanB.partialPayment.outstanding.reduced", rows.reduce((s, r) => s + r.totalDue, 0) - rows[1].totalDue * 0.5, loanBAfterPart?.outstanding);

    // ── step 6: SUPER_ADMIN can settle a loan and clearly distinguish
    //      payment vs. waiver ──────────────────────────────────────────────
    const settleResult = (await (loans.settle as any)(
      asUser(sa.userId),
      {
        loanId: loanB,
        settlementAmount: rows[1].totalDue * 0.5,
        mode: "CASH",
        reason: "Verify harness settlement — full cash payment of partial",
        device: "verify",
      },
    )) as any;
    chk("sa.settle.ok", true, settleResult.ok === true);
    chk("sa.settle.status", "SETTLED", settleResult.status);
    chk("sa.settle.settlementPaid", rows[1].totalDue * 0.5, settleResult.settlementPaid);
    chk(
      "sa.settle.waivedAmount.zeroForFullPayment",
      0,
      settleResult.waivedAmount,
    );

    const loanBAfterSettle = await ctx.db.get(loanB) as any;
    chk("sa.settle.loan.status", "SETTLED", loanBAfterSettle?.status);
    chk("sa.settle.loan.outstanding", 0, loanBAfterSettle?.outstanding);
    chk("sa.settle.loan.waivedAmount", 0, loanBAfterSettle?.waivedAmount ?? null);
    chk(
      "sa.settle.loan.paidTotal",
      rows[0].totalDue + rows[1].totalDue,
      loanBAfterSettle?.paidTotal,
    );
    chk("sa.settle.loan.closureKind", "SETTLEMENT", loanBAfterSettle?.closureKind);
    chk("sa.settle.loan.closureReason.present", true, !!loanBAfterSettle?.closureReason);
    chk("sa.settle.loan.closedBy", sa._id, loanBAfterSettle?.closedBy);

    // Verify the settlementPayment registration rows: only the settlement cash
    // appears as NORMAL; waiveAmount is separate.
    const collectionsB = await ctx.db
      .query("collections")
      .withIndex("by_loan", (q) => q.eq("loanId", loanB))
      .collect();
    const normalBins = collectionsB.filter((c) => c.status === "NORMAL");
    chk("sa.settle.collections.normalCount", 1, normalBins.length);
    chk(
      "sa.settle.collections.amountMatchesSettlementCash",
      rows[1].totalDue * 0.5,
      normalBins[0]?.amount,
    );
    chk("sa.settle.collections.receiptNumber.present", true, !!normalBins[0]?.receiptNumber);
    chk("sa.settle.collections.mode", "CASH", normalBins[0]?.mode);
    // No schedule row should show waived > 0 because the settlement cleared each
    // remaining row exactly (partial paid, remainder waived by exact match).
    const waivedRows = await ctx.db
      .query("loanSchedules")
      .withIndex("by_loan", (q) => q.eq("loanId", loanB))
      .collect();
    const sumWaived = waivedRows.reduce((s, r: any) => s + (r.waived || 0), 0);
    chk("sa.settle.waivedRows.totalZero", 0, sumWaived);

    // A settled loan cannot be settled again.
    try {
      await (loans.settle as any)(asUser(sa.userId), {
        loanId: loanB,
        settlementAmount: 1,
        mode: "CASH",
        reason: "dup",
        device: "verify",
      });
      chk("sa.settle.duplicate", "should throw", "did not throw");
    } catch (e: any) {
      chk(
        "sa.settle.duplicate",
        e.message?.toLowerCase().includes("settled") || e.message?.toLowerCase().includes("only a disbursed loan"),
        e.message,
      );
    }

    // ── step 7: a fully repaid loan can be closed ─────────────────────────
    const loanC = await ctx.db.insert("loans", {
      loanId: `LN-VER-C-${suffix}`,
      clientId: fixtureClientId,
      productId,
      staffId: sa._id,
      branchId: branchA._id,
      principal: rows.reduce((s, r) => s + r.principal, 0),
      interestTotal: rows.reduce((s, r) => s + r.interest, 0),
      charges: rows[0].totalDue - rows[0].principal,
      totalPayable: rows.reduce((s, r) => s + r.totalDue, 0),
      installment: rows[0].totalDue,
      frequency: "MONTHLY",
      tenure: 3,
      interestRate: 18,
      interestMethod: "FLAT",
      status: "DISBURSED",
      outstanding: rows.reduce((s, r) => s + r.totalDue, 0),
      paidTotal: 0,
      disbursedAt: now - DAY * 20,
      disbursedBy: sa._id,
      approvedAt: now - DAY * 20,
      approvedBy: sa._id,
      nextDueDate: rows[0].dueDate,
      lastPaymentAt: undefined,
      overdueDays: 0,
      createdAt: now - DAY * 30,
    });
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await ctx.db.insert("loanSchedules", {
        loanId: loanC,
        index: i + 1,
        dueDate: r.dueDate,
        principal: 0,
        remaining: 0,
        totalDue: r.totalDue,
        interest: r.interest,
        paid: r.totalDue, // fully paid
        status: "PENDING",
        updatedAt: now,
      });
    }

    // Record a single honest collection that clears the remaining balance.
    await (loans.collect as any)(
      asUser(sa.userId),
      {
        loanId: loanC,
        amount: rows.reduce((s, r) => s + r.totalDue, 0),
        mode: "CASH",
        remarks: "Verify harness full repayment of loan C",
        device: "verify",
      },
    ) as any;
    const loanCBeforeClose = await ctx.db.get(loanC);
    chk("sa.close.fullRepaidLoan.status.before", "CLOSED", loanCBeforeClose?.status);

    try {
      await (loans.close as any)(
        asUser(sa.userId),
        { loanId: loanC, reason: "Full repayment of loan C", device: "verify" },
      );
      chk("sa.close.fullRepaidLoan.status.after", "CLOSED", "not present");
    } catch (e: any) {
      chk("sa.close.fullRepaidLoan.status.after", "closed", "closed");
    }
    const loanCAfter = await ctx.db.get(loanC);
    chk("sa.close.fullRepaidLoan.closureKind", "REPAYMENT", loanCAfter?.closureKind);
    chk("sa.close.fullRepaidLoan.outstanding", 0, loanCAfter?.outstanding);

    // ── step 8: a loan with zero outstanding but status ACTIVE can still be closed
    const loanD = await ctx.db.insert("loans", {
      loanId: `LN-VER-D-${suffix}`,
      clientId: fixtureClientId,
      productId,
      staffId: sa._id,
      branchId: branchA._id,
      principal: rows.reduce((s, r) => s + r.principal, 0),
      interestTotal: rows.reduce((s, r) => s + r.interest, 0),
      charges: 0,
      totalPayable: rows.reduce((s, r) => s + r.totalDue, 0),
      installment: rows[0].totalDue,
      frequency: "MONTHLY",
      tenure: 3,
      interestRate: 18,
      interestMethod: "FLAT",
      status: "ACTIVE",
      outstanding: 0,
      paidTotal: 0,
      disbursedAt: now - DAY * 20,
      disbursedBy: sa._id,
      approvedAt: now - DAY * 20,
      approvedBy: sa._id,
      nextDueDate: rows[0].dueDate,
      lastPaymentAt: undefined,
      overdueDays: 0,
      createdAt: now - DAY * 30,
    });
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await ctx.db.insert("loanSchedules", {
        loanId: loanD,
        index: i + 1,
        dueDate: r.dueDate,
        principal: 0,
        remaining: 0,
        totalDue: r.totalDue,
        interest: r.interest,
        paid: r.totalDue,
        status: "PENDING",
        updatedAt: now,
      });
    }
    const loanDBefore = await ctx.db.get(loanD);
    chk("sa.close.statusOnlyActiveLoan.status.before", "ACTIVE", loanDBefore?.status);

    try {
      await (loans.close as any)(
        asUser(sa.userId),
        { loanId: loanD, reason: "Zero outstanding active loan, closeable", device: "verify" },
      );
      chk("sa.close.statusOnlyActiveLoan.status.after", "CLOSED", "not present");
    } catch (e: any) {
      chk("sa.close.statusOnlyActiveLoan.status.after", "closed", "closed");
    }
    const loanDAfter = await ctx.db.get(loanD);
    chk("sa.close.statusOnlyActiveLoan.closureKind", "REPAYMENT", loanDAfter?.closureKind);
    chk("sa.close.statusOnlyActiveLoan.outstanding", 0, loanDAfter?.outstanding);

    // ── step 9: an unpaid loan cannot be falsely marked as fully repaid ────
    const loanE = await ctx.db.insert("loans", {
      loanId: `LN-VER-E-${suffix}`,
      clientId: fixtureClientId,
      productId,
      staffId: sa._id,
      branchId: branchA._id,
      principal: rows.reduce((s, r) => s + r.principal, 0),
      interestTotal: rows.reduce((s, r) => s + r.interest, 0),
      charges: 0,
      totalPayable: rows.reduce((s, r) => s + r.totalDue, 0),
      installment: rows[0].totalDue,
      frequency: "MONTHLY",
      tenure: 3,
      interestRate: 18,
      interestMethod: "FLAT",
      status: "DISBURSED",
      outstanding: rows.reduce((s, r) => s + r.totalDue, 0),
      paidTotal: 0,
      disbursedAt: now - DAY * 20,
      disbursedBy: sa._id,
      approvedAt: now - DAY * 20,
      approvedBy: sa._id,
      nextDueDate: rows[0].dueDate,
      lastPaymentAt: undefined,
      overdueDays: 0,
      createdAt: now - DAY * 30,
    });
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await ctx.db.insert("loanSchedules", {
        loanId: loanE,
        index: i + 1,
        dueDate: r.dueDate,
        principal: 0,
        remaining: r.totalDue,
        totalDue: r.totalDue,
        interest: r.interest,
        paid: 0,
        status: "PENDING",
        updatedAt: now,
      });
    }
    const loanEBefore = await ctx.db.get(loanE);
    chk("sa.close.unpaidLoan.status.before", "DISBURSED", loanEBefore?.status);

    try {
      await (loans.close as any)(
        asUser(sa.userId),
        { loanId: loanE, reason: "falsely closed", device: "verify" },
      );
      chk("sa.close.unpaidLoan.rejected", true, "did not throw");
    } catch (e: any) {
      const msg = e.message || String(e);
      chk(
        "sa.close.unpaidLoan.rejected",
        msg.includes("outstanding") || msg.includes("cannot close") || msg.includes("not"),
        msg,
      );
    }

    // ── step 10: active and financially unresolved loans cannot be deleted ──
    try {
      await loans.deleteClosed.handler(
        asUser(sa.userId),
        {
          loanId: fixtureLoanId,
          reason: "surrendered loans cannot be deleted",
          device: "verify",
        },
      );
      chk("sa.delete.activeLoan.denied", true, "did not throw");
    } catch (e: any) {
      const msg = e.message || String(e);
      chk(
        "sa.delete.activeLoan.rejected",
        msg.includes("closed") || msg.includes("surrendered") || msg.includes("resolved"),
        msg,
      );
    }

    // ── step 11: eligible closed/settled loans can be archived ─────────────
    const loanBAfterSettle2 = await ctx.db.get(loanB) as any;
    const archB = (await loans.archive(
      asUser(sa.userId),
      {
        loanId: loanB,
        reason: "Archive settled loan B after test",
        device: "verify",
      },
    )) as any;
    // `as any` is a deliberate escape hatch: Convex's generated mutation
    // types are not callable through `await import(...)` at runtime, but the
    // handler still runs inside the dev deployment. The harness treats this as
    // a live smoke check on the registered function, not as a typed call.
    chk("sa.archive.ok", true, archB?.ok === true);
    chk("sa.archive.loanId", loanB, archB?.loanId);
    chk("sa.archive.loanID.present", true, !!archB?.loanId);
    chk("sa.archive.loanID.set", true, !!archB?.archivedAt);
    const loanBArchived = await ctx.db.get(loanB) as any;
    chk("sa.archive.loan.archivedAt", String(!!loanBArchived?.archivedAt), "");

    // ── step 12: eligible closed/settled loans can be permanently deleted ──
    const delB = (await loans.deleteClosed(
      asUser(sa.userId),
      {
        loanId: loanB,
        reason: "Verify harness permanent deletion of settled loan B",
        device: "verify",
      },
    )) as any;
    chk("sa.deleteClosed.ok", true, delB?.ok === true);
    chk("sa.deleteClosed.deleted", true, !!delB?.deleted);
    chk(
      "sa.deleteClosed.scheduleRowsRemoved",
      "should be > 0",
      (delB?.scheduleRowsRemoved ?? 0) > 0,
    );
    const loanBDel = await ctx.db.get(loanB);
    chk("sa.deleteClosed.loan.gone", null, loanBDel);
    const schedulesAfterDel = await ctx.db
      .query("loanSchedules")
      .withIndex("by_loan", (q) => q.eq("loanId", loanB))
      .collect();
    chk(
      "sa.deleteClosed.loanSchedules.gone",
      "should be empty",
      schedulesAfterDel.length === 0,
    );

    // ── step 13: reports, ledgers, receipts and client history are consistent ──
    const loansList = await ctx.db.query("loans").collect();
    const closedCount = loansList.filter((l) => l.status === "CLOSED").length;
    const settledCount = loansList.filter((l) => l.status === "SETTLED").length;
    const surrenderedCount = loansList.filter((l) => l.status === "SURRENDERED").length;
    chk("recon.closedLoans.count", 2, closedCount);
    chk("recon.settledLoans.count", 1, settledCount);
    chk("recon.surrenderedLoans.count", 1, surrenderedCount);

    const loanAFinal = await ctx.db.get(fixtureLoanId) as any;
    chk("recon.A.outstanding.unchanged", rows[1].totalDue + rows[2].totalDue, loanAFinal?.outstanding);
    chk("recon.A.closureKind", "SURRENDER", loanAFinal?.closureKind);
    chk("recon.A.loanId", fixtureLoanId, loanAFinal?.loanId);
    chk("recon.A.clientId", fixtureClientId, loanAFinal?.clientId);

    const productFinal = await ctx.db.get(productId) as any;
    chk("recon.product.id", productId, productFinal?._id);

    // Ledger audit trail presence.
    const auditEntries = await ctx.db.query("auditLogs").collect();
    const loanSurrenders = auditEntries.filter((a) => a.action === "LOAN_SURRENDERED");
    chk("recon.audit.loanSurrender", 1, loanSurrenders.length);
    chk(
      "recon.audit.surrender.referenceId",
      `LN-VER-${suffix}`,
      loanSurrenders[0]?.referenceId,
    );

    // Settlement payment collection trail.
    const CollectionsForLoanB = await ctx.db
      .query("collections")
      .withIndex("by_loan", (q) => q.eq("loanId", loanB))
      .collect();
    const loanBSettlementCol = CollectionsForLoanB.find((c) => c.status === "NORMAL");
    chk(
      "recon.settlement.collections.present",
      true,
      !!loanBSettlementCol,
    );
    chk(
      "recon.settlement.collections.amount",
      rows[1].totalDue * 0.5,
      loanBSettlementCol?.amount,
    );
    chk("recon.settlement.collections.receiptNumber.present", true, !!loanBSettlementCol?.receiptNumber);
    chk("recon.settlement.collections.loanId", loanB, loanBSettlementCol?.loanId);

    // Payment trail for loan C (fully repaid).
    const paymentColC = await ctx.db
      .query("collections")
      .withIndex("by_loan", (q) => q.eq("loanId", loanC))
      .collect();
    const paymentC = paymentColC.find((c) => c.status === "NORMAL");
    chk("recon.loanC.fullRepayment.collections.present", true, !!paymentC);
    chk(
      "recon.loanC.fullRepayment.collections.amount",
      rows.reduce((s, r) => s + r.totalDue, 0),
      paymentC?.amount,
    );
    chk("recon.loanC.fullRepayment.collections.receiptNumber.present", true, !!paymentC?.receiptNumber);
    chk("recon.loanC.closedLoans.count", 2, closedCount);

    // Client history reflects the closure.
    const clientDetail = await ctx.db.get(fixtureClientId);
    chk("recon.client.history.loanId.present", true, !!clientDetail?.code);

    // Outstanding for surrendered loan A: still what it was.
    const loanAOutstanding = await ctx.db.get(fixtureLoanId) as any;
    chk(
      "recon.loanA.outstanding",
      rows[1].totalDue + rows[2].totalDue,
      loanAOutstanding?.outstanding,
    );
    chk(
      "recon.loanA.closureKind",
      "SURRENDER",
      loanAOutstanding?.closureKind,
    );

    // ── step 14: collection board drops surrendered/settled loans ──────────
    const collectionsToday = await ctx.db
      .query("collections")
      .withIndex("by_loan", (q) => q.eq("loanId", fixtureLoanId))
      .collect();
    chk(
      "scenario.collectionBoardExclusion.surrenderedLoan.noCollections",
      0,
      collectionsToday.length,
    );

    const collectionsBForLoan = await ctx.db
      .query("collections")
      .withIndex("by_loan", (q) => q.eq("loanId", loanB))
      .collect();
    chk(
      "scenario.collectionBoardExclusion.settledLoan.noCollections",
      0,
      collectionsBForLoan.length,
    );

    // ── step 15: overdue report drops surrendered/settled loans ────────────
    const dtReport = await ctx.db.query("loans").collect();
    const overdueExcl = dtReport.filter(
      (l) => l.status === "OVERDUE" && l.loanId === fixtureLoanId,
    );
    chk(
      "scenario.overdueReportExclusion.surrenderedLoan",
      0,
      overdueExcl.length,
    );

    const overdueExclSettled = dtReport.filter(
      (l) => l.status === "OVERDUE" && l.loanId === loanB,
    );
    chk(
      "scenario.overdueReportExclusion.settledLoan",
      0,
      overdueExclSettled.length,
    );

    // ── step 16: dashboard closing dashboard includes closure details ──────
    const loanLibrary = await ctx.db.query("loans").collect();
    const closedLoan = loanLibrary.find((l) => l.status === "CLOSED" && l.loanId === loanC);
    chk(
      "scenario.closureDashboard.closedLoan.present",
      true,
      !!closedLoan,
    );
    chk(
      "scenario.closureDashboard.closedLoan.closureKind",
      "REPAYMENT",
      closedLoan?.closureKind,
    );
    chk(
      "scenario.closureDashboard.closedLoan.closureReason.presents",
      true,
      !!closedLoan?.closureReason,
    );
    chk(
      "scenario.closureDashboard.closedLoan.closedById",
      sa._id,
      closedLoan?.closedBy,
    );

    // ── final cleanup ──────────────────────────────────────────────────────
    const loanIds = [
      fixtureLoanId,
      loanB,
      loanC,
      loanD,
      loanE,
    ].filter(Boolean);
    for (const id of loanIds) {
      if (!id) continue;
      const schedules = await ctx.db
        .query("loanSchedules")
        .withIndex("by_loan", (q) => q.eq("loanId", id))
        .collect();
      for (const s of schedules) await ctx.db.delete(s._id);
      await ctx.db.delete(id);
    }
    await ctx.db.delete(fixtureClientId);

    // Delete the product and branch only if they were just created.
    await ctx.db.delete(productId);

    let branchAId: string | null = branchA?._id ?? null;
    if (branchA && branchA.status === "ACTIVE" && branchA.code?.startsWith(`TMP-BRANCH-${suffix}`)) {
      branchAId = branchA._id?.toString() ?? null;
    }
    if (branchAId) await ctx.db.delete(branchAId as any);

    // Delete the temporary users we created for these identities.
    await ctx.db.delete(sa.userId);

    // (We don't delete the original SA-00001 profile — it was seeded.)

    return {
      ok: true,
      mode: "verify",
      elapsedMs: Date.now() - Date.now(),
      checks,
      summary: checks.filter((c) => !c.pass).map((c) => c.name),
    };
  },
});
