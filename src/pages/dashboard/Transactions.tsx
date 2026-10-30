import { api } from "@/convex/_generated/api";
import {
  ConfirmDialog,
  EmptyState,
  Money,
  PageHeader,
  RowSkeleton,
  StatusChip,
  formatDateTime,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { WALLET_TX_LABELS, type WalletTxType } from "@/lib/finance/types";
import { cn, fmtId } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { IndianRupee, Undo2, Wallet } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

export default function Transactions() {
  const navigate = useNavigate();
  const { profile } = useProfile();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<"collections" | "wallet">(
    params.get("tab") === "wallet" ? "wallet" : "collections",
  );

  const collections = useQuery(api.collections.list, {
    limit: 100,
    includeReversals: true,
  });
  const walletTxns = useQuery(api.wallet.transactions, { limit: 100 });
  const reverse = useMutation(api.collections.reverse);

  const [reversing, setReversing] = useState<{ id: string; code: string } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const canReverse =
    profile?.role === "SUPER_ADMIN" || profile?.role === "BRANCH_MANAGER";

  const doReverse = async () => {
    if (!reversing || !reason.trim()) {
      toast.error("A reason is required — reversals are audit-logged.");
      return;
    }
    setBusy(true);
    try {
      await reverse({ collectionId: reversing.id as never, reason: reason.trim() });
      toast.success(`Reversed ${fmtId(reversing.code)} — compensating entry posted`);
      setReversing(null);
      setReason("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reversal failed");
    } finally {
      setBusy(false);
    }
  };

  const switchTab = (t: "collections" | "wallet") => {
    setTab(t);
    setParams(t === "wallet" ? { tab: "wallet" } : {});
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Activity" subtitle="Every rupee, every ledger entry" />

      <div className="flex gap-2">
        {(["collections", "wallet"] as const).map((t) => (
          <button
            key={t}
            onClick={() => switchTab(t)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 border-2 border-ink py-2.5 text-xs font-black uppercase",
              tab === t ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
            )}
          >
            {t === "collections" ? (
              <>
                <IndianRupee className="size-3.5" /> Payments
              </>
            ) : (
              <>
                <Wallet className="size-3.5" /> Wallet
              </>
            )}
          </button>
        ))}
      </div>

      {tab === "collections" ? (
        collections === undefined ? (
          <RowSkeleton rows={6} />
        ) : collections.length === 0 ? (
          <EmptyState
            title="No payments yet"
            hint="Collected payments appear here instantly with their receipt numbers."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {collections.map((c) => (
              <div
                key={c._id}
                className="border-2 border-ink bg-card p-3 shadow-hard-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-black">
                      <Money value={c.amount} />
                      <span className="ml-2 text-[11px] font-black uppercase text-muted-foreground">
                        {c.mode}
                      </span>
                    </p>
                    <p className="truncate text-[11px] font-semibold text-muted-foreground">
                      {c.clientName} ({fmtId(c.clientCode)}) · {fmtId(c.loanId)}
                    </p>
                    <p className="text-[11px] font-semibold text-muted-foreground">
                      {formatDateTime(c.createdAt)} · by {c.staffName}
                    </p>
                    {c.status !== "NORMAL" && c.remarks && (
                      <p className="mt-0.5 text-[11px] font-bold">{c.remarks}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <StatusChip status={c.status} />
                    {c.receiptNumber && c.status === "NORMAL" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => navigate(`/dashboard/receipts/${c.receiptNumber}`)}
                      >
                        Receipt
                      </Button>
                    )}
                    {canReverse && c.status === "NORMAL" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => setReversing({ id: c._id, code: c.code })}
                      >
                        <Undo2 className="size-3.5" /> Reverse
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ) : walletTxns === undefined ? (
        <RowSkeleton rows={6} />
      ) : walletTxns.length === 0 ? (
        <EmptyState
          title="No wallet entries"
          hint="Working-cash movements (issues, collections, handovers) post here."
          icon={<Wallet className="size-5" />}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {walletTxns.map((t) => {
            const credit = t.direction === "CREDIT";
            const neutral = t.direction === "NONE";
            return (
              <div
                key={t._id}
                className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2.5 shadow-hard-sm"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-black">
                    {WALLET_TX_LABELS[t.type as WalletTxType] ?? t.type.replace(/_/g, " ")}
                  </p>
                  <p className="truncate text-[11px] font-semibold text-muted-foreground">
                    {fmtId(t.referenceId ?? t.txnId)} · {t.staffName} · {formatDateTime(t.createdAt)}
                  </p>
                  {t.remarks && (
                    <p className="truncate text-[11px] font-semibold">{t.remarks}</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <Money
                    value={t.amount}
                    signed={!neutral}
                    className={cn(
                      "block text-base",
                      credit && "text-success",
                      !credit && !neutral && "text-destructive",
                    )}
                  />
                  <span className="text-[10px] font-black uppercase text-muted-foreground">
                    bal {t.balanceAfter.toLocaleString("en-IN")}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={reversing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setReversing(null);
            setReason("");
          }
        }}
        title="Reverse transaction"
        message={`${reversing?.code ?? ""} will NOT be deleted — a compensating reversal entry is appended and both stay visible in the audit trail.`}
        confirmLabel="Post reversal"
        tone="danger"
        loading={busy}
        onConfirm={() => void doReverse()}
      >
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required, audit-logged)"
          className="min-h-20 w-full border-2 border-ink bg-white px-3 py-2 text-sm font-semibold outline-none"
        />
      </ConfirmDialog>
    </div>
  );
}
