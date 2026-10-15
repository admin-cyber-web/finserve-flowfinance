import { api } from "@/convex/_generated/api";
import {
  EmptyState,
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
} from "@/components/fs/primitives";
import {
  ClientEditDialog,
  RecordActions,
  RemoveConfirm,
} from "@/components/fs/RecordEdits";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { formatINR } from "@/lib/finance/money";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { Plus, Search, UserPlus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "kyc", label: "KYC pending" },
  { id: "overdue", label: "With overdue" },
] as const;

export default function Clients() {
  const navigate = useNavigate();
  const { can, profile } = useProfile();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [busy, setBusy] = useState(false);
  const [editTarget, setEditTarget] = useState<ClientRow | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ClientRow | null>(null);

  const clients = useQuery(api.clients.list, q.trim() ? { search: q.trim() } : {});
  const removeClient = useMutation(api.admin.deactivateClient);

  /** Edit/Remove are admin controls: rendered only for SUPER_ADMIN and
   * re-authorized on the server by clients.update / admin.deactivateClient. */
  const isAdmin = profile?.role === "SUPER_ADMIN";

  const rows = (clients ?? []).filter((c) => {
    if (filter === "kyc") return c.kycStatus !== "VERIFIED";
    if (filter === "overdue") return c.overdueLoans > 0;
    return true;
  });

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setBusy(true);
    try {
      await removeClient({
        clientId: removeTarget._id,
        reason: "Removed by SUPER_ADMIN",
      });
      toast.success(`${removeTarget.name} (${removeTarget.code}) removed`);
      setRemoveTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove client");
    } finally {
      setBusy(false);
    }
  };

  type ClientRow = NonNullable<typeof clients>[number];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Clients"
        subtitle={`${clients?.length ?? 0} on your book`}
        action={
          can("create_client") ? (
            <Button size="sm" onClick={() => navigate("/dashboard/clients/new")}>
              <Plus /> New
            </Button>
          ) : undefined
        }
      />

      <div className="flex items-center border-2 border-ink bg-white shadow-hard-sm">
        <Search className="ml-3 size-4 shrink-0 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, code, village or mobile"
          className="h-11 w-full bg-transparent px-3 text-sm font-bold outline-none"
        />
      </div>

      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "flex-1 border-2 border-ink px-2 py-2 text-[11px] font-black uppercase",
              filter === f.id ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {clients === undefined ? (
        <RowSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No clients found"
          hint={
            q
              ? "Nothing matches that search."
              : "Add your first client to start originating loans."
          }
          action={
            can("create_client") ? (
              <Button size="sm" onClick={() => navigate("/dashboard/clients/new")}>
                <UserPlus /> Add client
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((c) => (
            <div
              key={c._id}
              className="flex items-stretch border-2 border-ink bg-card shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
            <button
              onClick={() => navigate(`/dashboard/clients/${c._id}`)}
              className="flex min-w-0 flex-1 items-center justify-between gap-3 p-3 text-left"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-black">{c.name}</span>
                <span className="block text-[11px] font-semibold text-muted-foreground">
                  {c.code} · {c.village} · {c.mobile}
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  <StatusChip status={c.kycStatus} label={`KYC ${c.kycStatus.toLowerCase()}`} />
                  {c.centerCode && (
                    <StatusChip
                      label={`${c.centerCode}${c.centerName ? ` · ${c.centerName}` : ""}`}
                    />
                  )}
                  {c.overdueLoans > 0 && (
                    <StatusChip label={`${c.overdueLoans} overdue`} tone="bad" />
                  )}
                  {c.activeLoans > 0 && (
                    <StatusChip label={`${c.activeLoans} active`} tone="ok" />
                  )}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-[10px] font-black uppercase text-muted-foreground">
                  Outstanding
                </span>
                <Money value={c.outstanding} className="block text-base" />
                {c.overdueAmount > 0 && (
                  <span className="text-[10px] font-black uppercase text-destructive">
                    {formatINR(c.overdueAmount)} overdue
                  </span>
                )}
              </span>
            </button>
              {isAdmin && (
                <RecordActions
                  label={c.name}
                  busy={busy}
                  onEdit={() => setEditTarget(c)}
                  onDelete={() => setRemoveTarget(c)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <SectionTitle>Tip</SectionTitle>
      <p className="border-2 border-ink bg-sky p-3 text-xs font-bold">
        Tap a client to open Client 360° — loans, payments, documents, notes and
        the full activity trail in one place.
      </p>

      <ClientEditDialog
        open={!!editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
        target={editTarget}
      />
      <RemoveConfirm
        open={!!removeTarget}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title={`Remove ${removeTarget?.name ?? "client"}?`}
        name={removeTarget?.name ?? ""}
        id={removeTarget?.code ?? ""}
        impact="The client is deactivated and hidden from lists; KYC, loans and receipts stay intact as history."
        loading={busy}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  );
}
