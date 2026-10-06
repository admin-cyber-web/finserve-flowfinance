/**
 * Core loan operations — the ONE code path used by live mutations
 * (convex/collections.ts, convex/loans.ts) and by the demo seed.
 *
 * Every operation appends to an immutable ledger (walletTransactions,
 * collections, receipts, journalEntries, auditLogs). Nothing here ever edits
 * a stored balance: balances are derived, statuses are recomputed.
 */
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { collectionEntry, disbursementEntry } from "../finance/journal";
import { round2 } from "../finance/money";
import { generateSchedule, type ScheduleRow } from "../finance/schedule";
import type { Frequency, InterestMethod, PayMode } from "../finance/types";
import { evaluateEligibility } from "../finance/eligibility";
import {
  AppError,
  daySuffix,
  istDateKey,
  logAudit,
  makeCode,
  nextSeq,
  notify,
  writeJournal,
  writeWalletTx,
  type Mtx,
} from "./convexHelpers";

/* ------------------------------ Read helpers ------------------------------ */

export function baseScheduleRows(
  input: {
    principal: number;
    interestRate: number;
    interestMethod: InterestMethod;
    frequency: Frequency;
    tenure: number;
    disbursedOn: number;
    graceDays?: number;
    charges?: number;
  },
): ScheduleRow[] {
  const result = generateSchedule({
    principal: input.principal,
    annualRate: input.interestRate,
    method: input.interestMethod,
    frequency: input.frequency,
    tenure: input.tenure,
    disbursedOn: input.disbursedOn,
    graceDays: input.graceDays,
  });
  const charges = round2(input.charges ?? 0);
  if (charges > 0 && result.rows.length > 0) {
    // Approved charges are financed into the first installment, so the
    // receivable (Σ principal) always equals principal + charges.
    const first = result.rows[0];
    first.principal = round2(first.principal + charges);
    first.totalDue = round2(first.totalDue + charges);
    first.remaining = round2(first.remaining + charges);
    result.totalPayable = round2(result.totalPayable + charges);
  }
  return result.rows;
}

export interface LoanView {
  displayStatus: string;
  overdueDays: number;
  overdueAmount: number;
  nextDueDate: number | null;
  dueToday: number;
  progressPct: number;
}

/** Status derived from the schedule + clock — never from a stale field. */
export function deriveLoanView(
  loan: Doc<"loans">,
  rows: Doc<"loanSchedules">[],
  now: number,
): LoanView {
  const openRows = rows.filter((r) => r.paid < r.totalDue);
  const overdueRows = openRows.filter((r) => r.dueDate < now);
  const overdueAmount = round2(
    overdueRows.reduce((s, r) => s + (r.totalDue - r.paid), 0),
  );
  const overdueDays = overdueRows.length
    ? Math.floor((now - Math.min(...overdueRows.map((r) => r.dueDate))) / 86_400_000)
    : 0;
  const dueTodayStart = now - (now % 86_400_000);
  const dueToday = round2(
    openRows
      .filter((r) => r.dueDate >= dueTodayStart && r.dueDate < dueTodayStart + 86_400_000)
      .reduce((s, r) => s + (r.totalDue - r.paid), 0),
  );

  let displayStatus = loan.status;
  if (["DISBURSED", "ACTIVE", "OVERDUE"].includes(loan.status)) {
    if (loan.outstanding <= 0) displayStatus = "CLOSED";
    else if (overdueAmount > 0) displayStatus = "OVERDUE";
    else displayStatus = "ACTIVE";
  }

  const progressPct =
    loan.totalPayable > 0
      ? Math.min(100, round2((loan.paidTotal / loan.totalPayable) * 100))
      : 0;

  return {
    displayStatus,
    overdueDays,
    overdueAmount,
    nextDueDate: openRows.length
      ? Math.min(...openRows.map((r) => r.dueDate))
      : null,
    dueToday,
    progressPct,
  };
}

/* ------------------------------ Allocation ------------------------------- */

interface Allocation {
  rows: { row: Doc<"loanSchedules">; interestPaid: number; principalPaid: number }[];
  principalPortion: number;
  interestPortion: number;
}

/** Interest-first waterfall allocation of a payment across due installments. */
export function allocatePayment(
  rows: Doc<"loanSchedules">[],
  amount: number,
): Allocation {
  let left = round2(amount);
  const result: Allocation["rows"] = [];
  let principalPortion = 0;
  let interestPortion = 0;

  for (const row of [...rows].sort((a, b) => a.index - b.index)) {
    if (left <= 0) break;
    const due = round2(row.totalDue - row.paid);
    if (due <= 0) continue;
    const take = round2(Math.min(left, due));
    const interestLeft = round2(row.interest - Math.min(row.paid, row.interest));
    const interestPaid = round2(Math.min(take, Math.max(0, interestLeft)));
    const principalPaid = round2(take - interestPaid);
    left = round2(left - take);
    result.push({ row, interestPaid, principalPaid });
    interestPortion = round2(interestPortion + interestPaid);
    principalPortion = round2(principalPortion + principalPaid);
  }

  if (round2(principalPortion + interestPortion) < round2(amount)) {
    throw new AppError("Payment exceeds the outstanding amount on this loan.");
  }
  return { rows: result, principalPortion, interestPortion };
}

/** Same waterfall run in reverse (used by corrections / reversals). */
export function unallocatePayment(
  rows: Doc<"loanSchedules">[],
  amount: number,
): Doc<"loanSchedules">[] {
  let left = round2(amount);
  const targets: Doc<"loanSchedules">[] = [];
  const paidRows = rows
    .filter((r) => r.paid > 0)
    .sort((a, b) => b.index - a.index);
  for (const row of paidRows) {
    if (left <= 0) break;
    const take = Math.min(left, row.paid);
    left = round2(left - take);
    targets.push(row);
  }
  if (left > 0) {
    throw new AppError("Cannot reverse more than what was collected.");
  }
  return targets;
}

/* ----------------------------- Disbursement ------------------------------ */

export interface DisburseArgs {
  loanId: Id<"loans">;
  actor: Doc<"profiles">;
  device?: string;
  now?: number;
}

/**
 * Disburses an approved loan: inserts the repayment schedule, moves the
 * principal out of the staff wallet (ledger), writes the double-entry journal
 * and the audit trail, then notifies everyone who needs to know.
 */
export async function disburseLoan(
  ctx: Mtx,
  { loanId, actor, device, now }: DisburseArgs,
): Promise<{ loan: Doc<"loans">; walletDebit: number }> {
  const nowMs = now ?? Date.now();
  const loan = await ctx.db.get(loanId);
  if (!loan) throw new AppError("Loan not found.");
  if (!["APPROVED", "DISBURSED"].includes(loan.status)) {
    throw new AppError(`Loan is ${loan.status} — only an approved loan can be disbursed.`);
  }

  const [client, product, staff] = await Promise.all([
    ctx.db.get(loan.clientId),
    ctx.db.get(loan.productId),
    ctx.db.get(loan.staffId),
  ]);
  if (!client || !product || !staff) throw new AppError("Loan references are broken.");

  const rows = baseScheduleRows({
    principal: loan.principal,
    interestRate: loan.interestRate,
    interestMethod: loan.interestMethod as InterestMethod,
    frequency: loan.frequency as Frequency,
    tenure: loan.tenure,
    disbursedOn: nowMs,
    graceDays: product.graceDays,
    charges: loan.charges,
  });

  for (const row of rows) {
    await ctx.db.insert("loanSchedules", {
      loanId: loan._id,
      index: row.index,
      dueDate: row.dueDate,
      principal: row.principal,
      interest: row.interest,
      totalDue: row.totalDue,
      paid: 0,
      remaining: row.totalDue,
      status: "PENDING",
      updatedAt: nowMs,
    });
  }

  const outstanding = round2(rows.reduce((s, r) => s + r.totalDue, 0));
  const totalPayable = round2(outstanding);

  // Wallet: principal walks out of the staff working wallet (ledger only).
  let walletDebit = 0;
  const wallet = await ctx.db
    .query("wallets")
    .withIndex("by_profile", (q) => q.eq("profileId", staff._id))
    .unique();
  if (wallet) {
    walletDebit = loan.principal;
    await writeWalletTx(ctx, {
      walletId: wallet._id,
      profileId: staff._id,
      branchId: loan.branchId,
      type: "LOAN_DISBURSEMENT",
      amount: walletDebit,
      direction: "DEBIT",
      referenceType: "LOAN",
      referenceId: loan.loanId,
      idempotencyKey: `disburse:${loan.loanId}`,
      createdBy: actor._id,
      remarks: `Disbursed to ${client.name} (${client.code})`,
      createdAt: nowMs,
    });
  }

  // Journal: Loan Receivable Dr / Cash Cr (+ fee income when charges apply).
  await writeJournal(
    ctx,
    disbursementEntry({
      principal: round2(loan.principal + loan.charges),
      fee: loan.charges,
      cashSource: "staff",
      memo: `Loan disbursal ${loan.loanId} — ${client.name}`,
      refId: loan.loanId,
    }),
    { branchId: loan.branchId, createdBy: actor._id, createdAt: nowMs },
  );

  await ctx.db.patch(loan._id, {
    status: "ACTIVE",
    disbursedAt: nowMs,
    disbursedBy: actor._id,
    outstanding,
    totalPayable,
    paidTotal: 0,
    nextDueDate: rows[0]?.dueDate ?? null,
    overdueDays: 0,
  });
  const updated = (await ctx.db.get(loan._id))!;

  await logAudit(ctx, {
    actorId: actor._id,
    actorName: actor.name,
    role: actor.role,
    action: "LOAN_DISBURSED",
    entity: "loans",
    entityId: loan.loanId,
    before: { status: loan.status },
    after: { status: "ACTIVE", outstanding, walletDebit },
    referenceId: loan.loanId,
    branchId: loan.branchId,
    device,
  });

  await notify(ctx, staff._id, {
    title: "Loan disbursed",
    body: `${loan.loanId} — ₹${loan.principal.toLocaleString("en-IN")} disbursed to ${client.name}.`,
    kind: "LOAN",
    link: `/dashboard/loans/${loan._id}`,
  });
  if (client) {
    const clientProfile = (
      await ctx.db.query("profiles").collect()
    ).find((p) => p.clientId === client._id);
    if (clientProfile) {
      await notify(ctx, clientProfile._id, {
        title: "Loan approved & disbursed",
        body: `Your loan ${loan.loanId} has been disbursed. First installment ₹${rows[0]?.totalDue ?? 0} due ${new Date(rows[0]?.dueDate ?? nowMs).toLocaleDateString("en-IN")}.`,
        kind: "LOAN",
        link: `/dashboard/loans/${loan._id}`,
      });
    }
  }

  return { loan: updated, walletDebit };
}

/* ------------------------------ Collection ------------------------------- */

export interface CollectArgs {
  loanId: Id<"loans">;
  actor: Doc<"profiles">; // the staff member collecting
  amount: number;
  mode: PayMode;
  remarks?: string;
  idempotencyKey?: string;
  location?: string;
  device?: string;
  now?: number;
}

export interface CollectResult {
  collectionId: Id<"collections">;
  receiptNumber: string;
  principalPortion: number;
  interestPortion: number;
  outstandingAfter: number;
  duplicate: boolean;
}

/**
 * Records a repayment: idempotent, ledger-first, receipting, journalised and
 * audited. CASH credits the staff wallet; UPI/BANK are recorded on the wallet
 * ledger with no cash effect (funds settle in the bank account).
 */
export async function recordCollection(
  ctx: Mtx,
  args: CollectArgs,
): Promise<CollectResult> {
  const nowMs = args.now ?? Date.now();

  // Idempotency — offline queues can safely retry.
  if (args.idempotencyKey) {
    const existing = await ctx.db
      .query("collections")
      .withIndex("by_idem", (q) => q.eq("idempotencyKey", args.idempotencyKey!))
      .unique();
    if (existing) {
      return {
        collectionId: existing._id,
        receiptNumber: existing.receiptNumber ?? "—",
        principalPortion: existing.principalPortion,
        interestPortion: existing.interestPortion,
        outstandingAfter: 0,
        duplicate: true,
      };
    }
  }

  if (args.actor.status !== "ACTIVE") {
    throw new AppError(
      `Collections are blocked: your account is ${args.actor.status.toLowerCase()}.`,
    );
  }

  const loan = await ctx.db.get(args.loanId);
  if (!loan) throw new AppError("Loan not found.");
  if (!["ACTIVE", "OVERDUE", "DISBURSED"].includes(loan.status)) {
    throw new AppError(`Loan ${loan.loanId} is ${loan.status} — no collections accepted.`);
  }

  const rows = await ctx.db
    .query("loanSchedules")
    .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
    .collect();

  const allocation = allocatePayment(rows, args.amount);

  // 1. Collection document (append-only).
  const collectionCode = await makeCode(ctx, "collection", "PY-", 6);
  const collectionId = await ctx.db.insert("collections", {
    code: collectionCode,
    loanId: loan._id,
    scheduleId: allocation.rows[0]?.row._id,
    clientId: loan.clientId,
    staffId: args.actor._id,
    branchId: loan.branchId,
    amount: args.amount,
    principalPortion: allocation.principalPortion,
    interestPortion: allocation.interestPortion,
    mode: args.mode,
    remarks: args.remarks,
    status: "NORMAL",
    idempotencyKey: args.idempotencyKey,
    syncStatus: "SYNCED",
    location: args.location,
    createdAt: nowMs,
  });

  // 2. Wallet ledger (cash only in, UPI/BANK recorded with no cash effect).
  let walletTxnId: Id<"walletTransactions"> | undefined;
  const wallet = await ctx.db
    .query("wallets")
    .withIndex("by_profile", (q) => q.eq("profileId", args.actor._id))
    .unique();
  if (wallet) {
    const type =
      args.mode === "CASH"
        ? "CASH_COLLECTION"
        : args.mode === "UPI"
          ? "UPI_COLLECTION"
          : "BANK_COLLECTION";
    const written = await writeWalletTx(ctx, {
      walletId: wallet._id,
      profileId: args.actor._id,
      branchId: loan.branchId,
      type,
      amount: args.amount,
      direction: args.mode === "CASH" ? "CREDIT" : "NONE",
      referenceType: "COLLECTION",
      referenceId: collectionCode,
      idempotencyKey: args.idempotencyKey
        ? `wallet:${args.idempotencyKey}`
        : undefined,
      createdBy: args.actor._id,
      remarks: `${args.mode} collection — ${loan.loanId}`,
      createdAt: nowMs,
    });
    walletTxnId = written.txnId;
  }

  // 3. Receipt (unique per day, immediately shareable).
  const receiptSeq = await nextSeq(ctx, `receipt-${daySuffix(nowMs)}`);
  const receiptNumber = `RCPT-${daySuffix(nowMs)}-${String(receiptSeq).padStart(4, "0")}`;
  const receiptId = await ctx.db.insert("receipts", {
    number: receiptNumber,
    loanId: loan._id,
    clientId: loan.clientId,
    collectionId,
    staffId: args.actor._id,
    branchId: loan.branchId,
    amount: args.amount,
    mode: args.mode,
    outstandingAfter: 0, // patched below
    createdAt: nowMs,
  });
  await ctx.db.patch(collectionId, { receiptId, receiptNumber });

  // 4. Journal: Cash/Bank Dr / Loan Receivable Cr / Interest Income Cr.
  await writeJournal(
    ctx,
    collectionEntry({
      principal: allocation.principalPortion,
      interest: allocation.interestPortion,
      mode: args.mode,
      memo: `Repayment ${collectionCode} — ${loan.loanId}`,
      refId: collectionCode,
    }),
    { branchId: loan.branchId, createdBy: args.actor._id, createdAt: nowMs },
  );

  // 5. Roll the schedule forward.
  for (const part of allocation.rows) {
    const paid = round2(part.row.paid + part.interestPaid + part.principalPaid);
    const remaining = round2(part.row.totalDue - paid);
    const status =
      remaining <= 0 ? "PAID" : nowMs > part.row.dueDate ? "OVERDUE" : "PARTIAL";
    await ctx.db.patch(part.row._id, { paid, remaining, status, updatedAt: nowMs });
  }

  const allRows = await ctx.db
    .query("loanSchedules")
    .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
    .collect();
  const outstanding = round2(
    allRows.reduce((s, r) => s + Math.max(0, r.totalDue - r.paid), 0),
  );
  const paidTotal = round2(allRows.reduce((s, r) => s + r.paid, 0));
  const openRows = allRows
    .filter((r) => r.paid < r.totalDue)
    .sort((a, b) => a.index - b.index);

  const closed = outstanding <= 0;
  const overdue = !closed && allRows.some((r) => r.paid < r.totalDue && r.dueDate < nowMs);

  await ctx.db.patch(loan._id, {
    outstanding,
    paidTotal,
    lastPaymentAt: nowMs,
    nextDueDate: openRows[0]?.dueDate ?? null,
    status: closed ? "CLOSED" : overdue ? "OVERDUE" : "ACTIVE",
    closeDate: closed ? nowMs : loan.closeDate,
    overdueDays: 0,
  });

  await ctx.db.patch(receiptId, { outstandingAfter: outstanding });
  await ctx.db.patch(collectionId, { receiptNumber });

  // 6. Audit + notifications.
  await logAudit(ctx, {
    actorId: args.actor._id,
    actorName: args.actor.name,
    role: args.actor.role,
    action: "PAYMENT_COLLECTED",
    entity: "collections",
    entityId: collectionCode,
    after: {
      amount: args.amount,
      mode: args.mode,
      principal: allocation.principalPortion,
      interest: allocation.interestPortion,
      loanId: loan.loanId,
      outstandingAfter: outstanding,
    },
    referenceId: receiptNumber,
    branchId: loan.branchId,
    device: args.device,
  });

  const client = await ctx.db.get(loan.clientId);
  const clientProfile = (await ctx.db.query("profiles").collect()).find(
    (p) => p.clientId === loan.clientId,
  );
  if (clientProfile) {
    await notify(ctx, clientProfile._id, {
      title: "Payment received",
      body: `₹${args.amount.toLocaleString("en-IN")} received. Receipt ${receiptNumber}. Outstanding ₹${outstanding.toLocaleString("en-IN")}.`,
      kind: "DUE",
      link: `/dashboard/receipts/${receiptNumber}`,
    });
  }
  await notify(ctx, args.actor._id, {
    title: "Collection recorded",
    body: `${client?.name ?? "Client"} — ₹${args.amount.toLocaleString("en-IN")} (${args.mode}). Receipt ${receiptNumber}.`,
    kind: "DUE",
  });

  return {
    collectionId,
    receiptNumber,
    principalPortion: allocation.principalPortion,
    interestPortion: allocation.interestPortion,
    outstandingAfter: outstanding,
    duplicate: false,
  };
}

/* ------------------------------- Reversal -------------------------------- */

export interface ReverseArgs {
  collectionId: Id<"collections">;
  actor: Doc<"profiles">;
  reason: string;
  device?: string;
  now?: number;
}

/**
 * Financial transactions are NEVER deleted. A reversal appends a
 * compensating transaction and marks the original as reversed, keeping both
 * visible with their audit history.
 */
export async function reverseCollection(
  ctx: Mtx,
  { collectionId, actor, reason, device, now }: ReverseArgs,
): Promise<{ reversalId: Id<"collections">; receiptNumber: string }> {
  const nowMs = now ?? Date.now();
  const original = await ctx.db.get(collectionId);
  if (!original) throw new AppError("Collection not found.");
  if (original.status !== "NORMAL") {
    throw new AppError("Only a normal collection can be reversed.");
  }
  if (actor.role !== "SUPER_ADMIN" && actor.role !== "BRANCH_MANAGER") {
    throw new AppError("Only a Branch Manager or Admin can reverse a transaction.");
  }

  const loan = await ctx.db.get(original.loanId);
  if (!loan) throw new AppError("Loan not found.");

  // 1. Compensating collection row (original stays intact).
  const reversalCode = await makeCode(ctx, "collection", "PY-", 6);
  const reversalId = await ctx.db.insert("collections", {
    code: reversalCode,
    loanId: original.loanId,
    scheduleId: original.scheduleId,
    clientId: original.clientId,
    staffId: original.staffId,
    branchId: original.branchId,
    amount: original.amount,
    principalPortion: original.principalPortion,
    interestPortion: original.interestPortion,
    mode: original.mode,
    remarks: `REVERSAL of ${original.code}: ${reason}`,
    status: "REVERSAL",
    reversalOfId: original._id,
    createdAt: nowMs,
  });

  // 2. Wallet ledger — mirror image of the original (cash comes back out).
  const wallet = await ctx.db
    .query("wallets")
    .withIndex("by_profile", (q) => q.eq("profileId", original.staffId))
    .unique();
  if (wallet) {
    await writeWalletTx(ctx, {
      walletId: wallet._id,
      profileId: original.staffId,
      branchId: original.branchId,
      type: "REVERSAL",
      amount: original.amount,
      direction: original.mode === "CASH" ? "DEBIT" : "NONE",
      referenceType: "COLLECTION",
      referenceId: reversalCode,
      createdBy: actor._id,
      remarks: `Reversal of ${original.code} — ${reason}`,
      createdAt: nowMs,
    });
  }

  // 3. Reverse the schedule allocation — latest installments first.
  const allRows = await ctx.db
    .query("loanSchedules")
    .withIndex("by_loan", (q) => q.eq("loanId", original.loanId))
    .collect();
  let left = round2(original.amount);
  for (const row of allRows
    .filter((r) => r.paid > 0)
    .sort((a, b) => b.index - a.index)) {
    if (left <= 0) break;
    const subtract = Math.min(left, row.paid);
    const newPaid = round2(row.paid - subtract);
    left = round2(left - subtract);
    await ctx.db.patch(row._id, {
      paid: newPaid,
      remaining: round2(row.totalDue - newPaid),
      status: newPaid <= 0 ? "PENDING" : nowMs > row.dueDate ? "OVERDUE" : "PARTIAL",
      updatedAt: nowMs,
    });
  }

  // 4. Mark original reversed.
  await ctx.db.patch(original._id, { status: "REVERSED" });

  // 5. Reverse journal entry.
  await writeJournal(
    ctx,
    {
      memo: `Reversal of ${original.code} — ${reason}`,
      refType: "REVERSAL",
      refId: reversalCode,
      lines: [
        {
          code: "1100",
          debit: original.principalPortion,
          credit: 0,
        },
        {
          code: "4000",
          debit: original.interestPortion,
          credit: 0,
        },
        {
          code: original.mode === "CASH" ? "1010" : "1020",
          debit: 0,
          credit: original.amount,
        },
      ],
    },
    { branchId: original.branchId, createdBy: actor._id, createdAt: nowMs },
  );

  // 6. Recompute loan aggregates.
  const freshRows = await ctx.db
    .query("loanSchedules")
    .withIndex("by_loan", (q) => q.eq("loanId", original.loanId))
    .collect();
  const outstanding = round2(
    freshRows.reduce((s, r) => s + Math.max(0, r.totalDue - r.paid), 0),
  );
  const paidTotal = round2(freshRows.reduce((s, r) => s + r.paid, 0));
  await ctx.db.patch(loan._id, {
    outstanding,
    paidTotal,
    status: outstanding <= 0 ? "CLOSED" : "ACTIVE",
  });

  await logAudit(ctx, {
    actorId: actor._id,
    actorName: actor.name,
    role: actor.role,
    action: "TRANSACTION_REVERSED",
    entity: "collections",
    entityId: original.code,
    before: { status: "NORMAL", amount: original.amount },
    after: { status: "REVERSED", reversalId, reason },
    referenceId: reversalCode,
    branchId: original.branchId,
    device,
  });

  await notify(ctx, original.staffId, {
    title: "Payment reversed",
    body: `${original.code} (₹${original.amount.toLocaleString("en-IN")}) was reversed: ${reason}`,
    kind: "SYSTEM",
  });

  return { reversalId, receiptNumber: original.receiptNumber ?? reversalCode };
}

/* ---------------------------- Application flow --------------------------- */

export function eligibilityFor(
  client: Doc<"clients">,
  product: Doc<"loanProducts">,
  existingObligations: number,
  proposedObligation: number,
  overdueHistory: number,
  activeLoans: number,
) {
  return evaluateEligibility({
    householdIncome: client.householdIncome,
    monthlyIncome: client.monthlyIncome,
    existingObligations,
    proposedObligation,
    maxObligationRatio: product.maxObligationRatio,
    overdueHistory,
    activeLoans,
  });
}

export function dateKeyOf(now: number): string {
  return istDateKey(now);
}
