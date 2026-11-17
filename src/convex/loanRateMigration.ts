import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { recastOpenTail } from "../lib/finance/recast";
import { round2 } from "../lib/finance/money";
import type { Frequency, InterestMethod } from "../lib/finance/types";
import { baseScheduleRows } from "../lib/server/loanOps";
import { FIXED_LOAN_TERMS } from "../lib/server/loanTerms";

/**
 * One-off correction: 79% → 78.5% reducing, applied to CONFIGURATION and to
 * the OPEN tail of live loans.
 *
 * Rules enforced here:
 *   • Historical money is never touched — collections, receipts, the journal,
 *     wallet ledger and every schedule row that has received cash (or been
 *     waived) stay exactly as they are.
 *   • Closed / settled / surrendered / written-off loans are historical
 *     records and are left at the rate they were priced at.
 *   • For an open loan, the first fully-unpaid installment starts the recast:
 *     the outstanding principal of that installment and every installment
 *     after it is re-priced at 78.5% over the same remaining count on the same
 *     due dates. Already-paid installments keep their original split.
 *   • Loan totals are then re-derived from the rows (outstanding, paid total,
 *     payable, interest, installment, next due) so reports reconcile.
 *
 * Safe to re-run: only loans/products still at 79% are touched.
 */

const RATE_FROM = 79;
const RATE_TO = FIXED_LOAN_TERMS.interestRate;

const TERMINAL = ["CLOSED", "SETTLED", "SURRENDERED", "WRITTEN_OFF"];

const openOn = (row: { totalDue: number; paid: number; waived?: number }) =>
  round2(Math.max(0, row.totalDue - row.paid - (row.waived ?? 0)));

export const applyCorrectedInterestRate = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    /** Safety valve for very large books; the rest is reported as skipped. */
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    const limit = args.limit ?? 500;
    const now = Date.now();

    /* ------------------------- 1. loan products ------------------------- */
    const products = await ctx.db.query("loanProducts").collect();
    const repriceProducts = products.filter((p) => p.interestRate === RATE_FROM);
    if (!dryRun) {
      for (const product of repriceProducts) {
        await ctx.db.patch(product._id, { interestRate: RATE_TO });
      }
    }

    /* ----------------------------- 2. loans ----------------------------- */
    const loans = (await ctx.db.query("loans").collect())
      .filter((l) => l.interestRate === RATE_FROM)
      .sort((a, b) => a.createdAt - b.createdAt);

    const report: {
      loanId: string;
      action: string;
      recastFrom?: number;
      installment?: number;
      outstandingBefore?: number;
      outstandingAfter?: number;
      paidTotal?: number;
      rowsRepriced?: number;
    }[] = [];

    const toProcess = loans.slice(0, limit);
    const deferred = loans.slice(limit).map((l) => l.loanId);

    for (const loan of toProcess) {
      if (TERMINAL.includes(loan.status)) {
        report.push({
          loanId: loan.loanId,
          action: "SKIPPED_TERMINAL_HISTORY",
        });
        continue;
      }

      const rows = await ctx.db
        .query("loanSchedules")
        .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
        .collect();

      /* ------- approved but not disbursed: reprice the terms only ------- */
      if (rows.length === 0) {
        const priced = baseScheduleRows({
          principal: loan.principal,
          interestRate: RATE_TO,
          interestMethod: loan.interestMethod as InterestMethod,
          frequency: loan.frequency as Frequency,
          tenure: loan.tenure,
          disbursedOn: loan.firstMeetingDate ?? now,
          graceDays: FIXED_LOAN_TERMS.graceDays,
          charges: 0,
        });
        const interestTotal = round2(
          priced.reduce((sum, row) => sum + row.interest, 0),
        );
        if (!dryRun) {
          await ctx.db.patch(loan._id, {
            interestRate: RATE_TO,
            interestTotal,
            installment: priced[0]?.totalDue ?? loan.installment,
          });
        }
        report.push({
          loanId: loan.loanId,
          action: "REPRICED_UNDISBURSED",
          installment: priced[0]?.totalDue,
          outstandingBefore: loan.outstanding,
          outstandingAfter: loan.outstanding,
          paidTotal: loan.paidTotal,
        });
        continue;
      }

      const outstandingBefore = round2(
        rows.reduce((sum, row) => sum + openOn(row), 0),
      );
      const paidTotal = round2(rows.reduce((sum, row) => sum + row.paid, 0));
      if (outstandingBefore <= 0) {
        report.push({
          loanId: loan.loanId,
          action: "SKIPPED_FULLY_REPAID",
          outstandingBefore,
          outstandingAfter: outstandingBefore,
          paidTotal,
        });
        continue;
      }

      const recast = recastOpenTail(rows, RATE_TO, loan.frequency as Frequency);
      if (recast.recastFromIndex === null) {
        report.push({ loanId: loan.loanId, action: "NO_OPEN_TAIL" });
        continue;
      }
      const recastFromIndex = recast.recastFromIndex;

      if (!dryRun) {
        let repriced = 0;
        for (const row of recast.rows) {
          if (row.index < recastFromIndex) continue;
          await ctx.db.patch(row._id, {
            principal: row.principal,
            interest: row.interest,
            totalDue: row.totalDue,
            paid: 0,
            waived: 0,
            remaining: row.totalDue,
            principalBalance: row.principalBalance,
            status: row.dueDate < now ? "OVERDUE" : "PENDING",
            updatedAt: now,
          });
          repriced += 1;
        }

        // Re-derive every loan figure from the rows (single source of truth).
        const allRows = await ctx.db
          .query("loanSchedules")
          .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
          .collect();
        const outstanding = round2(
          allRows.reduce((sum, row) => sum + openOn(row), 0),
        );
        const openRows = allRows
          .filter((row) => openOn(row) > 0)
          .sort((a, b) => a.index - b.index);

        await ctx.db.patch(loan._id, {
          interestRate: RATE_TO,
          interestTotal: round2(
            allRows.reduce((sum, row) => sum + row.interest, 0),
          ),
          totalPayable: round2(
            allRows.reduce((sum, row) => sum + row.totalDue, 0),
          ),
          installment: openRows[0]?.totalDue ?? loan.installment,
          outstanding,
          paidTotal: round2(allRows.reduce((sum, row) => sum + row.paid, 0)),
          nextDueDate: openRows[0]?.dueDate,
        });

        report.push({
          loanId: loan.loanId,
          action: "RECAST_OPEN_TAIL",
          recastFrom: recastFromIndex,
          installment: openRows[0]?.totalDue ?? recast.installment ?? undefined,
          outstandingBefore,
          outstandingAfter: outstanding,
          paidTotal,
          rowsRepriced: repriced,
        });
      } else {
        const outstandingAfter = round2(
          rows.reduce(
            (sum, row) =>
              sum +
              (row.index < recastFromIndex
                ? openOn(row)
                : openOn(recast.rows.find((r) => r.index === row.index) ?? row)),
            0,
          ),
        );
        report.push({
          loanId: loan.loanId,
          action: "RECAST_OPEN_TAIL",
          recastFrom: recastFromIndex,
          installment: recast.installment ?? undefined,
          outstandingBefore,
          outstandingAfter,
          paidTotal,
          rowsRepriced: recast.rows.filter((r) => r.index >= recastFromIndex)
            .length,
        });
      }
    }

    const changed = report.filter(
      (r) => r.action === "RECAST_OPEN_TAIL" || r.action === "REPRICED_UNDISBURSED",
    );

    return {
      dryRun,
      rateFrom: RATE_FROM,
      rateTo: RATE_TO,
      productsScanned: products.length,
      productsRepriced: repriceProducts.map((p) => p.code),
      loansScanned: loans.length,
      loansChanged: changed.length,
      deferred,
      report,
    };
  },
});
