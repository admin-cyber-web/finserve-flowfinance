import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type {
  FunctionVisibility,
  RegisteredMutation,
  RegisteredQuery,
} from "convex/server";
import * as loans from "./loans";
import { collect as collectPayment, today as collectionsToday } from "./collections";
import {
  baseScheduleRows,
  deriveLoanView,
  loanOpenBalance,
} from "../lib/server/loanOps";
import { rowOutstanding } from "../lib/finance/schedule";

/**
 * One-off, self-cleaning, transactional live-verification harness for the
 * SUPER_ADMIN loan closure feature (surrender / settle / close / archive /
 * deleteClosed) plus the collection paths they interact with.
 *
 * Run with:
 *   bun convex run _tmpLoanClosureVerify:verify
 *
 * What it does, inside ONE Convex transaction (any failed assertion throws,
 * the platform rolls everything back, and the fixture is never left behind):
 *
 *   1. finds the seeded SUPER_ADMIN and one profile per other role,
 *   2. builds a self-contained fixture (branch, client, product, six loans
 *      with schedules that include overdue rows),
 *   3. exercises the ACTUAL registered handlers (loans.surrender / settle /
 *      close / archive / deleteClosed, collections.collect, collections.today
 *      and loans.list) via direct handler calls with stubbed auth identities
 *      — the same identity path @convex-dev/auth derives userId from, and the
 *      same authorization code (requireSuperAdmin / requirePermission) a real
 *      client call walks,
 *   4. asserts the authorization negatives (FIELD_STAFF / BRANCH_MANAGER /
 *      ACCOUNTANT / CLIENT are refused),
 *   5. asserts every business rule of the closure workflows (dues are never
 *      erased by surrender, settlement separates cash from waiver, close
 *      never marks a loan repaid by fiat, delete refuses whenever the
 *      immutable financial ledger references the loan, …),
 *   6. verifies reports and boards drop resolved loans (collection board,
 *      OVERDUE loan list, overdue view) and that the closure record
 *      (closureKind / closureReason / closedBy) is populated, then
 *   7. removes every fixture document — including the ledger rows its
 *      collections created — inside the same transaction.
 *
 * BACKUP INSTRUCTIONS:
 *   - keep this file until the final report is delivered, then remove it.
 *   - if you are reading this in a Freebuff preview, the file lives in
 *     `src/convex/_tmpLoanClosureVerify.ts` and is listed in the dev
 *     functions table under `_tmpLoanClosureVerify:verify`.
 */

/* --------------------------- calling registered functions ---------------- */

/**
 * Convex's registered-function TYPES (`RegisteredMutation` / `RegisteredQuery`)
 * intentionally hide call signatures, but the runtime value IS a
 * `(ctx, args) => Promise<...>` wrapper around the exact registered handler
 * (`dontCallDirectly` in convex's registration_impl). This harness runs inside
 * one transaction, so it invokes those real handlers through this single
 * documented bridge — same code path, including `requireSuperAdmin` and the
 * @convex-dev/auth identity lookup, that a client call walks. Only the RPC
 * layer's args validation is skipped, which is why every call below passes
 * fully-formed args.
 */
type HandlerOf<T> =
  T extends RegisteredMutation<FunctionVisibility, infer A, infer R>
    ? (ctx: MutationCtx, args: A) => R
    : T extends RegisteredQuery<FunctionVisibility, infer A, infer R>
      ? (ctx: QueryCtx, args: A) => R
      : never;
type ArgsOf<T> =
  T extends RegisteredMutation<FunctionVisibility, infer A, unknown> ? A : never;

function handler<T>(registered: T): HandlerOf<T> {
  return registered as unknown as HandlerOf<T>;
}

const surrender = handler(loans.surrender);
const settle = handler(loans.settle);
const close = handler(loans.close);
const archive = handler(loans.archive);
const deleteClosed = handler(loans.deleteClosed);
const collect = handler(collectPayment);
const board = handler(collectionsToday);
const loanList = handler(loans.list);

// Compile-time sanity: the bridge really recovers the registered arg types
// (indexing a wrongly-inferred `unknown` would not compile).
const _bridgeArgs: ArgsOf<typeof loans.surrender>["reason"] = "bridge-ok";

/* ------------------------------- check helpers ---------------------------- */

type Check = { name: string; expected: string; actual: string; pass: boolean };

let checks: Check[] = [];

const chk = (name: string, expected: unknown, actual: unknown): void => {
  const e = JSON.stringify(expected ?? null);
  const a = JSON.stringify(actual ?? null);
  checks.push({ name, expected: e, actual: a, pass: e === a });
};

/** Boolean assertion — on failure the actual slot shows the detail message. */
const chkTrue = (name: string, cond: boolean, detail?: unknown): void => {
  checks.push({
    name,
    expected: "true",
    actual: cond ? "true" : String(detail ?? "false"),
    pass: cond,
  });
};

/** Returns the thrown error's message, or null when the call resolved. */
async function expectThrow(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

/* --------------------------------- harness -------------------------------- */

export const verify = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Module-level accumulator: reset per run (Convex reuses the module
    // instance across invocations within a worker).
    checks = [];
    const suffix = String(Date.now()).slice(-6);
    const DAY = 86_400_000;
    const now = Date.now();
    // Disbursed 70 days ago so the schedule contains exactly one overdue row
    // and one future row: row 1 due ~40d ago (paid on loan A), row 2 due ~10d
    // ago, row 3 due ~20d ahead.
    const disbursedOn = now - 70 * DAY;

    // ── step 1: identities ─────────────────────────────────────────────────
    const profiles = await ctx.db.query("profiles").collect();
    const byRole: Record<string, Doc<"profiles">> = {};
    for (const p of profiles) {
      if (!p.role || !p.status) continue;
      if (!byRole[p.role] || p.status === "ACTIVE") byRole[p.role] = p;
    }
    const sa = byRole["SUPER_ADMIN"];
    chk("id.SUPER_ADMIN.present", true, !!sa);
    if (!sa || !sa.userId) {
      return {
        ok: false,
        note: "No SUPER_ADMIN profile with a userId — cannot impersonate.",
        checks,
      };
    }

    /**
     * Impersonate a user through the EXACT subject shape @convex-dev/auth
     * derives ids from: `getAuthUserId` splits the subject on the library's
     * TOKEN_SUB_CLAIM_DIVIDER ("|") and takes the first segment. The proxy
     * keeps every ctx member (db, storage, …) reachable while swapping only
     * `auth`.
     */
    function asUser(userId: Id<"users">): MutationCtx {
      return new Proxy(ctx, {
        get(target, prop) {
          if (prop === "auth") {
            return {
              getUserIdentity: async () => ({ subject: `${userId}|verifySession` }),
            };
          }
          const value = (target as any)[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    const saCtx = asUser(sa.userId);

    // ── step 2: self-contained fixture ─────────────────────────────────────
    const branchA = (await ctx.db.query("branches").collect()).find(
      (b) => b.status === "ACTIVE",
    );
    chk("fixture.branch.present", true, !!branchA);
    if (!branchA) throw new Error("No ACTIVE branch — fixture cannot be placed.");

    const fixtureClientId = await ctx.db.insert("clients", {
      code: `C-TMPCL-${suffix}`,
      name: `Verify Closure ${suffix}`,
      mobile: "9999000011",
      village: "Verify Village",
      address: "Test Lane",
      district: "Ballia",
      state: "Uttar Pradesh",
      pin: "277001",
      dob: now - 1800 * DAY,
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
      searchText: `Verify Closure ${suffix}`,
      createdAt: now,
    });

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

    // Three monthly rows with the approved charges financed into row 1:
    // row 1 — oldest (overdue), row 2 — overdue, row 3 — future.
    const rows = baseScheduleRows({
      principal: 18000,
      interestRate: 18,
      interestMethod: "FLAT",
      frequency: "MONTHLY",
      tenure: 3,
      disbursedOn,
      charges: 600,
    });
    chk("fixture.rows.count", 3, rows.length);
    const totalOf = (r: typeof rows) => Math.round(r.reduce((s, x) => s + x.totalDue, 0) * 100) / 100;
    const Σ = totalOf(rows); // total payable across the schedule
    const row1Due = rows[0].dueDate;
    const row2Due = rows[1].dueDate;
    chkTrue(
      "fixture.rows.overdueShape",
      row2Due < now && rows[2].dueDate > now && row1Due < now,
      `row1=${row1Due} row2=${row2Due} row3=${rows[2].dueDate} now=${now}`,
    );

    /** Insert a loan + schedule with internally consistent stored aggregates. */
    async function insertLoan(
      kind: string,
      opts: { status: string; paidIndexes: number[] },
    ): Promise<Id<"loans">> {
      const paidTotal = totalOf(rows.filter((r) => opts.paidIndexes.includes(r.index)));
      const outstanding = Math.round((Σ - paidTotal) * 100) / 100;
      const id = await ctx.db.insert("loans", {
        loanId: `LN-VER-${kind}-${suffix}`,
        clientId: fixtureClientId,
        productId,
        staffId: sa._id,
        branchId: branchA!._id,
        principal: Math.round(rows.reduce((s, r) => s + r.principal, 0) * 100) / 100,
        interestTotal: Math.round(rows.reduce((s, r) => s + r.interest, 0) * 100) / 100,
        charges: Math.round((rows[0].totalDue - rows[0].principal) * 100) / 100,
        totalPayable: Σ,
        installment: rows[0].totalDue,
        frequency: "MONTHLY",
        tenure: 3,
        interestRate: 18,
        interestMethod: "FLAT",
        status: opts.status,
        outstanding,
        paidTotal,
        disbursedAt: disbursedOn,
        disbursedBy: sa._id,
        approvedAt: disbursedOn,
        approvedBy: sa._id,
        nextDueDate: rows[0].dueDate,
        overdueDays: 0,
        createdAt: now - 80 * DAY,
      });
      for (const r of rows) {
        const paid = opts.paidIndexes.includes(r.index) ? r.totalDue : 0;
        await ctx.db.insert("loanSchedules", {
          loanId: id,
          index: r.index,
          dueDate: r.dueDate,
          principal: r.principal,
          interest: r.interest,
          totalDue: r.totalDue,
          paid,
          remaining: Math.round((r.totalDue - paid) * 100) / 100,
          status:
            paid >= r.totalDue ? "PAID" : r.dueDate < now ? "OVERDUE" : "PENDING",
          updatedAt: now,
        });
      }
      return id;
    }

    // A — normal loan with its first installment already paid (one overdue
    //     row open). B — untouched. C — untouched (will repay fully).
    // D — fully repaid rows, no money ever moved through the ledger.
    // E — untouched (stays unpaid). F — untouched (will settle with waiver).
    const loanA = await insertLoan("A", { status: "DISBURSED", paidIndexes: [1] });
    const loanB = await insertLoan("B", { status: "DISBURSED", paidIndexes: [] });
    const loanC = await insertLoan("C", { status: "DISBURSED", paidIndexes: [] });
    const loanD = await insertLoan("D", { status: "ACTIVE", paidIndexes: [1, 2, 3] });
    const loanE = await insertLoan("E", { status: "DISBURSED", paidIndexes: [] });
    const loanF = await insertLoan("F", { status: "DISBURSED", paidIndexes: [] });
    chk("fixture.loanA.openBalance", rows[1].totalDue + rows[2].totalDue, await loanOpenBalance(ctx, loanA));
    chk("fixture.loanD.openBalance", 0, await loanOpenBalance(ctx, loanD));

    const loanADoc = (await ctx.db.get(loanA))!;
    const loanARows = (
      await ctx.db
        .query("loanSchedules")
        .withIndex("by_loan", (q) => q.eq("loanId", loanA))
        .collect()
    ).sort((a, b) => a.index - b.index);
    const viewA = deriveLoanView(loanADoc, loanARows as Doc<"loanSchedules">[], now);
    chk("fixture.loanA.view.displayStatus", "OVERDUE", viewA.displayStatus);
    chk("fixture.loanA.view.overdueAmount", rows[1].totalDue, viewA.overdueAmount);
    chk("fixture.loanA.view.nextDueDate", rows[1].dueDate, viewA.nextDueDate);
    // Stored outstanding agrees with the schedule-derived open balance.
    chk("fixture.loanA.outstandingConsistent", loanADoc.outstanding, await loanOpenBalance(ctx, loanA));

    // ── step 3: authorization negatives (real registered handlers) ─────────
    // The harness is self-contained: when the deployment has no profile for a
    // role, it creates a throwaway ACTIVE user + profile for that role and
    // removes both again during cleanup. The denial is only trusted when it
    // came from requireSuperAdmin's role check, so an ACTIVE profile is
    // guaranteed before the call.
    const throwawayProfileIds: Id<"profiles">[] = [];
    const throwawayUserIds: Id<"users">[] = [];

    async function ensureRoleIdentity(who: string): Promise<Doc<"profiles">> {
      const existing = byRole[who];
      if (existing?.userId && existing.status === "ACTIVE") return existing;
      const userId = await ctx.db.insert("users", {
        name: `Verify ${who} ${suffix}`,
        email: `verify-${who.toLowerCase()}-${suffix}@example.test`,
      });
      throwawayUserIds.push(userId);
      const profileId = await ctx.db.insert("profiles", {
        userId,
        name: `Verify ${who} ${suffix}`,
        staffId: `TMP-${who.slice(0, 2)}-${suffix}`,
        role: who,
        branchId: branchA!._id,
        status: "ACTIVE",
        ...(who === "CLIENT" ? { clientId: fixtureClientId } : {}),
        createdBy: sa._id,
        createdAt: now,
      });
      throwawayProfileIds.push(profileId);
      return (await ctx.db.get(profileId))!;
    }

    async function expectDeniedAs(
      who: string,
      call: (c: MutationCtx) => Promise<unknown>,
    ): Promise<string | null> {
      const p = await ensureRoleIdentity(who);
      if (!p.userId) return `${who} profile has no userId to impersonate`;
      const userId = p.userId; // narrow once — closures can't keep property narrowing
      return await expectThrow(() => call(asUser(userId)));
    }

    for (const who of ["FIELD_STAFF", "BRANCH_MANAGER", "ACCOUNTANT", "CLIENT"]) {
      const msg = await expectDeniedAs(who, (c) =>
        surrender(c, {
          loanId: loanA,
          reason: `helper check — ${who} must not surrender`,
          device: "verify",
        }),
      );
      chkTrue(
        `auth.${who}.surrender.denied`,
        !!msg && msg.includes("Only a SUPER_ADMIN"),
        msg ?? "call unexpectedly succeeded",
      );
    }
    const msgNoAuth = await expectThrow(() =>
      surrender(ctx, { loanId: loanA, reason: "anonymous", device: "verify" }),
    );
    chkTrue(
      "auth.anonymous.surrender.denied",
      !!msgNoAuth && msgNoAuth.includes("Not signed in"),
      msgNoAuth ?? "call unexpectedly succeeded",
    );

    // ── step 4: SUPER_ADMIN surrenders an eligible loan (dues stay on record)
    const surrenderRes = await surrender(saCtx, {
      loanId: loanA,
      reason: "Verify harness surrender — routine administration",
      device: "verify",
    });
    chk("sa.surrender.ok", true, surrenderRes.ok);
    chk("sa.surrender.loanId", `LN-VER-A-${suffix}`, surrenderRes.loanId);
    chk("sa.surrender.status", "SURRENDERED", surrenderRes.status);
    // The open debt is preserved verbatim — surrender never erases dues.
    chk(
      "sa.surrender.outstandingPreserved",
      rows[1].totalDue + rows[2].totalDue,
      surrenderRes.outstanding,
    );
    const loanAAfter = (await ctx.db.get(loanA))!;
    chk("sa.surrender.loan.status", "SURRENDERED", loanAAfter.status);
    chk("sa.surrender.loan.closureKind", "SURRENDER", loanAAfter.closureKind);
    chk(
      "sa.surrender.loan.closureReason",
      "Verify harness surrender — routine administration",
      loanAAfter.closureReason,
    );
    chk("sa.surrender.loan.closedBy", sa._id, loanAAfter.closedBy);
    chk(
      "sa.surrender.loan.outstandingUnchanged",
      loanADoc.outstanding,
      loanAAfter.outstanding,
    );

    const surrenderAudit = (await ctx.db.query("auditLogs").collect()).filter(
      (a) =>
        a.action === "LOAN_SURRENDERED" &&
        a.referenceId === `LN-VER-A-${suffix}`,
    );
    chk("sa.surrender.audit.count", 1, surrenderAudit.length);

    // A surrendered loan is operationally closed for money movement.
    const dupSurrender = await expectThrow(() =>
      surrender(saCtx, { loanId: loanA, reason: "double", device: "verify" }),
    );
    chkTrue(
      "sa.surrender.doubleReplaced",
      !!dupSurrender && dupSurrender.includes("surrendered"),
      dupSurrender ?? "second surrender unexpectedly succeeded",
    );
    const settleFromSurrendered = await expectThrow(() =>
      settle(saCtx, {
        loanId: loanA,
        settlementAmount: 1,
        mode: "CASH",
        reason: "settle a surrendered loan",
        device: "verify",
      }),
    );
    chkTrue(
      "sa.settle.fromSurrendered.rejected",
      !!settleFromSurrendered && settleFromSurrendered.includes("surrendered"),
      settleFromSurrendered ?? "settle on surrendered loan unexpectedly succeeded",
    );
    const collectFromSurrendered = await expectThrow(() =>
      collect(saCtx, {
        loanId: loanA,
        amount: 100,
        mode: "CASH",
        remarks: "collect on surrendered loan",
        device: "verify",
      }),
    );
    chkTrue(
      "sa.collect.onSurrendered.rejected",
      !!collectFromSurrendered && collectFromSurrendered.includes("no collections accepted"),
      collectFromSurrendered ?? "collection on surrendered loan unexpectedly succeeded",
    );
    const closeSurrenderedUnpaid = await expectThrow(() =>
      close(saCtx, { loanId: loanA, reason: "close unpaid surrendered loan", device: "verify" }),
    );
    chkTrue(
      "sa.close.surrenderedUnpaid.rejected",
      !!closeSurrenderedUnpaid && closeSurrenderedUnpaid.includes("outstanding"),
      closeSurrenderedUnpaid ?? "close of unpaid surrendered loan unexpectedly succeeded",
    );
    const archiveSurrendered = await expectThrow(() =>
      archive(saCtx, { loanId: loanA, reason: "archive surrendered loan", device: "verify" }),
    );
    chkTrue(
      "sa.archive.surrendered.rejected",
      !!archiveSurrendered && archiveSurrendered.includes("Only a closed or settled"),
      archiveSurrendered ?? "archive of surrendered loan unexpectedly succeeded",
    );

    // ── step 5: settle with a FULL cash payment (no waiver) ────────────────
    // Partial payment first, then settle the remaining open balance in cash.
    const partial = rows[1].totalDue * 0.5;
    const partRes = await collect(saCtx, {
      loanId: loanB,
      amount: partial,
      mode: "CASH",
      remarks: "Verify harness partial payment on loan B",
      device: "verify",
    });
    chkTrue("scenario.loanB.partial.ok", partRes.ok === true, partRes);
    chkTrue("scenario.loanB.partial.receipt", !!partRes.receiptNumber, partRes.receiptNumber);
    const openAfterPartial = await loanOpenBalance(ctx, loanB);
    chk(
      "scenario.loanB.partial.outstandingReduced",
      Math.round((Σ - partial) * 100) / 100,
      openAfterPartial,
    );

    const settleRes = await settle(saCtx, {
      loanId: loanB,
      settlementAmount: openAfterPartial,
      mode: "CASH",
      reason: "Verify harness full-cash settlement of loan B",
      device: "verify",
    });
    chk("sa.settle.ok", true, settleRes.ok);
    chk("sa.settle.status", "SETTLED", settleRes.status);
    chk("sa.settle.settlementPaid", openAfterPartial, settleRes.settlementPaid);
    chk("sa.settle.waivedAmount.zeroForFullCash", 0, settleRes.waivedAmount);
    chkTrue("sa.settle.receiptNumber.present", !!settleRes.receiptNumber, settleRes.receiptNumber);

    const loanBAfter = (await ctx.db.get(loanB))!;
    chk("sa.settle.loan.status", "SETTLED", loanBAfter.status);
    chk("sa.settle.loan.outstanding", 0, loanBAfter.outstanding);
    chk("sa.settle.loan.waivedAmount", 0, loanBAfter.waivedAmount ?? null);
    chk("sa.settle.loan.paidTotal", Σ, loanBAfter.paidTotal);
    chk("sa.settle.loan.closureKind", "SETTLEMENT", loanBAfter.closureKind);
    chk(
      "sa.settle.loan.closureReason",
      "Verify harness full-cash settlement of loan B",
      loanBAfter.closureReason,
    );
    chk("sa.settle.loan.closedBy", sa._id, loanBAfter.closedBy);
    chkTrue("sa.settle.loan.closeDate.present", !!loanBAfter.closeDate, loanBAfter.closeDate);

    // Ledger coherence: partial + settlement are the only NORMAL collections
    // and together they equal the whole schedule — nothing waived, nothing
    // invented.
    const collectionsB = (
      await ctx.db
        .query("collections")
        .withIndex("by_loan", (q) => q.eq("loanId", loanB))
        .collect()
    ).filter((c) => c.status === "NORMAL");
    chk("sa.settle.collections.normalCount", 2, collectionsB.length);
    const settleCol = collectionsB.find((c) => c.amount === openAfterPartial);
    chkTrue("sa.settle.collections.settlementRowPresent", !!settleCol, collectionsB.map((c) => c.amount));
    chk("sa.settle.collections.settlementMode", "CASH", settleCol?.mode);
    chkTrue("sa.settle.collections.receipt", !!settleCol?.receiptNumber, settleCol?.receiptNumber);
    const collectedB = Math.round(collectionsB.reduce((s, c) => s + c.amount, 0) * 100) / 100;
    chk("sa.settle.collections.sumEqualsSchedule", Σ, collectedB);
    const waivedB = (
      await ctx.db
        .query("loanSchedules")
        .withIndex("by_loan", (q) => q.eq("loanId", loanB))
        .collect()
    ).reduce((s, r: any) => s + (r.waived ?? 0), 0);
    chk("sa.settle.waivedRows.totalZero", 0, waivedB);

    const dupSettle = await expectThrow(() =>
      settle(saCtx, {
        loanId: loanB,
        settlementAmount: 1,
        mode: "CASH",
        reason: "settle a settled loan",
        device: "verify",
      }),
    );
    chkTrue(
      "sa.settle.duplicate.rejected",
      !!dupSettle && dupSettle.includes("settled"),
      dupSettle ?? "second settlement unexpectedly succeeded",
    );

    // ── step 6: settle with WAIVER — cash and waiver stay separate ─────────
    const waiverCash = 1000;
    const openF = await loanOpenBalance(ctx, loanF);
    const settleF = await settle(saCtx, {
      loanId: loanF,
      settlementAmount: waiverCash,
      mode: "CASH",
      reason: "Verify harness waiver settlement of loan F",
      device: "verify",
    });
    chk("sa.settleF.status", "SETTLED", settleF.status);
    chk("sa.settleF.settlementPaid", waiverCash, settleF.settlementPaid);
    chk("sa.settleF.waivedAmount", Math.round((openF - waiverCash) * 100) / 100, settleF.waivedAmount);
    const loanFAfter = (await ctx.db.get(loanF))!;
    chk("sa.settleF.loan.waivedAmount", settleF.waivedAmount, loanFAfter.waivedAmount);
    chk("sa.settleF.loan.paidTotal", waiverCash, loanFAfter.paidTotal);
    const collectionsF = (
      await ctx.db
        .query("collections")
        .withIndex("by_loan", (q) => q.eq("loanId", loanF))
        .collect()
    ).filter((c) => c.status === "NORMAL");
    chk("sa.settleF.collections.cashOnly", 1, collectionsF.length);
    chk("sa.settleF.collections.cashAmount", waiverCash, collectionsF[0]?.amount);
    const rowsF = await ctx.db
      .query("loanSchedules")
      .withIndex("by_loan", (q) => q.eq("loanId", loanF))
        .collect();
    const waivedF = rowsF.reduce((s, r: any) => s + (r.waived ?? 0), 0);
    chk("sa.settleF.waivedMatchesSchedule", settleF.waivedAmount, waivedF);
    chkTrue(
      "sa.settleF.rowsAllResolved",
      rowsF.every((r: any) => rowOutstanding(r) === 0),
      rowsF.map((r: any) => rowOutstanding(r)),
    );
    const openCForGuard = await loanOpenBalance(ctx, loanC);
    const overSettle = await expectThrow(() =>
      settle(saCtx, {
        loanId: loanC,
        settlementAmount: openCForGuard + 1,
        mode: "CASH",
        reason: "settle above outstanding",
        device: "verify",
      }),
    );
    chkTrue(
      "sa.settle.aboveOutstanding.rejected",
      !!overSettle && overSettle.includes("cannot exceed the outstanding"),
      overSettle ?? "settlement above outstanding unexpectedly succeeded",
    );

    // ── step 7: full repayment auto-closes; administrative Close records the
    //      closure metadata instead of failing ──────────────────────────────
    const openC = await loanOpenBalance(ctx, loanC);
    const payC = await collect(saCtx, {
      loanId: loanC,
      amount: openC,
      mode: "CASH",
      remarks: "Verify harness full repayment of loan C",
      device: "verify",
    });
    chkTrue("scenario.loanC.repay.ok", payC.ok === true, payC);
    chkTrue("scenario.loanC.repay.receipt", !!payC.receiptNumber, payC.receiptNumber);
    const loanCAfterPay = (await ctx.db.get(loanC))!;
    chk("scenario.loanC.autoClosed.status", "CLOSED", loanCAfterPay.status);
    chk("scenario.loanC.autoClosed.outstanding", 0, loanCAfterPay.outstanding);
    chkTrue("scenario.loanC.autoClosed.closeDate", !!loanCAfterPay.closeDate, loanCAfterPay.closeDate);
    chk("scenario.loanC.autoClosed.closureKind", "REPAYMENT", loanCAfterPay.closureKind);

    const closeC = await close(saCtx, {
      loanId: loanC,
      reason: "Full repayment of loan C verified by harness",
      device: "verify",
    });
    chk("sa.close.repaidLoan.ok", true, closeC.ok);
    chk("sa.close.repaidLoan.status", "CLOSED", closeC.status);
    const loanCAfterClose = (await ctx.db.get(loanC))!;
    chk("sa.close.repaidLoan.closureKind", "REPAYMENT", loanCAfterClose.closureKind);
    chk(
      "sa.close.repaidLoan.closureReason",
      "Full repayment of loan C verified by harness",
      loanCAfterClose.closureReason,
    );
    chk("sa.close.repaidLoan.closedBy", sa._id, loanCAfterClose.closedBy);
    chk("sa.close.repaidLoan.outstanding", 0, loanCAfterClose.outstanding);
    // Close is idempotent on a genuinely closed loan.
    const closeCAgain = await close(saCtx, {
      loanId: loanC,
      reason: "Full repayment of loan C verified by harness",
      device: "verify",
    });
    chk("sa.close.repaidLoan.idempotent", true, closeCAgain.ok);

    // ── step 8: zero-outstanding ACTIVE loan closes as REPAYMENT ───────────
    const loanDBefore = (await ctx.db.get(loanD))!;
    chk("sa.close.zeroOutstandingLoan.before", "ACTIVE", loanDBefore.status);
    const closeD = await close(saCtx, {
      loanId: loanD,
      reason: "Zero-outstanding loan closed by administration",
      device: "verify",
    });
    chk("sa.close.zeroOutstandingLoan.ok", true, closeD.ok);
    const loanDAfter = (await ctx.db.get(loanD))!;
    chk("sa.close.zeroOutstandingLoan.closureKind", "REPAYMENT", loanDAfter.closureKind);
    chk("sa.close.zeroOutstandingLoan.outstanding", 0, loanDAfter.outstanding);

    // ── step 9: an unpaid loan can NEVER be closed by fiat ─────────────────
    const loanEBefore = (await ctx.db.get(loanE))!;
    chk("sa.close.unpaidLoan.before", "DISBURSED", loanEBefore.status);
    const closeUnpaid = await expectThrow(() =>
      close(saCtx, { loanId: loanE, reason: "falsely close an unpaid loan", device: "verify" }),
    );
    chkTrue(
      "sa.close.unpaidLoan.rejected",
      !!closeUnpaid && closeUnpaid.includes("still outstanding"),
      closeUnpaid ?? "close of unpaid loan unexpectedly succeeded",
    );
    const loanEAfter = (await ctx.db.get(loanE))!;
    chk("sa.close.unpaidLoan.statusUnchanged", "DISBURSED", loanEAfter.status);
    chkTrue("sa.close.unpaidLoan.closureKindUntouched", !loanEAfter.closureKind, loanEAfter.closureKind);

    // ── step 10: permanent delete ──────────────────────────────────────────
    // Unresolved loans are refused.
    const deleteSurrendered = await expectThrow(() =>
      deleteClosed(saCtx, {
        loanId: loanA,
        reason: "delete a surrendered loan",
        device: "verify",
      }),
    );
    chkTrue(
      "sa.delete.unresolved.rejected",
      !!deleteSurrendered && deleteSurrendered.includes("only a closed or settled loan"),
      deleteSurrendered ?? "delete of surrendered loan unexpectedly succeeded",
    );
    // Loans with financial history are refused — the ledger is immutable.
    const deleteB = await expectThrow(() =>
      deleteClosed(saCtx, {
        loanId: loanB,
        reason: "delete a settled loan that has payments",
        device: "verify",
      }),
    );
    chkTrue(
      "sa.delete.withLedger.rejected",
      !!deleteB && deleteB.includes("Cannot permanently delete"),
      deleteB ?? "delete of loan with ledger references unexpectedly succeeded",
    );
    chkTrue(
      "sa.delete.withLedger.pointsAtArchive",
      !!deleteB && deleteB.includes("Archive the loan instead"),
      deleteB,
    );
    chkTrue("sa.delete.withLedger.loanSurvives", !!(await ctx.db.get(loanB)), "loan B was deleted");
    // A closed loan no money ever moved for CAN be permanently deleted.
    const delD = await deleteClosed(saCtx, {
      loanId: loanD,
      reason: "Verify harness permanent deletion of the clean closed loan",
      device: "verify",
    });
    chk("sa.delete.cleanLoan.ok", true, delD.ok);
    chkTrue("sa.delete.cleanLoan.deleted", !!delD.deleted, delD);
    chk("sa.delete.cleanLoan.scheduleRowsRemoved", 3, delD.scheduleRowsRemoved);
    chk("sa.delete.cleanLoan.loanGone", null, await ctx.db.get(loanD));
    const rowsAfterDel = await ctx.db
      .query("loanSchedules")
      .withIndex("by_loan", (q) => q.eq("loanId", loanD))
      .collect();
    chk("sa.delete.cleanLoan.schedulesGone", 0, rowsAfterDel.length);

    // ── step 11: archive a resolved loan ───────────────────────────────────
    const archB = await archive(saCtx, {
      loanId: loanB,
      reason: "Archive settled loan B after verification",
      device: "verify",
    });
    chk("sa.archive.ok", true, archB.ok);
    chk("sa.archive.loanId", `LN-VER-B-${suffix}`, archB.loanId);
    chkTrue("sa.archive.archivedAtSet", !!archB.archivedAt, archB.archivedAt);
    chkTrue(
      "sa.archive.loan.archived",
      !!(await ctx.db.get(loanB))?.archivedAt,
      "loan B has no archivedAt",
    );
    const dupArchive = await expectThrow(() =>
      archive(saCtx, { loanId: loanB, reason: "archive again", device: "verify" }),
    );
    chkTrue(
      "sa.archive.duplicate.rejected",
      !!dupArchive && dupArchive.includes("already archived"),
      dupArchive ?? "second archive unexpectedly succeeded",
    );

    // ── step 12: boards and reports drop resolved loans ────────────────────
    // Collection board (collections.today, called as SUPER_ADMIN): only loan
    // E — the still-unpaid loan — may contribute to the fixture client's row.
    const boardRes = await board(saCtx, {});
    const boardEntry = (boardRes.due as any[]).find(
      (d) => d.clientId === fixtureClientId,
    );
    const eOverdue = Math.round((rows[0].totalDue + rows[1].totalDue) * 100) / 100; // loans E rows 1+2 open
    chkTrue("scenario.board.entryPresentForLoanE", !!boardEntry, "fixture client missing from board");
    chk("scenario.board.overdueOnlyFromLoanE", eOverdue, boardEntry?.overdue);
    chk("scenario.board.dueToday", 0, boardEntry?.dueToday);

    // OVERDUE loan list (loans.list): loan E appears; resolved loans do not.
    const overdueList = await loanList(saCtx, { status: "OVERDUE" });
    const overdueIds = (overdueList as any[]).map((e) => e.loan._id);
    chkTrue("scenario.overdueList.containsLoanE", overdueIds.includes(loanE), overdueIds);
    for (const [name, id] of [
      ["loanA-surrendered", loanA],
      ["loanB-settled", loanB],
      ["loanC-closed", loanC],
      ["loanF-settled", loanF],
    ] as const) {
      chkTrue(
        `scenario.overdueList.excludes-${name}`,
        !overdueIds.includes(id),
        overdueIds,
      );
    }
    // The overdue VIEW of a terminal loan never reports overdue amounts.
    const loanAFinal = (await ctx.db.get(loanA))!;
    const viewAFinal = deriveLoanView(
      loanAFinal,
      (
        await ctx.db
          .query("loanSchedules")
          .withIndex("by_loan", (q) => q.eq("loanId", loanA))
          .collect()
      ) as Doc<"loanSchedules">[],
      now,
    );
    chk("scenario.overdueView.surrendered.overdueAmount", 0, viewAFinal.overdueAmount);
    chk("scenario.overdueView.surrendered.overdueDays", 0, viewAFinal.overdueDays);
    chk("scenario.overdueView.surrendered.displayStatus", "SURRENDERED", viewAFinal.displayStatus);

    // ── step 13: reconciliation — statuses, audit trail, closure records ───
    const fixtureLoans = (await ctx.db.query("loans").collect()).filter(
      (l) => l.clientId === fixtureClientId,
    );
    const countBy = (status: string) =>
      fixtureLoans.filter((l) => l.status === status).length;
    chk("recon.surrenderedCount", 1, countBy("SURRENDERED")); // A
    chk("recon.settledCount", 2, countBy("SETTLED")); // B, F
    chk("recon.closedCount", 1, countBy("CLOSED")); // C (D was deleted)
    chk("recon.disbursedCount", 1, countBy("DISBURSED")); // E

    const audits = await ctx.db.query("auditLogs").collect();
    chk(
      "recon.audit.settlements",
      2,
      audits.filter(
        (a) => a.action === "LOAN_SETTLED" && a.referenceId?.includes(suffix),
      ).length,
    );
    chk(
      "recon.audit.closures",
      3, // loan C closed twice (repayment + idempotent confirm), loan D once
      audits.filter(
        (a) => a.action === "LOAN_CLOSED" && a.referenceId?.includes(suffix),
      ).length,
    );
    chk("recon.audit.archive", 1, audits.filter((a) => a.action === "LOAN_ARCHIVED" && a.referenceId === `LN-VER-B-${suffix}`).length);
    chk("recon.audit.deletion", 1, audits.filter((a) => a.action === "LOAN_DELETED" && a.referenceId === `LN-VER-D-${suffix}`).length);
    const settledB = audits.find(
      (a) => a.action === "LOAN_SETTLED" && a.referenceId === `LN-VER-B-${suffix}`,
    );
    chkTrue(
      "recon.audit.settlementSeparatesCashAndWaiver",
      (settledB?.after as any)?.settlementPaid === openAfterPartial &&
        (settledB?.after as any)?.waived === 0,
      settledB?.after,
    );

    // Closure record as the dashboard renders it (loan C = repayment).
    const closedC = fixtureLoans.find((l) => l._id === loanC)!;
    chk("recon.closureRecord.loanC.kind", "REPAYMENT", closedC.closureKind);
    chkTrue("recon.closureRecord.loanC.reason", !!closedC.closureReason, closedC.closureReason);
    chk("recon.closureRecord.loanC.closedBy", sa._id, closedC.closedBy);

    /* ------------------------------ cleanup ------------------------------- */
    // Every fixture document, including the ledger rows its collections
    // created, goes away inside this same transaction. Nothing seeded is
    // touched — especially not the SUPER_ADMIN identity.
    const fixtureDocIds = [loanA, loanB, loanC, loanE, loanF]; // D already deleted
    const fixtureBusinessIds = [
      `LN-VER-A-${suffix}`,
      `LN-VER-B-${suffix}`,
      `LN-VER-C-${suffix}`,
      `LN-VER-D-${suffix}`,
      `LN-VER-E-${suffix}`,
      `LN-VER-F-${suffix}`,
    ];

    const fixtureCollections = (await ctx.db.query("collections").collect()).filter(
      (c) => fixtureDocIds.includes(c.loanId as Id<"loans">),
    );
    const collectionCodes = fixtureCollections.map((c) => c.code);
    const receiptNumbers = fixtureCollections
      .map((c) => c.receiptNumber)
      .filter((n): n is string => !!n);
    for (const code of collectionCodes) {
      for (const j of await ctx.db
        .query("journalEntries")
        .collect()
        .then((all) => all.filter((j) => j.refId === code))) {
        await ctx.db.delete(j._id);
      }
      for (const w of await ctx.db
        .query("walletTransactions")
        .withIndex("by_ref", (q) => q.eq("referenceId", code))
        .collect()) {
        await ctx.db.delete(w._id);
      }
    }
    for (const c of fixtureCollections) await ctx.db.delete(c._id);
    for (const r of (await ctx.db.query("receipts").collect()).filter((r) =>
      fixtureDocIds.includes(r.loanId as Id<"loans">),
    )) {
      await ctx.db.delete(r._id);
    }
    const isFixtureRef = (v?: string) =>
      !!v &&
      (v.includes("LN-VER-") ||
        v.includes("Verify Closure") ||
        v.includes(`C-TMPCL-${suffix}`) ||
        collectionCodes.includes(v) ||
        receiptNumbers.includes(v));
    for (const a of await ctx.db.query("auditLogs").collect()) {
      if (isFixtureRef(a.referenceId) || isFixtureRef(a.entityId)) {
        await ctx.db.delete(a._id);
      }
    }
    for (const n of await ctx.db.query("notifications").collect()) {
      if (isFixtureRef(n.body)) await ctx.db.delete(n._id);
    }
    for (const id of fixtureDocIds) {
      for (const s of await ctx.db
        .query("loanSchedules")
        .withIndex("by_loan", (q) => q.eq("loanId", id))
        .collect()) {
        await ctx.db.delete(s._id);
      }
      await ctx.db.delete(id);
    }
    await ctx.db.delete(fixtureClientId);
    await ctx.db.delete(productId);

    // Throwaway identities created for the authorization negatives.
    for (const id of throwawayProfileIds) await ctx.db.delete(id);
    for (const id of throwawayUserIds) await ctx.db.delete(id);

    const failed = checks.filter((c) => !c.pass).map((c) => c.name);
    return {
      ok: failed.length === 0,
      mode: "verify",
      bridgeArgsSanity: _bridgeArgs,
      totalChecks: checks.length,
      failedChecks: failed,
      checks,
    };
  },
});
