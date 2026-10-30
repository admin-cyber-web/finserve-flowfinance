import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  EmptyState,
  KeyValue,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  formatDate,
  formatDateTime,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { formatINR } from "@/lib/finance/money";
import { LEDGER_TYPE_LABELS } from "@/lib/finance/statement";
import { cn, fmtId } from "@/lib/utils";
import { useQuery } from "convex/react";
import {
  Download,
  FileSearch,
  Eye,
  EyeOff,
  Printer,
  Search,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

/**
 * Reports → Statement (the fifth section beside the four range reports).
 *
 * Search a client by Client ID / Customer ID / LAN ID / Loan ID, then read a
 * complete, ledger-backed statement: client details (identity numbers masked
 * server-side unless the viewer is a SUPER_ADMIN), loan details, the next due
 * date taken off the actual installment schedule, and the chronological
 * transaction ledger with a period filter, CSV export and a branded print
 * view. Every figure comes from `reports.statement` — nothing is computed
 * from demo data or guesses.
 */

const INPUT_CLS =
  "h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none";
const TH_CLS =
  "border border-ink bg-muted px-1.5 py-1 text-left text-[10px] font-black uppercase whitespace-nowrap";
const TD_CLS = "border border-ink px-1.5 py-1 font-semibold";

const NA = "Not Available";
const orNA = (v: string | null | undefined) => v || NA;
const money = (v: number | null | undefined) =>
  v == null ? NA : formatINR(v);

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "border-2 border-ink bg-card p-4 shadow-hard-sm",
        className,
      )}
    >
      <h3 className="mb-2 text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

const htmlEsc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export default function ClientStatement() {
  /* ------------------------------- Search -------------------------------- */
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [clientId, setClientId] = useState<Id<"clients"> | null>(null);
  const [loanDbId, setLoanDbId] = useState<Id<"loans"> | null>(null);
  const [reveal, setReveal] = useState(false);

  const search = useQuery(
    api.reports.statementSearch,
    submitted ? { q: submitted } : "skip",
  );

  // An exact single hit opens immediately; multiple hits must be chosen so a
  // client is never shown because of an ambiguous ID.
  useEffect(() => {
    if (!search) return;
    if (search.matches.length === 1) {
      setClientId(search.matches[0].clientId as Id<"clients">);
      setLoanDbId(null);
    }
  }, [search]);

  const pick = (id: string) => {
    setClientId(id as Id<"clients">);
    setLoanDbId(null);
    setReveal(false);
  };

  /* ------------------------------- Period -------------------------------- */
  const [fullHistory, setFullHistory] = useState(true);
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");

  const periodError = useMemo(() => {
    if (fullHistory) return null;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(fromDay) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(toDay)
    ) {
      return "Pick a valid From and To date, or switch to full history.";
    }
    if (fromDay > toDay) return "From date must be on or before To date.";
    return null;
  }, [fullHistory, fromDay, toDay]);

  /* ------------------------------ Statement ------------------------------ */
  const data = useQuery(
    api.reports.statement,
    clientId && !periodError
      ? {
          clientId,
          loanDbId: loanDbId ?? undefined,
          fromDay: fullHistory ? undefined : fromDay,
          toDay: fullHistory ? undefined : toDay,
        }
      : "skip",
  );

  const selected = data?.selected ?? null;
  const ledger = selected?.ledger ?? [];
  const summary = selected?.summary ?? null;
  const repayment = selected?.repayment ?? null;
  const staffNames = data?.staffNames ?? {};

  const noUpcoming =
    repayment != null && repayment.nextDueDate == null && ledger.length > 0;

  /* -------------------------------- CSV ---------------------------------- */
  const csv = () => {
    if (!data || !data.client) return;
    const esc = (v: string | number) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = [
      "Date",
      "Receipt / Ref",
      "Type",
      "Installment Due",
      "Amount Paid",
      "Principal",
      "Interest",
      "Outstanding After",
      "Mode",
      "Staff",
      "Status / Remarks",
    ];
    const body = ledger.map((r) => [
      formatDate(r.date),
      r.reference,
      LEDGER_TYPE_LABELS[r.type],
      r.due ?? "",
      r.paid ?? "",
      r.principalPart ?? "",
      r.interestPart ?? "",
      r.balanceAfter,
      r.mode ?? "",
      r.staffId ? (staffNames[r.staffId] ?? r.staffId) : "",
      [r.status, r.remarks].filter(Boolean).join(" — "),
    ]);
    const meta: (string | number)[][] = [
      ["Organisation", "KIRAT MICRO CREDIT"],
      ["Client", `${fmtId(data.client.code)} — ${data.client.name}`],
      ["Loan", data.selected?.loanId ?? "Combined (all loans)"],
      [
        "Period",
        data.period ? `${data.period.fromKey} → ${data.period.toKey}` : "Full history",
      ],
      ["Generated at", new Date().toISOString()],
      [],
      ["Opening balance", summary?.openingBalance ?? ""],
      ["Total disbursement in period", summary?.disbursementInPeriod ?? ""],
      ["Total dues scheduled in period", summary?.totalDues ?? ""],
      ["Total successful payments", summary?.totalPaid ?? ""],
      ["Adjustments (reversals)", summary?.adjustments ?? ""],
      ["Closing outstanding", summary?.closingOutstanding ?? ""],
      [],
    ];
    const csvText = [
      ...meta.map((m) => m.map(esc).join(",")),
      head.map(esc).join(","),
      ...body.map((r) => r.map(esc).join(",")),
    ].join("\n");
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kirat-statement_${fmtId(data.client.code)}_${fmtId(data.selected?.loanId ?? "") || "all-loans"}_${data.period ? `${data.period.fromKey}_to_${data.period.toKey}` : "full"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* -------------------------------- Print -------------------------------- */
  const printStatement = () => {
    if (!data || !data.client || !selected) return;
    const c = data.client;
    const rowHtml = ledger
      .map(
        (r) => `<tr>
<td>${htmlEsc(formatDate(r.date))}</td>
<td>${htmlEsc(r.reference)}</td>
<td>${htmlEsc(LEDGER_TYPE_LABELS[r.type])}</td>
<td class="n">${r.due != null ? htmlEsc(formatINR(r.due)) : "—"}</td>
<td class="n">${r.paid != null ? htmlEsc(formatINR(r.paid)) : "—"}</td>
<td class="n">${r.principalPart != null ? htmlEsc(formatINR(r.principalPart)) : "—"}</td>
<td class="n">${r.interestPart != null ? htmlEsc(formatINR(r.interestPart)) : "—"}</td>
<td class="n">${htmlEsc(formatINR(r.balanceAfter))}</td>
<td>${htmlEsc(r.mode ?? "—")}</td>
<td>${htmlEsc(r.staffId ? (staffNames[r.staffId] ?? "—") : "—")}</td>
<td>${htmlEsc([r.status, r.remarks].filter(Boolean).join(" — "))}</td>
</tr>`,
      )
      .join("");
    const loanRows = data.loans
      .map(
        (l) => `<tr>
<td>${htmlEsc(l.loanId)}</td>
<td class="n">${htmlEsc(formatDate(l.appliedAt))}</td>
<td class="n">${htmlEsc(formatDate(l.approvedAt))}</td>
<td class="n">${htmlEsc(formatDate(l.disbursedAt))}</td>
<td class="n">${htmlEsc(money(l.requestedAmount))}</td>
<td class="n">${htmlEsc(money(l.sanctionedAmount))}</td>
<td class="n">${htmlEsc(money(l.disbursedAmount))}</td>
<td class="n">${l.tenure}</td>
<td class="n">${htmlEsc(formatINR(l.installment))}</td>
<td>${htmlEsc(l.frequency)}</td>
<td class="n">${htmlEsc(formatINR(l.totalPayable))}</td>
<td class="n">${htmlEsc(formatINR(l.totalPaid))}</td>
<td class="n">${htmlEsc(formatINR(l.outstanding))}</td>
<td>${htmlEsc(l.displayStatus)}</td>
</tr>`,
      )
      .join("");
    const upcoming =
      repayment && repayment.upcoming && repayment.upcoming.length > 0
        ? `<table><thead><tr><th>Inst</th><th>Due date</th><th>Amount</th><th>Paid</th><th>Remaining</th></tr></thead><tbody>${repayment.upcoming
            .map(
              (u) =>
                `<tr><td class="n">${u.index}</td><td>${htmlEsc(formatDate(u.dueDate))}</td><td class="n">${htmlEsc(formatINR(u.amount))}</td><td class="n">${htmlEsc(formatINR(u.paid))}</td><td class="n">${htmlEsc(formatINR(u.remaining))}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : `<p>${noUpcoming ? "No Upcoming Dues — every scheduled installment is paid." : "No open installments."}</p>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>KIRAT MICRO CREDIT — Statement — ${htmlEsc(c.code)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 24px; }
  header { border-bottom: 3px solid #111; padding-bottom: 8px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: flex-end; }
  h1 { font-size: 20px; margin: 0; letter-spacing: 1px; }
  .sub { font-size: 11px; text-transform: uppercase; letter-spacing: 2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; margin: 18px 0 6px; border-bottom: 1px solid #999; padding-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 8px; }
  th, td { border: 1px solid #444; padding: 3px 5px; text-align: left; }
  th { background: #f2b705; text-transform: uppercase; font-size: 9px; letter-spacing: .5px; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 24px; font-size: 11px; }
  .grid div span:first-child { color: #555; text-transform: uppercase; font-size: 9px; letter-spacing: .5px; }
  .due { border: 2px solid #111; padding: 8px; margin: 10px 0; font-size: 12px; }
  footer { margin-top: 18px; font-size: 9px; color: #555; border-top: 1px solid #999; padding-top: 6px; }
  @media print { body { margin: 10mm; } }
</style></head><body>
<header>
  <div><h1>KIRAT MICRO CREDIT</h1><div class="sub">Client Statement</div></div>
  <div style="text-align:right"><div class="sub">Generated</div><div>${htmlEsc(formatDateTime(data.generatedAt))}</div>
  <div class="sub">Period</div><div>${data.period ? `${htmlEsc(data.period.fromKey)} to ${htmlEsc(data.period.toKey)}` : "Full history"}</div></div>
</header>
<h2>Client details</h2>
<div class="grid">
  <div><span>Client ID / Customer ID</span><br><b>${htmlEsc(c.code)}</b></div>
  <div><span>Full name</span><br><b>${htmlEsc(c.name)}</b></div>
  <div><span>Husband name</span><br>${htmlEsc(orNA(c.husbandName))}</div>
  <div><span>Father name</span><br>${htmlEsc(orNA(c.fatherName))}</div>
  <div><span>Mobile number</span><br>${htmlEsc(orNA(c.mobileMasked))}</div>
  <div><span>Age / gender</span><br>${c.age} · ${htmlEsc(c.gender?.toLowerCase() ?? "")}</div>
  <div><span>Permanent address</span><br>${htmlEsc(orNA([c.address, c.village, c.district, c.state, c.pin].filter(Boolean).join(", ")))}</div>
  <div><span>Maternal home address</span><br>${htmlEsc(orNA(c.maternalHomeAddress))}</div>
  <div><span>Occupation</span><br>${htmlEsc(orNA(c.occupation))}</div>
  <div><span>Monthly / household income</span><br>${htmlEsc(formatINR(c.monthlyIncome))} / ${htmlEsc(formatINR(c.householdIncome))}</div>
  <div><span>Aadhaar</span><br>${htmlEsc(data.revealAllowed && reveal && c.aadhaar ? c.aadhaar : orNA(c.aadhaarMasked))}</div>
  <div><span>PAN</span><br>${htmlEsc(data.revealAllowed && reveal && c.pan ? c.pan : orNA(c.panMasked))}</div>
  <div><span>Voter ID</span><br>${htmlEsc(data.revealAllowed && reveal && c.voter ? c.voter : orNA(c.voterMasked))}</div>
  <div><span>KYC status</span><br>${htmlEsc(c.kycStatus)}</div>
  <div><span>Centre</span><br>${htmlEsc(c.center ? `${fmtId(c.center.code)} · ${orNA(c.center.name)}` : NA)}</div>
  <div><span>Group</span><br>${htmlEsc(c.group ? `${fmtId(c.group.code)} · ${orNA(c.group.name)}` : NA)}</div>
  <div><span>Branch</span><br>${htmlEsc(c.branch ? `${fmtId(c.branch.code)} · ${orNA(c.branch.name)}` : NA)}</div>
  <div><span>Account opened</span><br>${htmlEsc(formatDate(c.createdAt))}</div>
  <div><span>Registered by</span><br>${htmlEsc(c.registeredBy ? `${c.registeredBy.name} (${c.registeredBy.profileId})` : NA)}</div>
</div>
<h2>Loan details</h2>
<table><thead><tr><th>Loan ID / LAN</th><th>Applied</th><th>Approved</th><th>Disbursed</th><th>Requested</th><th>Sanctioned</th><th>Disbursed ₹</th><th>Tenure</th><th>EMI</th><th>Frequency</th><th>Total payable</th><th>Total paid</th><th>Outstanding</th><th>Status</th></tr></thead><tbody>${loanRows}</tbody></table>
<h2>Next due &amp; repayment status</h2>
<div class="due">
${noUpcoming ? "<b>No Upcoming Dues</b> — the actual installment schedule and ledger show every installment paid." : repayment?.nextDueDate ? `<b>Next due date:</b> ${htmlEsc(formatDate(repayment.nextDueDate))} &nbsp;·&nbsp; <b>Next installment due:</b> ${htmlEsc(formatINR(repayment.nextDueAmount ?? 0))}<br>
<b>Current arrears / overdue:</b> ${htmlEsc(formatINR(repayment.totalOverdueAmount))} (${repayment.overdueDays} days) &nbsp;·&nbsp; <b>Installments paid / remaining:</b> ${repayment.installmentsPaid} / ${repayment.installmentsRemaining}<br>
<b>Total paid to date:</b> ${htmlEsc(formatINR(repayment.totalPaidToDate))} &nbsp;·&nbsp; <b>Outstanding:</b> ${htmlEsc(formatINR(repayment.outstanding))}<br>
<b>Last payment:</b> ${repayment.lastPaymentDate ? `${htmlEsc(formatDate(repayment.lastPaymentDate))} · ${htmlEsc(formatINR(repayment.lastPaymentAmount ?? 0))}` : NA}` : "No loan selected."}
</div>
<h2>Upcoming installment schedule</h2>
${upcoming}
<h2>Transaction statement</h2>
<table><thead><tr><th>Date</th><th>Receipt / Ref</th><th>Type</th><th>Inst. due</th><th>Amount paid</th><th>Principal</th><th>Interest</th><th>Outstanding after</th><th>Mode</th><th>Staff</th><th>Status / remarks</th></tr></thead><tbody>${rowHtml || '<tr><td colspan="11">No transactions in this period.</td></tr>'}</tbody></table>
<h2>Summary</h2>
<div class="grid">
  <div><span>Opening balance</span><br><b>${htmlEsc(money(summary?.openingBalance))}</b></div>
  <div><span>Total disbursement in period</span><br><b>${htmlEsc(money(summary?.disbursementInPeriod))}</b></div>
  <div><span>Total dues scheduled in period</span><br>${htmlEsc(money(summary?.totalDues))}</div>
  <div><span>Total successful payments</span><br>${htmlEsc(money(summary?.totalPaid))}</div>
  <div><span>Adjustments (reversals, memo)</span><br>${htmlEsc(money(summary?.adjustments))}</div>
  <div><span>Closing outstanding</span><br><b>${htmlEsc(money(summary?.closingOutstanding))}</b></div>
</div>
<footer>Generated from KIRAT MICRO CREDIT records. Identity numbers follow the viewer's access rights. Reversals and reversed payments are shown transparently and excluded from payment totals so no rupee is counted twice.</footer>
</body></html>`;
    try {
      const win = window.open("", "_blank", "width=980,height=720");
      if (!win) throw new Error("pop-up blocked");
      win.document.write(html);
      win.document.close();
      win.focus();
      setTimeout(() => win.print(), 350);
    } catch {
      toast.error("Could not open the print view — allow pop-ups for this site.");
    }
  };

  /* -------------------------------- Screen ------------------------------- */
  return (
    <div className="space-y-4">
      {/* ----------------------------- Search ---------------------------- */}
      <Card title="Client statement search">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const value = q.trim();
            if (!value) return;
            setClientId(null);
            setLoanDbId(null);
            setReveal(false);
            setSubmitted(value);
          }}
        >
          <label className="min-w-0 flex-1">
            <span className="text-[10px] font-black uppercase text-muted-foreground">
              Search by Client ID / Customer ID / LAN ID / Loan ID
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="000128 · LN000123"
              className={cn(INPUT_CLS, "mt-1 font-mono")}
            />
          </label>
          <Button type="submit" variant="outline" className="h-11">
            <Search className="size-4" /> Search
          </Button>
        </form>

        {search && search.matches.length === 0 && (
          <p className="mt-3 border-2 border-ink bg-blush p-2 text-[11px] font-black uppercase">
            No client or loan matches “{search.query}”. Check the ID and try
            again — nothing outside your access is ever shown here.
          </p>
        )}
        {search && search.matches.length > 1 && (
          <div className="mt-3 space-y-1.5">
            <p className="text-[11px] font-black uppercase text-muted-foreground">
              {search.matches.length} clients match — pick the exact one
            </p>
            {search.matches.map((m) => (
              <button
                key={m.clientId}
                onClick={() => pick(m.clientId)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 border-2 border-ink bg-white px-3 py-2 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
                  clientId === m.clientId && "bg-sky",
                )}
              >
                <span className="font-mono text-xs font-black">{fmtId(m.code)}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-bold">
                  {m.name}
                </span>
                <span className="font-mono text-[10px] font-bold">
                  {m.mobileMasked ?? ""}
                </span>
                <span className="border border-ink bg-clay px-1.5 py-0.5 text-[9px] font-black uppercase">
                  {m.matchedOn === "CLIENT_ID" ? "Client ID" : "LAN"}
                </span>
                <span className="text-[10px] font-bold">
                  {m.loanIds.length} {m.loanIds.length === 1 ? "loan" : "loans"}
                </span>
              </button>
            ))}
          </div>
        )}
        {search && search.matches.length === 1 && clientId && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-2 border-ink bg-mint px-3 py-2">
            <span className="flex items-center gap-2 text-xs font-black uppercase">
              <UserRound className="size-4" />
              {fmtId(search.matches[0].code)} · {search.matches[0].name}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setClientId(null);
                setLoanDbId(null);
                setSubmitted(null);
              }}
            >
              New search
            </Button>
          </div>
        )}
      </Card>

      {/* ------------------------------ No hit ----------------------------- */}
      {submitted && search && search.matches.length === 0 && (
        <EmptyState
          title="Nothing to show"
          hint="Search a Client ID, Customer ID, LAN ID or Loan ID to open a statement."
          icon={<FileSearch className="size-5" />}
        />
      )}

      {/* ------------------------------ Loading ---------------------------- */}
      {clientId && periodError && (
        <p className="text-[11px] font-black uppercase text-destructive">
          {periodError}
        </p>
      )}
      {clientId && !periodError && data === undefined && (
        <RowSkeleton rows={10} />
      )}

      {/* ------------------------------ Statement -------------------------- */}
      {clientId && !periodError && data && (
        <>
          {/* Period filter */}
          <Card title="Statement period">
            <div className="flex flex-wrap items-end gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFullHistory((v) => !v)}
              >
                {fullHistory ? "Viewing: full history — switch to period" : "Viewing: selected period — switch to full history"}
              </Button>
              {!fullHistory && (
                <div className="grid flex-1 grid-cols-2 gap-2">
                  <label className="space-y-1">
                    <span className="text-[10px] font-black uppercase text-muted-foreground">
                      From date
                    </span>
                    <input
                      type="date"
                      value={fromDay}
                      max={toDay || undefined}
                      onChange={(e) => setFromDay(e.target.value)}
                      className={INPUT_CLS}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-black uppercase text-muted-foreground">
                      To date
                    </span>
                    <input
                      type="date"
                      value={toDay}
                      min={fromDay || undefined}
                      onChange={(e) => setToDay(e.target.value)}
                      className={INPUT_CLS}
                    />
                  </label>
                </div>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={csv} disabled={!selected}>
                  <Download className="size-4" /> Export CSV
                </Button>
                <Button variant="outline" onClick={printStatement} disabled={!selected}>
                  <Printer className="size-4" /> Print / Save as PDF
                </Button>
              </div>
            </div>
            {data.period && (
              <p className="mt-2 font-mono text-xs font-black">
                Period: {data.period.fromKey} → {data.period.toKey} ·{" "}
                {ledger.length} transactions
              </p>
            )}
            {!data.period && (
              <p className="mt-2 font-mono text-xs font-black">
                Full history · {ledger.length} transactions
              </p>
            )}
          </Card>

          {/* -------------------- Next due & repayment status --------------- */}
          <section className="border-2 border-ink bg-navy px-4 py-4 text-paper shadow-hard">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
                  Next due date — from the actual installment schedule
                </div>
                {noUpcoming ? (
                  <div className="mt-1 text-xl font-black uppercase">
                    No Upcoming Dues
                  </div>
                ) : repayment?.nextDueDate ? (
                  <div className="mt-1 font-mono text-2xl font-black tracking-tight">
                    {formatDate(repayment.nextDueDate)}
                  </div>
                ) : (
                  <div className="mt-1 text-lg font-black">{NA}</div>
                )}
                <div className="mt-1 text-[11px] font-bold text-paper/80">
                  {noUpcoming
                    ? "Every scheduled installment is paid — verified against the schedule and ledger."
                    : repayment?.nextDueDate
                      ? `Installment due: ${formatINR(repayment.nextDueAmount ?? 0)}`
                      : "No open installment on this loan."}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-[11px] font-bold sm:grid-cols-3">
                <div>
                  <span className="block text-[9px] uppercase text-gold">Arrears</span>
                  <span className={cn(repayment && repayment.totalOverdueAmount > 0 && "text-blush font-black")}>
                    {repayment ? formatINR(repayment.totalOverdueAmount) : NA}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-gold">Overdue days</span>
                  <span>{repayment ? repayment.overdueDays || "0" : NA}</span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-gold">Paid to date</span>
                  <span>{repayment ? formatINR(repayment.totalPaidToDate) : NA}</span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-gold">Outstanding</span>
                  <span>{repayment ? formatINR(repayment.outstanding) : NA}</span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-gold">Paid / remaining</span>
                  <span>
                    {repayment
                      ? `${repayment.installmentsPaid} / ${repayment.installmentsRemaining}`
                      : NA}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-gold">Last payment</span>
                  <span>
                    {repayment?.lastPaymentDate
                      ? `${formatDate(repayment.lastPaymentDate)} · ${formatINR(repayment.lastPaymentAmount ?? 0)}`
                      : NA}
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* Upcoming schedule */}
          {repayment && repayment.upcoming.length > 0 && (
            <Card title="Upcoming installment schedule">
              <div className="overflow-x-auto">
                <table className="w-full border-2 border-ink text-xs">
                  <thead>
                    <tr>
                      <th className={TH_CLS}>Loan</th>
                      <th className={TH_CLS}>Inst.</th>
                      <th className={TH_CLS}>Due date</th>
                      <th className={TH_CLS}>Amount</th>
                      <th className={TH_CLS}>Paid</th>
                      <th className={TH_CLS}>Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repayment.upcoming.map((u) => (
                      <tr key={`${u.loanId}-${u.index}`} className="hover:bg-sky/40">
                        <td className={cn(TD_CLS, "font-mono whitespace-nowrap")}>
                          {fmtId(u.loanId)}
                        </td>
                        <td className={cn(TD_CLS, "text-center font-black")}>
                          {u.index}
                        </td>
                        <td className={cn(TD_CLS, "whitespace-nowrap")}>
                          {formatDate(u.dueDate)}
                        </td>
                        <td className={cn(TD_CLS, "text-right whitespace-nowrap")}>
                          {formatINR(u.amount)}
                        </td>
                        <td className={cn(TD_CLS, "text-right whitespace-nowrap")}>
                          {formatINR(u.paid)}
                        </td>
                        <td
                          className={cn(
                            TD_CLS,
                            "text-right whitespace-nowrap font-black",
                          )}
                        >
                          {formatINR(u.remaining)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* ------------------------ Loan selector ------------------------- */}
          {data.loans.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setLoanDbId(null)}
                className={cn(
                  "border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase shadow-hard-sm",
                  loanDbId === null ? "bg-navy text-paper" : "bg-white",
                )}
              >
                Combined statement ({data.loans.length} loans)
              </button>
              {data.loans.map((l) => (
                <button
                  key={l._id}
                  onClick={() => setLoanDbId(l._id as Id<"loans">)}
                  className={cn(
                    "border-2 border-ink px-2.5 py-1.5 font-mono text-[11px] font-black uppercase shadow-hard-sm",
                    loanDbId === l._id ? "bg-navy text-paper" : "bg-white",
                  )}
                >
                  {fmtId(l.loanId)}
                </button>
              ))}
            </div>
          )}

          {/* -------------------------- Client details ---------------------- */}
          <Card title="Client details">
            <div className="flex flex-wrap items-start gap-4">
              {data.client.photoUrl ? (
                <img
                  src={data.client.photoUrl}
                  alt={`Photo of ${data.client.name}`}
                  className="size-24 border-2 border-ink object-cover shadow-hard-sm"
                />
              ) : (
                <div className="grid size-24 place-items-center border-2 border-ink bg-clay text-[9px] font-black uppercase text-muted-foreground">
                  No photo
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-black">
                    {fmtId(data.client.code)}
                  </span>
                  <span className="text-base font-black">
                    {data.client.name}
                  </span>
                  <StatusChip status={data.client.kycStatus} />
                  {data.revealAllowed && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setReveal((v) => !v)}
                    >
                      {reveal ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                      {reveal ? "Hide" : "Reveal"} identity numbers
                    </Button>
                  )}
                </div>
                <div className="mt-1">
                  <KeyValue k="Husband name" v={orNA(data.client.husbandName)} />
                  <KeyValue k="Father name" v={orNA(data.client.fatherName)} />
                  <KeyValue k="Mobile number" v={orNA(data.client.mobileMasked)} mono />
                  <KeyValue
                    k="Age / gender"
                    v={`${data.client.age} · ${data.client.gender.toLowerCase()}`}
                  />
                  <KeyValue
                    k="Permanent address"
                    v={orNA(
                      [
                        data.client.address,
                        data.client.village,
                        data.client.district,
                        data.client.state,
                        data.client.pin,
                      ]
                        .filter(Boolean)
                        .join(", "),
                    )}
                  />
                  <KeyValue
                    k="Maternal home address"
                    v={orNA(data.client.maternalHomeAddress)}
                  />
                  <KeyValue k="Occupation" v={orNA(data.client.occupation)} />
                  <KeyValue
                    k="Monthly / household income"
                    v={`${formatINR(data.client.monthlyIncome)} / ${formatINR(data.client.householdIncome)}`}
                  />
                  <KeyValue
                    k="Aadhaar"
                    v={
                      data.revealAllowed && reveal && data.client.aadhaar
                        ? data.client.aadhaar
                        : orNA(data.client.aadhaarMasked)
                    }
                    mono
                  />
                  <KeyValue
                    k="PAN"
                    v={
                      data.revealAllowed && reveal && data.client.pan
                        ? data.client.pan
                        : orNA(data.client.panMasked)
                    }
                    mono
                  />
                  <KeyValue
                    k="Voter ID"
                    v={
                      data.revealAllowed && reveal && data.client.voter
                        ? data.client.voter
                        : orNA(data.client.voterMasked)
                    }
                    mono
                  />
                  <KeyValue
                    k="Centre"
                    v={
                      data.client.center
                        ? `${fmtId(data.client.center.code)} · ${orNA(data.client.center.name)}`
                        : NA
                    }
                  />
                  <KeyValue
                    k="Group"
                    v={
                      data.client.group
                        ? `${fmtId(data.client.group.code)} · ${orNA(data.client.group.name)}`
                        : NA
                    }
                  />
                  <KeyValue
                    k="Branch"
                    v={
                      data.client.branch
                        ? `${fmtId(data.client.branch.code)} · ${orNA(data.client.branch.name)}`
                        : NA
                    }
                  />
                  <KeyValue
                    k="Account opened"
                    v={formatDate(data.client.createdAt)}
                  />
                  <KeyValue
                    k="Registered by"
                    v={
                      data.client.registeredBy
                        ? `${data.client.registeredBy.name} (${data.client.registeredBy.profileId})`
                        : NA
                    }
                  />
                </div>
              </div>
            </div>
          </Card>

          {/* -------------------------- Loan details ------------------------ */}
          {data.loans.length === 0 ? (
            <EmptyState
              title="No loans on file"
              hint="This client has no loan records yet, so there is nothing to statement."
              icon={<FileSearch className="size-5" />}
            />
          ) : (
            <div className="space-y-3">
              <SectionTitle>Loan details</SectionTitle>
              {data.loans.map((l) => (
                <Card key={l._id} title={`Loan ${fmtId(l.loanId)}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip status={l.displayStatus} />
                    {l.product && (
                      <span className="border border-ink bg-clay px-1.5 py-0.5 text-[10px] font-black uppercase">
                        {l.product.name}
                      </span>
                    )}
                    <span className="text-[10px] font-black uppercase text-muted-foreground">
                      {l.frequency} · {l.tenure} installments ·{" "}
                      {l.interestRate}% {l.interestMethod.toLowerCase()}
                    </span>
                  </div>
                  <div className="mt-1">
                    <KeyValue
                      k="Requested amount"
                      v={money(l.requestedAmount)}
                    />
                    <KeyValue
                      k="Sanctioned amount"
                      v={formatINR(l.sanctionedAmount)}
                    />
                    <KeyValue
                      k="Disbursed amount"
                      v={money(l.disbursedAmount)}
                    />
                    <KeyValue k="Applied on" v={formatDate(l.appliedAt)} />
                    <KeyValue
                      k="Approved on"
                      v={l.approvedAt ? formatDate(l.approvedAt) : NA}
                    />
                    <KeyValue
                      k="Disbursed on"
                      v={l.disbursedAt ? formatDate(l.disbursedAt) : NA}
                    />
                    <KeyValue
                      k="EMI / installment"
                      v={formatINR(l.installment)}
                    />
                    <KeyValue
                      k="Repayment frequency"
                      v={l.frequency.toLowerCase()}
                    />
                    <KeyValue k="Loan purpose" v={orNA(l.purpose)} />
                    <KeyValue
                      k="First installment date"
                      v={
                        l.firstInstallmentDate
                          ? formatDate(l.firstInstallmentDate)
                          : NA
                      }
                    />
                    <KeyValue
                      k="Last scheduled installment"
                      v={
                        l.lastInstallmentDate
                          ? formatDate(l.lastInstallmentDate)
                          : NA
                      }
                    />
                    <KeyValue
                      k="Total payable (schedule)"
                      v={formatINR(l.totalPayable)}
                    />
                    <KeyValue
                      k="Total amount paid"
                      v={formatINR(l.totalPaid)}
                    />
                    <KeyValue
                      k="Outstanding principal"
                      v={formatINR(l.outstandingPrincipal)}
                    />
                    <KeyValue
                      k="Total outstanding"
                      v={formatINR(l.outstanding)}
                    />
                    <KeyValue k="Current status" v={l.displayStatus.toLowerCase()} />
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* ------------------------ Statement ledger ---------------------- */}
          <Card title="Transaction statement / ledger">
            {ledger.length === 0 ? (
              <EmptyState
                title="No transactions in this period"
                hint="Disbursements, installment dues, payments and reversals inside the selected period appear here."
                icon={<FileSearch className="size-5" />}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-2 border-ink text-xs">
                  <thead>
                    <tr>
                      <th className={TH_CLS}>Date</th>
                      <th className={TH_CLS}>Receipt / Ref</th>
                      <th className={TH_CLS}>Type</th>
                      <th className={TH_CLS}>Inst. due</th>
                      <th className={TH_CLS}>Amount paid</th>
                      <th className={TH_CLS}>Principal</th>
                      <th className={TH_CLS}>Interest</th>
                      <th className={TH_CLS}>Outstanding after</th>
                      <th className={TH_CLS}>Mode</th>
                      <th className={TH_CLS}>Staff</th>
                      <th className={TH_CLS}>Status / remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((r) => (
                      <tr
                        key={r.id}
                        className={cn(
                          "hover:bg-sky/40",
                          r.type === "DISBURSEMENT" && "bg-gold/30",
                          !r.counted && "text-muted-foreground",
                        )}
                      >
                        <td className={cn(TD_CLS, "whitespace-nowrap")}>
                          {formatDate(r.date)}
                        </td>
                        <td className={cn(TD_CLS, "font-mono whitespace-nowrap")}>
                          {fmtId(r.reference)}
                        </td>
                        <td className={cn(TD_CLS, "whitespace-nowrap")}>
                          {LEDGER_TYPE_LABELS[r.type]}
                        </td>
                        <td className={cn(TD_CLS, "text-right whitespace-nowrap")}>
                          {r.due != null ? formatINR(r.due) : "—"}
                        </td>
                        <td className={cn(TD_CLS, "text-right whitespace-nowrap")}>
                          {r.paid != null ? formatINR(r.paid) : "—"}
                        </td>
                        <td className={cn(TD_CLS, "text-right whitespace-nowrap")}>
                          {r.principalPart != null ? formatINR(r.principalPart) : "—"}
                        </td>
                        <td className={cn(TD_CLS, "text-right whitespace-nowrap")}>
                          {r.interestPart != null ? formatINR(r.interestPart) : "—"}
                        </td>
                        <td
                          className={cn(
                            TD_CLS,
                            "text-right whitespace-nowrap font-black",
                          )}
                        >
                          {formatINR(r.balanceAfter)}
                        </td>
                        <td className={cn(TD_CLS, "text-center")}>
                          {r.mode ?? "—"}
                        </td>
                        <td className={cn(TD_CLS, "whitespace-nowrap")}>
                          {r.staffId
                            ? (staffNames[r.staffId] ?? "—")
                            : "—"}
                        </td>
                        <td className={cn(TD_CLS, "whitespace-nowrap")}>
                          {[r.status, r.remarks].filter(Boolean).join(" — ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* --------------------------- Summary ---------------------------- */}
          {summary && (
            <section className="border-2 border-ink bg-navy px-4 py-3 text-paper shadow-hard">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[11px] font-bold sm:grid-cols-3">
                <div>
                  <span className="block text-[9px] uppercase text-gold">
                    Opening balance
                  </span>
                  <span className="font-mono text-sm font-black">
                    {formatINR(summary.openingBalance)}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-gold">
                    Total disbursement (in period)
                  </span>
                  <span className="font-mono text-sm font-black">
                    {formatINR(summary.disbursementInPeriod)}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-gold">
                    Total dues scheduled (memo)
                  </span>
                  <span className="font-mono text-sm font-black">
                    {formatINR(summary.totalDues)}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-gold">
                    Total successful payments
                  </span>
                  <span className="font-mono text-sm font-black">
                    {formatINR(summary.totalPaid)}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-gold">
                    Adjustments — reversals (memo)
                  </span>
                  <span className="font-mono text-sm font-black">
                    {formatINR(summary.adjustments)}
                  </span>
                </div>
                <div>
                  <span className="block text-[9px] uppercase text-gold">
                    Closing outstanding
                  </span>
                  <span className="font-mono text-sm font-black text-gold">
                    {formatINR(summary.closingOutstanding)}
                  </span>
                </div>
              </div>
              <p className="mt-2 text-[10px] font-bold text-paper/70">
                Closing = opening + disbursement in period − successful
                payments. Reversed payments leave the paid total when their
                refund is booked, and both rows stay visible in the ledger — no
                rupee is ever counted twice.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
