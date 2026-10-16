import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  EmptyState,
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatCard,
  StatusChip,
  formatDate,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  DATE_REPORT_CATEGORIES,
  DATE_REPORT_CATEGORY_LABELS,
  DATE_REPORT_PRESETS,
  DATE_REPORT_PRESET_LABELS,
  istDayKey,
  istDayStart,
  presetRange,
  resolveRange,
  type DateReportCategory,
  type DateReportPreset,
} from "@/lib/finance/dateReport";
import { LOAN_STATUSES } from "@/lib/finance/types";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import { useNavigate } from "react-router";
import {
  Building2,
  Download,
  FileBarChart,
  Lock,
  Search,
  UserSearch,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import ReportClient from "./ReportClient";

/* ---------------------------------------------------------------------------
 * Reports — six report categories over the real database:
 *   Overview    portfolio metrics (clients, loans, repayments, dues)
 *   Transactions ledger-derived transaction report (pre-existing engine)
 *   Clients      authorized client list + Client ID search → full report
 *   Staff        staff-wise and branch-manager-wise reports with filters
 *   Centres      centre-wise client report by Centre ID (e.g. BALLIA-001)
 *   Date range   IST date-wise report: quick ranges, real records, CSV export
 * Every figure comes from authenticated Convex queries with backend scoping.
 * --------------------------------------------------------------------------- */

const TYPES = [
  { id: "ALL", label: "All" },
  { id: "COLLECTION", label: "Collections" },
  { id: "WALLET", label: "Wallet" },
  { id: "DISBURSEMENT", label: "Disbursed" },
  { id: "HANDOVER", label: "Cash flow" },
  { id: "EXPENSE", label: "Expenses" },
] as const;

const MODES = [
  { id: "", label: "Any mode" },
  { id: "CASH", label: "Cash" },
  { id: "UPI", label: "UPI" },
  { id: "BANK", label: "Bank" },
] as const;

const COLL_STATUSES = [
  { id: "", label: "Any status" },
  { id: "NORMAL", label: "Normal" },
  { id: "REVERSED", label: "Reversed" },
  { id: "REVERSAL", label: "Reversal" },
] as const;

/** Institution-local (IST) day key — never shifts with the device timezone. */
function isoDaysAgo(days: number): string {
  return istDayKey(Date.now() - days * 86_400_000);
}

/**
 * Safe start-of-day timestamp in IST — the day boundaries must match the
 * backend's business-date clock, so ranges never miss the first/last hours
 * of the From/To day. Falls back when a date input is cleared/partial.
 */
function dayTs(iso: string, fallbackDaysAgo = 30): number {
  const t = istDayStart(iso);
  if (t !== null) return t;
  return (
    istDayStart(istDayKey(Date.now() - fallbackDaysAgo * 86_400_000)) ??
    Date.now()
  );
}

const selectCls =
  "h-10 w-full border-2 border-ink bg-white px-2 text-xs font-black uppercase outline-none";

/**
 * Cash direction of a date-report row for colouring — mirrors how the rest
 * of the app reads these records (collection IN, reversal/disbursal OUT…).
 */
function rowDirection(r: { kind: string; status: string }): "IN" | "OUT" | "NONE" {
  switch (r.kind) {
    case "COLLECTION":
      return r.status === "REVERSAL" ? "OUT" : "IN";
    case "LOAN_DISBURSED":
      return "OUT";
    case "CASH_ISSUE":
      return "IN";
    case "HANDOVER":
      return r.status === "ACCEPTED" ? "OUT" : "NONE";
    case "WALLET":
      return r.status === "CREDIT" ? "IN" : r.status === "DEBIT" ? "OUT" : "NONE";
    default:
      return "NONE";
  }
}

export default function Reports() {
  const [tab, setTab] = useState("overview");

  /* ------------------------------ transactions ---------------------------- */
  const [type, setType] = useState<(typeof TYPES)[number]["id"]>("ALL");
  const [mode, setMode] = useState<string>("");
  const [collStatus, setCollStatus] = useState<string>("");
  const [from, setFrom] = useState(() => isoDaysAgo(30));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  const report = useQuery(api.reports.run, {
    type,
    mode: mode || undefined,
    status: collStatus || undefined,
    dateFrom: dayTs(from),
    dateTo: dayTs(to, 0),
    limit: 300,
  });

  const totals = report?.totals;

  const csv = useMemo(() => {
    if (!report) return "";
    const head = ["date", "kind", "type", "party", "reference", "mode", "direction", "amount", "status", "staff"];
    const lines = report.rows.map((r) =>
      [
        new Date(r.date).toISOString().slice(0, 10),
        r.kind,
        r.type,
        r.party,
        r.reference,
        r.mode ?? "",
        r.direction,
        String(r.amount),
        r.status,
        r.staffName,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    return [head.join(","), ...lines].join("\n");
  }, [report]);

  const download = () => {
    if (!csv) return;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kirat-report-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV downloaded");
  };

  /* -------------------------------- overview ------------------------------ */
  const overview = useQuery(api.reports.overview, {});
  const upcoming = useQuery(api.reports.upcoming, {});

  /* -------------------------------- clients ------------------------------- */
  const [clientSearch, setClientSearch] = useState("");
  const [clientQuery, setClientQuery] = useState("");
  const [selectedClientId, setSelectedClientId] = useState<Id<"clients"> | null>(null);
  const clientList = useQuery(api.clients.list, {
    search: clientQuery.trim() || undefined,
    limit: 50,
  });

  const searchClients = (e: FormEvent) => {
    e.preventDefault();
    setClientQuery(clientSearch.trim());
  };

  /* ------------------------------ staff & branch -------------------------- */
  const [staffFrom, setStaffFrom] = useState(() => isoDaysAgo(30));
  const [staffTo, setStaffTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [staffFilter, setStaffFilter] = useState("");
  const [managerFilter, setManagerFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [loanStatus, setLoanStatus] = useState("ALL");

  const staffReport = useQuery(api.reports.staffReport, {
    dateFrom: dayTs(staffFrom),
    dateTo: dayTs(staffTo, 0),
    staffId: (staffFilter || undefined) as Id<"profiles"> | undefined,
    managerId: (managerFilter || undefined) as Id<"profiles"> | undefined,
    branchId: (branchFilter || undefined) as Id<"branches"> | undefined,
    loanStatus,
  });

  const drillClients = useQuery(
    api.clients.list,
    staffFilter ? { staffId: staffFilter as Id<"profiles">, limit: 25 } : "skip",
  );
  const drillLoans = useQuery(
    api.loans.list,
    staffFilter ? { staffId: staffFilter as Id<"profiles">, limit: 25 } : "skip",
  );

  /* ------------------------------ centre-wise ---------------------------- */
  const CENTER_PAGE = 25;
  const [centerInput, setCenterInput] = useState("");
  const [centerCode, setCenterCode] = useState("");
  const [centerOffset, setCenterOffset] = useState(0);

  const centerReport = useQuery(
    api.clients.centerReport,
    centerCode
      ? { centerCode, limit: CENTER_PAGE, offset: centerOffset }
      : "skip",
  );

  const searchCenter = (e: FormEvent) => {
    e.preventDefault();
    setCenterOffset(0);
    setCenterCode(centerInput.trim().toUpperCase());
  };

  /* ------------------------------ date range ----------------------------- */
  const navigate = useNavigate();
  const [drPreset, setDrPreset] = useState<DateReportPreset>("LAST_30");
  const [drFrom, setDrFrom] = useState(() => isoDaysAgo(29));
  const [drTo, setDrTo] = useState(() => istDayKey(Date.now()));
  const [drCategory, setDrCategory] = useState<DateReportCategory>("ALL");
  const [drBranch, setDrBranch] = useState("");
  const [drStaff, setDrStaff] = useState("");
  const [drCenter, setDrCenter] = useState("");
  // The applied (already generated) period. Dates only ever reach the query
  // through a successful validation — an invalid range can never fetch.
  const [drApplied, setDrApplied] = useState<{ fromDay: string; toDay: string } | null>(
    () => {
      const p = presetRange("LAST_30");
      return p ? { fromDay: p.fromIso, toDay: p.toIso } : null;
    },
  );

  const drCheck = useMemo(() => resolveRange(drFrom, drTo), [drFrom, drTo]);
  const drError = "error" in drCheck ? drCheck.error : null;
  const drDirty =
    drApplied !== null &&
    (drApplied.fromDay !== drFrom || drApplied.toDay !== drTo);

  const dateReport = useQuery(
    api.reports.dateReport,
    drApplied
      ? {
          fromDay: drApplied.fromDay,
          toDay: drApplied.toDay,
          category: drCategory,
          branchId: (drBranch || undefined) as Id<"branches"> | undefined,
          staffId: (drStaff || undefined) as Id<"profiles"> | undefined,
          centerCode: drCenter || undefined,
          limit: 2000,
        }
      : "skip",
  );
  const drSummary = dateReport?.summary;
  const drComplete =
    dateReport != null && dateReport.rowTotal === dateReport.rows.length;
  const drBranchName = (id?: string | null) =>
    (id && dateReport?.filterOptions.branches.find((b) => b.id === id)?.name) ||
    id ||
    "All branches in scope";

  const applyPreset = (p: DateReportPreset) => {
    setDrPreset(p);
    const r = presetRange(p);
    if (!r) return; // CUSTOM — the pickers stand as typed
    setDrFrom(r.fromIso);
    setDrTo(r.toIso);
    setDrApplied({ fromDay: r.fromIso, toDay: r.toIso });
  };

  const generate = (e?: FormEvent) => {
    e?.preventDefault();
    const r = resolveRange(drFrom, drTo);
    if ("error" in r) {
      toast.error(r.error);
      return;
    }
    setDrApplied({ fromDay: drFrom, toDay: drTo });
  };

  const pickBranch = (v: string) => {
    setDrBranch(v);
    setDrStaff("");
    setDrCenter("");
  };

  /* Staff-wise / branch-wise activity over the listed records (complete lists only). */
  const drByStaff = useMemo(() => {
    if (!dateReport || !drComplete) return null;
    const m = new Map<
      string,
      { key: string; name: string; records: number; collected: number; disbursed: number }
    >();
    for (const r of dateReport.rows) {
      const cur = m.get(r.staffName) ?? {
        key: r.staffName,
        name: r.staffName,
        records: 0,
        collected: 0,
        disbursed: 0,
      };
      cur.records += 1;
      if (r.kind === "COLLECTION" && r.status === "NORMAL")
        cur.collected += r.amount ?? 0;
      if (r.kind === "LOAN_DISBURSED") cur.disbursed += r.amount ?? 0;
      m.set(r.staffName, cur);
    }
    return [...m.values()].sort(
      (a, b) => b.collected - a.collected || b.records - a.records,
    );
  }, [dateReport, drComplete]);

  const drByBranch = useMemo(() => {
    if (!dateReport || !drComplete) return null;
    const m = new Map<
      string,
      { key: string; name: string; records: number; collected: number; disbursed: number }
    >();
    const nameOf = (id?: string | null) =>
      (id && dateReport.filterOptions.branches.find((b) => b.id === id)?.name) ||
      id ||
      "All branches in scope";
    for (const r of dateReport.rows) {
      const key = r.branchId ?? "";
      const cur = m.get(key) ?? {
        key,
        name: nameOf(r.branchId),
        records: 0,
        collected: 0,
        disbursed: 0,
      };
      cur.records += 1;
      if (r.kind === "COLLECTION" && r.status === "NORMAL")
        cur.collected += r.amount ?? 0;
      if (r.kind === "LOAN_DISBURSED") cur.disbursed += r.amount ?? 0;
      m.set(key, cur);
    }
    return [...m.values()].sort(
      (a, b) => b.collected - a.collected || b.records - a.records,
    );
  }, [dateReport, drComplete]);

  /* CSV export — metadata, totals and every listed record of this report. */
  const dateCsv = useMemo(() => {
    if (!dateReport) return "";
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const s = dateReport.summary;
    const nameOf = (id?: string | null) =>
      (id && dateReport.filterOptions.branches.find((b) => b.id === id)?.name) ||
      id ||
      "All branches in scope";
    const meta: (string | number)[][] = [
      ["KIRAT MICRO CREDIT — date-wise report"],
      ["Period (IST, inclusive)", dateReport.range.fromKey, dateReport.range.toKey],
      [
        "Category",
        DATE_REPORT_CATEGORY_LABELS[
          dateReport.category as DateReportCategory
        ] ?? dateReport.category,
      ],
      ["Branch filter", drBranch ? nameOf(drBranch) : "All branches in scope"],
      [
        "Staff filter",
        drStaff
          ? dateReport.filterOptions.staff.find((x) => x.id === drStaff)?.name ??
            drStaff
          : "All staff in scope",
      ],
      ["Centre filter", drCenter || "All centres in scope"],
      ["Generated at", new Date().toISOString()],
      [],
      ["Summary", "Value"],
      ["Clients registered", s.clientsRegistered],
      [
        "KYC verified / rejected / pending",
        `${s.kycVerified} / ${s.kycRejected} / ${s.kycPending}`,
      ],
      ["Loans applied (amount INR)", `${s.loansApplied} (${s.loansAppliedAmount})`],
      [
        "Loans approved (amount INR)",
        `${s.loansApproved} (${s.loansApprovedAmount})`,
      ],
      ["Loans rejected", s.loansRejected],
      ["Loans disbursed (amount INR)", `${s.loansDisbursed} (${s.disbursedAmount})`],
      [
        "Collections received (amount INR)",
        `${s.collectionsCount} (${s.collectionsAmount})`,
      ],
      [
        "Collection reversals (amount INR)",
        `${s.reversalsCount} (${s.reversalsAmount})`,
      ],
      ["Outstanding balance (current)", s.outstanding],
      [
        "Overdue accounts / instalments / amount",
        `${s.overdueAccounts} / ${s.overdueInstalments} / ${s.overdueAmount}`,
      ],
      [
        "Recovery activities (promised INR)",
        `${s.recoveryCount} (${s.recoveryPromised})`,
      ],
      ["Cash handovers (amount INR)", `${s.handoverCount} (${s.handoverAmount})`],
      [
        "Wallet transactions (credit / debit)",
        `${s.walletTxnCount} (${s.walletCredit} / ${s.walletDebit})`,
      ],
      [],
      [
        "Date (IST)",
        "Category",
        "Record",
        "Party",
        "Reference",
        "Amount (INR)",
        "Status",
        "Staff",
        "Branch",
      ],
      ...dateReport.rows.map((r) => [
        istDayKey(r.date),
        r.label,
        r.kind,
        r.party,
        r.reference,
        r.amount === null ? "" : String(r.amount),
        r.status,
        r.staffName,
        nameOf(r.branchId),
      ]),
    ];
    return meta.map((row) => row.map(cell).join(",")).join("\n");
  }, [dateReport, drBranch, drStaff, drCenter]);

  const downloadDateCsv = () => {
    if (!dateCsv || !dateReport) return;
    const blob = new Blob([dateCsv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kirat-date-report-${dateReport.range.fromKey}-to-${dateReport.range.toKey}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV downloaded");
  };

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Reports"
        subtitle="Ledger-derived — every figure traces to a transaction"
        action={
          tab === "daterange" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={downloadDateCsv}
              disabled={!dateCsv}
            >
              <Download className="size-4" /> CSV
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={download} disabled={!csv}>
              <Download className="size-4" /> CSV
            </Button>
          )
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full flex-wrap border-2 border-ink bg-white p-1">
          <TabsTrigger value="overview" className="flex-1 text-xs font-black uppercase">
            Overview
          </TabsTrigger>
          <TabsTrigger value="transactions" className="flex-1 text-xs font-black uppercase">
            Transactions
          </TabsTrigger>
          <TabsTrigger value="clients" className="flex-1 text-xs font-black uppercase">
            Clients
          </TabsTrigger>
          <TabsTrigger value="staff" className="flex-1 text-xs font-black uppercase">
            Staff & branch
          </TabsTrigger>
          <TabsTrigger value="centres" className="flex-1 text-xs font-black uppercase">
            Centres
          </TabsTrigger>
          <TabsTrigger value="daterange" className="flex-1 text-xs font-black uppercase">
            Date range
          </TabsTrigger>
        </TabsList>

        {/* ----------------------------- OVERVIEW -------------------------- */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          {overview === undefined ? (
            <RowSkeleton rows={4} />
          ) : (
            <>
              <SectionTitle>Portfolio</SectionTitle>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatCard
                  label="Total registered clients"
                  value={overview.totalClients.toLocaleString("en-IN")}
                />
                <StatCard
                  label="Total active loans"
                  value={overview.activeLoans.toLocaleString("en-IN")}
                  sub={`${overview.closedLoans} closed · ${overview.totalLoans} total`}
                />
                <StatCard
                  label="Total loan amount disbursed"
                  value={<Money value={overview.totalDisbursed} className="text-xl" />}
                />
                <StatCard
                  label="Total repayments received"
                  value={<Money value={overview.totalRepaid} className="text-xl" />}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatCard
                  label="Outstanding loan balance"
                  value={<Money value={overview.outstanding} className="text-xl" />}
                />
                <StatCard
                  label="Instalments due (incl. overdue)"
                  value={overview.instalmentsDue.toLocaleString("en-IN")}
                  sub={
                    overview.dueAmount > 0 ? (
                      <Money value={overview.dueAmount} className="text-xs" />
                    ) : (
                      "None due"
                    )
                  }
                  tone="warn"
                />
                <StatCard
                  label="Overdue instalments"
                  value={overview.overdueInstalments.toLocaleString("en-IN")}
                  sub={
                    overview.overdueAmount > 0 ? (
                      <Money value={overview.overdueAmount} className="text-xs" />
                    ) : (
                      "None overdue"
                    )
                  }
                  tone={overview.overdueInstalments > 0 ? "bad" : "idle"}
                />
                <StatCard
                  label="Next instalment due"
                  value={
                    overview.nextDueDate ? formatDate(overview.nextDueDate) : "—"
                  }
                  sub={
                    overview.nextDueAmount !== null ? (
                      <Money value={overview.nextDueAmount} className="text-xs" />
                    ) : (
                      "No open instalment"
                    )
                  }
                />
              </div>
              <p className="text-[11px] font-semibold text-muted-foreground">
                Figures cover your authorized scope only — field staff see their
                own clients and loans, branch managers see their branch, admins
                and accountants see the organization. Counts and balances are
                derived from the same loan, schedule and collection records the
                rest of the app uses.
              </p>

              <SectionTitle>Upcoming due dates — next 30 days</SectionTitle>
              {upcoming === undefined ? (
                <RowSkeleton rows={3} />
              ) : upcoming.rows.length === 0 ? (
                <EmptyState
                  title="No instalments due in the next 30 days"
                  hint="No open schedule rows fall in this window for your scope."
                />
              ) : (
                <>
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    {upcoming.totalCount} open instalment
                    {upcoming.totalCount === 1 ? "" : "s"} ·{" "}
                    <Money value={upcoming.totalAmount} className="text-[11px]" /> ·{" "}
                    {upcoming.weeklyCount} weekly — dates are the stored
                    schedule dates, never assumed.
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {upcoming.rows.slice(0, 50).map((r) => (
                      <div
                        key={r.scheduleId}
                        className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-xs font-black">
                            <span className="font-mono">{r.clientCode}</span> · {r.clientName}
                          </p>
                          <p className="truncate text-[11px] font-semibold text-muted-foreground">
                            {formatDate(r.dueDate)} · {r.loanId} · instalment #{""}
                            {r.index} · {r.frequency.toLowerCase()} · {r.staffName}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <Money value={r.amount} className="block text-sm" />
                          <StatusChip status={r.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                  {upcoming.rows.length > 50 && (
                    <p className="text-[11px] font-semibold text-muted-foreground">
                      Showing 50 of {upcoming.totalCount} upcoming instalments —
                      open a client report for the full schedule.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </TabsContent>

        {/* --------------------------- TRANSACTIONS ------------------------ */}
        <TabsContent value="transactions" className="mt-4 space-y-4">
          {/* Range */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase text-muted-foreground">From</label>
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
                className="h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase text-muted-foreground">To</label>
              <input
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
                className="h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
              />
            </div>
          </div>

          {/* Type / mode chips */}
          <div className="flex flex-wrap gap-1.5">
            {TYPES.map((t) => (
              <button
                key={t.id}
                onClick={() => setType(t.id)}
                className={cn(
                  "border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
                  type === t.id ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={cn(
                  "border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
                  mode === m.id ? "bg-royal text-white shadow-hard-sm" : "bg-white",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-black uppercase text-muted-foreground">
              Collection status
            </span>
            {COLL_STATUSES.map((s) => (
              <button
                key={s.id}
                onClick={() => setCollStatus(s.id)}
                className={cn(
                  "border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
                  collStatus === s.id ? "bg-ink text-paper shadow-hard-sm" : "bg-white",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* Totals */}
          {report === undefined ? (
            <RowSkeleton rows={3} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="border-2 border-ink bg-mint p-3 shadow-hard-sm">
                  <div className="text-[10px] font-black uppercase text-muted-foreground">
                    Collected
                  </div>
                  <Money value={totals?.collected ?? 0} className="text-xl" />
                  <div className="text-[10px] font-bold text-muted-foreground">
                    {report.range.fromKey} → {report.range.toKey}
                  </div>
                </div>
                <div className="border-2 border-ink bg-sky p-3 shadow-hard-sm">
                  <div className="text-[10px] font-black uppercase text-muted-foreground">
                    Cash / UPI / Bank
                  </div>
                  <div className="text-xs font-black">
                    ₹{(totals?.cashCollected ?? 0).toLocaleString("en-IN")} / ₹
                    {(totals?.upiCollected ?? 0).toLocaleString("en-IN")} / ₹
                    {(totals?.bankCollected ?? 0).toLocaleString("en-IN")}
                  </div>
                </div>
                <div className="border-2 border-ink bg-gold p-3 shadow-hard-sm">
                  <div className="text-[10px] font-black uppercase text-muted-foreground">
                    Disbursed
                  </div>
                  <Money value={totals?.disbursed ?? 0} className="text-xl" />
                </div>
                <div className="border-2 border-ink bg-card p-3 shadow-hard-sm">
                  <div className="text-[10px] font-black uppercase text-muted-foreground">
                    Closing wallet
                  </div>
                  <Money value={totals?.closingWallet ?? 0} className="text-xl" />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="border-2 border-ink bg-white p-2.5 shadow-hard-sm text-center">
                  <div className="text-[10px] font-black uppercase text-muted-foreground">
                    Handover in
                  </div>
                  <Money value={totals?.handoverIn ?? 0} className="text-sm" />
                </div>
                <div className="border-2 border-ink bg-white p-2.5 shadow-hard-sm text-center">
                  <div className="text-[10px] font-black uppercase text-muted-foreground">
                    Handover out
                  </div>
                  <Money value={totals?.handoverOut ?? 0} className="text-sm" />
                </div>
                <div className="border-2 border-ink bg-white p-2.5 shadow-hard-sm text-center">
                  <div className="text-[10px] font-black uppercase text-muted-foreground">
                    Expenses
                  </div>
                  <Money value={totals?.expenses ?? 0} className="text-sm" />
                </div>
              </div>

              {/* Rows */}
              <SectionTitle>{totals?.rowCount ?? 0} transactions</SectionTitle>
              {report.rows.length === 0 ? (
                <EmptyState
                  title="Nothing in this range"
                  hint="Widen the date range or switch the filters."
                  icon={<FileBarChart className="size-5" />}
                />
              ) : (
                <div className="flex flex-col gap-1.5">
                  {report.rows.map((r) => (
                    <div
                      key={`${r.kind}-${r.id}`}
                      className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs font-black uppercase">{r.type}</p>
                        <p className="truncate text-[11px] font-semibold text-muted-foreground">
                          {r.party} · {r.reference} · {formatDate(r.date)}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <Money
                          value={r.amount}
                          className={cn(
                            "block text-sm",
                            r.direction === "IN" && "text-success",
                            r.direction === "OUT" && "text-destructive",
                          )}
                        />
                        <span className="flex justify-end">
                          <StatusChip status={r.status} />
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </TabsContent>

        {/* ------------------------------ CLIENTS -------------------------- */}
        <TabsContent value="clients" className="mt-4 space-y-4">
          {selectedClientId ? (
            <ReportClient
              clientId={selectedClientId}
              onBack={() => setSelectedClientId(null)}
            />
          ) : (
            <>
              <form onSubmit={searchClients} className="flex gap-2">
                <Input
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  placeholder="Client ID (C-000123), name or mobile"
                  aria-label="Search by client ID, name or mobile"
                  className="h-11 border-2 border-ink font-mono"
                />
                <Button type="submit" size="lg" aria-label="Search clients">
                  <Search className="size-4" /> Search
                </Button>
              </form>

              {clientQuery && (
                <p className="text-[11px] font-black uppercase text-muted-foreground">
                  Results for “{clientQuery}”
                </p>
              )}

              {clientList === undefined ? (
                <RowSkeleton rows={5} />
              ) : clientList.length === 0 ? (
                clientQuery ? (
                  <EmptyState
                    title="Client not found"
                    hint={`No client matches “${clientQuery}”. Check the Client ID and try again. Searching never changes client records.`}
                    icon={<UserSearch className="size-5" />}
                  />
                ) : (
                  <EmptyState
                    title="No clients"
                    hint="No clients are visible in your authorization scope yet."
                    icon={<UserSearch className="size-5" />}
                  />
                )
              ) : (
                <div className="flex flex-col gap-1.5">
                  {clientList.map((c) => (
                    <button
                      key={c._id}
                      onClick={() => setSelectedClientId(c._id)}
                      className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2 text-left shadow-hard-sm transition-colors hover:bg-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black">
                          <span className="font-mono">{c.code}</span> · {c.name}
                        </p>
                        <p className="truncate text-[11px] font-semibold text-muted-foreground">
                          {c.mobile} · staff: {c.staffName}
                          {c.activeLoans > 0 ? ` · ${c.activeLoans} active loan(s)` : ""}
                        </p>
                      </div>
                      <StatusChip status={c.kycStatus} className="shrink-0" />
                    </button>
                  ))}
                </div>
              )}
              {clientList && clientList.length > 0 && (
                <p className="text-[11px] font-semibold text-muted-foreground">
                  Showing {clientList.length} of your authorized clients —
                  open one for the complete report (profile, history, loans,
                  schedules, repayments and position).
                </p>
              )}
            </>
          )}
        </TabsContent>

        {/* --------------------------- STAFF & BRANCH ---------------------- */}
        <TabsContent value="staff" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase text-muted-foreground">From</label>
              <input
                type="date"
                value={staffFrom}
                max={staffTo}
                onChange={(e) => setStaffFrom(e.target.value)}
                className="h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase text-muted-foreground">To</label>
              <input
                type="date"
                value={staffTo}
                min={staffFrom}
                onChange={(e) => setStaffTo(e.target.value)}
                className="h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase text-muted-foreground">
                Staff member
              </label>
              <select
                className={selectCls}
                value={staffFilter}
                onChange={(e) => setStaffFilter(e.target.value)}
              >
                <option value="">All staff</option>
                {staffReport?.staffOptions.map((s) => (
                  <option key={s.profileId} value={s.profileId}>
                    {s.name} ({s.systemId})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase text-muted-foreground">
                Branch manager
              </label>
              <select
                className={selectCls}
                value={managerFilter}
                onChange={(e) => setManagerFilter(e.target.value)}
              >
                <option value="">All managers</option>
                {staffReport?.managerOptions.map((s) => (
                  <option key={s.profileId} value={s.profileId}>
                    {s.name} ({s.systemId})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase text-muted-foreground">
                Loan status
              </label>
              <select
                className={selectCls}
                value={loanStatus}
                onChange={(e) => setLoanStatus(e.target.value)}
              >
                <option value="ALL">All statuses</option>
                {LOAN_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {(staffReport?.branchOptions.length ?? 0) > 1 && (
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase text-muted-foreground">
                Branch
              </label>
              <select
                className={cn(selectCls, "max-w-xs")}
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
              >
                <option value="">All branches</option>
                {staffReport?.branchOptions.map((b) => (
                  <option key={b.branchId} value={b.branchId}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {staffReport === undefined ? (
            <RowSkeleton rows={5} />
          ) : (
            <>
              {/* Staff-wise report */}
              <SectionTitle>Staff-wise report</SectionTitle>
              {staffReport.staffRows.length === 0 ? (
                <EmptyState
                  title="No staff in scope"
                  hint="No staff members match your filters and authorization scope."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        {["Staff", "System ID", "Branch", "Registered", "Assigned", "Loans", "Disbursed", "Collected"].map((h) => (
                          <th
                            key={h}
                            className="border-2 border-ink bg-muted px-2 py-1.5 text-left text-[10px] font-black uppercase"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {staffReport.staffRows.map((r) => (
                        <tr
                          key={r.profileId}
                          className={cn(
                            "cursor-pointer transition-colors hover:bg-gold/40",
                            staffFilter === r.profileId && "bg-gold/60",
                          )}
                          onClick={() =>
                            setStaffFilter((cur) => (cur === r.profileId ? "" : r.profileId))
                          }
                        >
                          <td className="border-2 border-ink px-2 py-1.5 text-xs font-black">
                            {r.name}
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5 font-mono text-xs">
                            {r.systemId}
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5 text-xs font-semibold">
                            {r.branchName}
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5 text-xs font-bold">
                            {r.clientsRegistered}
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5 text-xs font-bold">
                            {r.clientsAssigned}
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5 text-xs font-bold">
                            {r.loans}{" "}
                            <span className="text-muted-foreground">({r.activeLoans} act.)</span>
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5">
                            <Money value={r.disbursedAmount} className="text-xs" />
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5">
                            <Money value={r.repaymentsCollected} className="text-xs" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[11px] font-semibold text-muted-foreground">
                Registered = clients created by the staff member in range ·
                Assigned = clients currently assigned · Loans / Disbursed are
                attributed from the loan record (staff & disbursement date) ·
                Collected = repayments they collected in range (NORMAL only).
                Click a row to drill down.
              </p>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <StatCard
                  label="Staff registered clients"
                  value={staffReport.totals.staff.registeredClients}
                />
                <StatCard
                  label="Staff assigned clients"
                  value={staffReport.totals.staff.assignedClients}
                />
                <StatCard
                  label="Staff loans"
                  value={staffReport.totals.staff.loans}
                />
                <StatCard
                  label="Staff disbursed"
                  value={<Money value={staffReport.totals.staff.disbursed} className="text-base" />}
                />
                <StatCard
                  label="Staff collected"
                  value={<Money value={staffReport.totals.staff.collected} className="text-base" />}
                />
              </div>

              {/* Drill-down for the selected staff member */}
              {staffFilter && (
                <>
                  <SectionTitle>
                    {staffReport.staffRows[0]?.name ?? "Staff"} — assigned clients & loans
                  </SectionTitle>
                  {drillClients === undefined ? (
                    <RowSkeleton rows={3} />
                  ) : drillClients.length === 0 ? (
                    <EmptyState title="No assigned clients" hint="This staff member has no clients assigned." />
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {drillClients.map((c) => (
                        <button
                          key={c._id}
                          onClick={() => {
                            setTab("clients");
                            setSelectedClientId(c._id);
                          }}
                          className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2 text-left shadow-hard-sm transition-colors hover:bg-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                        >
                          <span className="min-w-0 truncate text-xs font-black">
                            <span className="font-mono">{c.code}</span> · {c.name} · {c.mobile}
                          </span>
                          <span className="shrink-0 text-[11px] font-bold text-muted-foreground">
                            {formatDate(c.createdAt)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  {drillLoans !== undefined && (
                    <div className="flex flex-col gap-1.5">
                      {drillLoans.length === 0 ? (
                        <p className="text-xs font-semibold text-muted-foreground">
                          No loans recorded for this staff member.
                        </p>
                      ) : (
                        drillLoans.map((l) => (
                          <div
                            key={l.loan._id}
                            className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
                          >
                            <span className="min-w-0 truncate text-xs font-black">
                              <span className="font-mono">{l.loan.loanId}</span> ·{" "}
                              {l.client?.name ?? "—"}
                            </span>
                            <span className="flex shrink-0 items-center gap-2">
                              <Money value={l.loan.principal} className="text-xs" />
                              <StatusChip status={l.loan.status} />
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Branch-manager-wise report */}
              <SectionTitle>Branch-manager-wise report</SectionTitle>
              {staffReport.managerRows.length === 0 ? (
                <EmptyState
                  title="No branch managers in scope"
                  hint="No branch managers match your filters and authorization scope."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        {["Manager", "System ID", "Branch", "Clients", "Loans", "Disbursed", "Collected"].map((h) => (
                          <th
                            key={h}
                            className="border-2 border-ink bg-muted px-2 py-1.5 text-left text-[10px] font-black uppercase"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {staffReport.managerRows.map((r) => (
                        <tr key={r.profileId}>
                          <td className="border-2 border-ink px-2 py-1.5 text-xs font-black">
                            {r.name}
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5 font-mono text-xs">
                            {r.systemId}
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5 text-xs font-semibold">
                            {r.branchName}
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5 text-xs font-bold">
                            {r.clients}
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5 text-xs font-bold">
                            {r.loans}{" "}
                            <span className="text-muted-foreground">({r.activeLoans} act.)</span>
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5">
                            <Money value={r.disbursedAmount} className="text-xs" />
                          </td>
                          <td className="border-2 border-ink px-2 py-1.5">
                            <Money value={r.repaymentsCollected} className="text-xs" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[11px] font-semibold text-muted-foreground">
                Branch figures are whole-branch aggregates from the loan and
                collection records — they already include that branch's staff
                activity, so they are shown separately and never summed with
                the staff totals above.
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatCard label="Branch clients" value={staffReport.totals.branch.clients} />
                <StatCard label="Branch loans" value={staffReport.totals.branch.loans} />
                <StatCard
                  label="Branch disbursed"
                  value={<Money value={staffReport.totals.branch.disbursed} className="text-base" />}
                />
                <StatCard
                  label="Branch collected"
                  value={<Money value={staffReport.totals.branch.collected} className="text-base" />}
                />
              </div>
            </>
          )}
        </TabsContent>

        {/* ----------------------------- CENTRES --------------------------- */}
        <TabsContent value="centres" className="mt-4 space-y-4">
          <form onSubmit={searchCenter} className="flex gap-2">
            <div className="flex flex-1 items-center border-2 border-ink bg-white shadow-hard-sm">
              <Search className="ml-3 size-4 shrink-0 text-muted-foreground" />
              <input
                value={centerInput}
                onChange={(e) => setCenterInput(e.target.value)}
                placeholder="ENTER CENTRE ID — E.G. BALLIA-001"
                className="h-11 w-full bg-transparent px-3 text-sm font-bold uppercase outline-none"
              />
            </div>
            <Button type="submit" size="sm" disabled={!centerInput.trim()}>
              <Search className="size-4" /> Search
            </Button>
          </form>

          {!centerCode ? (
            <EmptyState
              title="Centre-wise client report"
              hint="Enter a Centre ID such as BALLIA-001 to list every registered client of that centre from the database."
              icon={<Building2 className="size-5" />}
            />
          ) : centerReport === undefined ? (
            <RowSkeleton rows={5} />
          ) : centerReport.status === "NOT_FOUND" ? (
            <EmptyState
              title="Centre not found"
              hint={`No centre exists with ID ${centerCode}. Check the Centre ID and search again.`}
              icon={<Search className="size-5" />}
            />
          ) : centerReport.status === "FORBIDDEN" ? (
            <EmptyState
              title="Access denied"
              hint="You are not authorised to view clients of this centre."
              icon={<Lock className="size-5" />}
            />
          ) : centerReport.total === 0 ? (
            <EmptyState
              title="No clients found"
              hint={`Centre ${centerCode} exists but has no registered clients yet.`}
              icon={<UserSearch className="size-5" />}
            />
          ) : (
            <>
              <section className="border-2 border-ink bg-navy px-3 py-3 text-paper shadow-hard">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-black uppercase">
                      {centerReport.center?.name}
                    </div>
                    <div className="truncate text-[11px] font-semibold text-paper/70">
                      {centerReport.center?.village || "—"}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="border-2 border-gold px-2 py-1 font-mono text-xs font-black text-gold">
                      {centerReport.center?.code}
                    </div>
                    <div className="mt-1 text-[10px] font-black uppercase text-gold">
                      {centerReport.total} client{centerReport.total === 1 ? "" : "s"}
                    </div>
                  </div>
                </div>
              </section>

              <div className="flex flex-col gap-2">
                {centerReport.clients.map((c) => (
                  <div
                    key={c._id}
                    className="border-2 border-ink bg-card p-3 shadow-hard-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-black">{c.name}</div>
                        <div className="font-mono text-[11px] font-bold text-muted-foreground">
                          {c.code} · {c.mobile}
                        </div>
                      </div>
                      <StatusChip status={c.kycStatus} label={`KYC ${c.kycStatus.toLowerCase()}`} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-semibold text-muted-foreground">
                      <span>Joined {formatDate(c.createdAt)}</span>
                      <span>{c.village || "—"}</span>
                      <span>Staff: {c.staffName}</span>
                      <span className="font-mono font-black text-foreground">
                        Centre {c.centerCode}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {centerReport.total > CENTER_PAGE && (
                <div className="flex items-center justify-between gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={centerOffset === 0}
                    onClick={() => setCenterOffset(Math.max(0, centerOffset - CENTER_PAGE))}
                  >
                    Previous
                  </Button>
                  <span className="text-[11px] font-black uppercase text-muted-foreground">
                    Showing {centerOffset + 1}–
                    {Math.min(centerOffset + CENTER_PAGE, centerReport.total)} of{" "}
                    {centerReport.total}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={centerOffset + CENTER_PAGE >= centerReport.total}
                    onClick={() => setCenterOffset(centerOffset + CENTER_PAGE)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
        </TabsContent>

        {/* ---------------------------- DATE RANGE --------------------------- */}
        <TabsContent value="daterange" className="mt-4 space-y-4">
          {/* Quick filters — evaluated in the institution's local day (IST) */}
          <div className="flex flex-wrap gap-1.5">
            {DATE_REPORT_PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => applyPreset(p)}
                className={cn(
                  "border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
                  drPreset === p ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
                )}
              >
                {DATE_REPORT_PRESET_LABELS[p]}
              </button>
            ))}
          </div>

          {/* From / To + generate */}
          <form onSubmit={generate} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label
                  htmlFor="dr-from"
                  className="text-[10px] font-black uppercase text-muted-foreground"
                >
                  From date
                </label>
                <input
                  id="dr-from"
                  type="date"
                  value={drFrom}
                  max={drTo}
                  onChange={(e) => {
                    setDrFrom(e.target.value);
                    setDrPreset("CUSTOM");
                  }}
                  className="h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="dr-to"
                  className="text-[10px] font-black uppercase text-muted-foreground"
                >
                  To date
                </label>
                <input
                  id="dr-to"
                  type="date"
                  value={drTo}
                  min={drFrom}
                  onChange={(e) => {
                    setDrTo(e.target.value);
                    setDrPreset("CUSTOM");
                  }}
                  className="h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
                />
              </div>
            </div>
            {drError ? (
              <p className="text-[11px] font-black uppercase text-destructive">
                {drError}
              </p>
            ) : drDirty ? (
              <p className="text-[11px] font-black uppercase text-muted-foreground">
                Dates changed — press Generate report to refresh the results.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={drError !== null}>
                <Search className="size-4" /> Generate report
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={downloadDateCsv}
                disabled={!dateCsv}
              >
                <Download className="size-4" /> Export CSV
              </Button>
            </div>
          </form>

          {/* Scope filters — every option is scoped server-side to the viewer */}
          {dateReport && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {dateReport.filterOptions.branches.length > 1 && (
                <div className="space-y-1">
                  <label
                    htmlFor="dr-branch"
                    className="text-[10px] font-black uppercase text-muted-foreground"
                  >
                    Branch
                  </label>
                  <select
                    id="dr-branch"
                    className={selectCls}
                    value={drBranch}
                    onChange={(e) => pickBranch(e.target.value)}
                  >
                    <option value="">All branches (my scope)</option>
                    {dateReport.filterOptions.branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {dateReport.filterOptions.staff.length > 0 && (
                <div className="space-y-1">
                  <label
                    htmlFor="dr-staff"
                    className="text-[10px] font-black uppercase text-muted-foreground"
                  >
                    Staff member
                  </label>
                  <select
                    id="dr-staff"
                    className={selectCls}
                    value={drStaff}
                    onChange={(e) => setDrStaff(e.target.value)}
                  >
                    <option value="">All staff (my scope)</option>
                    {dateReport.filterOptions.staff
                      .filter((s) => !drBranch || s.branchId === drBranch)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {s.role}
                        </option>
                      ))}
                  </select>
                </div>
              )}
              {dateReport.filterOptions.centers.length > 0 && (
                <div className="space-y-1">
                  <label
                    htmlFor="dr-center"
                    className="text-[10px] font-black uppercase text-muted-foreground"
                  >
                    Centre ID
                  </label>
                  <select
                    id="dr-center"
                    className={selectCls}
                    value={drCenter}
                    onChange={(e) => setDrCenter(e.target.value)}
                  >
                    <option value="">All centres</option>
                    {dateReport.filterOptions.centers
                      .filter((c) => !drBranch || c.branchId === drBranch)
                      .map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.code} · {c.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Report category */}
          <div className="flex flex-wrap gap-1.5">
            {DATE_REPORT_CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setDrCategory(c)}
                className={cn(
                  "border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
                  drCategory === c ? "bg-ink text-paper shadow-hard-sm" : "bg-white",
                )}
              >
                {DATE_REPORT_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>

          {/* Results */}
          {!dateReport ? (
            <RowSkeleton rows={6} />
          ) : (
            <>
              {/* Period banner — what this report actually covers */}
              <section className="border-2 border-ink bg-navy px-3 py-3 text-paper shadow-hard">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[10px] font-black uppercase text-gold">
                      Report period — institution-local dates, both ends included
                    </div>
                    <div className="font-mono text-sm font-black">
                      {dateReport.range.fromKey} → {dateReport.range.toKey}
                    </div>
                  </div>
                  <div className="min-w-0 text-right text-[11px] font-bold text-paper/80">
                    <div>
                      {DATE_REPORT_CATEGORY_LABELS[
                        dateReport.category as DateReportCategory
                      ] ?? dateReport.category}
                    </div>
                    <div>
                      {drBranch ? drBranchName(drBranch) : "All branches in scope"}
                      {drStaff
                        ? ` · ${
                            dateReport.filterOptions.staff.find(
                              (x) => x.id === drStaff,
                            )?.name ?? "staff"
                          }`
                        : ""}
                      {drCenter ? ` · centre ${drCenter}` : ""}
                    </div>
                  </div>
                </div>
              </section>

              {drSummary && (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <StatCard
                      label="New clients registered"
                      value={drSummary.clientsRegistered}
                      sub={`KYC: ${drSummary.kycVerified} verified · ${drSummary.kycPending} pending`}
                    />
                    <StatCard
                      label="Loans applied for"
                      value={drSummary.loansApplied}
                      sub={<Money value={drSummary.loansAppliedAmount} className="text-xs" />}
                    />
                    <StatCard
                      label="Loans approved"
                      value={drSummary.loansApproved}
                      sub={<Money value={drSummary.loansApprovedAmount} className="text-xs" />}
                      tone="ok"
                    />
                    <StatCard
                      label="Loans rejected"
                      value={drSummary.loansRejected}
                      tone={drSummary.loansRejected > 0 ? "bad" : "idle"}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <StatCard
                      label="Disbursed"
                      value={<Money value={drSummary.disbursedAmount} className="text-xl" />}
                      sub={`${drSummary.loansDisbursed} loan(s)`}
                      tone="info"
                    />
                    <StatCard
                      label="Collections received"
                      value={<Money value={drSummary.collectionsAmount} className="text-xl" />}
                      sub={
                        drSummary.reversalsCount > 0
                          ? `${drSummary.collectionsCount} receipts · ${drSummary.reversalsCount} refund(s) of ₹${drSummary.reversalsAmount.toLocaleString("en-IN")}`
                          : `${drSummary.collectionsCount} receipt(s)`
                      }
                      tone="ok"
                    />
                    <StatCard
                      label="Outstanding balance"
                      value={<Money value={drSummary.outstanding} className="text-xl" />}
                      sub="current — all open loans"
                      tone="warn"
                    />
                    <StatCard
                      label="Overdue accounts"
                      value={drSummary.overdueAccounts}
                      sub={
                        <>
                          {drSummary.overdueInstalments} instalment(s) ·{" "}
                          <Money value={drSummary.overdueAmount} className="text-xs" />
                        </>
                      }
                      tone={drSummary.overdueAccounts > 0 ? "bad" : "idle"}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <StatCard
                      label="Recovery activity"
                      value={drSummary.recoveryCount}
                      sub={
                        <>
                          promised <Money value={drSummary.recoveryPromised} className="text-xs" />
                        </>
                      }
                    />
                    <StatCard
                      label="Cash handovers"
                      value={<Money value={drSummary.handoverAmount} className="text-xl" />}
                      sub={`${drSummary.handoverCount} handover(s)`}
                    />
                    <StatCard
                      label="Wallet transactions"
                      value={drSummary.walletTxnCount}
                      sub={`credit ₹${drSummary.walletCredit.toLocaleString("en-IN")} · debit ₹${drSummary.walletDebit.toLocaleString("en-IN")}`}
                    />
                    <StatCard
                      label="Records listed"
                      value={dateReport.rowTotal}
                      sub={drComplete ? "complete list" : `showing ${dateReport.rows.length}`}
                    />
                  </div>
                </>
              )}

              <p className="text-[11px] font-semibold text-muted-foreground">
                Period figures ({dateReport.range.fromKey} → {dateReport.range.toKey}, IST)
                count only records dated inside the range. Outstanding and overdue are
                current positions derived from the loan ledger — never sums of the range.
                Collections count NORMAL receipts only; reversals are listed separately so
                no rupee is counted twice.
              </p>

              {/* Staff-wise / branch-wise activity in the period */}
              {drByStaff && drByStaff.length > 0 && (
                <section>
                  <SectionTitle>Staff-wise activity in this period</SectionTitle>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr>
                          {["Staff", "Records", "Collected", "Disbursed"].map((h) => (
                            <th
                              key={h}
                              className="border-2 border-ink bg-muted px-2 py-1.5 text-left text-[10px] font-black uppercase"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {drByStaff.map((r) => (
                          <tr key={r.key}>
                            <td className="border-2 border-ink px-2 py-1.5 text-xs font-black">
                              {r.name}
                            </td>
                            <td className="border-2 border-ink px-2 py-1.5 text-xs font-bold">
                              {r.records}
                            </td>
                            <td className="border-2 border-ink px-2 py-1.5">
                              <Money value={r.collected} className="text-xs" />
                            </td>
                            <td className="border-2 border-ink px-2 py-1.5">
                              <Money value={r.disbursed} className="text-xs" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              {drByBranch && drByBranch.length > 1 && (
                <section>
                  <SectionTitle>Branch-wise activity in this period</SectionTitle>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr>
                          {["Branch", "Records", "Collected", "Disbursed"].map((h) => (
                            <th
                              key={h}
                              className="border-2 border-ink bg-muted px-2 py-1.5 text-left text-[10px] font-black uppercase"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {drByBranch.map((r) => (
                          <tr key={r.key}>
                            <td className="border-2 border-ink px-2 py-1.5 text-xs font-black">
                              {r.name}
                            </td>
                            <td className="border-2 border-ink px-2 py-1.5 text-xs font-bold">
                              {r.records}
                            </td>
                            <td className="border-2 border-ink px-2 py-1.5">
                              <Money value={r.collected} className="text-xs" />
                            </td>
                            <td className="border-2 border-ink px-2 py-1.5">
                              <Money value={r.disbursed} className="text-xs" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              <SectionTitle>
                {dateReport.rowTotal} record{dateReport.rowTotal === 1 ? "" : "s"} —{" "}
                {DATE_REPORT_CATEGORY_LABELS[dateReport.category as DateReportCategory] ??
                  dateReport.category}
              </SectionTitle>
              {dateReport.rows.length === 0 ? (
                <EmptyState
                  title={`No records between ${dateReport.range.fromKey} and ${dateReport.range.toKey}`}
                  hint="Nothing in your authorization scope matches this range and category. Widen the dates, switch the category or clear the branch, staff and centre filters."
                  icon={<FileBarChart className="size-5" />}
                />
              ) : (
                <div className="flex flex-col gap-1.5">
                  {dateReport.rows.map((r) => {
                    const dir = rowDirection(r);
                    return (
                      <div
                        key={r.id}
                        className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-xs font-black uppercase">{r.label}</p>
                          <p className="truncate text-[11px] font-semibold text-muted-foreground">
                            {istDayKey(r.date)} · {r.party} · {r.reference} · {r.staffName}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          {r.amount !== null && (
                            <Money
                              value={r.amount}
                              className={cn(
                                "text-sm",
                                dir === "IN" && "text-success",
                                dir === "OUT" && "text-destructive",
                              )}
                            />
                          )}
                          <StatusChip status={r.status} />
                          {r.clientId && (
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Open ${r.party} report`}
                              onClick={() => {
                                setTab("clients");
                                setSelectedClientId(r.clientId as Id<"clients">);
                              }}
                            >
                              Client
                            </Button>
                          )}
                          {r.loanDbId && (
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Open loan ${r.reference}`}
                              onClick={() => navigate(`/dashboard/loans/${r.loanDbId}`)}
                            >
                              Loan
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {!drComplete && dateReport.rows.length > 0 && (
                <p className="text-[11px] font-semibold text-muted-foreground">
                  Showing {dateReport.rows.length} of {dateReport.rowTotal} matching records —
                  narrow the range or pick a category for the rest. The CSV export contains
                  every record listed here.
                </p>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
