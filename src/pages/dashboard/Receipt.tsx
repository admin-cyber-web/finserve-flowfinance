import { api } from "@/convex/_generated/api";
import {
  CopyableCode,
  EmptyState,
  KeyValue,
  Money,
  PageHeader,
  RowSkeleton,
  StatusChip,
  formatDate,
  formatDateTime,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useQuery } from "convex/react";
import { Download, Share2 } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

export default function Receipt() {
  const { number } = useParams();
  const navigate = useNavigate();

  const skip = !number || number === "QUEUED-OFFLINE";
  const data = useQuery(
    api.collections.receipt,
    skip ? "skip" : { number: number! },
  );

  if (skip) {
    return (
      <div className="space-y-4">
        <PageHeader title="Receipt" back="/dashboard" />
        <EmptyState
          title="Receipt not synced yet"
          hint="This payment was queued offline. The receipt number is generated when it syncs — check Activity afterwards."
        />
      </div>
    );
  }

  if (data === undefined) {
    return (
      <div className="space-y-3">
        <PageHeader title="Receipt" back />
        <RowSkeleton rows={5} />
      </div>
    );
  }

  const { receipt, client, loan, staff, branch, nextDue, overdueAmount } = data;

  const share = async () => {
    const text = `KIRAT MICRO CREDIT receipt ${receipt.number} — ₹${receipt.amount.toLocaleString("en-IN")} (${receipt.mode}) from ${client?.name ?? "client"} on ${formatDate(receipt.createdAt)}. Outstanding after payment: ₹${receipt.outstandingAfter.toLocaleString("en-IN")}.`;
    try {
      if (navigator.share) await navigator.share({ text });
      else await navigator.clipboard.writeText(text);
      toast.success("Receipt shared");
    } catch {
      /* user dismissed */
    }
  };

  return (
    <div className="space-y-4 pb-6">
      <PageHeader
        title="Payment receipt"
        subtitle={receipt.number}
        back
        action={<StatusChip status={receipt.mode === "CASH" ? "CASH" : receipt.mode} label={receipt.mode} tone="info" />}
      />

      <section className="border-2 border-ink bg-card shadow-hard print:border-black print:shadow-none">
        {/* Brand header */}
        <div className="flex items-center justify-between border-b-2 border-ink bg-navy px-4 py-3 text-paper">
          <div>
            <div className="text-lg font-black leading-none">
              KIRAT
            </div>
            <div className="mt-0.5 text-[9px] font-black uppercase tracking-[0.2em] text-paper/70">
              Micro Credit
            </div>
          </div>
          <div className="text-right">
            <div className="text-[9px] font-black uppercase text-paper/60">Branch</div>
            <div className="text-xs font-black">{branch?.name ?? "—"}</div>
          </div>
        </div>

        <div className="p-4">
          <div className="text-center">
            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">
              Amount received
            </div>
            <Money value={receipt.amount} className="mt-1 block text-4xl" />
            <div className="mt-2 inline-block border-2 border-ink bg-gold px-3 py-1 text-xs font-black uppercase">
              {receipt.mode}
            </div>
          </div>

          <div className="mt-4">
            <KeyValue k="Receipt no." v={<span className="font-mono">{receipt.number}</span>} mono />
            <KeyValue k="Date" v={formatDateTime(receipt.createdAt)} />
            <KeyValue k="Client" v={client ? `${client.name} (${client.code})` : "—"} />
            <KeyValue k="Loan" v={<span className="font-mono">{loan?.loanId ?? "—"}</span>} mono />
            <KeyValue k="Collected by" v={staff?.name ?? "—"} />
            <KeyValue
              k="Outstanding after"
              v={<Money value={receipt.outstandingAfter} />}
            />
            <KeyValue
              k="Next installment"
              v={nextDue ? `${formatDate(nextDue.dueDate)} · ₹${nextDue.totalDue.toLocaleString("en-IN")}` : "—"}
            />
            <KeyValue
              k="Overdue now"
              v={
                overdueAmount > 0 ? (
                  <span className="text-destructive">
                    ₹{overdueAmount.toLocaleString("en-IN")}
                  </span>
                ) : (
                  "None"
                )
              }
            />
          </div>

          <p className="mt-4 border-2 border-dashed border-ink/40 p-2 text-center text-[10px] font-semibold text-muted-foreground">
            This receipt is generated from the immutable ledger. Corrections are
            made by reversal — never by deletion.
          </p>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2 print:hidden">
        <Button variant="outline" size="lg" onClick={() => window.print()}>
          <Download className="size-4" /> Print
        </Button>
        <Button variant="outline" size="lg" onClick={() => void share()}>
          <Share2 className="size-4" /> Share
        </Button>
      </div>

      <div className="flex justify-center print:hidden">
        <Button
          variant="ghost"
          disabled={!loan}
          onClick={() => loan && navigate(`/dashboard/clients/${loan.clientId}`)}
        >
          Client 360°
        </Button>
      </div>

      <div className="flex justify-center gap-2 print:hidden">
        <CopyableCode value={receipt.number} />
      </div>
    </div>
  );
}
