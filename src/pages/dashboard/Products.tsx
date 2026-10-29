import {
  EmptyState,
  KeyValue,
  Money,
  PageHeader,
  RowSkeleton,
  StatusChip,
  formatDate,
} from "@/components/fs/primitives";
import { api } from "@/convex/_generated/api";
import { useProfile } from "@/hooks/use-profile";
import { useQuery } from "convex/react";
import { Package } from "lucide-react";

export default function Products() {
  const { profile, loading } = useProfile();
  // Loan Products is a Branch Manager / SUPER_ADMIN section. The backend
  // query enforces the same roles — this guard only renders a clean notice
  // instead of firing a request that would be refused.
  const allowed =
    profile?.role === "BRANCH_MANAGER" || profile?.role === "SUPER_ADMIN";
  const catalog = useQuery(
    api.loans.productSchedules,
    allowed ? {} : "skip",
  );

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Loan products"
        subtitle="Three standard products — terms fixed in the backend"
      />

      {loading ? (
        <RowSkeleton rows={3} />
      ) : !allowed ? (
        <EmptyState
          title="Restricted section"
          hint="Loan products are visible to Branch Managers and the Super Admin only."
          icon={<Package className="size-5" />}
        />
      ) : catalog === undefined ? (
        <RowSkeleton rows={3} />
      ) : catalog.length === 0 ? (
        <EmptyState
          title="No products configured"
          hint="Loan products define interest, tenure and policy limits."
          icon={<Package className="size-5" />}
        />
      ) : (
        <div className="space-y-4">
          {catalog.map(
            ({ product: p, principal, charges, netDisbursed, installment, totalInterest, totalPayable, schedule }) => (
              <section key={p._id} className="border-2 border-ink bg-card shadow-hard">
                <div className="flex items-center justify-between gap-2 border-b-2 border-ink bg-navy px-3 py-2 text-paper">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-black uppercase">{p.name}</div>
                    <div className="font-mono text-[10px] font-bold uppercase text-gold">
                      {p.code}
                    </div>
                  </div>
                  <StatusChip status={p.status} />
                </div>

                <div className="grid gap-x-4 p-3 sm:grid-cols-2">
                  <div>
                    <KeyValue k="Principal (fixed)" v={<Money value={principal} />} mono />
                    <KeyValue
                      k="Processing fee"
                      v={
                        <>
                          <Money value={charges} /> ·{" "}
                          {p.chargePercent > 0 && p.processingFee > 0
                            ? `${p.chargePercent}% of principal + ₹${p.processingFee} flat`
                            : p.chargePercent > 0
                              ? `${p.chargePercent}% of principal`
                              : "one-time, flat"}
                        </>
                      }
                    />
                    <KeyValue k="Net disbursed to client" v={<Money value={netDisbursed} />} mono />
                    <KeyValue
                      k="Interest"
                      v={`${p.interestRate}% p.a. · ${p.interestMethod.toLowerCase()} balance`}
                    />
                  </div>
                  <div>
                    <KeyValue
                      k="Repayment"
                      v={`${p.tenure} × ${p.frequency.toLowerCase()} installments`}
                    />
                    <KeyValue k="Installment" v={<Money value={installment} />} mono />
                    <KeyValue k="Total interest" v={<Money value={totalInterest} />} mono />
                    <KeyValue k="Total payable" v={<Money value={totalPayable} />} mono />
                    <KeyValue k="Grace days" v={String(p.graceDays)} />
                    <KeyValue k="Max obligation" v={`${p.maxObligationRatio}% of income`} />
                  </div>
                </div>

                {/* Installment schedule — computed by the backend engine. */}
                <div className="border-t-2 border-ink px-3 py-2">
                  <div className="mb-1 text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">
                    Installment schedule ({schedule.length} periods · reducing balance)
                  </div>
                  <div className="max-h-64 overflow-y-auto border-2 border-ink">
                    <table className="w-full border-collapse text-xs">
                      <thead className="sticky top-0 bg-muted">
                        <tr className="text-left text-[10px] font-black uppercase">
                          <th className="border-b-2 border-ink px-2 py-1">#</th>
                          <th className="border-b-2 border-ink px-2 py-1">Due</th>
                          <th className="border-b-2 border-ink px-2 py-1 text-right">Principal</th>
                          <th className="border-b-2 border-ink px-2 py-1 text-right">Interest</th>
                          <th className="border-b-2 border-ink px-2 py-1 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {schedule.map((r) => (
                          <tr key={r.index} className="odd:bg-card even:bg-muted/40">
                            <td className="border-b border-ink/10 px-2 py-1 font-black">{r.index}</td>
                            <td className="border-b border-ink/10 px-2 py-1 whitespace-nowrap">
                              {formatDate(r.dueDate)}
                            </td>
                            <td className="border-b border-ink/10 px-2 py-1 text-right font-mono">
                              ₹{r.principal.toLocaleString("en-IN")}
                            </td>
                            <td className="border-b border-ink/10 px-2 py-1 text-right font-mono">
                              ₹{r.interest.toLocaleString("en-IN")}
                            </td>
                            <td className="border-b border-ink/10 px-2 py-1 text-right font-mono font-black">
                              ₹{r.totalDue.toLocaleString("en-IN")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            ),
          )}
        </div>
      )}

      <div className="border-2 border-ink bg-sky p-3 text-xs font-bold">
        Interest is computed on the reducing balance by the backend engine — the
        same calculation used for every installment, receipt, outstanding and
        statement. Principal, rate, fee and schedule are stored on the product
        and cannot be overridden from the UI.
      </div>
    </div>
  );
}
