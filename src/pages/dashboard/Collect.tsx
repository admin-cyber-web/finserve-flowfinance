import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ConfirmDialog,
  EmptyState,
  Money,
  MoneyInput,
  PageHeader,
  RowSkeleton,
  StatusChip,
} from "@/components/fs/primitives";
import { formatINR } from "@/lib/finance/money";
import { newIdempotencyKey, enqueueCollection } from "@/lib/offline";
import { cn, fmtId } from "@/lib/utils";
import { formatMeetingDateShort } from "@/lib/meeting";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  CheckCircle2,
  CloudOff,
  Download,
  QrCode,
  Search,
  Share2,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type Step =
  | { name: "list" }
  | { name: "amount"; clientId: Id<"clients"> }
  | {
      name: "done";
      receipt: string;
      amount: number;
      outstanding: number;
      queued?: boolean;
    };

const MODES = [
  { id: "CASH", label: "Cash", tone: "bg-mint" },
  { id: "UPI", label: "UPI", tone: "bg-sky" },
  { id: "BANK", label: "Bank", tone: "bg-clay" },
] as const;

/** Loan statuses a payment can be posted against. */
const OPEN_STATUSES = ["ACTIVE", "OVERDUE", "DISBURSED"];

export default function Collect() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const today = useQuery(api.collections.today, {});
  const [step, setStep] = useState<Step>(
    params.get("client")
      ? { name: "amount", clientId: params.get("client") as Id<"clients"> }
      : { name: "list" },
  );
  const [tab, setTab] = useState<"today" | "overdue">(
    params.get("tab") === "overdue" ? "overdue" : "today",
  );
  const [q, setQ] = useState("");
  const collect = useMutation(api.collections.collect);

  // Resolve the loan a payment posts against — never a client-side guess.
  const clientLoans = useQuery(
    api.loans.list,
    step.name === "amount" ? { clientId: step.clientId, limit: 25 } : "skip",
  );

  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("CASH");
  const [remarks, setRemarks] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const dueList = today?.due ?? [];
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    let rows = dueList;
    if (tab === "overdue") rows = rows.filter((r) => r.overdue > 0);
    else rows = rows.filter((r) => r.dueToday > 0);
    if (term) {
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(term) ||
          r.code.toLowerCase().includes(term) ||
          r.village.toLowerCase().includes(term),
      );
    }
    return rows;
  }, [dueList, q, tab]);

  const selected =
    step.name === "amount" ? dueList.find((d) => d.clientId === step.clientId) : undefined;
  const numericAmount = Number(amount || 0);

  // Pick the client's open loan (prefer one actually in arrears/active).
  const loanEntry =
    step.name === "amount" && clientLoans !== undefined
      ? (clientLoans.find((l) => OPEN_STATUSES.includes(l.view.displayStatus)) ??
        clientLoans[0])
      : undefined;
  const loanId = loanEntry?.loan._id ?? null;
  const loanLoading = step.name === "amount" && clientLoans === undefined;
  const noOpenLoan = step.name === "amount" && clientLoans !== undefined && !loanId;

  /* ------------------------------- LIST ---------------------------------- */
  if (step.name === "list") {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Today's collection"
          subtitle={new Date().toLocaleDateString("en-IN", {
            weekday: "long",
            day: "2-digit",
            month: "long",
          })}
        />

        {/* Summary */}
        <div className="grid grid-cols-3 gap-2">
          <div className="border-2 border-ink bg-white p-2.5 shadow-hard-sm">
            <div className="text-[10px] font-black uppercase text-muted-foreground">
              Expected
            </div>
            <Money value={today?.summary.expected ?? 0} className="text-lg" />
          </div>
          <div className="border-2 border-ink bg-mint p-2.5 shadow-hard-sm">
            <div className="text-[10px] font-black uppercase text-muted-foreground">
              Collected
            </div>
            <Money value={today?.summary.collected ?? 0} className="text-lg" />
          </div>
          <div className="border-2 border-ink bg-gold p-2.5 shadow-hard-sm">
            <div className="text-[10px] font-black uppercase text-muted-foreground">
              Pending
            </div>
            <Money value={today?.summary.pending ?? 0} className="text-lg" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] font-black uppercase">
          <span className="border-2 border-ink bg-white px-2 py-1">
            Due clients: {today?.summary.dueClients ?? 0}
          </span>
          <span className="border-2 border-ink bg-blush px-2 py-1">
            Overdue: {today?.summary.overdueClients ?? 0}
          </span>
          <span className="border-2 border-ink bg-sky px-2 py-1">
            UPI {formatINR(today?.summary.upiCollected ?? 0)}
          </span>
        </div>

        {/* Tabs + search */}
        <div className="flex gap-2">
          {(["today", "overdue"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex-1 border-2 border-ink py-2 text-xs font-black uppercase",
                tab === t ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
              )}
            >
              {t === "today" ? "Due today" : "Overdue"}
            </button>
          ))}
        </div>
        <div className="flex items-center border-2 border-ink bg-white">
          <Search className="ml-3 size-4 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, code or village"
            className="h-11 w-full bg-transparent px-3 text-sm font-bold outline-none"
          />
        </div>

        {/* Client rows */}
        {today === undefined ? (
          <RowSkeleton rows={5} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={tab === "overdue" ? "No overdue clients" : "All dues cleared"}
            hint={
              tab === "overdue"
                ? "Nothing past due on your book right now."
                : "Every installment due today has been collected."
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((d) => (
              <button
                key={d.clientId}
                onClick={() => setStep({ name: "amount", clientId: d.clientId })}
                className="flex items-center justify-between gap-3 border-2 border-ink bg-card p-3 text-left shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-black">{d.name}</span>
                  <span className="block text-[11px] font-semibold text-muted-foreground">
                    {fmtId(d.code)} · {d.village}
                  </span>
                  <span className="mt-1 block text-[10px] font-black uppercase text-muted-foreground">
                    {d.centerMeetingDay ? `Meeting ${d.centerMeetingDay}` : "Meeting day not set"}
                    {d.nextDue ? ` · next due ${formatMeetingDateShort(d.nextDue)}` : ""}
                  </span>
                  <span className="mt-1 flex gap-1">
                    {d.kycStatus !== "VERIFIED" && (
                      <StatusChip label="KYC pending" tone="warn" />
                    )}
                    {d.collectedToday > 0 && (
                      <StatusChip label={`Paid ${formatINR(d.collectedToday)}`} tone="ok" />
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <Money value={d.dueToday} className="block text-lg" />
                  {d.overdue > 0 ? (
                    <span className="text-[10px] font-black uppercase text-destructive">
                      +{formatINR(d.overdue)} overdue
                    </span>
                  ) : (
                    <span className="text-[10px] font-black uppercase text-muted-foreground">
                      due today
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* -------------------------------- DONE --------------------------------- */
  if (step.name === "done") {
    return (
      <div className="space-y-4">
        <div className="border-2 border-ink bg-mint p-5 text-center shadow-hard">
          <div className="mx-auto grid size-14 place-items-center border-2 border-ink bg-white">
            <CheckCircle2 className="size-7" />
          </div>
          <h1 className="mt-3 text-xl font-black uppercase tracking-tight">
            {step.queued ? "Queued offline" : "Payment collected"}
          </h1>
          <Money value={step.amount} className="mt-2 block text-4xl" />
          <div className="mt-3 inline-flex items-center gap-2 border-2 border-ink bg-white px-2 py-1 font-mono text-xs font-bold">
            {step.queued ? <CloudOff className="size-3.5" /> : null}
            {step.receipt}
          </div>
          {!step.queued && (
            <p className="mt-3 text-xs font-bold">
              Outstanding after payment: <Money value={step.outstanding} />
            </p>
          )}
          {step.queued && (
            <p className="mt-3 text-xs font-semibold">
              Saved on device — will sync automatically when you're back online.
              A unique reference guarantees no duplicate posting.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="lg"
            onClick={() => navigate(`/dashboard/receipts/${step.receipt}`)}
            disabled={step.queued}
          >
            <Download className="size-4" /> View receipt
          </Button>
          <Button
            variant="outline"
            size="lg"
            disabled={step.queued}
            onClick={async () => {
              const text = `KIRAT MICRO CREDIT receipt ${step.receipt} — ${formatINR(step.amount)}`;
              try {
                if (navigator.share) await navigator.share({ text });
                else await navigator.clipboard.writeText(text);
                toast.success("Receipt shared");
              } catch {
                /* user dismissed */
              }
            }}
          >
            <Share2 className="size-4" /> Share
          </Button>
        </div>

        <Button
          size="lg"
          className="w-full"
          onClick={() => {
            setAmount("");
            setRemarks("");
            setParams({});
            setStep({ name: "list" });
          }}
        >
          Collect next payment
        </Button>
        <Button
          variant="ghost"
          className="w-full"
          onClick={() => navigate("/dashboard")}
        >
          <ArrowLeft className="size-4" /> Back to home
        </Button>
      </div>
    );
  }

  /* ------------------------------- AMOUNT -------------------------------- */
  const due = selected?.dueToday ?? 0;
  const overdue = selected?.overdue ?? 0;
  const canSubmit = numericAmount > 0 && !!loanId && !busy;

  return (
    <div className="space-y-4">
      <PageHeader
        title={selected?.name ?? loanEntry?.client?.name ?? "Collect payment"}
        subtitle={`${selected?.code ?? loanEntry?.client?.code ?? ""} · ${
          selected?.village ?? loanEntry?.client?.village ?? ""
        }`}
        back
        action={
          <StatusChip
            label={selected && selected.overdue > 0 ? "Overdue" : "Due today"}
            tone={selected && selected.overdue > 0 ? "bad" : "warn"}
          />
        }
      />

      <div className="grid grid-cols-2 gap-2">
        <div className="border-2 border-ink bg-gold p-3 shadow-hard-sm">
          <div className="text-[10px] font-black uppercase text-muted-foreground">
            Today's due
          </div>
          <Money value={due} className="text-2xl" />
        </div>
        <div className="border-2 border-ink bg-blush p-3 shadow-hard-sm">
          <div className="text-[10px] font-black uppercase text-muted-foreground">
            Overdue
          </div>
          <Money value={overdue} className="text-2xl" />
        </div>
      </div>

      {/* Loan resolution status */}
      {loanLoading ? (
        <div className="border-2 border-ink bg-white px-3 py-2 text-xs font-black uppercase text-muted-foreground">
          Resolving active loan…
        </div>
      ) : noOpenLoan ? (
        <div className="flex items-start gap-2 border-2 border-ink bg-blush p-3 text-xs font-bold">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            No open loan found for this client — payments can only post against an
            active loan.
          </span>
        </div>
      ) : loanEntry ? (
        <div className="space-y-1 border-2 border-ink bg-white px-3 py-2 text-xs font-black uppercase">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Posting to loan</span>
            <span className="font-mono">
              {loanEntry.product?.code ?? "LOAN"} · {loanEntry.view.displayStatus}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Center meeting day</span>
            <span>{loanEntry.loan.centerMeetingDay ?? "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Next due</span>
            <span className="normal-case">
              {loanEntry.view.nextDueDate
                ? formatMeetingDateShort(loanEntry.view.nextDueDate)
                : "—"}
            </span>
          </div>
        </div>
      ) : null}

      <MoneyInput
        value={amount}
        onChange={setAmount}
        autoFocus
        label="Amount to collect"
        quick={[
          ...(due > 0 ? [due] : []),
          ...(overdue > 0 ? [overdue] : []),
          ...(due + overdue > 0 ? [due + overdue] : []),
          500,
          1000,
        ].filter((v, i, arr) => v > 0 && arr.indexOf(v) === i)}
      />

      <div>
        <div className="mb-2 text-xs font-black uppercase tracking-wider text-muted-foreground">
          Payment mode
        </div>
        <div className="grid grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={cn(
                "flex items-center justify-center gap-1.5 border-2 border-ink py-3 text-sm font-black uppercase",
                mode === m.id ? `${m.tone} shadow-hard-sm` : "bg-white",
              )}
            >
              {m.id === "CASH" ? null : <QrCode className="size-3.5" />}
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs font-black uppercase tracking-wider text-muted-foreground">
          Remarks (optional)
        </div>
        <input
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="e.g. part payment, balance promised Friday"
          className="h-11 w-full border-2 border-ink bg-white px-3 text-sm font-semibold outline-none"
        />
      </div>

      <div className="sticky bottom-24 border-2 border-ink bg-card p-3 shadow-hard">
        <div className="mb-2 flex items-center justify-between text-xs font-black uppercase">
          <span className="text-muted-foreground">You are collecting</span>
          <Money value={numericAmount} className="text-xl" />
        </div>
        <Button
          className="w-full"
          size="lg"
          disabled={!canSubmit}
          onClick={() => setConfirmOpen(true)}
        >
          {loanLoading ? "Resolving loan…" : "Collect payment"}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Confirm collection"
        message={`Collect ${formatINR(numericAmount)} from ${selected?.name ?? loanEntry?.client?.name ?? "client"} via ${mode}? This posts to the ledger and issues a receipt.`}
        confirmLabel="Confirm & receipt"
        loading={busy}
        onConfirm={async () => {
          if (!loanId) {
            setConfirmOpen(false);
            toast.error("No open loan to post this payment against");
            return;
          }
          setBusy(true);
          try {
            const key = newIdempotencyKey("pay");
            if (!navigator.onLine) {
              enqueueCollection({
                loanId,
                clientId: step.clientId,
                clientName: selected?.name ?? loanEntry?.client?.name ?? "",
                amount: numericAmount,
                mode,
                remarks,
                idempotencyKey: key,
              });
              toast.warning("Offline — payment queued for sync");
              setConfirmOpen(false);
              setStep({
                name: "done",
                receipt: "QUEUED-OFFLINE",
                amount: numericAmount,
                outstanding: 0,
                queued: true,
              });
              return;
            }
            const result = await collect({
              loanId,
              amount: numericAmount,
              mode,
              remarks: remarks || undefined,
              idempotencyKey: key,
              device: navigator.userAgent.slice(0, 60),
            });
            setConfirmOpen(false);
            setStep({
              name: "done",
              receipt: result.receiptNumber,
              amount: numericAmount,
              outstanding: result.outstandingAfter,
            });
          } catch (err) {
            setConfirmOpen(false);
            toast.error(err instanceof Error ? err.message : "Collection failed");
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
