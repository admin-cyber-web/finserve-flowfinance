import { api } from "@/convex/_generated/api";
import {
  EmptyState,
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  formatDate,
  formatDateTime,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useQuery } from "convex/react";
import { FileText, HandCoins } from "lucide-react";
import { useNavigate } from "react-router";

export default function ClientHome() {
  const navigate = useNavigate();
  const loans = useQuery(api.loans.list, { limit: 20 });
  const payments = useQuery(api.collections.list, { limit: 20 });

  if (loans === undefined) {
    return (
      <div className="space-y-3">
        <PageHeader title="My loans" />
        <RowSkeleton rows={4} />
      </div>
    );
  }

  const active = loans.filter((l) => ["ACTIVE", "OVERDUE"].includes(l.view.displayStatus));
  const outstanding = active.reduce((s, l) => s + l.loan.outstanding, 0);
  const overdue = active.reduce((s, l) => s + l.view.overdueAmount, 0);

  return (
    <div className="space-y-5 pb-8">
      <PageHeader title="My loans" subtitle="Repayments, schedule and receipts" />

      <section className="border-2 border-ink bg-navy p-4 text-paper shadow-hard">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
              Outstanding
            </div>
            <Money value={outstanding} className="text-3xl" />
          </div>
          <div className="text-right">
            <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
              Overdue
            </div>
            <Money
              value={overdue}
              className={`text-lg ${overdue > 0 ? "text-blush" : "text-paper"}`}
            />
          </div>
        </div>
        <div className="mt-2 text-[11px] font-bold text-paper/70">
          {active.length} active loan(s) · {loans.length} total
        </div>
      </section>

      <section>
        <SectionTitle>My loans</SectionTitle>
        {loans.length === 0 ? (
          <EmptyState title="No loans yet" hint="Your loans will appear here once disbursed." />
        ) : (
          <div className="flex flex-col gap-2">
            {loans.map(({ loan, view }) => (
              <button
                key={loan._id}
                onClick={() => navigate(`/dashboard/loans/${loan._id}`)}
                className="w-full border-2 border-ink bg-card p-3 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-black">{loan.loanId}</span>
                  <StatusChip status={view.displayStatus} />
                </div>
                <div className="mt-1 flex items-end justify-between">
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    Next due {view.nextDueDate ? formatDate(view.nextDueDate) : "—"}
                  </span>
                  <Money value={loan.outstanding} className="text-base" />
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Recent payments</SectionTitle>
        {payments === undefined ? (
          <RowSkeleton rows={3} />
        ) : payments.length === 0 ? (
          <EmptyState title="No payments yet" icon={<HandCoins className="size-5" />} />
        ) : (
          <div className="flex flex-col gap-2">
            {payments.map((p) => (
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
                    {formatDateTime(p.createdAt)}
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
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
