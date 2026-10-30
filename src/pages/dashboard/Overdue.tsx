import { api } from "@/convex/_generated/api";
import {
  EmptyState,
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { BUCKET_LABELS, RECOVERY_KINDS, RECOVERY_LABELS, OVERDUE_BUCKETS } from "@/lib/finance/types";
import { cn, fmtId } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { AlertTriangle, PhoneCall } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

export default function Overdue() {
  const navigate = useNavigate();
  const { can } = useProfile();
  const [bucket, setBucket] = useState<string>("ALL");
  const data = useQuery(api.reports.overdue, bucket === "ALL" ? {} : { bucket });

  const addRecovery = useMutation(api.loans.addRecovery);
  const [active, setActive] = useState<{
    loanDbId: string;
    loanId: string;
  } | null>(null);
  const [kind, setKind] = useState<string>("CONTACT");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const logRecovery = async () => {
    if (!active) return;
    setBusy(true);
    try {
      await addRecovery({
        loanId: active.loanDbId as never,
        kind,
        notes: notes.trim() || undefined,
      });
      toast.success(`Recovery activity logged on ${fmtId(active.loanId)}`);
      setActive(null);
      setNotes("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not log activity");
    } finally {
      setBusy(false);
    }
  };

  const buckets = data?.buckets;

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Overdue & recovery"
        subtitle="Ageing buckets derived from repayment schedules"
        action={
          <StatusChip
            label={`${data?.rows.length ?? 0} loans`}
            tone={(data?.rows.length ?? 0) > 0 ? "bad" : "ok"}
          />
        }
      />

      {/* Bucket summary */}
      <div className="grid grid-cols-4 gap-1.5">
        {OVERDUE_BUCKETS.map((b) => (
          <button
            key={b}
            onClick={() => setBucket(bucket === b ? "ALL" : b)}
            className={cn(
              "border-2 border-ink p-2 text-center shadow-hard-sm",
              bucket === b ? "bg-navy text-paper" : "bg-card",
            )}
          >
            <div className="text-[9px] font-black uppercase opacity-70">
              {BUCKET_LABELS[b]}
            </div>
            <div className="text-lg font-black leading-none">
              {buckets?.[b]?.count ?? 0}
            </div>
            <div className="text-[9px] font-black tabular-nums opacity-70">
              ₹{Math.round(buckets?.[b]?.amount ?? 0).toLocaleString("en-IN")}
            </div>
          </button>
        ))}
      </div>

      {bucket !== "ALL" && (
        <Button size="sm" variant="outline" onClick={() => setBucket("ALL")}>
          Clear bucket filter
        </Button>
      )}

      {data === undefined ? (
        <RowSkeleton rows={5} />
      ) : data.rows.length === 0 ? (
        <EmptyState
          title="No overdue loans"
          hint="Every open installment is within its due window. Keep it up."
          icon={<AlertTriangle className="size-5" />}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {data.rows.map((r) => (
            <div key={r.loanDbId} className="border-2 border-ink bg-card p-3 shadow-hard-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <button
                    onClick={() => navigate(`/dashboard/loans/${r.loanDbId}`)}
                    className="text-left font-mono text-sm font-black underline decoration-2 underline-offset-2"
                  >
                    {fmtId(r.loanId)}
                  </button>
                  <p className="truncate text-[11px] font-semibold text-muted-foreground">
                    {r.clientName} ({fmtId(r.clientCode)}) · {r.village} · {r.staffName}
                  </p>
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    {r.daysOverdue} days overdue · bucket {BUCKET_LABELS[r.bucket as keyof typeof BUCKET_LABELS]}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span className="block text-[10px] font-black uppercase text-muted-foreground">
                    Overdue
                  </span>
                  <Money value={r.overdueAmount} className="block text-lg text-destructive" />
                  <span className="text-[10px] font-black uppercase text-muted-foreground">
                    of {r.outstanding.toLocaleString("en-IN")} open
                  </span>
                </div>
              </div>
              {can("collect_payment") && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setActive({ loanDbId: r.loanDbId, loanId: r.loanId });
                      setKind("CONTACT");
                    }}
                  >
                    <PhoneCall className="size-3.5" /> Log recovery
                  </Button>
                  <Button size="sm" onClick={() => navigate(`/dashboard/loans/${r.loanDbId}`)}>
                    Open loan
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <SectionTitle>Recovery playbook</SectionTitle>
      <p className="border-2 border-ink bg-sky p-3 text-xs font-bold">
        Log every contact, visit and promise to pay — the trail feeds the
        overdue report and is visible to your BM.
      </p>

      {/* Recovery dialog */}
      {active && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-sm border-2 border-ink bg-card p-4 shadow-hard">
            <h3 className="text-lg font-black uppercase tracking-tight">
              Recovery on {fmtId(active.loanId)}
            </h3>
            <div className="mt-3 space-y-2">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
              >
                {RECOVERY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {RECOVERY_LABELS[k]}
                  </option>
                ))}
              </select>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes — what was said, what was promised…"
                className="min-h-24 w-full border-2 border-ink bg-white px-3 py-2 text-sm font-semibold outline-none"
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => setActive(null)}>
                Cancel
              </Button>
              <Button disabled={busy || !notes.trim()} onClick={() => void logRecovery()}>
                {busy ? "Saving…" : "Log it"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
