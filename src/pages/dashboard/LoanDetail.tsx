import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ConfirmDialog,
  EmptyState,
  KeyValue,
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  formatDate,
  formatDateTime,
  timeAgo,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoanActions } from "@/components/fs/LoanActions";
import { useProfile } from "@/hooks/use-profile";
import { LOAN_STATUS_LABELS, RECOVERY_KINDS, RECOVERY_LABELS } from "@/lib/finance/types";
import { round2 } from "@/lib/finance/money";
import { rowOutstanding } from "@/lib/finance/schedule";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { FileText, HandCoins, IndianRupee, PhoneCall } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

export default function LoanDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, profile } = useProfile();
  const loanId = id as Id<"loans">;
  const data = useQuery(api.loans.get, { loanId });

  const disburse = useMutation(api.loans.disburse);
  const addRecovery = useMutation(api.loans.addRecovery);

  const [confirmDisburse, setConfirmDisburse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recKind, setRecKind] = useState<string>("VISIT");
  const [recNotes, setRecNotes] = useState("");
  const [recAmount, setRecAmount] = useState("");

  if (data === undefined) {
    return (
      <div className="space-y-3">
        <PageHeader title="Loan file" back="/dashboard/loans" />
        <RowSkeleton rows={6} />
      </div>
    );

  }

  const { loan, view, client, product, staff, rows, payments, recovery, journals } =
    data;

  void profile;
  const canDisburse = can("disburse_loan") && loan.status === "APPROVED";

  const onDisburse = async () => {
    setBusy(true);
    try {
      const result = await disburse({ loanId, device: navigator.userAgent.slice(0, 60) });
      setConfirmDisburse(false);
      toast.success(
        `Disbursed — ₹${result.walletDebit.toLocaleString("en-IN")} moved from staff wallet`,
      );
    } catch (err) {
      setConfirmDisburse(false);
      toast.error(err instanceof Error ? err.message : "Disbursement failed");
    } finally {
      setBusy(false);
    }
  };

  const onRecovery = async () => {
    setBusy(true);
    try {
      await addRecovery({
        loanId,
        kind: recKind,
        notes: recNotes.trim() || undefined,
        promisedAmount: recAmount ? Number(recAmount) : undefined,
      });
      setRecNotes("");
      setRecAmount("");
      toast.success("Recovery activity logged");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not log activity");
    } finally {
      setBusy(false);
    }
  };

  const paidRows = rows.filter((r) => r.paid >= r.totalDue).length;
  const openOutstanding = round2(
    rows.reduce((s, r) => s + rowOutstanding(r), 0),
  );
  const isClosureVisible =
    loan.closureKind !== undefined ||
    loan.closeDate !== undefined ||
    ["SURRENDERED", "SETTLED", "CLOSED"].includes(loan.status);

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title={loan.loanId}
        subtitle={`${client?.name ?? "—"} · ${product?.name ?? ""} · ${staff?.name ?? ""}`}
        back="/dashboard/loans"
        action={<StatusChip status={view.displayStatus} />}
      />

      {/* Summary */}
      <section className="border-2 border-ink bg-navy p-4 text-paper shadow-hard">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
              Outstanding
            </div>
            <Money value={loan.outstanding} className="text-3xl" />
          </div>
          <div className="text-right">
            <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
              Principal
            </div>
            <Money value={loan.principal} className="text-xl" />
          </div>
        </div>
        <div className="mt-3 h-4 border-2 border-ink bg-paper">
          <div
            className={cn("h-full", view.displayStatus === "OVERDUE" ? "bg-destructive" : "bg-mint")}
            style={{ width: `${Math.max(2, view.progressPct)}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] font-black uppercase text-paper/70">
          <span>
            {paidRows}/{rows.length} installments · {Math.round(view.progressPct)}% paid
          </span>
          <span>
            {view.overdueAmount > 0
              ? `${view.overdueDays}d overdue · ₹${view.overdueAmount.toLocaleString("en-IN")}`
              : view.nextDueDate
                ? `next due ${formatDate(view.nextDueDate)}`
                : "no open dues"}
          </span>
        </div>
      </section>

      {/* Actions */}
      <div className="grid grid-cols-2 gap-2">
        {canDisburse ? (
          <Button size="lg" onClick={() => setConfirmDisburse(true)}>
            <HandCoins /> Disburse loan
          </Button>
        ) : ["ACTIVE", "OVERDUE", "DISBURSED"].includes(view.displayStatus) &&
          can("collect_payment") ? (
          <Button
            size="lg"
            onClick={() => navigate(`/dashboard/collect?client=${loan.clientId}`)}
          >
            <IndianRupee /> Collect payment
          </Button>
        ) : null}
        <Button
          size="lg"
          variant="outline"
          onClick={() => navigate(`/dashboard/clients/${loan.clientId}`)}
        >
          Client 360°
        </Button>
      </div>

      {/* SUPER_ADMIN closure controls — enforced server-side as well. */}
      <LoanActions
        loan={loan}
        outstanding={openOutstanding}
        clientName={client?.name ?? undefined}
      />

      {/* Closure record — final amounts, waived dues and archive state. */}
      {isClosureVisible && (
        <section className="border-2 border-ink bg-sky/20 p-4 shadow-hard-sm">
          <SectionTitle>Closure record</SectionTitle>
          <KeyValue
            k="Status"
            v={LOAN_STATUS_LABELS[loan.status] ?? loan.status}
          />
          <KeyValue
            k="Closure type"
            v={
              loan.closureKind === "SURRENDER"
                ? "Surrendered before completion"
                : loan.closureKind === "SETTLEMENT"
                  ? "Closed by approved settlement"
                  : loan.closureKind === "CANCELLED"
                    ? "Cancelled before disbursement"
                    : loan.closureKind === "REPAYMENT"
                      ? "Fully repaid"
                      : "—"
            }
          />
          <KeyValue k="Closure date" v={formatDate(loan.closeDate)} />
          <KeyValue
            k="Final amount paid"
            v={<Money value={loan.paidTotal} />}
          />
          <KeyValue
            k="Amount waived (not cash)"
            v={<Money value={loan.waivedAmount ?? 0} />}
          />
          <KeyValue
            k="Remaining balance"
            v={<Money value={loan.status === "SURRENDERED" ? openOutstanding : loan.outstanding} />}
          />
          <KeyValue k="Reason" v={loan.closureReason ?? "—"} />
          <KeyValue
            k="Archived"
            v={loan.archivedAt ? formatDate(loan.archivedAt) : "Not archived"}
          />
        </section>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="border-2 border-ink bg-white p-2.5 shadow-hard-sm">
          <div className="text-[10px] font-black uppercase text-muted-foreground">Rate</div>
          <div className="text-sm font-black">
            {loan.interestRate}% {loan.interestMethod.toLowerCase()}
          </div>
        </div>
        <div className="border-2 border-ink bg-white p-2.5 shadow-hard-sm">
          <div className="text-[10px] font-black uppercase text-muted-foreground">Frequency</div>
          <div className="text-sm font-black">{loan.frequency}</div>
        </div>
        <div className="border-2 border-ink bg-white p-2.5 shadow-hard-sm">
          <div className="text-[10px] font-black uppercase text-muted-foreground">Installment</div>
          <Money value={loan.installment} className="text-sm" />
        </div>
        <div className="border-2 border-ink bg-white p-2.5 shadow-hard-sm">
          <div className="text-[10px] font-black uppercase text-muted-foreground">Charges</div>
          <Money value={loan.charges} className="text-sm" />
        </div>
      </div>

      <Tabs defaultValue="schedule">
        <TabsList className="h-auto w-full border-2 border-ink bg-white p-1">
          <TabsTrigger value="schedule" className="flex-1 text-xs font-black uppercase">
            Schedule
          </TabsTrigger>
          <TabsTrigger value="payments" className="flex-1 text-xs font-black uppercase">
            Payments ({payments.length})
          </TabsTrigger>
          <TabsTrigger value="recovery" className="flex-1 text-xs font-black uppercase">
            Recovery ({recovery.length})
          </TabsTrigger>
          <TabsTrigger value="books" className="flex-1 text-xs font-black uppercase">
            Books
          </TabsTrigger>
        </TabsList>

        {/* SCHEDULE */}
        <TabsContent value="schedule" className="mt-4">
          {rows.length === 0 ? (
            <EmptyState
              title="No schedule yet"
              hint="The repayment schedule is generated the moment the loan is disbursed."
            />
          ) : (
            <div className="overflow-x-auto border-2 border-ink bg-card shadow-hard-sm">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b-2 border-ink bg-gold text-[10px] font-black uppercase">
                    <th className="px-2 py-2">#</th>
                    <th className="px-2 py-2">Due date</th>
                    <th className="px-2 py-2 text-right">Principal</th>
                    <th className="px-2 py-2 text-right">Interest</th>
                    <th className="px-2 py-2 text-right">Total</th>
                    <th className="px-2 py-2 text-right">Paid</th>
                    <th className="px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const open = rowOutstanding(r) > 0;
                    const overdue = open && r.dueDate < Date.now();
                    return (
                      <tr
                        key={r._id}
                        className={cn(
                          "border-b border-ink/15 last:border-0",
                          overdue && "bg-blush/60",
                        )}
                      >
                        <td className="px-2 py-1.5 font-mono font-black">{r.index}</td>
                        <td className="px-2 py-1.5 font-semibold">{formatDate(r.dueDate)}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                          ₹{r.principal.toLocaleString("en-IN")}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                          ₹{r.interest.toLocaleString("en-IN")}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono font-black tabular-nums">
                          ₹{r.totalDue.toLocaleString("en-IN")}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                          ₹{r.paid.toLocaleString("en-IN")}
                          {(r.waived ?? 0) > 0 && (
                            <span className="block text-[10px] font-black uppercase text-destructive">
                              waived ₹{(r.waived ?? 0).toLocaleString("en-IN")}
                            </span>
                          )}
                          {open && (
                            <span className="block text-[10px] font-semibold text-muted-foreground">
                              bal ₹{rowOutstanding(r).toLocaleString("en-IN")}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <StatusChip status={r.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* PAYMENTS */}
        <TabsContent value="payments" className="mt-4 space-y-2">
          {payments.length === 0 ? (
            <EmptyState title="No payments yet" icon={<IndianRupee className="size-5" />} />
          ) : (
            payments.map((p) => (
              <div
                key={p._id}
                className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
              >
                <div className="min-w-0">
                  <p className="text-sm font-black">
                    <Money value={p.amount} />
                    <span className="ml-2 text-[11px] uppercase text-muted-foreground">
                      {p.mode}
                    </span>
                  </p>
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    {p.receiptNumber ?? p.code} · principal ₹
                    {p.principalPortion.toLocaleString("en-IN")} + interest ₹
                    {p.interestPortion.toLocaleString("en-IN")} · {formatDateTime(p.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusChip status={p.status} />
                  {p.receiptNumber && p.status === "NORMAL" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => navigate(`/dashboard/receipts/${p.receiptNumber}`)}
                    >
                      <FileText className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </TabsContent>

        {/* RECOVERY */}
        <TabsContent value="recovery" className="mt-4 space-y-3">
          {can("collect_payment") && (
            <section className="space-y-2 border-2 border-ink bg-card p-3 shadow-hard-sm">
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={recKind}
                  onChange={(e) => setRecKind(e.target.value)}
                  className="h-11 border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
                >
                  {RECOVERY_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {RECOVERY_LABELS[k]}
                    </option>
                  ))}
                </select>
                <input
                  value={recAmount}
                  onChange={(e) => setRecAmount(e.target.value.replace(/\D/g, ""))}
                  placeholder="Promised ₹"
                  inputMode="numeric"
                  className="h-11 border-2 border-ink bg-white px-2 text-sm font-semibold outline-none"
                />
              </div>
              <textarea
                value={recNotes}
                onChange={(e) => setRecNotes(e.target.value)}
                placeholder="What happened on this follow-up?"
                className="min-h-16 w-full border-2 border-ink bg-white px-3 py-2 text-sm font-semibold outline-none"
              />
              <Button
                size="sm"
                className="w-full"
                disabled={busy || (!recNotes.trim() && !recAmount)}
                onClick={() => void onRecovery()}
              >
                <PhoneCall className="size-4" /> Log activity
              </Button>
            </section>
          )}
          {recovery.length === 0 ? (
            <EmptyState title="No recovery activities" hint="Log visits, calls and promises to pay here." />
          ) : (
            recovery.map((r) => (
              <div key={r._id} className="border-2 border-ink bg-card px-3 py-2 shadow-hard-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black uppercase">
                    {RECOVERY_LABELS[r.kind as keyof typeof RECOVERY_LABELS] ?? r.kind}
                  </span>
                  <span className="text-[10px] font-black uppercase text-muted-foreground">
                    {timeAgo(r.createdAt)}
                  </span>
                </div>
                {r.promisedAmount !== undefined && (
                  <p className="text-[11px] font-black">
                    Promised <Money value={r.promisedAmount} />
                    {r.promisedDate ? ` by ${formatDate(r.promisedDate)}` : ""}
                  </p>
                )}
                {r.notes && <p className="text-[11px] font-semibold">{r.notes}</p>}
              </div>
            ))
          )}
        </TabsContent>

        {/* BOOKS */}
        <TabsContent value="books" className="mt-4 space-y-4">
          <section className="border-2 border-ink bg-card p-4 shadow-hard-sm">
            <KeyValue k="Loan ID" v={<span className="font-mono">{loan.loanId}</span>} mono />
            <KeyValue k="Status" v={LOAN_STATUS_LABELS[loan.status] ?? loan.status} />
            <KeyValue k="Total payable" v={<Money value={loan.totalPayable} />} />
            <KeyValue k="Paid to date" v={<Money value={loan.paidTotal} />} />
            <KeyValue k="Interest booked" v={<Money value={loan.interestTotal} />} />
            <KeyValue k="Disbursed" v={formatDate(loan.disbursedAt)} />
            <KeyValue k="Approved by" v={staff?.name ?? "—"} />
            <KeyValue k="Created" v={formatDate(loan.createdAt)} />
          </section>

          <section>
            <SectionTitle>Double-entry journal</SectionTitle>
            {journals.length === 0 ? (
              <EmptyState title="No journal entries" hint="Entries appear after disbursement and collections." />
            ) : (
              <div className="flex flex-col gap-2">
                {journals.map((j) => (
                  <div key={j._id} className="border-2 border-ink bg-card p-3 shadow-hard-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-black">{j.entryId}</span>
                      <span className="text-[10px] font-black uppercase text-muted-foreground">
                        {formatDate(j.createdAt)}
                      </span>
                    </div>
                    <p className="text-[11px] font-semibold">{j.memo}</p>
                    <div className="mt-1 text-[11px] font-bold">
                      {j.lines.map((l, i) => (
                        <div key={i} className="flex justify-between border-b border-ink/10 py-0.5 last:border-0">
                          <span>
                            {l.code} {l.debit > 0 ? "· Dr" : "· Cr"}
                          </span>
                          <span className="font-mono tabular-nums">
                            Dr ₹{l.debit.toLocaleString("en-IN")} / Cr ₹
                            {l.credit.toLocaleString("en-IN")}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDisburse}
        onOpenChange={setConfirmDisburse}
        title="Disburse this loan?"
        message={`₹${loan.principal.toLocaleString("en-IN")} will move out of the assigned staff wallet, the repayment schedule will be generated, and a journal entry will be posted. This cannot be undone.`}
        confirmLabel="Disburse now"
        loading={busy}
        onConfirm={() => void onDisburse()}
      />

    </div>
  );
}
