import { internalQuery } from "./_generated/server";
import {
  buildCombinedStatement,
  buildLoanStatement,
  resolveClientMatches,
  type StatementCollection,
  type StatementLoan,
  type StatementReceipt,
  type StatementScheduleRow,
} from "../lib/finance/statement";

/**
 * TEMPORARY live probe for the Reports → Statement feature.
 *
 * Run with:
 *   bun convex run _tmpStatementProbe:run
 *
 * The public `reports.statementSearch` / `reports.statement` queries need an
 * authenticated identity (they call requireProfile), which the CLI does not
 * have — so this probe drives the SAME pure engine (resolveClientMatches,
 * buildLoanStatement, buildCombinedStatement) against the real tables and
 * reconciles its output with the stored loan balances. Read-only.
 */
export const run = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const [clients, loans, schedules, collections, receipts, centers, profiles] =
      await Promise.all([
        ctx.db.query("clients").collect(),
        ctx.db.query("loans").collect(),
        ctx.db.query("loanSchedules").collect(),
        ctx.db.query("collections").collect(),
        ctx.db.query("receipts").collect(),
        ctx.db.query("centers").collect(),
        ctx.db.query("profiles").collect(),
      ]);

    const profileById = new Map(profiles.map((p) => [p._id, p]));
    const loansByClient: Record<string, string[]> = {};
    for (const l of loans) {
      (loansByClient[l.clientId] ??= []).push(l.loanId);
    }

    // Real clients that actually have loans — the interesting records.
    const candidates = clients.filter((c) => (loansByClient[c._id] ?? []).length > 0);
    const sample = candidates.slice(0, 3);

    const results = [];
    for (const c of sample) {
      /* -------- Search by all four identifier spellings -------- */
      const byClientId = resolveClientMatches(clients, loansByClient, c.code);
      const byCustomerIdLower = resolveClientMatches(
        clients,
        loansByClient,
        c.code.toLowerCase(),
      );
      const cLoans = loans
        .filter((l) => l.clientId === c._id)
        .sort((a, b) => a.createdAt - b.createdAt);
      const byLan = resolveClientMatches(clients, loansByClient, cLoans[0].loanId);

      /* -------- Build the statement from the real ledgers -------- */
      const statementLoans: StatementLoan[] = cLoans.map((l) => {
        const schedule: StatementScheduleRow[] = schedules
          .filter((s) => s.loanId === l._id)
          .sort((a, b) => a.index - b.index)
          .map((r) => ({
            _id: r._id,
            index: r.index,
            dueDate: r.dueDate,
            principal: r.principal,
            interest: r.interest,
            totalDue: r.totalDue,
            paid: r.paid,
          }));
        const coll: StatementCollection[] = collections
          .filter((x) => x.loanId === l._id)
          .map((x) => ({
            _id: x._id,
            code: x.code,
            createdAt: x.createdAt,
            amount: x.amount,
            principalPortion: x.principalPortion,
            interestPortion: x.interestPortion,
            mode: x.mode,
            status: x.status,
            reversalOfId: x.reversalOfId,
            receiptNumber: x.receiptNumber,
            staffId: x.staffId,
            remarks: x.remarks,
          }));
        const rec: StatementReceipt[] = receipts
          .filter((r) => r.loanId === l._id)
          .map((r) => ({
            _id: r._id,
            collectionId: r.collectionId,
            number: r.number,
            amount: r.amount,
            createdAt: r.createdAt,
            outstandingAfter: r.outstandingAfter,
          }));
        return {
          ...l,
          schedule,
          collections: coll,
          receipts: rec,
          purpose: c.loanRequest?.purpose,
        } as unknown as StatementLoan;
      });
      // Fill the requested amount from each application document.
      for (let i = 0; i < cLoans.length; i++) {
        const appId = cLoans[i].applicationId;
        const app = appId ? await ctx.db.get(appId) : null;
        statementLoans[i].requestedAmount =
          app && "amount" in app ? (app as { amount: number }).amount : undefined;
      }

      const perLoan = statementLoans.map((l) => buildLoanStatement(l, {}, now));
      const combined = buildCombinedStatement(statementLoans, {}, now);

      const reconciliation = cLoans.map((l, i) => {
        const s = perLoan[i];
        const scheduleRows = statementLoans[i].schedule;
        const engineOutstanding = s.repayment.outstanding;
        const scheduleOutstanding = Math.round(
          scheduleRows.reduce((sum, r) => sum + Math.max(0, r.totalDue - r.paid), 0) * 100,
        ) / 100;
        return {
          loanId: l.loanId,
          storedStatus: l.status,
          storedOutstanding: l.outstanding,
          engineOutstanding,
          scheduleOutstanding,
          outstandingAllMatch:
            Math.abs(l.outstanding - engineOutstanding) < 0.011 &&
            Math.abs(scheduleOutstanding - engineOutstanding) < 0.011,
          storedPaidTotal: l.paidTotal,
          ledgerPaymentCount: statementLoans[i].collections.length,
          lifetimePaid: s.summary.lifetimePaid,
          nextDueDate: s.repayment.nextDueDate
            ? new Date(s.repayment.nextDueDate).toISOString().slice(0, 10)
            : null,
          nextDueAmount: s.repayment.nextDueAmount,
          overdueAmount: s.repayment.totalOverdueAmount,
          installmentsPaid: s.repayment.installmentsPaid,
          installmentsRemaining: s.repayment.installmentsRemaining,
          lastPayment: s.repayment.lastPaymentDate
            ? {
                date: new Date(s.repayment.lastPaymentDate).toISOString().slice(0, 10),
                amount: s.repayment.lastPaymentAmount,
              }
            : null,
          ledgerRows: s.ledger.length,
        };
      });

      const center = c.centerId
        ? centers.find((x) => x._id === c.centerId)
        : centers.find((x) => x.code === c.centerCode);
      results.push({
        client: {
          code: c.code,
          name: c.name,
          registeredBy: profileById.get(c.createdBy)?.name ?? null,
          registeredById: c.createdBy,
          openedOn: new Date(c.createdAt).toISOString().slice(0, 10),
          center: center ? `${center.code} · ${center.name}` : (c.centerCode ?? null),
          groupCode: c.groupCode ?? null,
        },
        search: {
          byClientId: byClientId.map((m) => `${m.code} (${m.matchedOn})`),
          byCustomerIdLowercase: byCustomerIdLower.map((m) => `${m.code} (${m.matchedOn})`),
          byLanId: byLan.map((m) => `${m.code} (${m.matchedOn})`),
        },
        reconciliation,
        combinedOutstanding: combined.repayment.outstanding,
        combinedNextDue: combined.repayment.nextDueDate
          ? new Date(combined.repayment.nextDueDate).toISOString().slice(0, 10)
          : null,
      });
    }

    // A query that matches nothing must stay empty (no fuzzy fallback).
    const noHit = resolveClientMatches(clients, loansByClient, "C-999999");

    return {
      totals: {
        clients: clients.length,
        clientsWithLoans: candidates.length,
        loans: loans.length,
      },
      results,
      noHitCount: noHit.length,
    };
  },
});
