import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  BottomSheet,
  KeyValue,
  Money,
  MoneyInput,
  PageHeader,
  RowSkeleton,
  SectionTitle,
} from "@/components/fs/primitives";
import { CenterWiseLoan } from "@/components/fs/CenterWiseLoan";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, HandCoins, TriangleAlert, Users } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

export default function LoanNew() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [clientId, setClientId] = useState<Id<"clients"> | null>(
    (params.get("client") as Id<"clients"> | null) ?? null,
  );
  // Three states: the initial chooser shows ONLY the two options (no product
  // cards, no centre list, no member panel), then either the centre-wise
  // batch wizard or the original single-client wizard. Arriving with a
  // pre-selected client (Client 360° → "Give loan") opens the single path.
  const [mode, setMode] = useState<"CHOOSE" | "CENTER" | "SINGLE">(
    params.get("client") ? "SINGLE" : "CHOOSE",
  );
  const [productId, setProductId] = useState<Id<"loanProducts"> | null>(null);
  const [amount, setAmount] = useState("");
  const [clientPicker, setClientPicker] = useState(false);
  const [clientSearch, setClientSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Product cards and the client list belong to the single-client path only —
  // they are never fetched (or shown) before an option has been chosen.
  const single = mode === "SINGLE";
  const products = useQuery(api.loans.products, single ? {} : "skip");
  const clients = useQuery(
    api.clients.list,
    single
      ? clientSearch.trim()
        ? { search: clientSearch.trim(), limit: 30 }
        : { limit: 30 }
      : "skip",
  );

  const numericAmount = Number(amount || 0);
  const previewReady = !!clientId && !!productId && numericAmount > 0;
  const preview = useQuery(
    api.loans.preview,
    previewReady
      ? { clientId: clientId!, productId: productId!, amount: numericAmount }
      : "skip",
  );
  const submit = useMutation(api.loans.submit);

  const selectedClient = clients?.find((c) => c._id === clientId);
  const product = products?.find((p) => p._id === productId);

  const onSubmit = async () => {
    if (!previewReady || !preview) return;
    if (!preview.eligibility.eligible) {
      const blocker = preview.eligibility.issues.find((i) => i.level === "BLOCKER");
      toast.error(blocker?.message ?? "Lender policy blocks this application.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await submit({
        clientId: clientId!,
        productId: productId!,
        amount: numericAmount,
        device: navigator.userAgent.slice(0, 60),
      });
      toast.success(`Application ${result.appId} submitted for approval`);
      navigate("/dashboard/loans");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  const modeSwitcher = (
    <>
      <PageHeader
        title="New loan"
        subtitle="Centre-wise disbursement or a single client — policy-checked before submission"
        back="/dashboard/loans"
      />

      {/* Mode chooser — centre-wise first and primary. */}
      <section className="space-y-2 border-2 border-ink bg-card p-3 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          How do you want to lend?
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            onClick={() => setMode("CENTER")}
            className={
              "w-full border-2 border-ink p-3 text-left shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none " +
              (mode === "CENTER" ? "bg-gold" : "bg-white")
            }
          >
            <span className="flex items-center gap-2 text-sm font-black uppercase">
              <Users className="size-4" /> Center-Wise Loan Disbursement
            </span>
            <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
              Primary path — create loan requests for every eligible member of
              one centre in a single batch, straight through the normal
              approval workflow.
            </span>
          </button>
          <button
            onClick={() => setMode("SINGLE")}
            className={
              "w-full border-2 border-ink p-3 text-left shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none " +
              (mode === "SINGLE" ? "bg-gold" : "bg-white")
            }
          >
            <span className="flex items-center gap-2 text-sm font-black uppercase">
              <HandCoins className="size-4" /> Single Client Loan
            </span>
            <span className="mt-1 block text-[11px] font-semibold text-muted-foreground">
              One borrower at a time through the existing application,
              approval and disbursement flow.
            </span>
          </button>
        </div>
      </section>
    </>
  );

  // Initial screen — and nothing else: exactly two choices.
  if (mode === "CHOOSE") {
    return <div className="space-y-4 pb-10">{modeSwitcher}</div>;
  }

  // Centre-wise path — the batch wizard lives in its own component.
  if (mode === "CENTER") {
    return (
      <div className="space-y-4 pb-10">
        {modeSwitcher}
        <CenterWiseLoan />
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-10">
      {modeSwitcher}

      {/* Step 1 — client */}
      <section className="space-y-2 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          1 · Client
        </h2>
        <button
          onClick={() => setClientPicker(true)}
          className="flex w-full items-center justify-between gap-2 border-2 border-ink bg-white px-3 py-3 text-left shadow-hard-sm"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-black">
              {selectedClient?.name ?? "Select client"}
            </span>
            {selectedClient && (
              <span className="block text-[11px] font-semibold text-muted-foreground">
                {selectedClient.code} · {selectedClient.village} · household income ₹
                {selectedClient.householdIncome.toLocaleString("en-IN")}
              </span>
            )}
          </span>
          <span className="shrink-0 border-2 border-ink bg-sky px-2 py-1 text-[10px] font-black uppercase">
            Change
          </span>
        </button>
      </section>

      {/* Step 2 — product */}
      <section className="space-y-2 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          2 · Loan product
        </h2>
        {products === undefined ? (
          <RowSkeleton rows={2} />
        ) : (
          <div className="grid gap-2">
            {products.map((p) => (
              <button
                key={p._id}
                onClick={() => {
                  setProductId(p._id);
                  // Fixed-principal product: lock the amount to the backend
                  // principal so the frontend can never override it.
                  setAmount(String(p.minAmount));
                }}
                className={
                  "border-2 border-ink p-3 text-left shadow-hard-sm " +
                  (productId === p._id ? "bg-gold" : "bg-white")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-black">{p.name}</span>
                  <span className="font-mono text-xs font-black">{p.code}</span>
                </div>
                <div className="mt-1 text-[11px] font-semibold text-muted-foreground">
                  {p.interestRate}% {p.interestMethod.toLowerCase()} ·{" "}
                  {p.tenure} {p.frequency.toLowerCase()} periods · ₹
                  {p.minAmount.toLocaleString("en-IN")}–₹
                  {p.maxAmount.toLocaleString("en-IN")}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Step 3 — amount */}
      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          3 · Amount
        </h2>
        <MoneyInput
          value={amount}
          onChange={setAmount}
          label="Loan amount"
          quick={
            product
              ? [product.minAmount, Math.round((product.minAmount + product.maxAmount) / 2), product.maxAmount]
              : [10000, 25000, 50000]
          }
        />
        {product && numericAmount > 0 && (
          <p className="text-[11px] font-semibold text-muted-foreground">
            Allowed range ₹{product.minAmount.toLocaleString("en-IN")} – ₹
            {product.maxAmount.toLocaleString("en-IN")}
          </p>
        )}
      </section>

      {/* Preview */}
      {!previewReady ? (
        <div className="border-2 border-dashed border-ink/50 p-4 text-center text-xs font-black uppercase text-muted-foreground">
          Select client, product and amount to see the schedule preview
        </div>
      ) : preview === undefined ? (
        <RowSkeleton rows={3} />
      ) : (
        <section className="space-y-3 border-2 border-ink bg-navy p-4 text-paper shadow-hard">
          <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
            Server-side policy preview
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Installment
              </div>
              <Money value={preview.regularInstallment} className="text-lg" />
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Processing fee
              </div>
              <Money value={preview.charges} className="text-lg" />
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Net disbursed
              </div>
              <Money value={preview.netDisbursed} className="text-lg" />
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Total interest
              </div>
              <Money value={preview.totalInterest} className="text-lg" />
            </div>
            <div className="col-span-2 border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Total payable (principal + interest)
              </div>
              <Money value={preview.totalPayable} className="text-lg" />
            </div>
          </div>

          <div className="text-[11px] font-bold text-paper/80">
            Obligation ratio {preview.eligibility.obligationRatio}% of household
            income (existing {preview.existingObligations.toLocaleString("en-IN")} +
            proposed {preview.proposedMonthly.toLocaleString("en-IN")}/mo) ·{" "}
            {preview.activeLoans} active loan(s)
          </div>

          {preview.eligibility.issues.length > 0 && (
            <div className="flex flex-col gap-2">
              {preview.eligibility.issues.map((issue, i) => (
                <div
                  key={i}
                  className={
                    "flex items-start gap-2 border-2 border-ink p-2 text-[11px] font-bold text-ink " +
                    (issue.level === "BLOCKER" ? "bg-blush" : "bg-gold")
                  }
                >
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    <span className="font-black uppercase">{issue.level} — </span>
                    {issue.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          {preview.eligibility.eligible && (
            <div className="flex items-center gap-2 border-2 border-ink bg-mint p-2 text-[11px] font-black uppercase text-ink">
              <CheckCircle2 className="size-4" /> Eligible under lender policy
            </div>
          )}

          <div>
            <div className="mb-1 text-[10px] font-black uppercase tracking-[0.18em] text-gold">
              Repayment schedule ({preview.schedule.length} periods)
            </div>
            <div className="max-h-64 overflow-y-auto border-2 border-paper/30">
              <div className="grid grid-cols-[2rem_1fr_auto] gap-x-2 border-b-2 border-paper/30 bg-white/10 px-2 py-1 text-[10px] font-black uppercase">
                <span>#</span>
                <span>Due</span>
                <span>Amount</span>
              </div>
              {preview.schedule.map((row) => (
                <div
                  key={row.index}
                  className="grid grid-cols-[2rem_1fr_auto] gap-x-2 border-b border-paper/10 px-2 py-1 text-[11px] font-bold last:border-0"
                >
                  <span className="font-mono">{row.index}</span>
                  <span>
                    {new Date(row.dueDate).toLocaleDateString("en-IN", {
                      day: "2-digit",
                      month: "short",
                    })}
                  </span>
                  <span className="font-mono tabular-nums">
                    ₹{row.totalDue.toLocaleString("en-IN")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <div className="sticky bottom-24 flex gap-2">
        <Button variant="outline" size="lg" className="flex-1" onClick={() => navigate(-1)}>
          Cancel
        </Button>
        <Button
          size="lg"
          className="flex-[2]"
          disabled={!previewReady || !preview || preview === undefined || !preview.eligibility.eligible || submitting}
          onClick={() => void onSubmit()}
        >
          {submitting ? "Submitting…" : "Submit for approval"}
        </Button>
      </div>

      {/* Client picker */}
      <BottomSheet
        open={clientPicker}
        onOpenChange={setClientPicker}
        title="Select client"
        subtitle="Pick the borrower for this application"
      >
        <input
          value={clientSearch}
          onChange={(e) => setClientSearch(e.target.value)}
          placeholder="Search name, code or mobile"
          className="mb-3 h-11 w-full border-2 border-ink bg-white px-3 text-sm font-bold outline-none"
        />
        <div className="flex flex-col gap-2">
          {clients === undefined && <RowSkeleton rows={3} />}
          {(clients ?? []).map((c) => (
            <button
              key={c._id}
              onClick={() => {
                setClientId(c._id);
                setClientPicker(false);
              }}
              className="border-2 border-ink bg-white p-2.5 text-left shadow-hard-sm"
            >
              <span className="block text-sm font-black">{c.name}</span>
              <span className="block text-[11px] font-semibold text-muted-foreground">
                {c.code} · {c.village} · {c.activeLoans} active loans
              </span>
            </button>
          ))}
        </div>
      </BottomSheet>

      {preview && (
        <SectionTitle className="sr-only">Preview summary</SectionTitle>
      )}
      <div className="sr-only">
        <KeyValue k="Client" v={selectedClient?.name ?? "—"} />
      </div>
    </div>
  );
}
