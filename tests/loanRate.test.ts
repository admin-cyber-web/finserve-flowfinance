import { describe, expect, test } from "bun:test";
import { recastOpenTail } from "../src/lib/finance/recast";
import {
  generateSchedule,
  rowOutstanding,
  type ScheduleRow,
} from "../src/lib/finance/schedule";

/**
 * 79% → 78.5% reducing, 24 weekly installments.
 *
 * The pricing complaint was concrete: a ₹15,000 loan showed a ₹751
 * installment while the field collected ₹750. These tests pin:
 *   • the corrected rate prices that loan at exactly ₹750
 *   • an installment is always a whole rupee, so the displayed amount is the
 *     amount that settles the row (no over/under collection)
 *   • an existing loan is recast on its OPEN tail only — paid rows, paid
 *     amounts and the accounting history are never rewritten
 */

const PRINCIPAL = 15_000;
const RATE_OLD = 79;
const RATE_NEW = 78.5;
const ANCHOR = Date.UTC(2026, 0, 5); // Monday

const oldSchedule = (): ScheduleRow[] =>
  generateSchedule({
    principal: PRINCIPAL,
    annualRate: RATE_OLD,
    method: "REDUCING",
    frequency: "WEEKLY",
    tenure: 24,
    disbursedOn: ANCHOR,
  }).rows;

const openTotal = (rows: { totalDue: number; paid: number; waived?: number }[]) =>
  Number(
    rows
      .reduce((sum, row) => sum + rowOutstanding(row), 0)
      .toFixed(2),
  );

describe("78.5% reducing terms", () => {
  test("₹15,000 over 24 weeks prices at exactly ₹750 (was ₹751 at 79%)", () => {
    const before = generateSchedule({
      principal: PRINCIPAL,
      annualRate: RATE_OLD,
      method: "REDUCING",
      frequency: "WEEKLY",
      tenure: 24,
      disbursedOn: ANCHOR,
    });
    const after = generateSchedule({
      principal: PRINCIPAL,
      annualRate: RATE_NEW,
      method: "REDUCING",
      frequency: "WEEKLY",
      tenure: 24,
      disbursedOn: ANCHOR,
    });

    expect(before.installment).toBe(751);
    expect(after.installment).toBe(750);
    expect(after.rows[0].totalDue).toBe(750);
  });

  test("installments are whole rupees, so a ₹750 collection settles a row", () => {
    const schedule = generateSchedule({
      principal: PRINCIPAL,
      annualRate: RATE_NEW,
      method: "REDUCING",
      frequency: "WEEKLY",
      tenure: 24,
      disbursedOn: ANCHOR,
    });

    for (const row of schedule.rows) {
      expect(Number.isInteger(row.totalDue)).toBe(true);
    }
    expect(rowOutstanding({ totalDue: 750, paid: 750 })).toBe(0);
  });

  test("the schedule still closes exactly on the principal", () => {
    const schedule = generateSchedule({
      principal: PRINCIPAL,
      annualRate: RATE_NEW,
      method: "REDUCING",
      frequency: "WEEKLY",
      tenure: 24,
      disbursedOn: ANCHOR,
    });

    const principalPaid = schedule.rows.reduce((s, r) => s + r.principal, 0);
    expect(Number(principalPaid.toFixed(2))).toBe(PRINCIPAL);
    expect(schedule.rows[schedule.rows.length - 1].principalBalance).toBe(0);
    expect(
      Number(
        schedule.rows.reduce((s, r) => s + r.totalDue, 0).toFixed(2),
      ),
    ).toBe(Number(schedule.totalPayable.toFixed(2)));
  });
});

describe("existing-loan recast", () => {
  test("a fully unpaid loan is repriced end to end at ₹750", () => {
    const original = oldSchedule();
    expect(original[0].totalDue).toBe(751);

    const recast = recastOpenTail(original, RATE_NEW, "WEEKLY");

    expect(recast.recastFromIndex).toBe(1);
    expect(recast.remainingInstallments).toBe(24);
    expect(recast.installment).toBe(750);
    expect(recast.rows[0].totalDue).toBe(750);
    expect(recast.rows.every((row) => Number.isInteger(row.totalDue))).toBe(
      true,
    );
    // Fewer interest rupees owed, principal still fully repaid.
    expect(openTotal(recast.rows)).toBeLessThan(openTotal(original));
    expect(
      Number(recast.rows.reduce((s, r) => s + r.principal, 0).toFixed(2)),
    ).toBe(PRINCIPAL);
    expect(recast.rows[recast.rows.length - 1].principalBalance).toBe(0);
  });

  test("paid installments and collected amounts are left untouched", () => {
    const original = oldSchedule();
    // Five weeks collected in cash at ₹751 — real, historical money.
    const withHistory = original.map((row, i) => ({
      ...row,
      paid: i < 5 ? row.totalDue : 0,
      remaining: i < 5 ? 0 : row.totalDue,
    }));

    const recast = recastOpenTail(withHistory, RATE_NEW, "WEEKLY");

    expect(recast.recastFromIndex).toBe(6);
    for (let i = 0; i < 5; i++) {
      expect(recast.rows[i]).toEqual(withHistory[i]);
    }
    // Only the open tail is repriced; the remaining principal is unchanged.
    expect(recast.remainingPrincipal).toBe(
      Number(
        withHistory
          .slice(5)
          .reduce((s, r) => s + r.principal, 0)
          .toFixed(2),
      ),
    );
    expect(
      Number(recast.rows.reduce((s, r) => s + r.paid, 0).toFixed(2)),
    ).toBe(Number(withHistory.reduce((s, r) => s + r.paid, 0).toFixed(2)));
    expect(recast.rows[5].totalDue).not.toBe(withHistory[5].totalDue);
  });

  test("a partially paid installment is frozen and the recast starts after it", () => {
    const original = oldSchedule();
    const partial = original.map((row, i) =>
      i === 0 ? { ...row, paid: 400, remaining: row.totalDue - 400 } : row,
    );

    const recast = recastOpenTail(partial, RATE_NEW, "WEEKLY");

    expect(recast.recastFromIndex).toBe(2);
    expect(recast.rows[0].paid).toBe(400);
    expect(recast.rows[0].totalDue).toBe(partial[0].totalDue);
    expect(recast.rows[1].paid).toBe(0);
    expect(openTotal(recast.rows)).toBeLessThan(openTotal(partial));
  });

  test("a fully repaid loan has nothing to recast", () => {
    const settled = oldSchedule().map((row) => ({
      ...row,
      paid: row.totalDue,
      remaining: 0,
    }));

    const recast = recastOpenTail(settled, RATE_NEW, "WEEKLY");

    expect(recast.recastFromIndex).toBeNull();
    expect(recast.installment).toBeNull();
    expect(recast.rows).toEqual(settled);
  });

  test("recasting preserves due dates and installment indexes", () => {
    const original = oldSchedule();
    const recast = recastOpenTail(original, RATE_NEW, "WEEKLY");

    expect(recast.rows.map((r) => r.index)).toEqual(
      original.map((r) => r.index),
    );
    expect(recast.rows.map((r) => r.dueDate)).toEqual(
      original.map((r) => r.dueDate),
    );
  });
});
