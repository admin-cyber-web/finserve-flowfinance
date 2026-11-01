import { api } from "@/convex/_generated/api";
import {
  EmptyState,
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  timeAgo,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { cn } from "@/lib/utils";
import { CLIENT_IMAGE_REQUIRED_MESSAGE } from "@/lib/clientImage";
import { useMutation, useQuery } from "convex/react";
import { Stamp, UserRound } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

const KIND_TONE: Record<string, string> = {
  LOAN: "bg-gold",
  HANDOVER: "bg-sky",
  CLOSING: "bg-blush",
  EXPENSE: "bg-clay",
};

type ApprovalItem = {
  id: string;
  kind: string;
  clientId?: string;
  clientImageAvailable?: boolean;
};

/** A LOAN row is blocked until its client has a valid saved image. */
function blockedByImage(item: ApprovalItem): boolean {
  return item.kind === "LOAN" && item.clientImageAvailable === false;
}

export default function Approvals() {
  const { profile } = useProfile();
  const navigate = useNavigate();
  const items = useQuery(api.admin.pendingApprovals);

  const decideLoan = useMutation(api.loans.decide);
  const decideHandover = useMutation(api.cash.decideHandover);
  const decideClosing = useMutation(api.cash.decideClosing);
  const decideExpense = useMutation(api.cash.decideExpense);
  const decideRequest = useMutation(api.admin.decideRequest);

  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; kind: string } | null>(null);
  const [remark, setRemark] = useState("");

  const canDecide =
    profile?.role === "BRANCH_MANAGER" || profile?.role === "SUPER_ADMIN";

  const decide = async (id: string, kind: string, action: "APPROVED" | "REJECTED") => {
    setBusy(id);
    try {
      const why = action === "REJECTED" ? remark.trim() || "Rejected at review" : undefined;
      switch (kind) {
        case "LOAN":
          await decideLoan({ applicationId: id as never, action, remark: why });
          break;
        case "HANDOVER":
          await decideHandover({
            handoverId: id as never,
            action: action === "APPROVED" ? "ACCEPTED" : "REJECTED",
            rejectReason: why,
          });
          break;
        case "CLOSING":
          await decideClosing({ closingId: id as never, action, remark: why });
          break;
        case "EXPENSE":
          await decideExpense({ expenseId: id as never, action, remark: why });
          break;
        default:
          await decideRequest({ requestId: id as never, action, remark: why });
          break;
      }
      toast.success(`${kind.toLowerCase()} ${action.toLowerCase()}`);
      setRejecting(null);
      setRemark("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Decision failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Approvals"
        subtitle="Loans, handovers, closings and expenses in one queue"
        action={
          <StatusChip
            label={`${items?.length ?? 0} pending`}
            tone={(items?.length ?? 0) > 0 ? "warn" : "ok"}
          />
        }
      />

      {!canDecide && (
        <div className="border-2 border-ink bg-sky p-3 text-xs font-bold">
          Your role can view this queue; decisions are made by the Branch Manager or
          Admin.
        </div>
      )}

      {items === undefined ? (
        <RowSkeleton rows={5} />
      ) : items.length === 0 ? (
        <EmptyState
          title="Queue is clear"
          hint="Loan applications, cash handovers, closings and expenses land here for decision."
          icon={<Stamp className="size-5" />}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <div key={item.id} className="border-2 border-ink bg-card p-3 shadow-hard-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "border-2 border-ink px-1.5 py-0.5 text-[10px] font-black uppercase",
                        KIND_TONE[item.kind] ?? "bg-mint",
                      )}
                    >
                      {item.kind === "CASH_SHORTAGE" || item.kind === "WALLET_LIMIT"
                        ? item.kind.replace(/_/g, " ")
                        : item.kind}
                    </span>
                    {item.refId && (
                      <span className="font-mono text-[11px] font-black text-muted-foreground">
                        {item.refId}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm font-black">{item.title}</p>
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    {item.subtitle}
                  </p>
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    by {item.requestedBy} · {timeAgo(item.at)}
                  </p>
                </div>
                {item.amount !== null && (
                  <Money value={item.amount} className="shrink-0 text-lg" />
                )}
              </div>

              {/* LOAN approval needs the client's saved image. The application
                  stays pending (never rejected) until it is saved. Client
                  approval itself — in the Clients section — never needs one. */}
              {blockedByImage(item) && (
                <div className="mt-2 space-y-2 border-2 border-ink bg-blush p-2">
                  <p className="text-[11px] font-black">
                    {CLIENT_IMAGE_REQUIRED_MESSAGE}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() =>
                      navigate(`/dashboard/clients/${item.clientId}#client-image`)
                    }
                  >
                    <UserRound className="size-3.5" /> Open Client Profile
                  </Button>
                </div>
              )}

              {canDecide && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    disabled={busy === item.id || blockedByImage(item)}
                    onClick={() => void decide(item.id, item.kind, "APPROVED")}
                  >
                    {busy === item.id ? "Working…" : "Approve"}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy === item.id}
                    onClick={() => setRejecting({ id: item.id, kind: item.kind })}
                  >
                    Reject
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Reject dialog */}
      {rejecting && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-sm border-2 border-ink bg-card p-4 shadow-hard">
            <h3 className="text-lg font-black uppercase tracking-tight">
              Reject {rejecting.kind.toLowerCase()}
            </h3>
            <p className="mt-1 text-xs font-semibold text-muted-foreground">
              The reason is recorded in the audit trail and sent to the requester.
            </p>
            <textarea
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="Reason (required)"
              className="mt-3 min-h-20 w-full border-2 border-ink bg-white px-3 py-2 text-sm font-semibold outline-none"
            />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setRejecting(null);
                  setRemark("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={!remark.trim() || busy === rejecting.id}
                onClick={() => void decide(rejecting.id, rejecting.kind, "REJECTED")}
              >
                Reject
              </Button>
            </div>
          </div>
        </div>
      )}

      <SectionTitle>How this works</SectionTitle>
      <p className="border-2 border-ink bg-sky p-3 text-xs font-bold">
        Approving a loan re-runs lender policy server-side, creates the loan, and
        notifies the field officer. Handover/closing/expense decisions post
        double-entry journal entries — balances are never edited directly.
      </p>
    </div>
  );
}
