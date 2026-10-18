import { internalMutation, internalQuery } from "./_generated/server";
import { recordCollection } from "../lib/server/loanOps";

/**
 * LIVE end-to-end check of the Collection workflow against the real database.
 *
 * Run with:
 *   bun convex run _tmpCollectionFlowTest:flow
 *
 * It exercises `recordCollection` — the exact function the Collection screen's
 * `collections.collect` mutation calls — with a temporary product, client,
 * loan and three schedules (one already overdue), then asserts:
 *
 *   1. the payment is saved against the correct loan (NORMAL row + receipt)
 *   2. the schedules roll forward (paid / partial / untouched)
 *   3. the loan's outstanding, paid total and status update
 *   4. the receipt records the outstanding after the payment
 *   5. the journal entry is posted and balanced, the audit log written
 *   6. a RETRY with the same idempotency key is flagged duplicate and
 *      posts nothing a second time (no double ledger movement)
 *
 * Every row it creates is deleted before it returns — all inside one
 * transaction, so a failure rolls everything back. The wallet is not touched
 * because this deployment has no wallet rows for the acting profile
 * (`recordCollection` writes the ledger only when a wallet exists).
 */
export const flow = internalMutation({
  args: {},
  handler: async (ctx) => {
    type Check = { name: string; expected: string; actual: string; pass: boolean };
    const checks: Check[] = [];
    const check = (name: string, expected: unknown, actual: unknown) => {
      const e = JSON.stringify(expected ?? null);
      const a = JSON.stringify(actual ?? null);
      checks.push({ name, expected: e, actual: a, pass: e === a });
    };
    const now = Date.now();
    const DAY = 86_400_000;

    const profiles = await ctx.db.query("profiles").collect();
    const actor = profiles.find((p) => p.status === "ACTIVE");
    const branch = (await ctx.db.query("branches").collect()).find(
      (b) => b.status === "ACTIVE",
    );
    if (!actor || !branch) {
      return {
        ok: false,
        note: "Need at least one ACTIVE profile and one ACTIVE branch.",
        checks,
      };
    }

    /* --------------------- temporary ledger fixture --------------------- */
    const suffix = String(now).slice(-6);
    const productId = await ctx.db.insert("loanProducts", {
      code: `PRC-TMP${suffix}`,
      name: "TMP — collection workflow test",
      minAmount: 1000,
      maxAmount: 100000,
      interestRate: 12,
      interestMethod: "FLAT",
      tenure: 3,
      frequency: "WEEKLY",
      processingFee: 0,
      chargePercent: 0,
      graceDays: 0,
      maxObligationRatio: 50,
      status: "ACTIVE",
      createdAt: now,
    });
    const clientId = await ctx.db.insert("clients", {
      code: `C-TMP${suffix}`,
      name: "TMP Collection Client",
      age: 33,
      gender: "FEMALE",
      mobile: "9876500002",
      address: "Test household, Ballia",
      village: "Test household",
      district: "Ballia",
      state: "Uttar Pradesh",
      pin: "277001",
      occupation: "Shopkeeper",
      monthlyIncome: 18000,
      householdIncome: 24000,
      familyMembers: 1,
      branchId: branch._id,
      assignedTo: actor._id,
      createdBy: actor._id,
      kycStatus: "PENDING",
      status: "ACTIVE",
      searchText: "tmp collection client 9876500002",
      createdAt: now,
    });
    const loanId = await ctx.db.insert("loans", {
      loanId: `LN-TMP${suffix}`,
      clientId,
      productId,
      staffId: actor._id,
      branchId: branch._id,
      principal: 3000,
      interestTotal: 0,
      charges: 0,
      totalPayable: 3000,
      installment: 1000,
      frequency: "WEEKLY",
      tenure: 3,
      interestRate: 0,
      interestMethod: "FLAT",
      status: "ACTIVE",
      outstanding: 3000,
      paidTotal: 0,
      disbursedAt: now - 15 * DAY,
      overdueDays: 0,
      createdAt: now - 15 * DAY,
    });
    await ctx.db.insert("loanSchedules", {
      loanId, index: 0, dueDate: now - 2 * DAY,
      principal: 1000, interest: 0, totalDue: 1000, paid: 0, remaining: 1000,
      status: "OVERDUE", updatedAt: now,
    });
    await ctx.db.insert("loanSchedules", {
      loanId, index: 1, dueDate: now - 3_600_000,
      principal: 1000, interest: 0, totalDue: 1000, paid: 0, remaining: 1000,
      status: "OVERDUE", updatedAt: now,
    });
    await ctx.db.insert("loanSchedules", {
      loanId, index: 2, dueDate: now + 7 * DAY,
      principal: 1000, interest: 0, totalDue: 1000, paid: 0, remaining: 1000,
      status: "PENDING", updatedAt: now,
    });

    /* -------------------- the Collection screen's save ------------------ */
    const key = `tmp-flow:${now}`;
    const first = await recordCollection(ctx, {
      loanId,
      actor,
      amount: 1500,
      mode: "CASH",
      idempotencyKey: key,
      device: "tmp-collection-flow-test",
    });

    const collections = (await ctx.db.query("collections").collect()).filter(
      (c) => c.loanId === loanId,
    );
    check("payment saved against the correct loan", 1, collections.length);
    check("collection status NORMAL", "NORMAL", collections[0]?.status);
    check("collection amount", 1500, collections[0]?.amount);
    check(
      "receipt issued",
      true,
      Boolean(collections[0]?.receiptNumber?.startsWith("RCPT-")),
    );
    check("first attempt is not a duplicate", false, first.duplicate);

    const scheds = (await ctx.db.query("loanSchedules").collect())
      .filter((s) => s.loanId === loanId)
      .sort((a, b) => a.index - b.index);
    check(
      "schedule 1 paid in full",
      { paid: 1000, remaining: 0, status: "PAID" },
      { paid: scheds[0]?.paid, remaining: scheds[0]?.remaining, status: scheds[0]?.status },
    );
    check(
      "schedule 2 partially paid",
      { paid: 500, remaining: 500 },
      { paid: scheds[1]?.paid, remaining: scheds[1]?.remaining },
    );
    check(
      "schedule 3 untouched",
      { paid: 0, status: "PENDING" },
      { paid: scheds[2]?.paid, status: scheds[2]?.status },
    );

    const loan = await ctx.db.get(loanId);
    check("loan outstanding updated", 1500, loan?.outstanding);
    check("loan paid total updated", 1500, loan?.paidTotal);
    check(
      "loan flagged OVERDUE (schedule 2 has an unpaid past-due part)",
      "OVERDUE",
      loan?.status,
    );

    const receipt = (await ctx.db.query("receipts").collect()).find(
      (r) => r.loanId === loanId,
    );
    check("receipt outstanding-after", 1500, receipt?.outstandingAfter);

    const code = collections[0]?.code ?? "";
    const journal = (await ctx.db.query("journalEntries").collect()).filter(
      (j) => j.refId === code,
    );
    const debit = journal.reduce((s, j) => s + j.lines.reduce((t, l) => t + l.debit, 0), 0);
    const credit = journal.reduce((s, j) => s + j.lines.reduce((t, l) => t + l.credit, 0), 0);
    check(
      "journal posted and balanced",
      { entries: 1, balanced: true },
      { entries: journal.length, balanced: debit === credit && debit > 0 },
    );

    const audit = (await ctx.db.query("auditLogs").collect()).filter(
      (a) => a.action === "PAYMENT_COLLECTED" && (a.referenceId === code || a.entityId === code),
    );
    check("audit trail written", 1, audit.length);

    /* ---------------- duplicate submission prevention ------------------- */
    const second = await recordCollection(ctx, {
      loanId,
      actor,
      amount: 1500,
      mode: "CASH",
      idempotencyKey: key,
      device: "tmp-collection-flow-test",
    });
    check("retry flagged as duplicate", true, second.duplicate);
    check(
      "retry saved no second collection",
      1,
      (await ctx.db.query("collections").collect()).filter((c) => c.loanId === loanId).length,
    );
    const loanAfterRetry = await ctx.db.get(loanId);
    check(
      "retry did not move the ledger twice",
      { outstanding: 1500, paidTotal: 1500 },
      { outstanding: loanAfterRetry?.outstanding, paidTotal: loanAfterRetry?.paidTotal },
    );

    /* ------------------------------ cleanup ----------------------------- */
    for (const j of journal) await ctx.db.delete(j._id);
    for (const a of audit) await ctx.db.delete(a._id);
    for (const c of collections) {
      if (c.receiptId) await ctx.db.delete(c.receiptId);
      await ctx.db.delete(c._id);
    }
    for (const r of (await ctx.db.query("receipts").collect()).filter((r) => r.loanId === loanId)) {
      await ctx.db.delete(r._id);
    }
    for (const s of scheds) await ctx.db.delete(s._id);
    await ctx.db.delete(loanId);
    await ctx.db.delete(clientId);
    await ctx.db.delete(productId);

    check(
      "cleanup left no rows behind",
      { loans: 0, collections: 0, receipts: 0, schedules: 0 },
      {
        loans: (await ctx.db.query("loans").collect()).filter((l) => l.loanId.startsWith("LN-TMP")).length,
        collections: (await ctx.db.query("collections").collect()).filter((c) => c.loanId === loanId).length,
        receipts: (await ctx.db.query("receipts").collect()).filter((r) => r.loanId === loanId).length,
        schedules: (await ctx.db.query("loanSchedules").collect()).filter((s) => s.loanId === loanId).length,
      },
    );

    return { ok: checks.every((c) => c.pass), checks };
  },
});

/** Read-only residue check — must be all zeros after the flow test ran. */
export const residue = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [products, loans, clients] = await Promise.all([
      ctx.db.query("loanProducts").collect(),
      ctx.db.query("loans").collect(),
      ctx.db.query("clients").collect(),
    ]);
    return {
      tmpProducts: products.filter((p) => p.code.startsWith("PRC-TMP")).length,
      tmpLoans: loans.filter((l) => l.loanId.startsWith("LN-TMP")).length,
      tmpClients: clients.filter((c) => c.code.startsWith("C-TMP")).length,
    };
  },
});