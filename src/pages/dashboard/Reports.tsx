import { api } from "@/convex/_generated/api";
import {
  EmptyState,
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  formatDate,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import { Download, FileBarChart } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const TYPES = [
  { id: "ALL", label: "All" },
  { id: "COLLECTION", label: "Collections" },
  { id: "WALLET", label: "Wallet" },
  { id: "DISBURSEMENT", label: "Disbursed" },
  { id: "HANDOVER", label: "Cash flow" },
  { id: "EXPENSE", label: "Expenses" },
] as const;

const MODES = [
  { id: "", label: "Any mode" },
  { id: "CASH", label: "Cash" },
  { id: "UPI", label: "UPI" },
  { id: "BANK", label: "Bank" },
] as const;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export default function Reports() {
  const [type, setType] = useState<(typeof TYPES)[number]["id"]>("ALL");
  const [mode, setMode] = useState<string>("");
  const [from, setFrom] = useState(() => isoDaysAgo(30));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  const report = useQuery(api.reports.run, {
    type,
    mode: mode || undefined,
    dateFrom: new Date(from).getTime(),
    dateTo: new Date(to).getTime(),
    limit: 300,
  });

  const totals = report?.totals;

  const csv = useMemo(() => {
    if (!report) return "";
    const head = ["date", "kind", "type", "party", "reference", "mode", "direction", "amount", "status", "staff"];
    const lines = report.rows.map((r) =>
      [
        new Date(r.date).toISOString().slice(0, 10),
        r.kind,
        r.type,
        r.party,
        r.reference,
        r.mode ?? "",
        r.direction,
        String(r.amount),
        r.status,
        r.staffName,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    return [head.join(","), ...lines].join("\n");
  }, [report]);

  const download = () => {
    if (!csv) return;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `finserve-report-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV downloaded");
  };

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Reports"
        subtitle="Ledger-derived — every figure traces to a transaction"
        action={
          <Button size="sm" variant="outline" onClick={download} disabled={!csv}>
            <Download className="size-4" /> CSV
          </Button>
        }
      />

      {/* Range */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[10px] font-black uppercase text-muted-foreground">From</label>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-black uppercase text-muted-foreground">To</label>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className="h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
          />
        </div>
      </div>

      {/* Type / mode chips */}
      <div className="flex flex-wrap gap-1.5">
        {TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => setType(t.id)}
            className={cn(
              "border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
              type === t.id ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={cn(
              "border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
              mode === m.id ? "bg-royal text-white shadow-hard-sm" : "bg-white",
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Totals */}
      {report === undefined ? (
        <RowSkeleton rows={3} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="border-2 border-ink bg-mint p-3 shadow-hard-sm">
              <div className="text-[10px] font-black uppercase text-muted-foreground">
                Collected
              </div>
              <Money value={totals?.collected ?? 0} className="text-xl" />
              <div className="text-[10px] font-bold text-muted-foreground">
                {report.range.fromKey} → {report.range.toKey}
              </div>
            </div>
            <div className="border-2 border-ink bg-sky p-3 shadow-hard-sm">
              <div className="text-[10px] font-black uppercase text-muted-foreground">
                Cash / UPI / Bank
              </div>
              <div className="text-xs font-black">
                ₹{(totals?.cashCollected ?? 0).toLocaleString("en-IN")} / ₹
                {(totals?.upiCollected ?? 0).toLocaleString("en-IN")} / ₹
                {(totals?.bankCollected ?? 0).toLocaleString("en-IN")}
              </div>
            </div>
            <div className="border-2 border-ink bg-gold p-3 shadow-hard-sm">
              <div className="text-[10px] font-black uppercase text-muted-foreground">
                Disbursed
              </div>
              <Money value={totals?.disbursed ?? 0} className="text-xl" />
            </div>
            <div className="border-2 border-ink bg-card p-3 shadow-hard-sm">
              <div className="text-[10px] font-black uppercase text-muted-foreground">
                Closing wallet
              </div>
              <Money value={totals?.closingWallet ?? 0} className="text-xl" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="border-2 border-ink bg-white p-2.5 shadow-hard-sm text-center">
              <div className="text-[10px] font-black uppercase text-muted-foreground">
                Handover in
              </div>
              <Money value={totals?.handoverIn ?? 0} className="text-sm" />
            </div>
            <div className="border-2 border-ink bg-white p-2.5 shadow-hard-sm text-center">
              <div className="text-[10px] font-black uppercase text-muted-foreground">
                Handover out
              </div>
              <Money value={totals?.handoverOut ?? 0} className="text-sm" />
            </div>
            <div className="border-2 border-ink bg-white p-2.5 shadow-hard-sm text-center">
              <div className="text-[10px] font-black uppercase text-muted-foreground">
                Expenses
              </div>
              <Money value={totals?.expenses ?? 0} className="text-sm" />
            </div>
          </div>

          {/* Rows */}
          <SectionTitle>{totals?.rowCount ?? 0} transactions</SectionTitle>
          {report.rows.length === 0 ? (
            <EmptyState
              title="Nothing in this range"
              hint="Widen the date range or switch the filters."
              icon={<FileBarChart className="size-5" />}
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              {report.rows.map((r) => (
                <div
                  key={`${r.kind}-${r.id}`}
                  className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-black uppercase">{r.type}</p>
                    <p className="truncate text-[11px] font-semibold text-muted-foreground">
                      {r.party} · {r.reference} · {formatDate(r.date)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Money
                      value={r.amount}
                      className={cn(
                        "block text-sm",
                        r.direction === "IN" && "text-success",
                        r.direction === "OUT" && "text-destructive",
                      )}
                    />
                    <span className="flex justify-end">
                      <StatusChip status={r.status} />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
