import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  EmptyState,
  PageHeader,
  RowSkeleton,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { formatINR } from "@/lib/finance/money";
import { formatMeetingDateShort } from "@/lib/meeting";
import { newIdempotencyKey } from "@/lib/offline";
import { cn, fmtId } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { Coins, IndianRupee, Loader2, Lock, Search } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Collection — post a payment against an open loan.
 *
 * The list comes from `collections.dueList` (open loans with money due as of
 * today, scoped server-side to the viewer's role/branch, searchable by group
 * name, group ID and LAN). Saving posts through the EXISTING backend
 * workflow — `collections.collect` → `recordCollection` — which owns amount
 * validation, idempotency (duplicate prevention), the wallet ledger, the
 * numbered receipt, the journal entry and the schedule/loan roll-forward.
 * Nothing on this screen writes to the database directly.
 */

const MODES = [
  { id: "CASH", label: "Cash", tone: "bg-mint" },
  { id: "UPI", label: "UPI", tone: "bg-sky" },
  { id: "BANK", label: "Bank", tone: "bg-clay" },
] as const;

const TH_CLS =
  "border border-ink bg-muted px-1.5 py-1 text-left text-[10px] font-black uppercase whitespace-nowrap";
const TD_CLS = "border border-ink px-1.5 py-1 font-semibold";

type Row = NonNullable<Awaited<ReturnType<typeof useQuery>>>[number];

/**
 * React-side convenience for the collection board. The Convex query returns the
 * server `dueList` shape, so `Row` already carries loanPk, loanId,
 * clientCode, customerName, arrear, totalDue, groupId and groupName. The
 * `CollectionRow` cast is only used in the save handler for behaviour that does
 * not care about the exact visible shape.
 */
type CollectionRow = Row;

export default function Collection() {
  const { can } = useProfile();
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("CASH");
  const rows = useQuery(
    api.collections.dueList,
    can("collect_payment") ? { q: q.trim() || undefined } : "skip",
  );
  const collect = useMutation(api.collections.collect);

  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // One idempotency key per loan, created when a submission is first
  // attempted and kept until it succeeds. A repeated click (or a retry after
  // a network error) re-uses the key, so the backend can never post the same
  // payment twice.
  const keysRef = useRef<Record<string, string>>({});

  const save = async (row: Row) => {
    if (busyKey) return; // one submission in flight at a time
    const raw = (amounts[row.loanPk] ?? String(row.totalDue)).trim();
    const amount = Number(raw);
    if (!raw || !Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid collect amount greater than zero.");
      return;
    }
    const key = keysRef.current[row.loanPk] ?? newIdempotencyKey("pay");
    keysRef.current[row.loanPk] = key;
    setBusyKey(row.loanPk);
    try {
      // Backend re-validates everything: amount, loan status, permissions.
      const result = await collect({
        loanId: row.loanPk as Id<"loans">,
        amount,
        mode,
        idempotencyKey: key,
        device: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 60) : undefined,
      });
      delete keysRef.current[row.loanPk];
      setAmounts((cur) => {
        const next = { ...cur };
        delete next[row.loanPk];
        return next;
      });
      // Success is only shown once the backend has confirmed the write.
      if (result.duplicate) {
        toast.warning(
          `Already recorded — receipt ${fmtId(result.receiptNumber)} (${formatINR(amount)}, ${fmtId(row.loanId)}).`,
        );
      } else {
        toast.success(
          `${formatINR(amount)} collected from ${row.customerName} (${fmtId(row.loanId)}) — receipt ${fmtId(result.receiptNumber)}.`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Collection failed.");
    } finally {
      setBusyKey(null);
    }
  };

  if (!can("collect_payment")) {
    return (
      <div className="space-y-4">
        <PageHeader title="Collection" subtitle="Post a payment against an open loan" />
        <EmptyState
          title="Not authorised"
          hint="Your role does not include the collect-payment permission."
          icon={<Lock className="size-5" />}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Collection"
        subtitle="Post a payment against an open loan — saved to the ledger with a receipt"
      />

      {/* Search — the three ways this sheet is searched */}
      <div className="space-y-1">
        <label
          htmlFor="coll-search"
          className="block text-[11px] font-black uppercase"
        >
          Search With Group Name / Group ID / LAN ID
        </label>
        <div className="flex items-center border-2 border-ink bg-white shadow-hard-sm">
          <Search className="ml-3 size-4 shrink-0 text-muted-foreground" />
          <input
            id="coll-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Group name · GRPMDG · LN000123"
            className="h-11 w-full bg-transparent px-3 text-sm font-bold outline-none"
          />
        </div>
      </div>

      {/* Payment mode — required by the ledger for every collection */}
      <div className="space-y-1">
        <span className="block text-[11px] font-black uppercase">
          Payment mode
        </span>
        <div className="flex gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={cn(
                "flex-1 border-2 border-ink px-2 py-2 text-[11px] font-black uppercase",
                mode === m.id ? `${m.tone} shadow-hard-sm` : "bg-white",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {rows === undefined ? (
        <RowSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing to collect"
          hint={
            q.trim()
              ? `No group name, group ID or LAN matches “${q.trim()}”.`
              : "No open loan has an installment due as of today."
          }
          icon={<Coins className="size-5" />}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-2 border-ink text-xs">
            <thead>
              <tr>
                {[
                  "Sr. No.",
                  "Client ID",
                  "Loan ID",
                  "Customer Name",
                  "Meeting Day",
                  "Due Date",
                  "Arrear",
                  "Total Due",
                  "Collect Amount",
                ].map((h) => (
                  <th key={h} className={TH_CLS}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r: Row, i) => {
                const busy = busyKey === r.loanPk;
                return (
                  <tr key={r.loanPk} className="hover:bg-sky/40">
                    <td className={cn(TD_CLS, "text-center font-black")}>
                      {i + 1}
                    </td>
                    <td className={cn(TD_CLS, "font-mono whitespace-nowrap")}>
                      {fmtId(r.clientCode)}
                    </td>
                    <td className={cn(TD_CLS, "font-mono whitespace-nowrap")}>
                      {fmtId(r.loanId)}
                    </td>
                    <td className={TD_CLS}>{r.customerName}</td>
                    <td className={cn(TD_CLS, "whitespace-nowrap")}>
                      {r.centerMeetingDay ?? "—"}
                    </td>
                    <td className={cn(TD_CLS, "whitespace-nowrap")}>
                      {r.dueDate ? formatMeetingDateShort(r.dueDate) : "—"}
                    </td>
                    <td
                      className={cn(
                        TD_CLS,
                        "text-right whitespace-nowrap",
                        r.arrear > 0 && "font-black text-destructive",
                      )}
                    >
                      {formatINR(r.arrear)}
                    </td>
                    <td className={cn(TD_CLS, "text-right whitespace-nowrap")}>
                      {formatINR(r.totalDue)}
                    </td>
                    <td className={TD_CLS}>
                      <div className="flex items-center gap-1.5">
                        <input
                          inputMode="decimal"
                          value={amounts[r.loanPk] ?? String(r.totalDue)}
                          onChange={(e) =>
                            setAmounts((cur) => ({
                              ...cur,
                              [r.loanPk]: e.target.value.replace(/[^\d.]/g, ""),
                            }))
                          }
                          className="h-9 w-24 border-2 border-ink bg-white px-2 text-right text-xs font-black outline-none"
                          aria-label={`Collect amount for ${fmtId(r.loanId)}`}
                        />
                        <Button
                          size="sm"
                          disabled={busyKey !== null}
                          onClick={() => void save(r)}
                        >
                          {busy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <IndianRupee className="size-3.5" />
                          )}
                          Save
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
        Saving posts through the existing collection workflow: amount
        validation, idempotency (a repeated click can never double-post), the
        wallet ledger, a numbered receipt, the journal entry and the loan's
        schedule, outstanding and arrears all update together. Balances on this
        screen refresh automatically once the backend confirms.
      </p>
    </div>
  );
}
