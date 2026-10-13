import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  EmptyState,
  KeyValue,
  Money,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  formatDate,
  formatDateTime,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useQuery } from "convex/react";
import { ArrowLeft, Printer } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Complete individual client report (spec 4.3) — profile, registration &
 * assignment history, loans, instalment schedules, repayment history and the
 * current position. Every figure comes from `clients.get`, which reads the
 * same records the rest of the app uses. Anything the database does not
 * record is shown as "Not available in recorded data" — never guessed.
 */

const NA = "Not available in recorded data";

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-2 border-ink bg-card p-4 shadow-hard-sm">
      <h2 className="mb-2 text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function TH({ children }: { children: ReactNode }) {
  return (
    <th className="border border-ink bg-muted px-1.5 py-1 text-left text-[10px] font-black uppercase">
      {children}
    </th>
  );
}
function TD({
  children,
  mono,
}: {
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <td
      className={`border border-ink px-1.5 py-1 text-xs ${mono ? "font-mono tabular-nums" : "font-semibold"}`}
    >
      {children}
    </td>
  );
}

export default function ReportClient({
  clientId,
  onBack,
}: {
  clientId: Id<"clients">;
  onBack: () => void;
}) {
  const data = useQuery(api.clients.get, { clientId });

  if (data === undefined) {
    return (
      <div className="space-y-3">
        <div className="mb-4 flex items-start gap-3">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Back to reports"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
          <h1 className="text-xl font-black tracking-tight">Client report</h1>
        </div>
        <RowSkeleton rows={8} />
      </div>
    );
  }

  const {
    client,
    coApplicantPhotoUrl,
    assignedStaff,
    createdBy,
    branch,
    branchManager,
    applications,
    loans,
    payments,
    staffHistory,
    documents,
    totals,
  } = data;
  const now = Date.now();

  /* ------------------------- derived, data-backed ------------------------- */

  const appByLoan = new Map(
    applications
      .filter((a) => a.loanId)
      .map((a) => [a.loanId as string, a]),
  );
  const loanByDbId = new Map(loans.map((l) => [l.loan._id, l]));
  const scheduleRowById = new Map(
    loans.flatMap((l) => l.rows.map((r) => [r._id, r] as const)),
  );

  const approvedTotal = loans.reduce((s, l) => s + l.loan.principal, 0);
  const disbursedTotal = loans
    .filter((l) => l.loan.disbursedAt)
    .reduce((s, l) => s + l.loan.principal, 0);
  const chargesTotal = loans.reduce((s, l) => s + l.loan.charges, 0);
  const openRows = loans
    .flatMap((l) => l.rows)
    .filter((r) => r.paid < r.totalDue);
  const overdueRows = openRows.filter((r) => r.dueDate < now);
  const nextOpen =
    [...openRows].filter((r) => r.dueDate >= now).sort((a, b) => a.dueDate - b.dueDate)[0] ??
    null;
  const scheduledPrincipalRemaining = openRows.reduce((s, r) => s + r.principal, 0);
  const scheduledInterestRemaining = openRows.reduce((s, r) => s + r.interest, 0);
  const overdueAmount = overdueRows.reduce((s, r) => s + (r.totalDue - r.paid), 0);
  const round = (n: number) => Math.round(n * 100) / 100;

  const coDocs = documents.filter((d) => d.coApplicant);

  /* -------------------------------- render -------------------------------- */

  return (
    <div className="space-y-4 pb-10">
      <div className="mb-4 flex items-start gap-3">
        <Button
          variant="outline"
          size="icon-sm"
          className="mt-0.5 shrink-0 print:hidden"
          aria-label="Back to reports"
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-black leading-tight tracking-tight">
            Client report — {client.name}
          </h1>
          <p className="truncate text-xs font-semibold text-muted-foreground">
            {client.code} · generated {formatDateTime(now)}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-0.5 shrink-0 print:hidden"
          onClick={() => window.print()}
        >
          <Printer className="size-4" /> Print
        </Button>
      </div>

      {/* A · CLIENT PROFILE */}
      <Panel title="A · Client profile">
        <KeyValue k="Client ID" v={<span className="font-mono">{client.code}</span>} />
        <KeyValue k="Full name" v={client.name} />
        <KeyValue k="Registered mobile" v={<span className="font-mono">{client.mobile}</span>} />
        <KeyValue k="Address" v={client.address ?? NA} />
        <KeyValue
          k="KYC status"
          v={<StatusChip status={client.kycStatus} label={client.kycStatus.replace(/_/g, " ")} />}
        />
        <KeyValue k="Registration date" v={formatDateTime(client.createdAt)} />
        <KeyValue
          k="Current status"
          v={<StatusChip status={client.status} label={client.status} />}
        />
        <KeyValue
          k="Assigned field staff"
          v={
            assignedStaff
              ? `${assignedStaff.name} (${assignedStaff.staffId})`
              : NA
          }
        />
        <KeyValue k="Branch" v={branch?.name ?? NA} />
        <KeyValue k="Branch manager" v={branchManager?.name ?? NA} />
        {coApplicantPhotoUrl && (
          <img
            src={coApplicantPhotoUrl}
            alt={`Applicant ${client.name} co-applicant`}
            className="mt-2 w-24 border-2 border-ink object-cover"
          />
        )}
        {coDocs.length > 0 && (
          <div className="mt-3 space-y-1">
            <div className="text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">
              Co-applicant documents ({coDocs.length})
            </div>
            {coDocs.map((d) => (
              <div
                key={d._id}
                className="flex items-center justify-between gap-2 border border-ink bg-white px-2 py-1"
              >
                <span className="min-w-0 flex-1 truncate text-[11px] font-bold">
                  {(d.docKind ?? d.type).replace(/_/g, " ")} · {d.fileName}
                </span>
                {d.url && (
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 border border-ink bg-gold px-1.5 py-0.5 text-[10px] font-black uppercase"
                  >
                    View
                  </a>
                )}
                <StatusChip status={d.status} className="shrink-0" />
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* B · REGISTRATION & ASSIGNMENT HISTORY */}
      <Panel title="B · Registration & assignment history">
        <KeyValue k="Created on" v={formatDateTime(client.createdAt)} />
        <KeyValue
          k="Created by"
          v={
            createdBy
              ? `${createdBy.name} (${createdBy.staffId})`
              : NA
          }
        />
        <KeyValue
          k="Currently assigned to"
          v={
            assignedStaff
              ? `${assignedStaff.name} (${assignedStaff.staffId})`
              : NA
          }
        />
        <KeyValue k="Assigned branch manager" v={branchManager?.name ?? NA} />
        {staffHistory.length === 0 ? (
          <p className="mt-2 text-xs font-semibold text-muted-foreground">
            No assignment changes recorded.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <TH>Date</TH>
                  <TH>From</TH>
                  <TH>To</TH>
                  <TH>Recorded by</TH>
                  <TH>Reason</TH>
                </tr>
              </thead>
              <tbody>
                {staffHistory.map((h) => (
                  <tr key={h._id}>
                    <TD mono>{formatDateTime(h.createdAt)}</TD>
                    <TD>{h.fromName ?? "—"}</TD>
                    <TD>{h.toName ?? "—"}</TD>
                    <TD>{h.createdByName ?? "—"}</TD>
                    <TD>{h.reason ?? "—"}</TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] font-semibold text-muted-foreground">
          The staff member who created a record and the staff member who
          disbursed or collected against a loan are shown separately in the
          sections below — each is attributed only from the field the database
          records.
        </p>
      </Panel>

      {/* C · LOAN DETAILS */}
      <Panel title={`C · Loan details (${loans.length})`}>
        {loans.length === 0 ? (
          <EmptyState title="No loans recorded" hint="This client has no loan records yet." />
        ) : (
          <div className="space-y-4">
            {loans.map(({ loan, rows, staffName, approvedByName, disbursedByName, branchName, branchManagerName, productName }) => {
              const app = appByLoan.get(loan._id);
              return (
                <div key={loan._id} className="border-2 border-ink bg-white p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-black">{loan.loanId}</span>
                    <StatusChip status={loan.status} label={loan.status} />
                  </div>
                  <KeyValue
                    k="Application date"
                    v={formatDate(app?.createdAt ?? loan.createdAt)}
                  />
                  <KeyValue
                    k="Requested amount"
                    v={app ? <Money value={app.amount} /> : NA}
                  />
                  <KeyValue k="Approval date" v={loan.approvedAt ? formatDate(loan.approvedAt) : "Not approved in recorded data"} />
                  <KeyValue k="Approved amount" v={<Money value={loan.principal} />} />
                  <KeyValue
                    k="Disbursed amount"
                    v={
                      loan.disbursedAt ? (
                        <Money value={loan.principal} />
                      ) : (
                        "Not yet disbursed"
                      )
                    }
                  />
                  <KeyValue k="Loan product" v={productName ?? NA} />
                  <KeyValue
                    k="Purpose (application)"
                    v={client.loanRequest?.purpose?.replace(/_/g, " ") ?? NA}
                  />
                  <KeyValue k="Tenure" v={`${loan.tenure} months`} />
                  <KeyValue k="Repayment frequency" v={loan.frequency} />
                  <KeyValue k="Interest" v={`${loan.interestRate}% · ${loan.interestMethod} · ₹${loan.interestTotal.toLocaleString("en-IN")}`} />
                  <KeyValue k="Field staff on loan" v={staffName ?? NA} />
                  <KeyValue k="Approved by" v={approvedByName ?? NA} />
                  <KeyValue k="Disbursed by" v={disbursedByName ?? NA} />
                  <KeyValue k="Branch" v={branchName ?? NA} />
                  <KeyValue k="Branch manager" v={branchManagerName ?? NA} />
                  <KeyValue k="Disbursement date" v={loan.disbursedAt ? formatDateTime(loan.disbursedAt) : "—"} />
                  <KeyValue k="Outstanding balance" v={<Money value={loan.outstanding} />} />

                  {/* D · instalment / repayment schedule for this loan */}
                  <div className="mt-3">
                    <div className="mb-1 text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">
                      D · Instalment schedule ({rows.length} rows)
                    </div>
                    {rows.length === 0 ? (
                      <p className="text-xs font-semibold text-muted-foreground">
                        No repayment schedule recorded for this loan.
                      </p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse">
                          <thead>
                            <tr>
                              <TH>#</TH>
                              <TH>Due date</TH>
                              <TH>Principal</TH>
                              <TH>Interest</TH>
                              <TH>Total due</TH>
                              <TH>Paid</TH>
                              <TH>Remaining</TH>
                              <TH>Status</TH>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r._id}>
                                <TD mono>{r.index}</TD>
                                <TD mono>
                                  {formatDate(r.dueDate)}
                                  {r.paid < r.totalDue && r.dueDate < now && (
                                    <span className="ml-1 text-destructive">⚠</span>
                                  )}
                                </TD>
                                <TD mono>{r.principal.toLocaleString("en-IN")}</TD>
                                <TD mono>{r.interest.toLocaleString("en-IN")}</TD>
                                <TD mono>{r.totalDue.toLocaleString("en-IN")}</TD>
                                <TD mono>{r.paid.toLocaleString("en-IN")}</TD>
                                <TD mono>{(r.totalDue - r.paid).toLocaleString("en-IN")}</TD>
                                <TD>
                                  <StatusChip status={r.status} label={r.status} />
                                </TD>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                      ⚠ marks an unpaid instalment past its recorded due date.
                      Weekly loans show the exact stored weekly dates above —
                      no schedule is assumed.
                    </p>
                  </div>

                  {/* Loan transaction history */}
                  <div className="mt-3">
                    <div className="mb-1 text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">
                      Loan transaction history
                    </div>
                    {(() => {
                      const own = payments.filter((p) => p.loanId === loan._id);
                      if (own.length === 0) {
                        return (
                          <p className="text-xs font-semibold text-muted-foreground">
                            No repayments recorded against this loan.
                          </p>
                        );
                      }
                      return (
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse">
                            <thead>
                              <tr>
                                <TH>Date</TH>
                                <TH>Receipt</TH>
                                <TH>Amount</TH>
                                <TH>Mode</TH>
                                <TH>Collected by</TH>
                                <TH>Status</TH>
                              </tr>
                            </thead>
                            <tbody>
                              {own.map((p) => (
                                <tr key={p._id}>
                                  <TD mono>{formatDateTime(p.createdAt)}</TD>
                                  <TD mono>{p.receiptNumber ?? p.code}</TD>
                                  <TD mono>{p.amount.toLocaleString("en-IN")}</TD>
                                  <TD>{p.mode}</TD>
                                  <TD>{p.staffName ?? "—"}</TD>
                                  <TD>
                                    <StatusChip status={p.status} label={p.status} />
                                  </TD>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* E · REPAYMENT HISTORY (all loans) */}
      <Panel title={`E · Repayment history (${payments.length})`}>
        {payments.length === 0 ? (
          <EmptyState title="No repayments recorded" hint="No collection entries exist for this client." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <TH>Date & time</TH>
                  <TH>Receipt / txn</TH>
                  <TH>Loan</TH>
                  <TH>Instalment</TH>
                  <TH>Amount</TH>
                  <TH>Mode</TH>
                  <TH>Collected by</TH>
                  <TH>Status</TH>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  const row = p.scheduleId ? scheduleRowById.get(p.scheduleId) : null;
                  const loan = loanByDbId.get(p.loanId);
                  return (
                    <tr key={p._id}>
                      <TD mono>{formatDateTime(p.createdAt)}</TD>
                      <TD mono>{p.receiptNumber ?? p.code}</TD>
                      <TD mono>{loan?.loan.loanId ?? "—"}</TD>
                      <TD mono>{row ? `#${row.index} · ${formatDate(row.dueDate)}` : NA}</TD>
                      <TD mono>{p.amount.toLocaleString("en-IN")}</TD>
                      <TD>{p.mode}</TD>
                      <TD>{p.staffName ?? "—"}</TD>
                      <TD>
                        <StatusChip status={p.status} label={p.status} />
                      </TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] font-semibold text-muted-foreground">
          Receipt IDs, dates, amounts, allocation and collection staff are
          shown exactly as recorded in the collections ledger; reversed
          entries keep their original record and show their status.
        </p>
      </Panel>

      {/* F · CURRENT LOAN POSITION */}
      <Panel title="F · Current loan position">
        <KeyValue k="Original approved amount (all loans)" v={<Money value={round(approvedTotal)} />} />
        <KeyValue k="Actual disbursed amount" v={<Money value={round(disbursedTotal)} />} />
        <KeyValue k="Total amount repaid" v={<Money value={totals.totalPaid} />} />
        <KeyValue k="Outstanding principal" v={<Money value={totals.outstanding} />} />
        <KeyValue
          k="Scheduled interest in unpaid instalments"
          v={<Money value={round(scheduledInterestRemaining)} />}
        />
        <KeyValue
          k="Scheduled principal in unpaid instalments"
          v={<Money value={round(scheduledPrincipalRemaining)} />}
        />
        <KeyValue k="Charges (recorded)" v={<Money value={round(chargesTotal)} />} />
        <KeyValue
          k="Remaining charges"
          v={<span className="text-xs text-muted-foreground">{NA}</span>}
        />
        <KeyValue k="Current outstanding balance" v={<Money value={totals.outstanding} />} />
        <KeyValue
          k="Next instalment due date"
          v={nextOpen ? formatDate(nextOpen.dueDate) : "No open instalment"}
        />
        <KeyValue
          k="Next instalment amount"
          v={nextOpen ? <Money value={round(nextOpen.totalDue - nextOpen.paid)} /> : "—"}
        />
        <KeyValue
          k="Total overdue amount"
          v={
            overdueAmount > 0 ? (
              <Money value={round(overdueAmount)} className="text-destructive" />
            ) : (
              "None"
            )
          }
        />
        <KeyValue
          k="Overdue instalments"
          v={`${overdueRows.length} of ${openRows.length} open`}
        />
        <KeyValue k="Active / closed loans" v={`${totals.activeLoans} / ${totals.closedLoans}`} />
        <p className="mt-2 text-[11px] font-semibold text-muted-foreground">
          Figures use the existing loan-accounting records (loan ledger,
          stored schedules and collections). No alternative calculation
          formula is applied here.
        </p>
      </Panel>

      <SectionTitle>End of report</SectionTitle>
    </div>
  );
}
