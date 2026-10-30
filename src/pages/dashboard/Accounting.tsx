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
import { cn, fmtId } from "@/lib/utils";
import { useQuery } from "convex/react";
import { BookOpen } from "lucide-react";
import { useState } from "react";

const BOOKS = [
  { id: "CASH", label: "Cash book" },
  { id: "BANK", label: "Bank book" },
  { id: "JOURNAL", label: "Journal" },
  { id: "TRIAL_BALANCE", label: "Trial balance" },
  { id: "INCOME", label: "Income" },
  { id: "EXPENSE", label: "Expense" },
  { id: "RECEIVABLE", label: "Receivable" },
] as const;

type BookId = (typeof BOOKS)[number]["id"];

interface LedgerRow {
  entryId: string;
  dateKey: string;
  createdAt: number;
  memo: string;
  refType?: string;
  refId?: string;
  debit: number;
  credit: number;
  balance?: number;
}

interface JournalRow {
  entryId: string;
  dateKey: string;
  createdAt: number;
  memo: string;
  refType?: string;
  refId?: string;
  lines: { code: string; name?: string; debit: number; credit: number }[];
  debit: number;
  credit: number;
}

interface TrialRow {
  account: { code: string; name: string; normalSide: string };
  debit: number;
  credit: number;
  balance: number;
}

export default function Accounting() {
  const [book, setBook] = useState<BookId>("CASH");
  const data = useQuery(api.reports.books, { book, limit: 200 });

  const isTrial = book === "TRIAL_BALANCE";
  const isJournal = book === "JOURNAL";

  const rows = ((data?.rows ?? []) as (LedgerRow | null | undefined)[]).filter(
    (r): r is LedgerRow => r != null,
  );

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Accounting"
        subtitle="Double-entry books — every entry balanced"
        action={
          data?.totals && "balanced" in data.totals ? (
            <StatusChip
              label={(data.totals as { balanced: boolean }).balanced ? "Balanced" : "Out of balance"}
              tone={(data.totals as { balanced: boolean }).balanced ? "ok" : "bad"}
            />
          ) : undefined
        }
      />

      <div className="flex flex-wrap gap-1.5">
        {BOOKS.map((b) => (
          <button
            key={b.id}
            onClick={() => setBook(b.id)}
            className={cn(
              "border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
              book === b.id ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
            )}
          >
            {b.label}
          </button>
        ))}
      </div>

      {/* Totals */}
      {data?.totals && (
        <div className="grid grid-cols-3 gap-2">
          {"totalDebit" in data.totals ? (
            <>
              <div className="border-2 border-ink bg-card p-3 text-center shadow-hard-sm">
                <div className="text-[10px] font-black uppercase text-muted-foreground">
                  Total debit
                </div>
                <Money value={(data.totals as { totalDebit: number }).totalDebit} className="text-lg" />
              </div>
              <div className="border-2 border-ink bg-card p-3 text-center shadow-hard-sm">
                <div className="text-[10px] font-black uppercase text-muted-foreground">
                  Total credit
                </div>
                <Money value={(data.totals as { totalCredit: number }).totalCredit} className="text-lg" />
              </div>
              <div className="border-2 border-ink bg-mint p-3 text-center shadow-hard-sm">
                <div className="text-[10px] font-black uppercase text-muted-foreground">
                  Status
                </div>
                <div className="text-sm font-black uppercase">
                  {(data.totals as { balanced: boolean }).balanced ? "✓ Balanced" : "✗ Differs"}
                </div>
              </div>
            </>
          ) : "closingBalance" in data.totals ? (
            <>
              <div className="border-2 border-ink bg-card p-3 text-center shadow-hard-sm">
                <div className="text-[10px] font-black uppercase text-muted-foreground">Debit</div>
                <Money value={(data.totals as { debit: number }).debit} className="text-lg" />
              </div>
              <div className="border-2 border-ink bg-card p-3 text-center shadow-hard-sm">
                <div className="text-[10px] font-black uppercase text-muted-foreground">Credit</div>
                <Money value={(data.totals as { credit: number }).credit} className="text-lg" />
              </div>
              <div className="border-2 border-ink bg-gold p-3 text-center shadow-hard-sm">
                <div className="text-[10px] font-black uppercase text-muted-foreground">
                  Closing balance
                </div>
                <Money
                  value={(data.totals as { closingBalance: number }).closingBalance}
                  className="text-lg"
                />
              </div>
            </>
          ) : null}
        </div>
      )}

      {data === undefined ? (
        <RowSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No entries yet"
          hint="Journal entries post as soon as disbursements, collections and cash movements happen."
          icon={<BookOpen className="size-5" />}
        />
      ) : isTrial ? (
        <div className="overflow-x-auto border-2 border-ink bg-card shadow-hard-sm">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b-2 border-ink bg-gold text-[10px] font-black uppercase">
                <th className="px-2 py-2">Code</th>
                <th className="px-2 py-2">Account</th>
                <th className="px-2 py-2 text-right">Debit</th>
                <th className="px-2 py-2 text-right">Credit</th>
                <th className="px-2 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {(rows as unknown as TrialRow[]).map((r) => (
                <tr key={r.account.code} className="border-b border-ink/15 last:border-0">
                  <td className="px-2 py-1.5 font-mono font-black">{fmtId(r.account.code)}</td>
                  <td className="px-2 py-1.5 font-semibold">{r.account.name}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {r.debit.toLocaleString("en-IN")}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {r.credit.toLocaleString("en-IN")}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-1.5 text-right font-mono font-black tabular-nums",
                      r.balance < 0 && "text-destructive",
                    )}
                  >
                    {r.balance.toLocaleString("en-IN")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : isJournal ? (
        <div className="flex flex-col gap-2">
          {(rows as unknown as JournalRow[]).map((r) => (
            <div key={r.entryId} className="border-2 border-ink bg-card p-3 shadow-hard-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-black">{fmtId(r.entryId)}</span>
                <span className="text-[10px] font-black uppercase text-muted-foreground">
                  {formatDate(r.createdAt)}
                </span>
              </div>
              <p className="text-[11px] font-semibold">{r.memo}</p>
              <div className="mt-1">
                {r.lines.map((l, i) => (
                  <div
                    key={i}
                    className="flex justify-between border-b border-ink/10 py-0.5 text-[11px] font-bold last:border-0"
                  >
                    <span>
                      {fmtId(l.code)} {l.name ? `· ${l.name}` : ""}
                      {l.debit > 0 ? " — Dr" : " — Cr"}
                    </span>
                    <span className="font-mono tabular-nums">
                      ₹{(l.debit || l.credit).toLocaleString("en-IN")}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[11px] font-black">
                <span>Dr ₹{r.debit.toLocaleString("en-IN")}</span>
                <span>Cr ₹{r.credit.toLocaleString("en-IN")}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto border-2 border-ink bg-card shadow-hard-sm">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b-2 border-ink bg-navy text-[10px] font-black uppercase text-paper">
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Memo</th>
                <th className="px-2 py-2 text-right">Debit</th>
                <th className="px-2 py-2 text-right">Credit</th>
                <th className="px-2 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {(rows as unknown as LedgerRow[]).map((r) => (
                <tr key={r.entryId} className="border-b border-ink/15 last:border-0">
                  <td className="px-2 py-1.5 font-semibold whitespace-nowrap">
                    {formatDate(r.createdAt)}
                  </td>
                  <td className="max-w-[180px] truncate px-2 py-1.5 font-semibold">
                    {r.memo}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {r.debit ? r.debit.toLocaleString("en-IN") : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {r.credit ? r.credit.toLocaleString("en-IN") : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono font-black tabular-nums">
                    {(r.balance ?? 0).toLocaleString("en-IN")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Integrity</SectionTitle>
      <p className="border-2 border-ink bg-sky p-3 text-xs font-bold">
        The server refuses to write any journal entry that doesn't balance, so
        this trial balance can't drift. Figures update live as transactions post.
      </p>
    </div>
  );
}
