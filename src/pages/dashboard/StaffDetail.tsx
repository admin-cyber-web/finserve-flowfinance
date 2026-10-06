import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  formatDateTime,
  timeAgo,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { ROLE_LABELS, WALLET_TX_LABELS, type FsRole, type WalletTxType } from "@/lib/finance/types";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

const inputCls =
  "h-11 w-full border-2 border-ink bg-white px-3 text-sm font-semibold outline-none";

export default function StaffDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, profile } = useProfile();
  const profileId = id as Id<"profiles">;
  const data = useQuery(api.profiles.staff360, { profileId });

  const setWalletLimit = useMutation(api.profiles.setWalletLimit);
  const setStatus = useMutation(api.profiles.setStatus);
  const adjustWallet = useMutation(api.wallet.adjust);

  const [limit, setLimit] = useState("");
  const [reason, setReason] = useState("");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjDir, setAdjDir] = useState<"CREDIT" | "DEBIT">("CREDIT");
  const [busy, setBusy] = useState(false);

  if (data === undefined) {
    return (
      <div className="space-y-3">
        <PageHeader title="Staff 360°" back="/dashboard/staff" />
        <RowSkeleton rows={6} />
      </div>
    );
  }

  const { profile: subject, branch, wallet, txns, loans, clients, performance, audit, handovers } =
    data;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const self = subject._id === profile?._id;

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title={subject.name}
        subtitle={`${subject.staffId} · ${ROLE_LABELS[subject.role as FsRole]} · ${branch?.name ?? "—"}`}
        back="/dashboard/staff"
        action={<StatusChip status={subject.status} />}
      />

      {/* Performance */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="border-2 border-ink bg-mint p-3 shadow-hard-sm">
          <div className="text-[10px] font-black uppercase text-muted-foreground">Collected</div>
          <Money value={performance.collected} className="text-lg" />
        </div>
        <div className="border-2 border-ink bg-sky p-3 shadow-hard-sm">
          <div className="text-[10px] font-black uppercase text-muted-foreground">Disbursed</div>
          <Money value={performance.disbursed} className="text-lg" />
        </div>
        <div className="border-2 border-ink bg-card p-3 shadow-hard-sm">
          <div className="text-[10px] font-black uppercase text-muted-foreground">
            Active loans
          </div>
          <div className="text-lg font-black">{performance.activeLoans}</div>
          <div className="text-[10px] font-bold text-destructive">
            {performance.overdueLoans} overdue
          </div>
        </div>
        <div className="border-2 border-ink bg-card p-3 shadow-hard-sm">
          <div className="text-[10px] font-black uppercase text-muted-foreground">Clients</div>
          <div className="text-lg font-black">{performance.activeClients}</div>
          <div className="text-[10px] font-bold text-muted-foreground">
            cash diff {performance.cashDifference.toLocaleString("en-IN")}
          </div>
        </div>
      </div>

      {/* Wallet */}
      <section className="border-2 border-ink bg-gold p-4 shadow-hard">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] font-black uppercase text-ink/70">
              Wallet balance (ledger-derived)
            </div>
            <Money value={wallet?.balance ?? 0} className="text-3xl" />
          </div>
          <div className="text-right">
            <div className="text-[10px] font-black uppercase text-ink/70">Limit</div>
            <Money value={wallet?.walletLimit ?? 0} className="text-lg" />
          </div>
        </div>
        {can("wallet_management") && wallet && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <input
              className={inputCls}
              inputMode="numeric"
              placeholder="New limit ₹"
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))}
            />
            <Button
              disabled={!Number(limit) || busy}
              onClick={() =>
                void run(async () => {
                  await setWalletLimit({ profileId, walletLimit: Number(limit) });
                  setLimit("");
                }, "Wallet limit updated")
              }
            >
              Set limit
            </Button>
          </div>
        )}
        {!wallet && (
          <p className="mt-2 text-[11px] font-bold">
            No wallet on this profile — wallets belong to field staff.
          </p>
        )}
      </section>

      {/* Approved adjustment */}
      {can("wallet_management") && wallet && (
        <section className="space-y-2 border-2 border-ink bg-card p-4 shadow-hard-sm">
          <SectionTitle>Approved adjustment</SectionTitle>
          <p className="text-[11px] font-semibold text-muted-foreground">
            The only way to move a wallet outside a business transaction — reason
            + actor are recorded, and the ledger entry is append-only.
          </p>
          <div className="grid grid-cols-[auto_1fr_auto] gap-2">
            <div className="flex">
              {(["CREDIT", "DEBIT"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setAdjDir(d)}
                  className={cn(
                    "border-2 border-ink px-2 text-[11px] font-black uppercase",
                    adjDir === d ? "bg-navy text-paper" : "bg-white",
                  )}
                >
                  {d === "CREDIT" ? "+" : "−"}
                </button>
              ))}
            </div>
            <input
              className={inputCls}
              inputMode="numeric"
              placeholder="Amount ₹"
              value={adjAmount}
              onChange={(e) => setAdjAmount(e.target.value.replace(/\D/g, ""))}
            />
            <Button
              disabled={!Number(adjAmount) || !reason.trim() || busy}
              onClick={() =>
                void run(async () => {
                  await adjustWallet({
                    profileId,
                    amount: Number(adjAmount),
                    direction: adjDir,
                    reason: reason.trim(),
                  });
                  setAdjAmount("");
                  setReason("");
                }, "Adjustment posted to wallet ledger")
              }
            >
              Post
            </Button>
          </div>
          <input
            className={inputCls}
            placeholder="Reason (required, audit-logged)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </section>
      )}

      {/* Status control */}
      {can("block_staff") && !self && (
        <section className="space-y-2 border-2 border-ink bg-blush p-4 shadow-hard-sm">
          <SectionTitle>Account status</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            {(["ACTIVE", "SUSPENDED", "BLOCKED"] as const).map((s) => (
              <Button
                key={s}
                variant={subject.status === s ? "default" : "outline"}
                size="sm"
                disabled={busy || subject.status === s}
                onClick={() =>
                  void run(
                    () =>
                      setStatus({
                        profileId,
                        status: s,
                        reason: `Status changed to ${s} from staff 360`,
                      }),
                    `Status set to ${s}`,
                  )
                }
              >
                {s}
              </Button>
            ))}
          </div>
          <p className="text-[11px] font-bold">
            Blocked accounts cannot sign in or collect. Every change is
            audit-logged with a reason.
          </p>
        </section>
      )}

      {/* Wallet ledger */}
      {txns.length > 0 && (
        <section>
          <SectionTitle>Wallet ledger (last {txns.length})</SectionTitle>
          <div className="flex flex-col gap-1.5">
            {txns.map((t) => (
              <div
                key={t._id}
                className="flex items-center justify-between gap-2 border-2 border-ink bg-card px-3 py-1.5 shadow-hard-sm"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-black">
                    {WALLET_TX_LABELS[t.type as WalletTxType] ?? t.type}
                  </p>
                  <p className="truncate text-[10px] font-semibold text-muted-foreground">
                    {t.referenceId ?? t.txnId} · {timeAgo(t.createdAt)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <Money
                    value={t.amount}
                    signed={t.direction !== "NONE"}
                    className={cn(
                      "text-sm",
                      t.direction === "CREDIT" && "text-success",
                      t.direction === "DEBIT" && "text-destructive",
                    )}
                  />
                  <p className="text-[10px] font-black text-muted-foreground">
                    bal {t.balanceAfter.toLocaleString("en-IN")}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Loans & clients */}
      <section>
        <SectionTitle>
          Book — {loans.length} loans · {clients.length} clients
        </SectionTitle>
        <div className="flex flex-col gap-1.5">
          {loans.slice(0, 8).map((l) => (
            <button
              key={l._id}
              onClick={() => navigate(`/dashboard/loans/${l._id}`)}
              className="flex items-center justify-between gap-2 border-2 border-ink bg-card px-3 py-1.5 text-left shadow-hard-sm"
            >
              <span className="font-mono text-xs font-black">{l.loanId}</span>
              <span className="flex items-center gap-2">
                <StatusChip status={l.status} />
                <Money value={l.outstanding} className="text-xs" />
              </span>
            </button>
          ))}
          {loans.length === 0 && (
            <p className="text-xs font-semibold text-muted-foreground">No loans yet.</p>
          )}
        </div>
      </section>

      {handovers.length > 0 && (
        <section>
          <SectionTitle>Cash handovers</SectionTitle>
          <div className="flex flex-col gap-1.5">
            {handovers.slice(0, 6).map((h) => (
              <div
                key={h._id}
                className="flex items-center justify-between gap-2 border-2 border-ink bg-card px-3 py-1.5 shadow-hard-sm"
              >
                <span className="font-mono text-xs font-black">{h.code}</span>
                <span className="flex items-center gap-2">
                  <StatusChip status={h.status} />
                  <Money value={h.amount} className="text-xs" />
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle>Recent audit trail</SectionTitle>
        <div className="flex flex-col gap-1.5">
          {audit.length === 0 && (
            <p className="text-xs font-semibold text-muted-foreground">No audit entries.</p>
          )}
          {audit.map((a) => (
            <div key={a._id} className="border-2 border-ink bg-card px-3 py-1.5 shadow-hard-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-black uppercase">{a.action}</span>
                <span className="text-[10px] font-black text-muted-foreground">
                  {formatDateTime(a.createdAt)}
                </span>
              </div>
              <p className="text-[11px] font-semibold text-muted-foreground">
                {a.entity}
                {a.entityId ? ` · ${a.entityId}` : ""}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
