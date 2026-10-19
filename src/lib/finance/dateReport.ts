/**
 * Date-wise report engine — pure logic shared by the Reports UI, the Convex
 * `reports.dateReport` query and the test suite.
 *
 * Boundaries: every range is expressed in INSTITUTION-LOCAL time (IST,
 * UTC+05:30 — the same clock `istDateKey` uses for business date keys). A
 * range covers 00:00:00.000 IST on the From date through 23:59:59.999 IST on
 * the To date, inclusive, regardless of the device or server timezone. Both
 * endpoints are inside the range; one millisecond outside either end is not.
 *
 * Counting rules (kept consistent with the rest of the app so nothing is
 * double counted):
 *   • Disbursed      ← loans.disbursedAt only (never wallet disbursement txns)
 *   • Applied        ← loanApplications.submittedAt (or createdAt)
 *   • Approved / Rejected ← loanApplications.decidedAt (single decision event)
 *   • Collections    ← collections with status NORMAL only (reversals and
 *                      reversed rows are excluded from the amount)
 *   • Outstanding    ← sum of loan.outstanding for ACTIVE/OVERDUE loans
 *                      (the existing derived balance — point in time, not a
 *                      date-range sum)
 *   • Overdue        ← open schedule rows with dueDate < now (existing rule)
 *
 * No DOM, no Convex imports — safe for browser, backend and `bun test`.
 */
import { RECOVERY_LABELS, WALLET_TX_LABELS } from "./types";
import { rowOutstanding } from "./schedule";

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const DAY_MS = 86_400_000;

/** Every category the date-wise report can return rows for. */
export const DATE_REPORT_CATEGORIES = [
  "ALL",
  "CLIENTS",
  "KYC",
  "LOANS",
  "DISBURSEMENTS",
  "COLLECTIONS",
  "OVERDUE",
  "RECOVERY",
  "HANDOVER",
  "WALLET",
] as const;
export type DateReportCategory = (typeof DATE_REPORT_CATEGORIES)[number];

export const DATE_REPORT_CATEGORY_LABELS: Record<DateReportCategory, string> = {
  ALL: "All records",
  CLIENTS: "New clients",
  KYC: "KYC decisions",
  LOANS: "Loans applied / decided",
  DISBURSEMENTS: "Disbursed loans",
  COLLECTIONS: "Collections",
  OVERDUE: "Overdue accounts",
  RECOVERY: "Recovery activity",
  HANDOVER: "Cash handovers",
  WALLET: "Wallet transactions",
};

/** Quick range filters offered above the From/To date pickers. */
export const DATE_REPORT_PRESETS = [
  "TODAY",
  "YESTERDAY",
  "LAST_7",
  "LAST_30",
  "THIS_MONTH",
  "CUSTOM",
] as const;
export type DateReportPreset = (typeof DATE_REPORT_PRESETS)[number];

export const DATE_REPORT_PRESET_LABELS: Record<DateReportPreset, string> = {
  TODAY: "Today",
  YESTERDAY: "Yesterday",
  LAST_7: "Last 7 days",
  LAST_30: "Last 30 days",
  THIS_MONTH: "This month",
  CUSTOM: "Custom range",
};

/* ---------------------------- IST day boundaries --------------------------- */

/** Institution-local (IST) business date key, YYYY-MM-DD — same as the backend. */
export function istDayKey(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Start-of-day (00:00:00.000 IST) for a `YYYY-MM-DD` date-input value.
 * Returns null for malformed input and impossible calendar dates
 * (e.g. 2026-02-31 — Date.UTC would silently roll it over).
 */
export function istDayStart(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const probe = new Date(utc);
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  // 00:00 IST on D = 18:30 UTC on D−1, so the offset is subtracted from
  // UTC midnight to reach the institution's midnight (istDateKey inverts it
  // by adding the same offset back).
  return utc - IST_OFFSET_MS;
}

/**
 * Inclusive millisecond bounds for two start-of-day timestamps (IST).
 * `to` is extended to the last millisecond of its day so records at both
 * edges of the range are included. Returns null for an invalid range.
 */
export function rangeBounds(
  fromDayStart: number,
  toDayStart: number,
): { from: number; to: number } | null {
  if (!Number.isFinite(fromDayStart) || !Number.isFinite(toDayStart)) return null;
  if (toDayStart < fromDayStart) return null;
  return { from: fromDayStart, to: toDayStart + DAY_MS - 1 };
}

/** Validate a From/To pair of date-input strings for the Generate button. */
export function resolveRange(
  fromIso: string,
  toIso: string,
): { fromDay: number; toDay: number } | { error: string } {
  const fromDay = istDayStart(fromIso);
  if (fromDay === null) {
    return { error: "From date is not a valid calendar date (YYYY-MM-DD)." };
  }
  const toDay = istDayStart(toIso);
  if (toDay === null) {
    return { error: "To date is not a valid calendar date (YYYY-MM-DD)." };
  }
  if (toDay < fromDay) {
    return { error: "To date must be on or after the From date." };
  }
  return { fromDay, toDay };
}

function keyToUtcMs(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function shiftDayKey(key: string, days: number): string {
  const t = keyToUtcMs(key);
  if (!Number.isFinite(t)) return key;
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * From/To ISO dates for a quick filter, evaluated in IST from `nowMs`.
 * Returns null for CUSTOM (the picker values are kept as typed).
 */
export function presetRange(
  preset: DateReportPreset,
  nowMs: number = Date.now(),
): { fromIso: string; toIso: string } | null {
  const today = istDayKey(nowMs);
  switch (preset) {
    case "TODAY":
      return { fromIso: today, toIso: today };
    case "YESTERDAY": {
      const y = shiftDayKey(today, -1);
      return { fromIso: y, toIso: y };
    }
    case "LAST_7":
      return { fromIso: shiftDayKey(today, -6), toIso: today };
    case "LAST_30":
      return { fromIso: shiftDayKey(today, -29), toIso: today };
    case "THIS_MONTH":
      return { fromIso: `${today.slice(0, 8)}01`, toIso: today };
    case "CUSTOM":
      return null;
  }
}

/* ------------------------------- record shapes ---------------------------- */
/**
 * Structural subsets of the Convex documents (a `Doc<"clients">` etc. is
 * assignable to these), so the backend passes tables straight through.
 */

export interface DateReportClient {
  _id: string;
  code: string;
  name: string;
  mobile?: string;
  centerCode?: string;
  kycStatus: string;
  createdAt: number;
  verifiedAt?: number;
  assignedTo: string;
  createdBy: string;
  branchId: string;
}

export interface DateReportApplication {
  _id: string;
  appId: string;
  clientId: string;
  amount: number;
  staffId: string;
  branchId: string;
  status: string;
  submittedAt?: number;
  decidedAt?: number;
  createdAt: number;
}

export interface DateReportLoan {
  _id: string;
  loanId: string;
  clientId: string;
  staffId: string;
  branchId: string;
  principal: number;
  status: string;
  outstanding: number;
  disbursedAt?: number;
  createdAt: number;
}

export interface DateReportSchedule {
  _id: string;
  loanId: string;
  dueDate: number;
  totalDue: number;
  paid: number;
}

export interface DateReportCollection {
  _id: string;
  code: string;
  loanId: string;
  clientId: string;
  staffId: string;
  branchId: string;
  amount: number;
  mode: string;
  status: string;
  receiptNumber?: string;
  createdAt: number;
}

export interface DateReportHandover {
  code: string;
  staffId: string;
  branchId: string;
  amount: number;
  status: string;
  requestedAt: number;
}

export interface DateReportIssue {
  code: string;
  staffId: string;
  branchId: string;
  bmId: string;
  amount: number;
  createdAt: number;
}

export interface DateReportRecovery {
  _id: string;
  loanId: string;
  clientId: string;
  staffId: string;
  branchId: string;
  kind: string;
  notes?: string;
  promisedAmount?: number;
  createdAt: number;
}

export interface DateReportWallet {
  _id: string;
  profileId: string;
  branchId: string;
}

export interface DateReportWalletTxn {
  txnId: string;
  walletId: string;
  profileId: string;
  branchId: string;
  type: string;
  amount: number;
  direction: string;
  createdAt: number;
}

export interface DateReportProfile {
  _id: string;
  name: string;
}

/* --------------------------------- results -------------------------------- */

export interface DateReportRow {
  /** Unique within one report — used as the React key. */
  id: string;
  /** Event timestamp (IST day for display comes from `istDayKey`). */
  date: number;
  kind: string;
  label: string;
  party: string;
  reference: string;
  amount: number | null;
  status: string;
  staffName: string;
  /** Client database id — drill-through to the client report. */
  clientId?: string;
  /** Loan database id — drill-through to the loan file. */
  loanDbId?: string;
  branchId?: string;
}

export interface DateReportSummary {
  clientsRegistered: number;
  kycVerified: number;
  kycRejected: number;
  kycPending: number;
  loansApplied: number;
  loansAppliedAmount: number;
  loansApproved: number;
  loansApprovedAmount: number;
  loansRejected: number;
  loansDisbursed: number;
  disbursedAmount: number;
  collectionsCount: number;
  collectionsAmount: number;
  reversalsCount: number;
  reversalsAmount: number;
  outstanding: number;
  overdueAccounts: number;
  overdueInstalments: number;
  overdueAmount: number;
  recoveryCount: number;
  recoveryPromised: number;
  handoverCount: number;
  handoverAmount: number;
  walletTxnCount: number;
  walletCredit: number;
  walletDebit: number;
}

export interface DateReportParams {
  bounds: { from: number; to: number };
  category: string;
  limit: number;
  now: number;
  /** Viewer identity for server-side scope (SUPER_ADMIN / ACCOUNTANT = all). */
  role: string;
  viewerId: string;
  viewerBranchId: string | null;
  /** Optional narrowing filters (never widen beyond the role scope). */
  branchId?: string | null;
  staffId?: string | null;
  centerCode?: string | null;
  clients: DateReportClient[];
  applications: DateReportApplication[];
  loans: DateReportLoan[];
  schedules: DateReportSchedule[];
  collections: DateReportCollection[];
  handovers: DateReportHandover[];
  issues: DateReportIssue[];
  recovery: DateReportRecovery[];
  wallets: DateReportWallet[];
  walletTxns: DateReportWalletTxn[];
  profiles: DateReportProfile[];
}

export interface DateReportResult {
  range: { from: number; to: number; fromKey: string; toKey: string };
  category: string;
  summary: DateReportSummary;
  rows: DateReportRow[];
  rowTotal: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const COLLECTION_LABELS: Record<string, string> = {
  CASH: "Cash collection",
  UPI: "UPI collection",
  BANK: "Bank collection",
};

/**
 * Wallet transaction types whose amount already appears as its own row
 * elsewhere in an ALL report (a collection, disbursement, handover or issue
 * row). Shown in full under the WALLET category; suppressed in ALL so one
 * rupee never appears twice in the same list.
 */
const WALLET_MIRROR_TYPES = new Set([
  "LOAN_DISBURSEMENT",
  "CASH_COLLECTION",
  "UPI_COLLECTION",
  "BANK_COLLECTION",
  "CASH_HANDOVER",
  "CASH_ISSUE",
  "REVERSAL",
]);

/**
 * Build the complete date-wise report: period summary (always) plus the
 * detail rows for the selected category, all filtered to the viewer's
 * authorization scope, the optional branch/staff/centre filters and the
 * inclusive date bounds.
 */
export function buildDateReport(p: DateReportParams): DateReportResult {
  const { from, to } = p.bounds;
  const inRange = (t: number | undefined | null): t is number =>
    typeof t === "number" &&
    Number.isFinite(t) &&
    t >= from &&
    t <= to;

  const cat: string = (DATE_REPORT_CATEGORIES as readonly string[]).includes(
    p.category,
  )
    ? p.category
    : "ALL";
  const want = (c: string) => cat === "ALL" || cat === c;

  const profileName = new Map(p.profiles.map((x) => [x._id, x.name]));
  const nameOf = (id: string) => profileName.get(id) ?? "—";
  const clientById = new Map(p.clients.map((c) => [c._id, c]));
  const clientName = (id: string) => clientById.get(id)?.name ?? "—";
  const loanById = new Map(p.loans.map((l) => [l._id, l]));

  /* ---------------------------- scope helpers ---------------------------- */

  const branchOk = (branchId: string) => !p.branchId || branchId === p.branchId;
  const staffOk = (staffId: string) => !p.staffId || staffId === p.staffId;

  // A centre filter applies to everything attributable to a client. Records
  // with no client (handovers, cash issues, wallet transactions) cannot be
  // attributed to a centre, so they are excluded rather than shown unfiltered.
  const centerIds = p.centerCode
    ? new Set(
        p.clients
          .filter((c) => c.centerCode === p.centerCode)
          .map((c) => c._id),
      )
    : null;
  const centerOk = (clientId?: string) =>
    centerIds === null ||
    (clientId !== undefined && centerIds.has(clientId));
  const centerOkNoClient = () => centerIds === null;

  const roleOk = (branchId: string, ownerIds: string[]): boolean => {
    if (p.role === "BRANCH_MANAGER") {
      return p.viewerBranchId !== null && branchId === p.viewerBranchId;
    }
    if (p.role === "FIELD_STAFF") {
      return ownerIds.includes(p.viewerId);
    }
    return true; // SUPER_ADMIN / ACCOUNTANT — organization-wide
  };

  const scopedClients = p.clients.filter(
    (c) =>
      roleOk(c.branchId, [c.assignedTo, c.createdBy]) &&
      branchOk(c.branchId) &&
      (!p.staffId ||
        c.assignedTo === p.staffId ||
        c.createdBy === p.staffId) &&
      centerOk(c._id),
  );
  const scopedLoans = p.loans.filter(
    (l) =>
      roleOk(l.branchId, [l.staffId]) &&
      branchOk(l.branchId) &&
      staffOk(l.staffId) &&
      centerOk(l.clientId),
  );
  const scopedApps = p.applications.filter(
    (a) =>
      roleOk(a.branchId, [a.staffId]) &&
      branchOk(a.branchId) &&
      staffOk(a.staffId) &&
      centerOk(a.clientId),
  );
  const scopedCollections = p.collections.filter(
    (c) =>
      roleOk(c.branchId, [c.staffId]) &&
      branchOk(c.branchId) &&
      staffOk(c.staffId) &&
      centerOk(c.clientId),
  );
  const scopedHandovers = p.handovers.filter(
    (h) =>
      centerOkNoClient() &&
      roleOk(h.branchId, [h.staffId]) &&
      branchOk(h.branchId) &&
      staffOk(h.staffId),
  );
  const scopedIssues = p.issues.filter(
    (i) =>
      centerOkNoClient() &&
      roleOk(i.branchId, [i.staffId]) &&
      branchOk(i.branchId) &&
      staffOk(i.staffId),
  );
  const scopedRecovery = p.recovery.filter(
    (r) =>
      roleOk(r.branchId, [r.staffId]) &&
      branchOk(r.branchId) &&
      staffOk(r.staffId) &&
      centerOk(r.clientId),
  );
  const scopedWalletIds = new Set(
    p.wallets
      .filter(
        (w) =>
          centerOkNoClient() &&
          roleOk(w.branchId, [w.profileId]) &&
          branchOk(w.branchId) &&
          staffOk(w.profileId),
      )
      .map((w) => w._id),
  );
  const scopedWalletTxns = p.walletTxns.filter(
    (t) =>
      scopedWalletIds.has(t.walletId) &&
      roleOk(t.branchId, [t.profileId]) &&
      branchOk(t.branchId) &&
      staffOk(t.profileId),
  );

  /* -------------------------------- summary ------------------------------ */

  const registeredInRange = scopedClients.filter((c) => inRange(c.createdAt));
  const kycDecidedInRange = scopedClients.filter((c) =>
    inRange(c.verifiedAt),
  );
  const appliedInRange = scopedApps.filter((a) =>
    inRange(a.submittedAt ?? a.createdAt),
  );
  const decidedInRange = scopedApps.filter((a) => inRange(a.decidedAt));
  const approvedInRange = decidedInRange.filter(
    (a) => a.status === "APPROVED" || a.status === "DISBURSED",
  );
  const rejectedInRange = decidedInRange.filter((a) => a.status === "REJECTED");
  const disbursedInRange = scopedLoans.filter((l) => inRange(l.disbursedAt));
  const normalCollections = scopedCollections.filter(
    (c) => c.status === "NORMAL" && inRange(c.createdAt),
  );
  const reversalsInRange = scopedCollections.filter(
    (c) => c.status === "REVERSAL" && inRange(c.createdAt),
  );
  const recoveryInRange = scopedRecovery.filter((r) =>
    inRange(r.createdAt),
  );
  const handoversInRange = scopedHandovers.filter((h) =>
    inRange(h.requestedAt),
  );
  const issuesInRange = scopedIssues.filter((i) => inRange(i.createdAt));
  const walletInRange = scopedWalletTxns.filter((t) => inRange(t.createdAt));

  // Point-in-time figures (NOT date-ranged — balances are current):
  const activeLoans = scopedLoans.filter((l) =>
    ["ACTIVE", "OVERDUE"].includes(l.status),
  );
  const scopedLoanIds = new Set(scopedLoans.map((l) => l._id));
  const overdueByLoan = new Map<string, { amount: number; since: number }>();
  for (const s of p.schedules) {
    if (!scopedLoanIds.has(s.loanId)) continue;
    if (rowOutstanding(s) <= 0 || s.dueDate >= p.now) continue;
    const cur = overdueByLoan.get(s.loanId);
    const amount = rowOutstanding(s);
    if (cur) {
      cur.amount += amount;
      cur.since = Math.min(cur.since, s.dueDate);
    } else {
      overdueByLoan.set(s.loanId, { amount, since: s.dueDate });
    }
  }

  const summary: DateReportSummary = {
    clientsRegistered: registeredInRange.length,
    kycVerified: kycDecidedInRange.filter((c) => c.kycStatus === "VERIFIED")
      .length,
    kycRejected: kycDecidedInRange.filter((c) => c.kycStatus === "REJECTED")
      .length,
    kycPending: scopedClients.filter((c) => c.kycStatus === "PENDING").length,
    loansApplied: appliedInRange.length,
    loansAppliedAmount: round2(
      appliedInRange.reduce((s, a) => s + a.amount, 0),
    ),
    loansApproved: approvedInRange.length,
    loansApprovedAmount: round2(
      approvedInRange.reduce((s, a) => s + a.amount, 0),
    ),
    loansRejected: rejectedInRange.length,
    loansDisbursed: disbursedInRange.length,
    disbursedAmount: round2(
      disbursedInRange.reduce((s, l) => s + l.principal, 0),
    ),
    collectionsCount: normalCollections.length,
    collectionsAmount: round2(
      normalCollections.reduce((s, c) => s + c.amount, 0),
    ),
    reversalsCount: reversalsInRange.length,
    reversalsAmount: round2(
      reversalsInRange.reduce((s, c) => s + c.amount, 0),
    ),
    outstanding: round2(
      activeLoans.reduce((s, l) => s + l.outstanding, 0),
    ),
    overdueAccounts: overdueByLoan.size,
    overdueInstalments: p.schedules.filter(
      (s) =>
        scopedLoanIds.has(s.loanId) &&
        rowOutstanding(s) > 0 &&
        s.dueDate < p.now,
    ).length,
    overdueAmount: round2(
      [...overdueByLoan.values()].reduce((s, r) => s + r.amount, 0),
    ),
    recoveryCount: recoveryInRange.length,
    recoveryPromised: round2(
      recoveryInRange.reduce((s, r) => s + (r.promisedAmount ?? 0), 0),
    ),
    handoverCount: handoversInRange.length,
    handoverAmount: round2(
      handoversInRange.reduce((s, h) => s + h.amount, 0),
    ),
    walletTxnCount: walletInRange.length,
    walletCredit: round2(
      walletInRange
        .filter((t) => t.direction === "CREDIT")
        .reduce((s, t) => s + t.amount, 0),
    ),
    walletDebit: round2(
      walletInRange
        .filter((t) => t.direction === "DEBIT")
        .reduce((s, t) => s + t.amount, 0),
    ),
  };

  /* ------------------------------ detail rows ---------------------------- */

  const rows: DateReportRow[] = [];

  if (want("CLIENTS")) {
    for (const c of registeredInRange) {
      rows.push({
        id: `client-${c._id}`,
        date: c.createdAt,
        kind: "CLIENT",
        label: "Client registered",
        party: c.name,
        reference: c.code,
        amount: null,
        status: c.kycStatus,
        staffName: nameOf(c.createdBy),
        clientId: c._id,
        branchId: c.branchId,
      });
    }
  }

  if (want("KYC")) {
    for (const c of kycDecidedInRange) {
      rows.push({
        id: `kyc-${c._id}`,
        date: c.verifiedAt as number,
        kind: "KYC",
        label:
          c.kycStatus === "VERIFIED"
            ? "KYC verified"
            : c.kycStatus === "REJECTED"
              ? "KYC rejected"
              : "KYC updated",
        party: c.name,
        reference: c.code,
        amount: null,
        status: c.kycStatus,
        staffName: nameOf(c.assignedTo),
        clientId: c._id,
        branchId: c.branchId,
      });
    }
  }

  if (want("LOANS")) {
    for (const a of scopedApps) {
      const appliedAt = a.submittedAt ?? a.createdAt;
      if (inRange(appliedAt)) {
        rows.push({
          id: `app-${a._id}-applied`,
          date: appliedAt,
          kind: "LOAN_APPLIED",
          label: "Loan applied for",
          party: clientName(a.clientId),
          reference: a.appId,
          amount: a.amount,
          status: a.status,
          staffName: nameOf(a.staffId),
          clientId: a.clientId,
          branchId: a.branchId,
        });
      }
      if (inRange(a.decidedAt)) {
        const rejected = a.status === "REJECTED";
        rows.push({
          id: `app-${a._id}-${rejected ? "rejected" : "approved"}`,
          date: a.decidedAt as number,
          kind: rejected ? "LOAN_REJECTED" : "LOAN_APPROVED",
          label: rejected ? "Loan rejected" : "Loan approved",
          party: clientName(a.clientId),
          reference: a.appId,
          amount: a.amount,
          status: a.status,
          staffName: nameOf(a.staffId),
          clientId: a.clientId,
          branchId: a.branchId,
        });
      }
    }
  }

  if (want("DISBURSEMENTS")) {
    for (const l of disbursedInRange) {
      rows.push({
        id: `loan-${l._id}-disbursed`,
        date: l.disbursedAt as number,
        kind: "LOAN_DISBURSED",
        label: "Loan disbursed",
        party: clientName(l.clientId),
        reference: l.loanId,
        amount: l.principal,
        status: l.status,
        staffName: nameOf(l.staffId),
        clientId: l.clientId,
        loanDbId: l._id,
        branchId: l.branchId,
      });
    }
  }

  if (want("COLLECTIONS")) {
    for (const c of scopedCollections) {
      if (!inRange(c.createdAt)) continue;
      // Reversed originals are superseded by their REVERSAL row — showing
      // both would double count the same rupee. Totals count NORMAL only:
      // a reversed original leaves the total exactly when its refund arrives.
      if (c.status === "REVERSED") continue;
      rows.push({
        id: `coll-${c._id}`,
        date: c.createdAt,
        kind: "COLLECTION",
        label: COLLECTION_LABELS[c.mode] ?? `${c.mode} collection`,
        party: clientName(c.clientId),
        reference: c.receiptNumber ?? c.code,
        amount: c.amount,
        status: c.status,
        staffName: nameOf(c.staffId),
        clientId: c.clientId,
        loanDbId: c.loanId,
        branchId: c.branchId,
      });
    }
  }

  if (want("OVERDUE")) {
    for (const [loanId, r] of overdueByLoan) {
      const loan = loanById.get(loanId);
      if (!loan) continue;
      rows.push({
        id: `overdue-${loanId}`,
        date: r.since,
        kind: "OVERDUE",
        label: "Overdue account",
        party: clientName(loan.clientId),
        reference: loan.loanId,
        amount: round2(r.amount),
        status: "OVERDUE",
        staffName: nameOf(loan.staffId),
        clientId: loan.clientId,
        loanDbId: loan._id,
        branchId: loan.branchId,
      });
    }
  }

  if (want("RECOVERY")) {
    for (const r of recoveryInRange) {
      rows.push({
        id: `recovery-${r._id}`,
        date: r.createdAt,
        kind: "RECOVERY",
        label: RECOVERY_LABELS[r.kind as keyof typeof RECOVERY_LABELS] ?? r.kind,
        party: clientName(r.clientId),
        reference: loanById.get(r.loanId)?.loanId ?? r.loanId,
        amount: r.promisedAmount ?? null,
        status: "LOGGED",
        staffName: nameOf(r.staffId),
        clientId: r.clientId,
        loanDbId: r.loanId,
        branchId: r.branchId,
      });
    }
  }

  if (want("HANDOVER")) {
    for (const h of handoversInRange) {
      rows.push({
        id: `handover-${h.code}`,
        date: h.requestedAt,
        kind: "HANDOVER",
        label: "Cash handover",
        party: nameOf(h.staffId),
        reference: h.code,
        amount: h.amount,
        status: h.status,
        staffName: nameOf(h.staffId),
        branchId: h.branchId,
      });
    }
    for (const i of issuesInRange) {
      rows.push({
        id: `issue-${i.code}`,
        date: i.createdAt,
        kind: "CASH_ISSUE",
        label: "Cash issued to staff",
        party: nameOf(i.staffId),
        reference: i.code,
        amount: i.amount,
        status: "ISSUED",
        staffName: nameOf(i.bmId),
        branchId: i.branchId,
      });
    }
  }

  if (want("WALLET")) {
    for (const t of walletInRange) {
      const mirrored = cat === "ALL" && WALLET_MIRROR_TYPES.has(t.type);
      if (mirrored) continue;
      rows.push({
        id: `wallet-${t.txnId}`,
        date: t.createdAt,
        kind: "WALLET",
        label: WALLET_TX_LABELS[t.type as keyof typeof WALLET_TX_LABELS] ??
          t.type.replace(/_/g, " ").toLowerCase(),
        party: nameOf(t.profileId),
        reference: t.txnId,
        amount: t.amount,
        status: t.direction,
        staffName: nameOf(t.profileId),
        branchId: t.branchId,
      });
    }
  }

  rows.sort((a, b) => b.date - a.date);
  const rowTotal = rows.length;
  const capped = rows.slice(0, Math.max(0, p.limit));

  return {
    range: { from, to, fromKey: istDayKey(from), toKey: istDayKey(to) },
    category: cat,
    summary,
    rows: capped,
    rowTotal,
  };
}
