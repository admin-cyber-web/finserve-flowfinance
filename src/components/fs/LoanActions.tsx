import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useProfile } from "@/hooks/use-profile";
import { round2 } from "@/lib/finance/money";
import { cn, fmtId } from "@/lib/utils";
import { useMutation } from "convex/react";
import { Archive, BadgeCheck, Handshake, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * SUPER_ADMIN loan closure controls (surrender / settle / close / archive /
 * delete). Rendered only for a SUPER_ADMIN session — and the backend
 * mutations behind every button re-verify the caller's real role, so hiding
 * this panel is never the security control.
 *
 * Every operation opens a confirmation dialog, shows the live financial
 * position, requires the mandatory reason where the workflow demands one,
 * and surfaces the server's verdict verbatim on failure.
 */

type Action = "surrender" | "settle" | "close" | "archive" | "delete";

/** Statuses that can still be surrendered or settled. */
const OPERABLE = ["DISBURSED", "ACTIVE", "OVERDUE"];
/** Statuses the Close workflow accepts (server verifies dues are cleared). */
const CLOSABLE = ["APPROVED", "DISBURSED", "ACTIVE", "OVERDUE", "SURRENDERED"];
/** Statuses eligible for archive / permanent delete. */
const RESOLVED = ["CLOSED", "SETTLED"];

const INPUT_CLS =
  "h-11 w-full border-2 border-ink bg-white px-3 text-sm font-semibold outline-none";
const LABEL_CLS =
  "block text-[10px] font-black uppercase tracking-wide text-muted-foreground";

function money(n: number): string {
  return `₹${round2(n).toLocaleString("en-IN")}`;
}

const CLOSURE_KIND_LABELS: Record<string, string> = {
  REPAYMENT: "Fully repaid",
  SURRENDER: "Surrendered before completion",
  SETTLEMENT: "Closed by approved settlement",
  CANCELLED: "Cancelled before disbursement",
};

export function LoanActions({
  loan,
  outstanding,
  clientName,
  compact = false,
}: {
  loan: Doc<"loans">;
  /** Exact open balance derived from the schedule rows, when available. */
  outstanding: number;
  clientName?: string;
  compact?: boolean;
}) {
  const { profile } = useProfile();
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [mode, setMode] = useState("CASH");
  const [busy, setBusy] = useState(false);

  const surrender = useMutation(api.loans.surrender);
  const settle = useMutation(api.loans.settle);
  const close = useMutation(api.loans.close);
  const archive = useMutation(api.loans.archive);
  const deleteClosed = useMutation(api.loans.deleteClosed);

  if (!profile || profile.role !== "SUPER_ADMIN") return null;

  const open = round2(outstanding);
  const eligible: Action[] = [];
  if (OPERABLE.includes(loan.status)) {
    eligible.push("surrender");
    if (open > 0) eligible.push("settle");
  }
  if (CLOSABLE.includes(loan.status)) eligible.push("close");
  if (RESOLVED.includes(loan.status)) {
    if (!loan.archivedAt) eligible.push("archive");
    eligible.push("delete");
  }
  if (eligible.length === 0) return null;

  const settleAmount = action === "settle" && amountStr !== "" ? round2(Number(amountStr)) : null;
  const waivedPreview =
    settleAmount !== null && Number.isFinite(settleAmount)
      ? round2(Math.max(0, open - settleAmount))
      : null;
  const settleInvalid =
    action === "settle" &&
    (settleAmount === null ||
      !Number.isFinite(settleAmount) ||
      settleAmount < 0 ||
      settleAmount > open);

  const reasonRequired =
    action === "surrender" || action === "settle" || action === "delete";
  const reasonOk = !reasonRequired || reason.trim().length >= 5;
  const canConfirm =
    !!action && !busy && reasonOk && (action !== "settle" || !settleInvalid);

  const openAction = (next: Action) => {
    setReason("");
    setAction(next);
    setAmountStr(next === "settle" ? String(open) : "");
    setMode("CASH");
  };

  const run = async () => {
    if (!action) return;
    setBusy(true);
    const device = navigator.userAgent.slice(0, 60);
    try {
      if (action === "surrender") {
        const res = await surrender({ loanId: loan._id, reason: reason.trim(), device });
        toast.success(
          `${fmtId(res.loanId)} surrendered — ${money(res.outstanding)} outstanding stays on record for recovery`,
        );
      } else if (action === "settle") {
        const res = await settle({
          loanId: loan._id,
          settlementAmount: settleAmount ?? 0,
          mode,
          reason: reason.trim(),
          device,
        });
        toast.success(
          `${fmtId(res.loanId)} settled — ${money(res.settlementPaid)} received` +
            (res.receiptNumber ? ` (receipt ${fmtId(res.receiptNumber)})` : "") +
            (res.waivedAmount > 0 ? `, ${money(res.waivedAmount)} waived` : ""),
        );
      } else if (action === "close") {
        const res = await close({ loanId: loan._id, reason: reason.trim() || undefined, device });
        toast.success(`${fmtId(res.loanId)} closed — all dues verified cleared`);
      } else if (action === "archive") {
        await archive({ loanId: loan._id, reason: reason.trim() || undefined, device });
        toast.success(
          `${fmtId(loan.loanId)} archived — hidden from active loan screens, records preserved`,
        );
      } else if (action === "delete") {
        const res = await deleteClosed({
          loanId: loan._id,
          reason: reason.trim(),
          device,
        });
        toast.success(
          `${fmtId(res.loanId)} permanently deleted (${res.scheduleRowsRemoved} schedule projection(s) removed)`,
        );
      }
      setAction(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };

  const titles: Record<Action, string> = {
    surrender: "Surrender loan",
    settle: "Settle loan",
    close: "Close loan",
    archive: "Archive loan",
    delete: "Delete closed loan",
  };

  const messages: Record<Action, string> = {
    surrender:
      `Terminates ${fmtId(loan.loanId)} before its normal completion. The remaining dues stay on record for recovery — nothing is waived or erased, and collections against this loan stop. ` +
      `Current outstanding: ${money(open)}. A mandatory reason is recorded in the audit log.`,
    settle:
      `Settles ${fmtId(loan.loanId)} for an agreed amount. The paid amount is recorded as a real payment with a receipt; only the waived remainder closes the remaining dues, and waived dues are never counted as cash received.`,
    close:
      `Marks ${fmtId(loan.loanId)} closed. The backend verifies every due is actually cleared — clicking Close can never mark an unpaid loan repaid.` +
      (open > 0
        ? ` WARNING: ${money(open)} is still outstanding — Close will be rejected; use Settle or Surrender instead.`
        : ""),
    archive:
      `Hides this closed/settled loan from ordinary loan screens while every payment, receipt, journal entry and the audit trail stay intact and reachable.`,
    delete:
      `Permanent. Only allowed when no payments, receipts, journal entries or wallet transactions reference this loan — otherwise the backend refuses and you should archive instead. Active or financially unresolved loans can never be deleted.`,
  };

  const confirmLabels: Record<Action, string> = {
    surrender: "Surrender loan",
    settle: "Record settlement",
    close: "Close loan",
    archive: "Archive loan",
    delete: "Delete permanently",
  };

  const btnCls = compact
    ? "h-8 px-2 text-[10px] uppercase"
    : "h-11 px-3 text-xs uppercase";

  return (
    <>
      <div
        className={cn("flex flex-wrap gap-1.5", !compact && "mt-1")}
        onClick={(e) => e.stopPropagation()}
      >
        {eligible.includes("surrender") && (
          <Button
            size="sm"
            variant="outline"
            className={cn(btnCls, "border-2 border-ink")}
            onClick={() => openAction("surrender")}
          >
            <Undo2 className="size-3.5" /> Surrender
          </Button>
        )}
        {eligible.includes("settle") && (
          <Button
            size="sm"
            className={cn(btnCls, "border-2 border-ink bg-gold text-ink")}
            onClick={() => openAction("settle")}
          >
            <Handshake className="size-3.5" /> Settle
          </Button>
        )}
        {eligible.includes("close") && (
          <Button
            size="sm"
            className={cn(btnCls, "border-2 border-ink bg-mint text-ink")}
            onClick={() => openAction("close")}
          >
            <BadgeCheck className="size-3.5" /> Close
          </Button>
        )}
        {eligible.includes("archive") && (
          <Button
            size="sm"
            variant="outline"
            className={cn(btnCls, "border-2 border-ink")}
            onClick={() => openAction("archive")}
          >
            <Archive className="size-3.5" /> Archive
          </Button>
        )}
        {eligible.includes("delete") && (
          <Button
            size="sm"
            variant="destructive"
            className={cn(btnCls, "border-2 border-ink")}
            onClick={() => openAction("delete")}
          >
            <Trash2 className="size-3.5" /> Delete
          </Button>
        )}
      </div>

      <Dialog open={action !== null} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto border-2 border-ink bg-card shadow-hard">
          <DialogHeader>
            <DialogTitle className="text-lg font-black uppercase tracking-tight">
              {action ? titles[action] : ""}
            </DialogTitle>
            <DialogDescription className="text-sm font-semibold">
              {action ? messages[action] : ""}
            </DialogDescription>
          </DialogHeader>

          {action && (
            <div className="space-y-3">
              {/* Live financial position — always shown before confirming. */}
              <div className="border-2 border-ink bg-paper text-xs font-bold">
                {(action === "settle" || action === "close" || open > 0) && (
                  <div className="flex items-center justify-between border-b border-ink/15 px-3 py-2">
                    <span className="text-[10px] font-black uppercase text-muted-foreground">
                      Current outstanding
                    </span>
                    <span className="font-mono font-black tabular-nums">
                      {money(open)}
                    </span>
                  </div>
                )}
                {action === "settle" && (
                  <>
                    <div className="flex items-center justify-between border-b border-ink/15 px-3 py-2">
                      <span className="text-[10px] font-black uppercase text-muted-foreground">
                        Settlement amount (paid)
                      </span>
                      <span className="font-mono font-black tabular-nums">
                        {settleAmount !== null && Number.isFinite(settleAmount)
                          ? money(settleAmount)
                          : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between px-3 py-2">
                      <span className="text-[10px] font-black uppercase text-muted-foreground">
                        Amount waived (not cash)
                      </span>
                      <span
                        className={cn(
                          "font-mono font-black tabular-nums",
                          (waivedPreview ?? 0) > 0 && "text-destructive",
                        )}
                      >
                        {waivedPreview !== null ? money(waivedPreview) : "—"}
                      </span>
                    </div>
                  </>
                )}
                {loan.closureKind && (
                  <div className="flex items-center justify-between border-t border-ink/15 px-3 py-2">
                    <span className="text-[10px] font-black uppercase text-muted-foreground">
                      Already resolved as
                    </span>
                    <span className="font-black">
                      {CLOSURE_KIND_LABELS[loan.closureKind] ?? loan.closureKind}
                    </span>
                  </div>
                )}
              </div>

              {clientName && (
                <p className="text-xs font-bold text-muted-foreground">
                  Client: {clientName} · {fmtId(loan.loanId)}
                </p>
              )}

              {action === "settle" && (
                <>
                  <div>
                    <label className={LABEL_CLS} htmlFor="settlement-amount">
                      Settlement amount (actual payment)
                    </label>
                    <input
                      id="settlement-amount"
                      inputMode="numeric"
                      value={amountStr}
                      onChange={(e) =>
                        setAmountStr(e.target.value.replace(/[^\d.]/g, ""))
                      }
                      placeholder={String(open)}
                      className={cn(
                        INPUT_CLS,
                        settleInvalid && "border-destructive",
                      )}
                    />
                    <div className="mt-1 flex gap-1.5">
                      <button
                        type="button"
                        className="border-2 border-ink bg-white px-2 py-1 text-[10px] font-black uppercase"
                        onClick={() => setAmountStr(String(open))}
                      >
                        Full {money(open)}
                      </button>
                      <button
                        type="button"
                        className="border-2 border-ink bg-white px-2 py-1 text-[10px] font-black uppercase"
                        onClick={() => setAmountStr("0")}
                      >
                        ₹0 · full waiver
                      </button>
                    </div>
                    {settleInvalid && (
                      <p className="mt-1 text-[11px] font-bold text-destructive">
                        Settlement must be between ₹0 and the outstanding{" "}
                        {money(open)}.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className={LABEL_CLS} htmlFor="settlement-mode">
                      Payment mode
                    </label>
                    <select
                      id="settlement-mode"
                      value={mode}
                      onChange={(e) => setMode(e.target.value)}
                      className={INPUT_CLS}
                    >
                      <option value="CASH">CASH</option>
                      <option value="UPI">UPI</option>
                      <option value="BANK">BANK</option>
                    </select>
                  </div>
                </>
              )}

              <div>
                <label className={LABEL_CLS} htmlFor="closure-reason">
                  Reason{" "}
                  {reasonRequired ? "(mandatory)" : "(optional)"}
                </label>
                <textarea
                  id="closure-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder={
                    action === "delete"
                      ? "Why is this closed loan being permanently deleted?"
                      : "Why is this operation being performed?"
                  }
                  className="min-h-16 w-full border-2 border-ink bg-white px-3 py-2 text-sm font-semibold outline-none"
                />
                {reasonRequired && reason.trim().length > 0 && reason.trim().length < 5 && (
                  <p className="mt-1 text-[11px] font-bold text-destructive">
                    Give a reason of at least 5 characters.
                  </p>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setAction(null)}
            >
              Cancel
            </Button>
            <Button
              variant={action === "delete" ? "destructive" : "default"}
              disabled={!canConfirm}
              onClick={() => void run()}
            >
              {busy
                ? "Working…"
                : action
                  ? confirmLabels[action]
                  : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
