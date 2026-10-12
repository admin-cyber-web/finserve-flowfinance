import { api } from "@/convex/_generated/api";
import {
  EmptyState,
  Money,
  RowSkeleton,
  SectionTitle,
  StatCard,
  StatusChip,
  timeAgo,
} from "@/components/fs/primitives";
import { useProfile } from "@/hooks/use-profile";
import { formatINR } from "@/lib/finance/money";
import { WALLET_TX_LABELS } from "@/lib/finance/types";
import { useQuery } from "convex/react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  HandCoins,
  IndianRupee,
  LayoutList,
  Plus,
  TriangleAlert,
  UserPlus,
  Wallet,
} from "lucide-react";
import { useNavigate } from "react-router";

export default function StaffHome() {
  const { profile } = useProfile();
  const navigate = useNavigate();
  const wallet = useQuery(api.wallet.myWallet);
  const today = useQuery(api.collections.today, {});
  const handovers = useQuery(api.cash.handovers, { status: "REQUESTED" });

  if (wallet === undefined || today === undefined) {
    return (
      <div className="space-y-3">
        <div className="h-40 animate-pulse-block border-2 border-ink bg-navy" />
        <RowSkeleton rows={4} />
      </div>
    );
  }

  const low = wallet?.warning;
  const stats = today?.summary;

  const quick = [
    { label: "Collect", icon: IndianRupee, to: "/dashboard/collect", tone: "bg-mint" },
    { label: "Give loan", icon: Wallet, to: "/dashboard/loans/new", tone: "bg-gold" },
    { label: "Add client", icon: UserPlus, to: "/dashboard/clients/new", tone: "bg-sky" },
    { label: "Clients", icon: LayoutList, to: "/dashboard/clients", tone: "bg-white" },
  ];

  return (
    <div className="space-y-5">
      {/* Wallet card */}
      <section className="relative overflow-hidden border-2 border-ink bg-navy p-4 text-paper shadow-hard">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-black uppercase tracking-[0.18em] text-gold">
              Available wallet
            </div>
            <div className="mt-1 text-4xl font-black leading-none tracking-tight">
              <Money value={wallet?.balance ?? 0} />
            </div>
          </div>
          <button
            onClick={() => navigate("/dashboard/profile")}
            className="border-2 border-ink bg-gold px-2 py-1 text-[10px] font-black uppercase text-ink shadow-hard-sm"
          >
            Ledger
          </button>
        </div>

        <div className="mt-4 flex items-end justify-between text-xs font-bold">
          <span className="text-paper/70">
            Wallet limit <Money value={wallet?.limit ?? 0} className="text-paper" />
          </span>
          <span className="font-mono text-gold">
            {formatINR(wallet?.balance ?? 0)} / {formatINR(wallet?.limit ?? 0)}
          </span>
        </div>
        <div className="mt-1.5 h-4 border-2 border-ink bg-paper">
          <div
            className="h-full bg-gold"
            style={{
              width: `${Math.max(2, Math.min(100, wallet?.utilization ?? 0))}%`,
            }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] font-black uppercase tracking-wider text-paper/70">
          <span>{Math.round(wallet?.utilization ?? 0)}% utilised</span>
          <span>{low ? "⚠ Low balance" : "Healthy"}</span>
        </div>

        {low && (
          <div className="mt-3 flex items-center gap-2 border-2 border-ink bg-gold px-2 py-1.5 text-[11px] font-black uppercase text-ink">
            <TriangleAlert className="size-3.5" />
            Wallet running low — request working cash from BM
          </div>
        )}
      </section>

      {/* Quick actions */}
      <section className="grid grid-cols-4 gap-2">
        {quick.map((q) => (
          <button
            key={q.to}
            onClick={() => navigate(q.to)}
            className={`flex flex-col items-center gap-1.5 border-2 border-ink p-2.5 text-center shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none ${q.tone}`}
          >
            <span className="grid size-8 place-items-center border-2 border-ink bg-white">
              <q.icon className="size-4" />
            </span>
            <span className="text-[10px] font-black uppercase leading-tight">
              {q.label}
            </span>
          </button>
        ))}
      </section>

      {/* Today's numbers */}
      <section>
        <SectionTitle action={
          <button
            className="text-xs font-black uppercase text-royal underline"
            onClick={() => navigate("/dashboard/collect")}
          >
            Open board
          </button>
        }>
          Today
        </SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <StatCard
            label="Today's collection"
            value={<Money value={stats?.collected ?? 0} />}
            sub={`Expected ${formatINR(stats?.expected ?? 0)}`}
            tone="ok"
            onClick={() => navigate("/dashboard/collect")}
          />
          <StatCard
            label="Today's disbursement"
            value={<Money value={stats?.disbursementToday ?? 0} />}
            sub="Loans disbursed"
            tone="info"
            onClick={() => navigate("/dashboard/loans")}
          />
          <StatCard
            label="Due today"
            value={<Money value={stats?.pending ?? 0} />}
            sub={`${stats?.dueClients ?? 0} clients`}
            tone="warn"
            onClick={() => navigate("/dashboard/collect")}
          />
          <StatCard
            label="Overdue"
            value={<Money value={stats?.overdueAmount ?? 0} />}
            sub={`${stats?.overdueClients ?? 0} clients past due`}
            tone="bad"
            onClick={() => navigate("/dashboard/collect?tab=overdue")}
          />
        </div>
      </section>

      {/* Pending handover */}
      {(handovers?.length ?? 0) > 0 && (
        <button
          onClick={() => navigate("/dashboard/cash")}
          className="flex w-full items-center justify-between gap-3 border-2 border-ink bg-gold p-3 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
        >
          <span className="flex items-center gap-2 text-sm font-black uppercase">
            <HandCoins className="size-4" />
            {handovers!.length} cash handover pending
            <Money value={handovers![0].amount} />
          </span>
          <StatusChip label="Review" tone="bad" />
        </button>
      )}

      {/* Due clients preview */}
      <section>
        <SectionTitle
          action={
            <button
              className="text-xs font-black uppercase text-royal underline"
              onClick={() => navigate("/dashboard/collect")}
            >
              Collect all
            </button>
          }
        >
          Due now
        </SectionTitle>
        {(today?.due ?? []).length === 0 ? (
          <EmptyState
            title="No dues today"
            hint="All installments for today are cleared. Great work."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {today!.due.slice(0, 4).map((d) => (
              <button
                key={d.clientId}
                onClick={() =>
                  navigate(`/dashboard/collect?client=${d.clientId}`)
                }
                className="flex items-center justify-between gap-3 border-2 border-ink bg-card p-3 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-black">
                    {d.name}
                  </span>
                  <span className="block text-[11px] font-semibold text-muted-foreground">
                    {d.code} · {d.village}
                    {d.overdue > 0 && (
                      <span className="ml-1 font-black text-destructive">
                        · {formatINR(d.overdue)} overdue
                      </span>
                    )}
                  </span>
                </span>
                <span className="text-right">
                  <Money value={d.dueToday} className="block text-base" />
                  <span className="text-[10px] font-black uppercase text-muted-foreground">
                    due today
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Recent wallet activity */}
      <section>
        <SectionTitle
          action={
            <button
              className="text-xs font-black uppercase text-royal underline"
              onClick={() => navigate("/dashboard/transactions")}
            >
              See all
            </button>
          }
        >
          Recent transactions
        </SectionTitle>
        {(wallet?.txns ?? []).length === 0 ? (
          <EmptyState title="No transactions yet" hint="Your wallet ledger will appear here." />
        ) : (
          <div className="flex flex-col gap-2">
            {(wallet?.txns ?? []).slice(0, 6).map((t) => (
              <div
                key={t._id}
                className="flex items-center gap-3 border-2 border-ink bg-card p-3"
              >
                <span
                  className={`grid size-9 shrink-0 place-items-center border-2 border-ink ${
                    t.direction === "CREDIT"
                      ? "bg-mint"
                      : t.direction === "DEBIT"
                        ? "bg-blush"
                        : "bg-sky"
                  }`}
                >
                  {t.direction === "DEBIT" ? (
                    <ArrowUpRight className="size-4" />
                  ) : (
                    <ArrowDownLeft className="size-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-black">
                    {WALLET_TX_LABELS[t.type as keyof typeof WALLET_TX_LABELS] ?? t.type}
                  </span>
                  <span className="block truncate text-[11px] font-semibold text-muted-foreground">
                    {t.txnId} · {timeAgo(t.createdAt)}
                    {t.referenceId ? ` · ${t.referenceId}` : ""}
                  </span>
                </span>
                <span className="text-right">
                  <Money
                    value={t.direction === "DEBIT" ? -t.amount : t.amount}
                    signed={t.direction === "CREDIT"}
                    className="text-sm"
                  />
                  <span className="block font-mono text-[10px] font-bold text-muted-foreground">
                    bal {formatINR(t.balanceAfter)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Branch strip */}
      <button
        onClick={() => navigate("/dashboard/cash")}
        className="flex w-full items-center justify-between border-2 border-ink bg-card p-3 text-left shadow-hard-sm"
      >
        <span className="flex items-center gap-2 text-sm font-black uppercase">
          <Building2 className="size-4" /> Cash management
        </span>
        <span className="text-xs font-black text-royal">Day book →</span>
      </button>

      <p className="pb-2 text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {profile?.branch?.name} · KIRAT field app
      </p>
    </div>
  );
}
