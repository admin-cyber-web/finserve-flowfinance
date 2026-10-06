import { api } from "@/convex/_generated/api";
import {
  EmptyState,
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatCard,
  StatusChip,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { ROLE_LABELS, type FsRole } from "@/lib/finance/types";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Bell,
  Building2,
  Stamp,
  Users,
} from "lucide-react";
import { useNavigate } from "react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const TONE_BG: Record<string, string> = {
  bad: "bg-blush",
  warn: "bg-gold",
  info: "bg-sky",
};

export default function AdminHome() {
  const navigate = useNavigate();
  const { profile } = useProfile();
  const dash = useQuery(api.admin.dashboard, {});

  if (dash === undefined) {
    return (
      <div className="space-y-3">
        <PageHeader title="Dashboard" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="h-24 animate-pulse-block border-2 border-ink bg-muted" />
          <div className="h-24 animate-pulse-block border-2 border-ink bg-muted" />
          <div className="h-24 animate-pulse-block border-2 border-ink bg-muted" />
          <div className="h-24 animate-pulse-block border-2 border-ink bg-muted" />
        </div>
        <RowSkeleton rows={4} />
      </div>
    );
  }

  const { stats, trends, alerts, pending, branchPerformance, staffPerformance } = dash;
  const trendData = trends.collectionTrend.map((c, i) => ({
    label: c.label,
    collected: c.amount,
    disbursed: trends.disbursementTrend[i]?.amount ?? 0,
  }));

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title={`Welcome, ${profile?.name?.split(" ")[0] ?? "there"}`}
        subtitle={`${ROLE_LABELS[(profile?.role ?? "SUPER_ADMIN") as FsRole]} · ${
          profile?.branch?.name ?? "Organisation-wide"
        } · ${new Date().toLocaleDateString("en-IN", {
          weekday: "long",
          day: "2-digit",
          month: "long",
        })}`}
      />

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard
          label="Portfolio outstanding"
          value={<Money value={stats.portfolio} />}
          sub={`${stats.activeLoans} active loans`}
          tone="info"
        />
        <StatCard
          label="Collected today"
          value={<Money value={stats.todayCollection} />}
          sub={`Disbursed ${format(stats.todayDisbursement)}`}
          tone="ok"
        />
        <StatCard
          label="Overdue"
          value={<Money value={stats.overdue} />}
          sub={`${stats.overdueLoans} loans past due`}
          tone={stats.overdue > 0 ? "bad" : "idle"}
          onClick={() => navigate("/dashboard/overdue")}
        />
        <StatCard
          label="Active clients"
          value={String(stats.activeClients)}
          sub={`${stats.totalStaff} staff`}
          tone="idle"
          onClick={() => navigate("/dashboard/clients")}
        />
        <StatCard
          label="Cash with staff"
          value={<Money value={stats.cashWithStaff} />}
          sub="Wallets (ledger)"
          tone="warn"
          onClick={() => navigate("/dashboard/staff")}
        />
        <StatCard
          label="Branch cash"
          value={<Money value={stats.cashWithBM} />}
          sub={`Bank ${format(stats.bankBalance)}`}
          tone="idle"
          onClick={() => navigate("/dashboard/accounting")}
        />
        <StatCard
          label="Pending approvals"
          value={String(pending.total)}
          sub={`${pending.loans} loans · ${pending.handovers} handovers`}
          tone={pending.total > 0 ? "warn" : "ok"}
          onClick={() => navigate("/dashboard/approvals")}
        />
        <StatCard
          label="Today disbursed"
          value={<Money value={stats.todayDisbursement} />}
          sub="From wallets"
          tone="info"
        />
      </div>

      {/* Charts */}
      <section className="border-2 border-ink bg-card p-4 shadow-hard">
        <SectionTitle
          action={
            <span className="text-[10px] font-black uppercase text-muted-foreground">
              Last 14 days
            </span>
          }
        >
          Collections vs disbursements
        </SectionTitle>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trendData} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.15)" />
              <XAxis dataKey="label" tick={{ fontSize: 9, fontWeight: 800 }} />
              <YAxis tick={{ fontSize: 9, fontWeight: 800 }} />
              <Tooltip
                cursor={{ fill: "rgba(0,0,0,0.06)" }}
                contentStyle={{
                  borderRadius: 0,
                  border: "2px solid #000",
                  boxShadow: "4px 4px 0 #000",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              />
              <Bar dataKey="collected" name="Collected" fill="var(--color-royal)" />
              <Bar dataKey="disbursed" name="Disbursed" fill="var(--color-gold)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-1 flex gap-3 text-[10px] font-black uppercase">
          <span className="flex items-center gap-1">
            <span className="size-3 border-2 border-ink bg-royal" /> Collected
          </span>
          <span className="flex items-center gap-1">
            <span className="size-3 border-2 border-ink bg-gold" /> Disbursed
          </span>
        </div>
      </section>

      <section className="border-2 border-ink bg-card p-4 shadow-hard">
        <SectionTitle>Outstanding portfolio trend</SectionTitle>
        <div className="h-44 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trends.portfolioTrend} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.15)" />
              <XAxis dataKey="label" tick={{ fontSize: 9, fontWeight: 800 }} />
              <YAxis tick={{ fontSize: 9, fontWeight: 800 }} />
              <Tooltip
                contentStyle={{
                  borderRadius: 0,
                  border: "2px solid #000",
                  boxShadow: "4px 4px 0 #000",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              />
              <Line
                type="monotone"
                dataKey="amount"
                name="Outstanding"
                stroke="var(--color-navy)"
                strokeWidth={3}
                dot={{ r: 3, fill: "var(--color-gold)", stroke: "#000", strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Alerts */}
      <section>
        <SectionTitle
          action={
            <button
              onClick={() => navigate("/dashboard/approvals")}
              className="border-2 border-ink bg-white px-2 py-0.5 text-[10px] font-black uppercase shadow-hard-sm"
            >
              Approve →
            </button>
          }
        >
          Alerts
        </SectionTitle>
        {alerts.length === 0 ? (
          <EmptyState title="All clear" hint="No pending issues right now." icon={<Bell className="size-5" />} />
        ) : (
          <div className="flex flex-col gap-2">
            {alerts.map((a, i) => (
              <button
                key={i}
                onClick={() => a.link && navigate(a.link)}
                className={cn(
                  "flex items-start gap-3 border-2 border-ink p-3 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
                  TONE_BG[a.tone] ?? "bg-card",
                )}
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-black">{a.title}</span>
                  <span className="block text-[11px] font-semibold">{a.body}</span>
                </span>
                <ArrowRight className="mt-1 size-4 shrink-0" />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Branch performance */}
      {branchPerformance.length > 0 && (
        <section>
          <SectionTitle>Branch performance</SectionTitle>
          <div className="overflow-x-auto border-2 border-ink bg-card shadow-hard-sm">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b-2 border-ink bg-navy text-[10px] font-black uppercase text-paper">
                  <th className="px-2 py-2">Branch</th>
                  <th className="px-2 py-2 text-right">Portfolio</th>
                  <th className="px-2 py-2 text-right">Today</th>
                  <th className="px-2 py-2 text-right">Clients</th>
                  <th className="px-2 py-2 text-right">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {branchPerformance.map((b) => (
                  <tr key={b.branch._id} className="border-b border-ink/15 last:border-0">
                    <td className="px-2 py-2 font-black">{b.branch.name}</td>
                    <td className="px-2 py-2 text-right font-mono">
                      {format(b.portfolio)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {format(b.collectionToday)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">{b.clients}</td>
                    <td className="px-2 py-2 text-right font-mono text-destructive">
                      {format(b.overdue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Staff performance */}
      {staffPerformance.length > 0 && (
        <section>
          <SectionTitle>Staff performance today</SectionTitle>
          <div className="flex flex-col gap-2">
            {staffPerformance.map((s) => (
              <button
                key={s.profile._id}
                onClick={() => navigate(`/dashboard/staff/${s.profile._id}`)}
                className="flex items-center justify-between gap-3 border-2 border-ink bg-card p-3 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-black">
                    {s.profile.name}
                  </span>
                  <span className="block text-[11px] font-semibold text-muted-foreground">
                    {s.profile.staffId} · {s.activeClients} clients · {format(s.disbursed)} disbursed
                  </span>
                  <span className="mt-1 flex gap-1">
                    <StatusChip label={`${s.overdue} overdue`} tone={s.overdue ? "bad" : "ok"} />
                    {s.wallet && s.wallet.limit > 0 && (
                      <StatusChip
                        label={`Wallet ${Math.round((s.wallet.balance / s.wallet.limit) * 100)}%`}
                        tone={s.wallet.balance / s.wallet.limit <= 0.15 ? "warn" : "idle"}
                      />
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[10px] font-black uppercase text-muted-foreground">
                    Today
                  </span>
                  <Money value={s.collectedToday} className="block text-base" />
                  <span className="text-[10px] font-black uppercase text-muted-foreground">
                    {format(s.outstanding)} book
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Quick links */}
      <div className="grid grid-cols-3 gap-2">
        <Button variant="outline" size="lg" onClick={() => navigate("/dashboard/approvals")}>
          <Stamp className="size-4" /> Approvals
        </Button>
        <Button variant="outline" size="lg" onClick={() => navigate("/dashboard/clients")}>
          <Users className="size-4" /> Clients
        </Button>
        <Button variant="outline" size="lg" onClick={() => navigate("/dashboard/reports")}>
          <Building2 className="size-4" /> Reports
        </Button>
      </div>

      <div className="flex items-center gap-2 border-2 border-ink bg-gold p-3 text-xs font-black uppercase">
        <Banknote className="size-4 shrink-0" />
        Balances shown are derived from immutable ledgers — nothing is stored editable.
      </div>
    </div>
  );
}

function format(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}
