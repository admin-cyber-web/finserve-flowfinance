import { api } from "@/convex/_generated/api";
import {
  Money,
  PageHeader,
  RowSkeleton,
  StatCard,
} from "@/components/fs/primitives";
import { BranchCashPanel } from "@/components/fs/BranchCashPanel";
import { useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { ROLE_LABELS, type FsRole } from "@/lib/finance/types";
import { Banknote, Building2, Stamp, Users } from "lucide-react";
import { useNavigate } from "react-router";


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

  const { stats, pending } = dash;

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title={`Welcome, ${profile?.name?.split(" ")[0] ?? "there"}`}
        subtitle={`${ROLE_LABELS[((profile?.designationRole ?? profile?.role) ?? "SUPER_ADMIN") as FsRole]} · ${
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

      {/* Branch cash — ledger-derived counter balance, today and month */}
      <BranchCashPanel />

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
