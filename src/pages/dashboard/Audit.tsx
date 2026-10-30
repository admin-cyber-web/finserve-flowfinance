import { api } from "@/convex/_generated/api";
import {
  EmptyState,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  formatDateTime,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { cn, fmtId } from "@/lib/utils";
import { useQuery } from "convex/react";
import { ArrowRight, GitBranch, ShieldCheck } from "lucide-react";
import React, { type ReactNode } from "react";
import { useState } from "react";

const ENTITIES = [
  "ALL",
  "loanApplications",
  "loans",
  "collections",
  "clients",
  "profiles",
  "wallets",
  "walletTransactions",
  "cashHandovers",
  "cashClosings",
  "expenses",
];

const KINDS = [
  { id: "collection", label: "Collection (code PY…)" },
  { id: "loan", label: "Loan (LN…)" },
  { id: "receipt", label: "Receipt (RCPT…)" },
  { id: "walletTxn", label: "Wallet txn reference" },
];

/** Isolates money-trail query errors (bad reference ids) from the page. */
class TrailBoundary extends React.Component<
  { children: ReactNode; fallback: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}

function TrailPanel({ kind, id, direction }: { kind: string; id: string; direction: string }) {
  const trail = useQuery(api.admin.moneyTrail, { kind, id, direction });
  return (
    <div className="space-y-3">
      <SectionTitle>Path of this rupee ({direction})</SectionTitle>
      <div className="flex flex-col gap-2">
        {(trail?.nodes ?? []).map((n, i) => (
          <div key={n.id} className="border-2 border-ink bg-card p-3 shadow-hard-sm">
            <div className="flex items-center justify-between gap-2">
              <StatusChip label={n.kind} tone="info" />
              <span className="text-[10px] font-black uppercase text-muted-foreground">
                step {i + 1}
              </span>
            </div>
            <p className="mt-1 text-sm font-black">{n.title}</p>
            {n.subtitle && (
              <p className="text-[11px] font-semibold text-muted-foreground">{n.subtitle}</p>
            )}
            {n.amount !== undefined && (
              <p className="text-xs font-black">₹{n.amount.toLocaleString("en-IN")}</p>
            )}
          </div>
        ))}
      </div>
      <SectionTitle>Edges</SectionTitle>
      <div className="flex flex-col gap-1.5">
        {(trail?.edges ?? []).map((e, i) => (
          <div
            key={i}
            className="flex items-center gap-2 border-2 border-ink bg-sky px-2 py-1.5 text-[11px] font-bold shadow-hard-sm"
          >
            <span className="truncate font-mono">{e.from}</span>
            <ArrowRight className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{e.to}</span>
            <span className="ml-auto shrink-0 border-l-2 border-ink pl-2 text-[10px] font-black uppercase">
              {e.label}
            </span>
          </div>
        ))}
        {(trail?.edges.length ?? 0) === 0 && (
          <p className="text-xs font-semibold text-muted-foreground">
            No edges — the reference may not exist yet.
          </p>
        )}
      </div>
    </div>
  );
}

export default function Audit() {
  const [tab, setTab] = useState<"log" | "trail">("log");
  const [entity, setEntity] = useState("ALL");
  const [search, setSearch] = useState("");

  const logs = useQuery(api.admin.auditLogs, {
    limit: 100,
    entity: entity === "ALL" ? undefined : entity,
    search: search.trim() || undefined,
  });

  const [kind, setKind] = useState("collection");
  const [id, setId] = useState("");
  const [direction, setDirection] = useState<"forward" | "reverse">("forward");

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Audit & money trail"
        subtitle="Who did what — and where every rupee went"
        action={<ShieldCheck className="size-6 text-success" />}
      />

      <div className="flex gap-2">
        {(["log", "trail"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 border-2 border-ink py-2.5 text-xs font-black uppercase",
              tab === t ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
            )}
          >
            {t === "log" ? "Audit log" : "Money trail"}
          </button>
        ))}
      </div>

      {tab === "log" ? (
        <>
          <div className="flex items-center border-2 border-ink bg-white shadow-hard-sm">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search action, actor or reference…"
              className="h-11 w-full bg-transparent px-3 text-sm font-bold outline-none"
            />
          </div>

          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {ENTITIES.map((e) => (
              <button
                key={e}
                onClick={() => setEntity(e)}
                className={cn(
                  "shrink-0 border-2 border-ink px-2 py-1 text-[10px] font-black uppercase",
                  entity === e ? "bg-gold shadow-hard-sm" : "bg-white",
                )}
              >
                {e === "ALL" ? "All" : e}
              </button>
            ))}
          </div>

          {logs === undefined ? (
            <RowSkeleton rows={6} />
          ) : logs.length === 0 ? (
            <EmptyState
              title="No audit entries"
              hint="Every mutation writes an audit line — sign in and do something."
              icon={<ShieldCheck className="size-5" />}
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              {logs.map((a) => (
                <details
                  key={a._id}
                  className="group border-2 border-ink bg-card px-3 py-2 shadow-hard-sm"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-black uppercase">
                        {a.action.replace(/_/g, " ")}
                      </span>
                      <span className="block truncate text-[11px] font-semibold text-muted-foreground">
                        {a.actorName} ({a.role}) · {a.entity}
                        {a.entityId ? ` · ${fmtId(a.entityId)}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] font-black uppercase text-muted-foreground">
                      {formatDateTime(a.createdAt)}
                    </span>
                  </summary>
                  {(a.before || a.after || a.device || a.referenceId) && (
                    <pre className="mt-2 max-h-40 overflow-auto border-2 border-ink bg-paper p-2 text-[10px] leading-4">
                      {JSON.stringify(
                        {
                          referenceId: a.referenceId,
                          device: a.device,
                          before: a.before,
                          after: a.after,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  )}
                </details>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
            <div className="space-y-1">
              <label className="text-xs font-black uppercase">Reference type</label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="h-11 w-full border-2 border-ink bg-white px-2 text-sm font-bold outline-none"
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-black uppercase">Reference ID</label>
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder={
                  kind === "collection"
                    ? "PY000123"
                    : kind === "loan"
                      ? "LN000123"
                      : kind === "receipt"
                        ? "RCPT0610260001"
                        : "wallet reference id"
                }
                className="h-11 w-full border-2 border-ink bg-white px-3 font-mono text-sm font-bold outline-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(["forward", "reverse"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={cn(
                    "border-2 border-ink py-2 text-xs font-black uppercase",
                    direction === d ? "bg-royal text-white shadow-hard-sm" : "bg-white",
                  )}
                >
                  {d === "forward" ? "Forward →" : "← Reverse"}
                </button>
              ))}
            </div>
          </section>

          {id.trim().length < 2 ? (
            <EmptyState
              title="Trace a rupee"
              hint="Enter a collection code, loan ID or receipt number to follow it from treasury to client and back."
              icon={<GitBranch className="size-5" />}
            />
          ) : (
            <TrailBoundary
              fallback={
                <div className="border-2 border-ink bg-blush p-4 text-xs font-bold">
                  Could not trace that reference. Check the ID and try again —
                  collection codes start with PY, loans with LN.
                </div>
              }
            >
              <TrailPanel kind={kind} id={id.trim()} direction={direction} />
            </TrailBoundary>
          )}
        </>
      )}

      <div className="border-2 border-ink bg-gold p-3 text-[11px] font-bold">
        Audit entries are append-only: edits and deletions never happen — even
        reversals create new entries linked to the originals.
      </div>
    </div>
  );
}
