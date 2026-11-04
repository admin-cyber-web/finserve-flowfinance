import { api } from "@/convex/_generated/api";
import { EmptyState, Money, SectionTitle } from "@/components/fs/primitives";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import { Banknote, Building2 } from "lucide-react";
import { useState } from "react";

/**
 * Branch counter cash — every figure is read from the posted cash journal
 * (`journalEntries`, account 1015 "Cash in Hand — Branch / BM", plus 1010 for
 * field wallets and 1020 for bank). Nothing here is stored, editable, seeded or
 * assumed: an empty ledger renders zero, never a demo balance.
 */
export function BranchCashPanel() {
  const data = useQuery(api.cash.branchCash);
  const [selected, setSelected] = useState<string | null>(null);

  if (data === undefined) {
    return (
      <div className="space-y-2">
        <SectionTitle>Branch cash</SectionTitle>
        <div className="h-32 animate-pulse-block border-2 border-ink bg-muted" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="h-16 animate-pulse-block border-2 border-ink bg-muted" />
          <div className="h-16 animate-pulse-block border-2 border-ink bg-muted" />
          <div className="h-16 animate-pulse-block border-2 border-ink bg-muted" />
        </div>
      </div>
    );
  }

  const view =
    (selected
      ? data.branches.find((b) => b.branchId === selected)
      : undefined) ?? data.totals;
  const { today, month } = view;
  const hasLedger = data.entryCount > 0;
  const mismatched = !today.reconciled || !month.reconciled;

  return (
    <section className="space-y-2">
      <SectionTitle
        action={
          <span className="inline-flex items-center gap-1 border-2 border-ink bg-mint px-1.5 py-0.5 text-[10px] font-black uppercase leading-none tracking-wider">
            <Banknote className="size-3" /> Live ledger
          </span>
        }
      >
        Branch cash
      </SectionTitle>

      {data.orgWide && data.branches.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <button
            onClick={() => setSelected(null)}
            className={cn(
              "shrink-0 border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
              selected === null ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
            )}
          >
            All branches
          </button>
          {data.branches.map((b) => (
            <button
              key={b.branchId ?? b.name}
              onClick={() => setSelected(b.branchId)}
              className={cn(
                "shrink-0 border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
                selected === b.branchId
                  ? "bg-navy text-paper shadow-hard-sm"
                  : "bg-white",
              )}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}

      {!hasLedger ? (
        <EmptyState
          title="No cash ledger entries"
          hint="No handovers, issues, collections or disbursements have been posted for this branch yet — balances show ₹0 until real entries exist."
          icon={<Banknote className="size-5" />}
        />
      ) : (
        <>
          {/* Current counter balance */}
          <div className="border-2 border-ink bg-navy p-4 text-paper shadow-hard">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
                  Current counter balance · {view.name}
                </div>
                <Money value={view.counter} className="text-3xl" />
                <div className="mt-1 text-[10px] font-bold uppercase text-paper/70">
                  Cash in hand — branch / BM (ledger 1015)
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[10px] font-black uppercase tracking-[0.18em] text-gold">
                  Bank
                </div>
                <Money value={view.bank} className="text-xl" />
              </div>
            </div>

            {/* Today's cash summary */}
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div className="border-2 border-paper/30 p-1.5">
                <div className="text-[9px] font-black uppercase text-paper/60">
                  Cash brought today
                </div>
                <Money value={today.received} className="text-sm" />
              </div>
              <div className="border-2 border-paper/30 p-1.5">
                <div className="text-[9px] font-black uppercase text-paper/60">
                  Disbursed to clients
                </div>
                <Money value={today.disbursedToClients} className="text-sm" />
                <div className="text-[9px] font-bold uppercase text-paper/60">
                  {today.disbursementCount} loan
                  {today.disbursementCount === 1 ? "" : "s"}
                </div>
              </div>
              <div className="border-2 border-paper/30 p-1.5">
                <div className="text-[9px] font-black uppercase text-paper/60">
                  With field staff
                </div>
                <Money value={view.staffCash} className="text-sm" />
                <div className="text-[9px] font-bold uppercase text-paper/60">
                  Wallets (ledger 1010)
                </div>
              </div>
              <div className="border-2 border-paper/30 p-1.5">
                <div className="text-[9px] font-black uppercase text-paper/60">
                  Cash received today
                </div>
                <Money value={today.cashCollections} className="text-sm" />
                <div className="text-[9px] font-bold uppercase text-paper/60">
                  {today.cashCollectionCount} receipt
                  {today.cashCollectionCount === 1 ? "" : "s"}
                </div>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-black uppercase text-paper/70">
              <span>Opening {fmt(today.opening)}</span>
              <span>In {fmt(today.received)}</span>
              <span>Out {fmt(today.issuedToStaff + today.expenses + today.bankDeposits + today.otherOut)}</span>
              <span>Closing {fmt(today.closing)}</span>
            </div>
          </div>

          {/* This month */}
          <div className="border-2 border-ink bg-card p-3 shadow-hard-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-black uppercase tracking-[0.14em]">
                This month · {data.monthKey}
              </h3>
              <span className="text-[10px] font-black uppercase text-muted-foreground">
                {view.name}
              </span>
            </div>
            <dl className="divide-y-2 divide-ink/10">
              <LedgerRow label="Opening balance" value={month.opening} />
              <LedgerRow
                label="Total cash received"
                value={month.received}
                hint={`Handovers ${fmt(month.handoversIn)}`}
              />
              <LedgerRow
                label="Disbursed to clients"
                value={month.disbursedToClients}
                hint={`${month.disbursementCount} loan${month.disbursementCount === 1 ? "" : "s"}`}
              />
              <LedgerRow
                label="Cash collections"
                value={month.cashCollections}
                hint={`${month.cashCollectionCount} receipt${month.cashCollectionCount === 1 ? "" : "s"}`}
              />
              <LedgerRow
                label="Bank deposits / transfers"
                value={month.bankDeposits}
                hint={month.bankDeposits === 0 ? "No transfers posted" : undefined}
              />
              <LedgerRow label="Issued to field staff" value={month.issuedToStaff} />
              <LedgerRow label="Expenses paid" value={month.expenses} />
              {month.otherIn !== 0 || month.otherOut !== 0 ? (
                <LedgerRow
                  label="Other authorised entries"
                  value={month.otherIn - month.otherOut}
                  hint={`In ${fmt(month.otherIn)} · out ${fmt(month.otherOut)}`}
                />
              ) : null}
              <LedgerRow
                label="Closing counter balance"
                value={month.closing}
                strong
              />
            </dl>
          </div>

          {/* SUPER_ADMIN: branch-wise */}
          {data.orgWide && data.branches.length > 1 && (
            <div className="border-2 border-ink bg-card shadow-hard-sm">
              <div className="flex items-center gap-2 border-b-2 border-ink bg-clay/40 px-3 py-2">
                <Building2 className="size-4" />
                <h3 className="text-xs font-black uppercase tracking-[0.14em]">
                  Branch-wise cash
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-left text-xs">
                  <thead className="border-b-2 border-ink/20 text-[9px] font-black uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5">Branch</th>
                      <th className="px-3 py-1.5 text-right">Counter</th>
                      <th className="px-3 py-1.5 text-right">Today in</th>
                      <th className="px-3 py-1.5 text-right">Today out</th>
                      <th className="px-3 py-1.5 text-right">Month cash in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.branches.map((b) => (
                      <tr
                        key={b.branchId ?? b.name}
                        className={cn(
                          "border-b-2 border-ink/10 last:border-0",
                          selected === b.branchId && "bg-gold/30",
                        )}
                      >
                        <td className="px-3 py-1.5 font-black uppercase">
                          {b.name}
                          <span className="ml-1 text-[10px] font-bold text-muted-foreground">
                            {b.code}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <Money value={b.counter} className="text-xs" />
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <Money value={b.today.received} className="text-xs" />
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <Money value={b.today.disbursedToClients} className="text-xs" />
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <Money value={b.month.received} className="text-xs" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {mismatched && (
            <p className="border-2 border-ink bg-blush p-2 text-[10px] font-black uppercase">
              Ledger check failed for this branch — opening plus movements does not
              equal the posted balance. Ask an accountant to review the journal.
            </p>
          )}
        </>
      )}

      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
        Derived from posted cash journal entries (1015 branch · 1010 field staff ·
        1020 bank). Balances are never stored or editable, and each entry is
        counted once.
      </p>
    </section>
  );
}

function LedgerRow({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: number;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt
        className={cn(
          "text-[11px] font-black uppercase tracking-wide",
          strong ? "text-ink" : "text-muted-foreground",
        )}
      >
        {label}
        {hint && (
          <span className="ml-1 text-[9px] font-bold uppercase text-muted-foreground/80">
            · {hint}
          </span>
        )}
      </dt>
      <dd>
        <Money value={value} className={strong ? "text-base" : "text-sm"} />
      </dd>
    </div>
  );
}

function fmt(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}
