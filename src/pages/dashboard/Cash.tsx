import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  EmptyState,
  KeyValue,
  Money,
  MoneyInput,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  formatDateTime,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProfile } from "@/hooks/use-profile";
import { cn, fmtId } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { HandCoins, PackageCheck, Receipt, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const EXPENSE_CATEGORIES = [
  "Office supplies",
  "Travel & fuel",
  "Staff welfare",
  "Utilities",
  "Field expenses",
  "Other",
];

export default function Cash() {
  const { profile } = useProfile();
  const isStaff = profile?.role === "FIELD_STAFF";
  const isDecisionMaker =
    profile?.role === "BRANCH_MANAGER" || profile?.role === "SUPER_ADMIN";

  const [selectedStaff, setSelectedStaff] = useState<Id<"profiles"> | null>(null);

  const dayBook = useQuery(api.cash.dayBook, selectedStaff ? { profileId: selectedStaff } : {});
  const handovers = useQuery(api.cash.handovers, {});
  const closings = useQuery(api.cash.closings, {});
  const expenses = useQuery(api.cash.expenses, {});
  const issues = useQuery(api.cash.issues, {});

  const requestHandover = useMutation(api.cash.requestHandover);
  const submitClosing = useMutation(api.cash.submitClosing);
  const submitExpense = useMutation(api.cash.submitExpense);
  const issueCash = useMutation(api.cash.issueCash);
  const decideHandover = useMutation(api.cash.decideHandover);
  const decideClosing = useMutation(api.cash.decideClosing);
  const decideExpense = useMutation(api.cash.decideExpense);

  const [handoverAmt, setHandoverAmt] = useState("");
  const [handoverNote, setHandoverNote] = useState("");
  const [closingAmt, setClosingAmt] = useState("");
  const [closingNote, setClosingNote] = useState("");
  const [expAmt, setExpAmt] = useState("");
  const [expCat, setExpCat] = useState(EXPENSE_CATEGORIES[0]);
  const [expNote, setExpNote] = useState("");
  const [issueAmt, setIssueAmt] = useState("");
  const [issueNote, setIssueNote] = useState("");
  const [busy, setBusy] = useState(false);

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

  const day = dayBook?.day ?? null;

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Cash & handovers"
        subtitle={day ? `${day.staffName} · ${dayBook?.dateKey}` : dayBook?.dateKey}
      />

      {/* Staff selector for decision makers */}
      {dayBook && dayBook.wallets.length > 1 && (
        <div className="space-y-1">
          <div className="text-xs font-black uppercase tracking-wider text-muted-foreground">
            Day book for
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            <button
              onClick={() => setSelectedStaff(null)}
              className={cn(
                "shrink-0 border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
                !selectedStaff ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
              )}
            >
              Select…
            </button>
            {dayBook.wallets.map((w) => (
              <button
                key={w.profileId}
                onClick={() => setSelectedStaff(w.profileId)}
                className={cn(
                  "shrink-0 border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
                  selectedStaff === w.profileId
                    ? "bg-navy text-paper shadow-hard-sm"
                    : "bg-white",
                )}
              >
                {w.staffName}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Day book */}
      {dayBook === undefined ? (
        <RowSkeleton rows={4} />
      ) : day === null ? (
        <EmptyState
          title="Day book"
          hint="Select a staff member above to see today's cash movement derived from their wallet ledger."
          icon={<Wallet className="size-5" />}
        />
      ) : (
        <section className="border-2 border-ink bg-navy p-4 text-paper shadow-hard">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
                Expected cash on hand
              </div>
              <Money value={day.expected} className="text-3xl" />
            </div>
            <div className="text-right">
              <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
                Ledger balance
              </div>
              <Money value={day.balance} className="text-xl" />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-3">
            <div className="border-2 border-paper/30 p-1.5">
              <div className="text-[9px] font-black uppercase text-paper/60">Opening</div>
              <Money value={day.opening} className="text-sm" />
            </div>
            <div className="border-2 border-paper/30 p-1.5">
              <div className="text-[9px] font-black uppercase text-paper/60">Cash in</div>
              <Money value={day.cashReceived + day.cashCollections} className="text-sm" />
            </div>
            <div className="border-2 border-paper/30 p-1.5">
              <div className="text-[9px] font-black uppercase text-paper/60">Cash out</div>
              <Money
                value={day.disbursement + day.handover + day.expenses}
                className="text-sm"
              />
            </div>
          </div>
          <div className="mt-2 text-[10px] font-black uppercase text-paper/70">
            Collections {formatIndian(day.cashCollections)} · disbursed{" "}
            {formatIndian(day.disbursement)} · handovers {formatIndian(day.handover)} ·
            expenses {formatIndian(day.expenses)}
          </div>
        </section>
      )}

      <Tabs defaultValue="handovers">
        <TabsList className="h-auto w-full flex-wrap border-2 border-ink bg-white p-1">
          <TabsTrigger value="handovers" className="flex-1 text-xs font-black uppercase">
            Handovers
          </TabsTrigger>
          <TabsTrigger value="closings" className="flex-1 text-xs font-black uppercase">
            Closings
          </TabsTrigger>
          <TabsTrigger value="expenses" className="flex-1 text-xs font-black uppercase">
            Expenses
          </TabsTrigger>
          <TabsTrigger value="issues" className="flex-1 text-xs font-black uppercase">
            Issues
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------ HANDOVERS --------------------------- */}
        <TabsContent value="handovers" className="mt-4 space-y-3">
          {isStaff && (
            <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
              <SectionTitle>Hand cash to your BM</SectionTitle>
              <MoneyInput
                value={handoverAmt}
                onChange={setHandoverAmt}
                label="Amount to hand over"
                quick={[1000, 5000, 10000]}
              />
              <input
                value={handoverNote}
                onChange={(e) => setHandoverNote(e.target.value)}
                placeholder="Remarks (optional)"
                className="h-11 w-full border-2 border-ink bg-white px-3 text-sm font-semibold outline-none"
              />
              <Button
                className="w-full"
                size="lg"
                disabled={!Number(handoverAmt) || busy}
                onClick={() =>
                  void run(async () => {
                    await requestHandover({
                      amount: Number(handoverAmt),
                      remarks: handoverNote.trim() || undefined,
                    });
                    setHandoverAmt("");
                    setHandoverNote("");
                  }, "Handover requested — your BM will accept it")
                }
              >
                <HandCoins className="size-4" /> Request handover
              </Button>
            </section>
          )}

          {handovers === undefined ? (
            <RowSkeleton rows={3} />
          ) : handovers.length === 0 ? (
            <EmptyState title="No handovers" hint="Cash handovers to the branch appear here." />
          ) : (
            handovers.map((h) => (
              <div key={h._id} className="border-2 border-ink bg-card p-3 shadow-hard-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-black">{fmtId(h.code)}</p>
                    <p className="text-[11px] font-semibold text-muted-foreground">
                      {h.staffName} ({h.staffIdCode}) · {formatDateTime(h.requestedAt)}
                    </p>
                    {h.remarks && (
                      <p className="text-[11px] font-semibold">{h.remarks}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <Money value={h.amount} className="block text-base" />
                    <StatusChip status={h.status} />
                  </div>
                </div>
                {isDecisionMaker && h.status === "REQUESTED" && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => decideHandover({ handoverId: h._id, action: "ACCEPTED" }),
                          `Accepted ${fmtId(h.code)} — wallet debited in the ledger`,
                        )
                      }
                    >
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            decideHandover({
                              handoverId: h._id,
                              action: "REJECTED",
                              rejectReason: "Count mismatch at branch",
                            }),
                          `Rejected ${fmtId(h.code)}`,
                        )
                      }
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </TabsContent>

        {/* ------------------------------- CLOSINGS --------------------------- */}
        <TabsContent value="closings" className="mt-4 space-y-3">
          {isStaff && (
            <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
              <SectionTitle>End-of-day cash count</SectionTitle>
              <MoneyInput
                value={closingAmt}
                onChange={setClosingAmt}
                label="Actual cash in hand"
                quick={day ? [day.expected] : []}
              />
              <input
                value={closingNote}
                onChange={(e) => setClosingNote(e.target.value)}
                placeholder="Explanation (required if it doesn't match)"
                className="h-11 w-full border-2 border-ink bg-white px-3 text-sm font-semibold outline-none"
              />
              <p className="text-[11px] font-semibold text-muted-foreground">
                Expected by ledger: {formatIndian(day?.expected ?? 0)}. A difference
                needs an explanation and goes to your BM for approval.
              </p>
              <Button
                className="w-full"
                size="lg"
                disabled={closingAmt === "" || busy}
                onClick={() =>
                  void run(async () => {
                    await submitClosing({
                      actual: Number(closingAmt),
                      explanation: closingNote.trim() || undefined,
                    });
                    setClosingAmt("");
                    setClosingNote("");
                    toast.success("Closing submitted");
                  }, "Closing submitted")
                }
              >
                Submit closing
              </Button>
            </section>
          )}

          {closings === undefined ? (
            <RowSkeleton rows={3} />
          ) : closings.length === 0 ? (
            <EmptyState title="No closings yet" hint="Daily cash closings will show up here." icon={<Receipt className="size-5" />} />
          ) : (
            closings.slice(0, 20).map((c) => (
              <div key={c._id} className="border-2 border-ink bg-card p-3 shadow-hard-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-black">{c.dateKey}</p>
                    <p className="text-[11px] font-semibold text-muted-foreground">
                      {c.staffName} · expected {formatIndian(c.expected)} · actual{" "}
                      {formatIndian(c.actual)}
                    </p>
                    {c.explanation && (
                      <p className="text-[11px] font-semibold">“{c.explanation}”</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <Money
                      value={c.difference}
                      signed
                      className={cn(
                        "block text-sm",
                        c.difference === 0 ? "text-success" : "text-destructive",
                      )}
                    />
                    <StatusChip status={c.status} />
                  </div>
                </div>
                {isDecisionMaker && c.status === "PENDING" && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => decideClosing({ closingId: c._id, action: "APPROVED" }),
                          `Closing for ${c.dateKey} approved`,
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            decideClosing({
                              closingId: c._id,
                              action: "REJECTED",
                              remark: "Please recount and resubmit",
                            }),
                          `Closing for ${c.dateKey} rejected`,
                        )
                      }
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </TabsContent>

        {/* ------------------------------- EXPENSES --------------------------- */}
        <TabsContent value="expenses" className="mt-4 space-y-3">
          {isStaff && (
            <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
              <SectionTitle>Submit an expense</SectionTitle>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={expCat}
                  onChange={(e) => setExpCat(e.target.value)}
                  className="h-11 border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
                >
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <input
                  value={expAmt}
                  onChange={(e) => setExpAmt(e.target.value.replace(/\D/g, ""))}
                  inputMode="numeric"
                  placeholder="Amount ₹"
                  className="h-11 border-2 border-ink bg-white px-2 text-sm font-semibold outline-none"
                />
              </div>
              <input
                value={expNote}
                onChange={(e) => setExpNote(e.target.value)}
                placeholder="What was it for? (required)"
                className="h-11 w-full border-2 border-ink bg-white px-3 text-sm font-semibold outline-none"
              />
              <Button
                className="w-full"
                disabled={!Number(expAmt) || !expNote.trim() || busy}
                onClick={() =>
                  void run(async () => {
                    await submitExpense({
                      amount: Number(expAmt),
                      category: expCat,
                      remarks: expNote.trim(),
                      idempotencyKey: `exp:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
                    });
                    setExpAmt("");
                    setExpNote("");
                  }, "Expense submitted for approval")
                }
              >
                Submit expense
              </Button>
            </section>
          )}

          {expenses === undefined ? (
            <RowSkeleton rows={3} />
          ) : expenses.length === 0 ? (
            <EmptyState title="No expenses" />
          ) : (
            expenses.slice(0, 20).map((e) => (
              <div key={e._id} className="border-2 border-ink bg-card p-3 shadow-hard-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-black">{fmtId(e.code)}</p>
                    <p className="text-[11px] font-semibold text-muted-foreground">
                      {e.category} · {e.staffName} · {formatDateTime(e.createdAt)}
                    </p>
                    <p className="text-[11px] font-semibold">{e.remarks}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Money value={e.amount} className="block text-base" />
                    <StatusChip status={e.status} />
                  </div>
                </div>
                {isDecisionMaker && e.status === "PENDING" && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => decideExpense({ expenseId: e._id, action: "APPROVED" }),
                          `Expense ${fmtId(e.code)} approved`,
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            decideExpense({
                              expenseId: e._id,
                              action: "REJECTED",
                              remark: "Not a valid business expense",
                            }),
                          `Expense ${fmtId(e.code)} rejected`,
                        )
                      }
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </TabsContent>

        {/* -------------------------------- ISSUES ---------------------------- */}
        <TabsContent value="issues" className="mt-4 space-y-3">
          {isDecisionMaker && dayBook && dayBook.wallets.length > 0 && (
            <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
              <SectionTitle>Issue working cash to staff</SectionTitle>
              <MoneyInput
                value={issueAmt}
                onChange={setIssueAmt}
                label="Amount"
                quick={[5000, 10000, 20000]}
              />
              <input
                value={issueNote}
                onChange={(e) => setIssueNote(e.target.value)}
                placeholder="Remarks (optional)"
                className="h-11 w-full border-2 border-ink bg-white px-3 text-sm font-semibold outline-none"
              />
              <Button
                className="w-full"
                disabled={!Number(issueAmt) || !selectedStaff || busy}
                onClick={() =>
                  selectedStaff
                    ? void run(async () => {
                        await issueCash({
                          staffId: selectedStaff,
                          amount: Number(issueAmt),
                          remarks: issueNote.trim() || undefined,
                        });
                        setIssueAmt("");
                        setIssueNote("");
                      }, "Cash issued — wallet credited in the ledger")
                    : undefined
                }
              >
                <PackageCheck className="size-4" /> Issue cash
              </Button>
              {!selectedStaff && (
                <p className="text-[11px] font-bold text-muted-foreground">
                  Select the staff member above first.
                </p>
              )}
            </section>
          )}

          {issues === undefined ? (
            <RowSkeleton rows={3} />
          ) : issues.length === 0 ? (
            <EmptyState title="No cash issues" hint="Cash issued from the branch appears here." />
          ) : (
            issues.slice(0, 20).map((i) => (
              <div
                key={i._id}
                className="flex items-center justify-between gap-3 border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
              >
                <div className="min-w-0">                    <p className="font-mono text-xs font-black">{fmtId(i.code)}</p>
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    {i.staffName} · by {i.bmName} · {formatDateTime(i.createdAt)}
                  </p>
                  {i.remarks && <p className="text-[11px] font-semibold">{i.remarks}</p>}
                </div>
                <Money value={i.amount} className="shrink-0 text-base" />
              </div>
            ))
          )}
        </TabsContent>
      </Tabs>

      {/* Ledger reminder */}
      <div className="border-2 border-ink bg-sky p-3 text-[11px] font-bold">
        Every action here appends to immutable ledgers (wallet transactions +
        double-entry journals). Nothing is ever edited in place.
      </div>
    </div>
  );
}

function formatIndian(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}
