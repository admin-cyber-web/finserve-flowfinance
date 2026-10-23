import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Money, RowSkeleton, SectionTitle, StatusChip } from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery } from "convex/react";
import { Check, CheckCircle2, Users } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

/**
 * Centre-Wise Loan Disbursement — the PRIMARY path of the New Loan flow.
 *
 * An authorised user picks a centre and a product, selects all (or some) of
 * the centre's members, reviews the batch, and confirms. The backend then
 * creates ONE SUBMITTED application per selected client through the same
 * policy engine and duplicate guards as a single loan: nothing is approved
 * or disbursed here — the existing approval workflow (and its authorised
 * approvers, wallet limits and cash controls) decides what happens next.
 * Ineligible members are shown with their reasons and skipped, never
 * silently included.
 */
export function CenterWiseLoan() {
  const navigate = useNavigate();
  const [productId, setProductId] = useState<Id<"loanProducts"> | null>(null);
  const [centerId, setCenterId] = useState<Id<"centers"> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    Awaited<ReturnType<typeof submitBatch>> | null
  >(null);

  const products = useQuery(api.loans.products, {});
  const centers = useQuery(api.loans.centerOptions, {});
  const roster = useQuery(
    api.loans.centerRoster,
    centerId ? { centerId, productId: productId ?? undefined } : "skip",
  );
  const submitBatch = useMutation(api.loans.submitCenterBatch);

  const product = products?.find((p) => p._id === productId) ?? null;
  const amount = product?.minAmount ?? 0;

  // A new centre or product invalidates the previous member selection —
  // cleared in the pick handlers below (never inside an effect).
  const pickCenter = (id: Id<"centers">) => {
    if (id === centerId) return;
    setCenterId(id);
    setSelected(new Set());
    setResult(null);
  };
  const pickProduct = (id: Id<"loanProducts">) => {
    if (id === productId) return;
    setProductId(id);
    setSelected(new Set());
    setResult(null);
  };

  const selectedRows = (roster?.rows ?? []).filter(
    (r) => r.eligible && selected.has(r.client._id),
  );
  const totalPrincipal = selectedRows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const totalFees = selectedRows.reduce((s, r) => s + (r.charges ?? 0), 0);

  const toggle = (clientId: string, eligible: boolean) => {
    if (!eligible) return;
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  };

  const eligibleRows = (roster?.rows ?? []).filter((r) => r.eligible);
  const selectAll = () => {
    setSelected(new Set(eligibleRows.map((r) => r.client._id)));
  };
  const clearSelection = () => setSelected(new Set());

  const onConfirm = async () => {
    if (!productId || !centerId) return;
    setSubmitting(true);
    try {
      const res = await submitBatch({
        centerId,
        productId,
        amount,
        clientIds: [...selected] as Id<"clients">[],
        device: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 60) : undefined,
      });
      setConfirming(false);
      setResult(res);
      setSelected(new Set());
      if (res.createdCount > 0) {
        toast.success(
          `${res.createdCount} loan request(s) submitted for approval`,
        );
      }
      if (res.createdCount === 0) {
        toast.error("No loan requests were created — see the batch report.");
      } else if (res.skippedCount > 0) {
        toast.warning(
          `${res.skippedCount} client(s) skipped — see the batch report.`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Batch submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  const cardBase =
    "w-full border-2 border-ink p-3 text-left shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none";
  const sectionLabel =
    "text-xs font-black uppercase tracking-[0.14em] text-muted-foreground";

  return (
    <div className="space-y-4">
      {/* Step 1 — product (the selected product fixes the amount, fee and
          terms for every member in the batch). */}
      <section className="space-y-2 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className={sectionLabel}>1 · Loan product</h2>
        {products === undefined ? (
          <RowSkeleton rows={2} />
        ) : products.length === 0 ? (
          <p className="border-2 border-dashed border-ink p-3 text-center text-xs font-bold text-muted-foreground">
            No active loan products are configured.
          </p>
        ) : (
          <div className="grid gap-2">
            {products.map((p) => (
              <button
                key={p._id}
                onClick={() => pickProduct(p._id)}
                className={
                  cardBase + " " + (productId === p._id ? "bg-gold" : "bg-white")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-black">{p.name}</span>
                  <span className="font-mono text-xs font-black">{p.code}</span>
                </div>
                <div className="mt-1 text-[11px] font-semibold text-muted-foreground">
                  ₹{p.minAmount.toLocaleString("en-IN")} · processing fee ₹
                  {Math.round(
                    p.processingFee + (p.minAmount * p.chargePercent) / 100,
                  ).toLocaleString("en-IN")}{" "}
                  · {p.interestRate}% {p.interestMethod.toLowerCase()} ·{" "}
                  {p.tenure} {p.frequency.toLowerCase()} installments
                </div>
              </button>
            ))}
          </div>
        )}
        {product && (
          <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
            Every loan in this batch uses {product.name}'s fixed principal of ₹
            {amount.toLocaleString("en-IN")} — the amount, fee and schedule are
            the product's, set by the backend.
          </p>
        )}
      </section>

      {/* Step 2 — centre */}
      <section className="space-y-2 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className={sectionLabel}>2 · Centre</h2>
        {centers === undefined ? (
          <RowSkeleton rows={2} />
        ) : centers.length === 0 ? (
          <p className="border-2 border-dashed border-ink p-3 text-center text-xs font-bold text-muted-foreground">
            No centres yet — create one from the New Client form first.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {centers.map((c) => (
              <button
                key={c._id}
                onClick={() => pickCenter(c._id)}
                className={
                  cardBase + " " + (centerId === c._id ? "bg-gold" : "bg-white")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-black">
                    {c.name}
                  </span>
                  <span className="shrink-0 border-2 border-ink bg-navy px-2 py-0.5 font-mono text-[10px] font-black text-gold">
                    {c.code}
                  </span>
                </div>
                <div className="mt-1 text-[11px] font-semibold text-muted-foreground">
                  {c.village || "—"} · {c.clientCount} member
                  {c.clientCount === 1 ? "" : "s"}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Step 3 — members */}
      <section className="space-y-2 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={sectionLabel}>3 · Members</h2>
          {roster && roster.rows.length > 0 && (
            <div className="flex gap-1.5">
              <button
                onClick={selectAll}
                disabled={eligibleRows.length === 0}
                className="border-2 border-ink bg-mint px-2.5 py-1.5 text-[10px] font-black uppercase shadow-hard-sm disabled:opacity-50"
              >
                Select all eligible ({eligibleRows.length})
              </button>
              <button
                onClick={clearSelection}
                disabled={selected.size === 0}
                className="border-2 border-ink bg-white px-2.5 py-1.5 text-[10px] font-black uppercase shadow-hard-sm disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {!centerId ? (
          <p className="border-2 border-dashed border-ink p-3 text-center text-xs font-bold text-muted-foreground">
            Pick a centre above to load its members.
          </p>
        ) : roster === undefined ? (
          <RowSkeleton rows={4} />
        ) : roster.rows.length === 0 ? (
          <p className="border-2 border-dashed border-ink p-3 text-center text-xs font-bold text-muted-foreground">
            No clients are linked to {roster.center.name} yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {!product && (
              <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
                Choose a product above to score each member against its policy
                and see loan amounts.
              </p>
            )}
            {roster.rows.map((r) => {
              const checked = selected.has(r.client._id);
              return (
                <div
                  key={r.client._id}
                  className={
                    "flex items-start gap-3 border-2 border-ink p-2.5 shadow-hard-sm " +
                    (r.eligible ? (checked ? "bg-gold" : "bg-white") : "bg-muted")
                  }
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={`Select ${r.client.name}`}
                    disabled={!r.eligible}
                    onClick={() => toggle(r.client._id, r.eligible)}
                    className="mt-0.5 grid size-6 shrink-0 place-items-center border-2 border-ink bg-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {checked && <Check className="size-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-black">{r.client.name}</span>
                      <span className="font-mono text-[11px] font-bold text-muted-foreground">
                        {r.client.code}
                      </span>
                      <StatusChip
                        label={r.client.kycStatus}
                        tone={
                          r.client.kycStatus === "VERIFIED"
                            ? "ok"
                            : r.client.kycStatus === "REJECTED"
                              ? "bad"
                              : "warn"
                        }
                      />
                      {r.pendingApplication && (
                        <StatusChip
                          label={`Pending ${r.pendingApplication.appId}`}
                          tone="warn"
                        />
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] font-semibold text-muted-foreground">
                      {r.client.village} · {r.activeLoans} active loan
                      {r.activeLoans === 1 ? "" : "s"}
                      {r.overdueHistory > 0
                        ? ` · overdue history ${r.overdueHistory}`
                        : ""}
                    </div>
                    {r.amount !== null && (
                      <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] font-bold">
                        <span>
                          Loan <Money value={r.amount} className="text-[11px]" />
                        </span>
                        <span>
                          Fee <Money value={r.charges ?? 0} className="text-[11px]" />
                        </span>
                        <span>
                          Installment{" "}
                          <Money
                            value={r.installment ?? 0}
                            className="text-[11px]"
                          />
                        </span>
                      </div>
                    )}
                    {r.blockers.map((b, i) => (
                      <p
                        key={`b${i}`}
                        className="mt-1 border-2 border-ink bg-blush px-2 py-1 text-[10px] font-black uppercase"
                      >
                        {b}
                      </p>
                    ))}
                    {r.warnings.map((w, i) => (
                      <p
                        key={`w${i}`}
                        className="mt-1 border-2 border-ink bg-gold px-2 py-1 text-[10px] font-black uppercase"
                      >
                        {w}
                      </p>
                    ))}
                  </div>
                  <StatusChip
                    label={r.eligible ? "Eligible" : "Blocked"}
                    tone={r.eligible ? "ok" : "bad"}
                    className="shrink-0"
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Step 4 — review */}
      {product && roster && selectedRows.length > 0 && (
        <section className="space-y-3 border-2 border-ink bg-navy p-4 text-paper shadow-hard">
          <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
            4 · Review the batch
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Centre
              </div>
              <div className="text-sm font-black">
                {roster.center.name} ({roster.center.code})
              </div>
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Members selected
              </div>
              <div className="text-lg font-black">{selectedRows.length}</div>
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Total proposed disbursement
              </div>
              <Money value={totalPrincipal} className="text-lg" />
            </div>
            <div className="border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Processing fees
              </div>
              <Money value={totalFees} className="text-lg" />
            </div>
            <div className="col-span-2 border-2 border-paper/30 p-2">
              <div className="text-[9px] font-black uppercase text-paper/60">
                Terms — each client
              </div>
              <div className="text-sm font-black">
                ₹{amount.toLocaleString("en-IN")} principal · fee ₹
                {(selectedRows[0]?.charges ?? 0).toLocaleString("en-IN")} ·{" "}
                {product.tenure} × {product.frequency.toLowerCase()} @{" "}
                {product.interestRate}% reducing · installment ₹
                {(selectedRows[0]?.installment ?? 0).toLocaleString("en-IN")}
              </div>
            </div>
          </div>

          <div className="max-h-48 overflow-y-auto border-2 border-paper/30">
            {selectedRows.map((r) => (
              <div
                key={r.client._id}
                className="flex items-center justify-between gap-2 border-b border-paper/10 px-2 py-1.5 text-[11px] font-bold last:border-0"
              >
                <span className="min-w-0 truncate">
                  {r.client.name}{" "}
                  <span className="font-mono text-muted-foreground">
                    {r.client.code}
                  </span>
                </span>
                <span className="shrink-0 font-mono tabular-nums">
                  ₹{(r.amount ?? 0).toLocaleString("en-IN")} + fee ₹
                  {(r.charges ?? 0).toLocaleString("en-IN")}
                </span>
              </div>
            ))}
          </div>

          <p className="border-2 border-ink bg-gold p-2 text-[11px] font-black uppercase text-ink">
            Submitting creates one pending loan request per member — nothing is
            approved or disbursed here. Approvers, wallet limits and cash
            controls apply exactly as for a single loan.
          </p>

          <Button size="lg" className="w-full" onClick={() => setConfirming(true)}>
            <CheckCircle2 /> Review & confirm {selectedRows.length} loan
            {selectedRows.length === 1 ? "" : "s"}
          </Button>
        </section>
      )}

      {/* Batch report — accurate partial-failure reporting. */}
      {result && (
        <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
          <SectionTitle>
            Batch report — {result.centerName} ({result.centerCode})
          </SectionTitle>
          {result.createdCount > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-black uppercase text-muted-foreground">
                Submitted for approval ({result.createdCount})
              </p>
              <div className="flex flex-col gap-1">
                {result.created.map((c) => (
                  <div
                    key={c.appId}
                    className="flex items-center justify-between gap-2 border-2 border-ink bg-mint px-2 py-1.5 text-[11px] font-bold"
                  >
                    <span className="min-w-0 truncate">
                      {c.name}{" "}
                      <span className="font-mono text-muted-foreground">
                        {c.code}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono font-black">
                      {c.appId}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {result.skippedCount > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-black uppercase text-destructive">
                Skipped ({result.skippedCount})
              </p>
              <div className="flex flex-col gap-1">
                {result.skipped.map((s) => (
                  <div
                    key={s.clientId}
                    className="border-2 border-ink bg-blush px-2 py-1.5 text-[11px] font-bold"
                  >
                    <span className="font-black">{s.name}</span>{" "}
                    <span className="font-mono">({s.code})</span> — {s.reason}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setResult(null)}
            >
              Start another batch
            </Button>
            <Button
              className="flex-1"
              onClick={() => navigate("/dashboard/approvals")}
            >
              <Users className="size-4" /> Go to approvals
            </Button>
          </div>
        </section>
      )}

      {/* Confirmation — required before anything is written. */}
      {confirming && product && roster && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-sm border-2 border-ink bg-card p-4 shadow-hard">
              <h3 className="text-lg font-black uppercase tracking-tight">
                Confirm centre-wise batch
              </h3>
              <p className="mt-2 text-sm font-semibold">
                Create <span className="font-black">{selectedRows.length}</span>{" "}
                loan request(s) of{" "}
                <span className="font-black">
                  ₹{amount.toLocaleString("en-IN")}
                </span>{" "}
                each for members of{" "}
                <span className="font-black">
                  {roster.center.name} ({roster.center.code})
                </span>{" "}
                under {product.name}? Each request goes to the approval queue.
              </p>
              <div className="mt-3 border-2 border-ink bg-sky p-2 text-[11px] font-bold">
                Total proposed disbursement ₹
                {totalPrincipal.toLocaleString("en-IN")} · fees ₹
                {totalFees.toLocaleString("en-IN")}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  onClick={() => setConfirming(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  disabled={submitting || selectedRows.length === 0}
                  onClick={() => void onConfirm()}
                >
                  {submitting ? "Submitting…" : "Confirm"}
                </Button>
              </div>
          </div>
        </div>
      )}
    </div>
  );
}
