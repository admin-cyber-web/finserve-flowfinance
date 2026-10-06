import { api } from "@/convex/_generated/api";
import {
  EmptyState,
  Money,
  PageHeader,
  RowSkeleton,
  StatusChip,
  formatDate,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { LOAN_STATUS_LABELS } from "@/lib/finance/types";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import { HandCoins, Plus, Search } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

const TABS = ["ALL", "ACTIVE", "OVERDUE", "APPROVED", "DISBURSED", "CLOSED"] as const;

export default function Loans() {
  const navigate = useNavigate();
  const { can } = useProfile();
  const [tab, setTab] = useState<(typeof TABS)[number]>("ALL");
  const [q, setQ] = useState("");

  const loans = useQuery(api.loans.list, {
    status: tab === "ALL" ? undefined : tab,
    search: q.trim() || undefined,
    limit: 200,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Loans"
        subtitle={`${loans?.length ?? 0} loans in view`}
        action={
          can("create_loan") ? (
            <Button size="sm" onClick={() => navigate("/dashboard/loans/new")}>
              <Plus /> New
            </Button>
          ) : undefined
        }
      />

      <div className="flex items-center border-2 border-ink bg-white shadow-hard-sm">
        <Search className="ml-3 size-4 shrink-0 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search loan ID or client"
          className="h-11 w-full bg-transparent px-3 text-sm font-bold outline-none"
        />
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "shrink-0 border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
              tab === t ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {loans === undefined ? (
        <RowSkeleton rows={5} />
      ) : loans.length === 0 ? (
        <EmptyState
          title="No loans here"
          hint="Loans appear once an application is approved and disbursed."
          icon={<HandCoins className="size-5" />}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {loans.map(({ loan, view, client, nextDue }) => (
            <button
              key={loan._id}
              onClick={() => navigate(`/dashboard/loans/${loan._id}`)}
              className="w-full border-2 border-ink bg-card p-3 text-left shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="block font-mono text-sm font-black">{loan.loanId}</span>
                  <span className="block truncate text-[11px] font-semibold text-muted-foreground">
                    {client?.name ?? "—"} · {client?.code ?? ""}
                  </span>
                </div>
                <StatusChip status={view.displayStatus} />
              </div>

              <div className="mt-2 h-3 border-2 border-ink bg-paper">
                <div
                  className={cn(
                    "h-full",
                    view.displayStatus === "OVERDUE" ? "bg-destructive" : "bg-mint",
                  )}
                  style={{ width: `${Math.max(2, view.progressPct)}%` }}
                />
              </div>

              <div className="mt-1.5 flex items-end justify-between gap-2">
                <span className="text-[10px] font-black uppercase text-muted-foreground">
                  {LOAN_STATUS_LABELS[view.displayStatus] ?? view.displayStatus} ·{" "}
                  {Math.round(view.progressPct)}% paid
                  {nextDue ? ` · next ${formatDate(nextDue.dueDate)}` : ""}
                </span>
                <span className="text-right">
                  <Money value={loan.outstanding} className="block text-sm" />
                  <span className="text-[10px] font-black uppercase text-muted-foreground">
                    of {view.displayStatus === "CLOSED" ? "closed" : "due"}
                  </span>
                </span>
              </div>
              {view.overdueAmount > 0 && (
                <div className="mt-1.5 border-2 border-ink bg-blush px-2 py-1 text-[10px] font-black uppercase">
                  {view.overdueDays}d overdue · {view.overdueAmount.toLocaleString("en-IN")} due
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
