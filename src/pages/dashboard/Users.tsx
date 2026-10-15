import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  BottomSheet,
  ConfirmDialog,
  EmptyState,
  KeyValue,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  formatDateTime,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/hooks/use-profile";
import { ROLE_LABELS, type FsRole } from "@/lib/finance/types";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { Ban, Lock, RotateCcw, Search, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

const inputCls =
  "h-11 w-full border-2 border-ink bg-white px-3 text-sm font-semibold outline-none";

const STAFF_FILTERS = [
  { id: "ALL", label: "All staff" },
  { id: "SUPER_ADMIN", label: "Admins" },
  { id: "BRANCH_MANAGER", label: "BM" },
  { id: "FIELD_STAFF", label: "Field" },
  { id: "ACCOUNTANT", label: "Accounts" },
] as const;

type StaffRow = {
  _id: Id<"profiles">;
  name: string;
  email?: string;
  mobile?: string;
  staffId: string;
  role: string;
  branch: { name: string } | null;
  status: string;
  createdAt: number;
  lastLoginAt?: number | null;
  isSelf?: boolean;
};

type ClientRow = {
  _id: Id<"clients">;
  code: string;
  name: string;
  mobile: string;
  village: string;
  district: string;
  kycStatus: string;
  status: string;
  createdAt: number;
  staffName: string;
  centerName?: string | null;
  activeLoans: number;
  outstanding: number;
};

type Target =
  | { kind: "staff"; row: StaffRow }
  | { kind: "client"; row: ClientRow };

type PendingAction = {
  action: "remove" | "status";
  target: Target;
  next?: "BLOCKED" | "SUSPENDED" | "ACTIVE";
};

/** Plain-text confirmation copy — kept out of the JSX so the dialog always
 * spells out exactly whose record is about to change. */
function describePending(
  pending: PendingAction | null,
  name: string,
  id: string,
): string {
  if (!pending) return "";
  if (pending.action === "remove") {
    const impact =
      pending.target.kind === "staff"
        ? "Their sessions and devices are revoked and the profile is deactivated; financial and audit history is preserved."
        : "The client is deactivated and hidden everywhere; receipts, ledger and audit history are preserved.";
    return `You are about to remove ${name} (${id}). ${impact} This is recorded in the audit log.`;
  }
  const change =
    pending.next === "ACTIVE"
      ? "reactivated and able to sign in again"
      : `set to ${pending.next} \u2014 they will be signed out and blocked from acting`;
  return `${name} (${id}) will be ${change}.`;
}

/**
 * SUPER_ADMIN user management: search every client / staff / branch manager,
 * open a record, then remove or suspend it. Every destructive action is
 * confirmed (name + ID on the dialog) and every result is toasted; the
 * backend re-checks SUPER_ADMIN authorization on each mutation.
 */
export default function Users() {
  const { profile, loading } = useProfile();

  if (loading) {
    return (
      <div className="space-y-3">
        <PageHeader title="User management" back="/dashboard" />
        <RowSkeleton rows={5} />
      </div>
    );
  }

  // Client-side gate only hides the controls — admin.listUsers,
  // admin.deleteStaff, admin.deactivateClient and profiles.setStatus all
  // enforce SUPER_ADMIN on the server.
  if (profile?.role !== "SUPER_ADMIN") {
    return (
      <div className="space-y-4">
        <PageHeader title="User management" back="/dashboard" />
        <EmptyState
          icon={<Lock className="size-5" />}
          title="SUPER_ADMIN only"
          hint="Managing and removing users is restricted to the SUPER_ADMIN role. Your account does not have this access."
        />
      </div>
    );
  }

  return <UserManager />;
}

function UserManager() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"staff" | "clients">("staff");
  const [q, setQ] = useState("");
  const [staffFilter, setStaffFilter] = useState<
    (typeof STAFF_FILTERS)[number]["id"]
  >("ALL");
  const [showRemoved, setShowRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Target | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");

  const staff = useQuery(api.admin.listUsers, {
    includeInactive: true,
    search: q.trim() ? q.trim() : undefined,
  });
  const clients = useQuery(api.clients.list, {
    includeInactive: true,
    search: q.trim() ? q.trim() : undefined,
  });

  const removeStaff = useMutation(api.admin.deleteStaff);
  const removeClient = useMutation(api.admin.deactivateClient);
  const setStatus = useMutation(api.profiles.setStatus);

  const staffRows = (staff ?? []).filter(
    (r) =>
      (showRemoved || r.status === "ACTIVE") &&
      (staffFilter === "ALL" || r.role === staffFilter),
  );
  const clientRows = (clients ?? []).filter((r) =>
    showRemoved ? true : r.status !== "INACTIVE",
  );

  const openTarget = (target: Target) => {
    setReason("");
    setSelected(target);
  };

  const run = async (fn: () => Promise<unknown>, okMessage: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(okMessage);
      setPending(null);
      setSelected(null);
      setReason("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = () => {
    if (!pending) return;
    if (pending.action === "remove" && pending.target.kind === "staff") {
      const row = pending.target.row;
      void run(
        () => removeStaff({ profileId: row._id, reason: reason.trim() || undefined }),
        `${row.name} (${row.staffId}) removed — sessions revoked`,
      );
      return;
    }
    if (pending.action === "remove" && pending.target.kind === "client") {
      const row = pending.target.row;
      void run(
        () => removeClient({ clientId: row._id, reason: reason.trim() || undefined }),
        `${row.name} (${row.code}) removed from the book`,
      );
      return;
    }
    if (pending.action === "status" && pending.target.kind === "staff" && pending.next) {
      const row = pending.target.row;
      void run(
        () =>
          setStatus({
            profileId: row._id,
            status: pending.next as string,
            reason: reason.trim(),
          }),
        `${row.name} (${row.staffId}) is now ${pending.next.toLowerCase()}`,
      );
    }
  };

  const pendingName = !pending ? "" : pending.target.row.name;
  const pendingId =
    !pending
      ? ""
      : pending.target.kind === "staff"
        ? pending.target.row.staffId
        : pending.target.row.code;
  const pendingTitle = !pending
    ? ""
    : pending.action === "remove"
      ? `Remove ${pendingName}?`
      : `${
          pending.next === "ACTIVE"
            ? "Reactivate"
            : pending.next === "BLOCKED"
              ? "Block"
              : "Suspend"
        } account?`;
  const pendingMessage = describePending(pending, pendingName, pendingId);

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="User management"
        subtitle="Clients, staff and branch managers — SUPER_ADMIN only"
        back="/dashboard"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate("/dashboard/clients/new")}
          >
            New client
          </Button>
        }
      />

      {/* Tabs */}
      <div className="flex border-2 border-ink bg-white">
        {(["staff", "clients"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 px-3 py-2.5 text-xs font-black uppercase tracking-wide",
              tab === t ? "bg-navy text-paper" : "bg-white text-ink",
            )}
          >
            {t === "staff" ? "Staff & BMs" : "Clients"}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="flex items-center border-2 border-ink bg-white shadow-hard-sm">
        <Search className="ml-3 size-4 shrink-0 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, system ID, mobile or email"
          className="h-11 w-full bg-transparent px-3 text-sm font-bold outline-none"
        />
      </div>

      {/* Staff role filter */}
      {tab === "staff" && (
        <div className="flex flex-wrap gap-2">
          {STAFF_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setStaffFilter(f.id)}
              className={cn(
                "border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
                staffFilter === f.id
                  ? "bg-navy text-paper shadow-hard-sm"
                  : "bg-white",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-xs font-bold">
        <input
          type="checkbox"
          checked={showRemoved}
          onChange={(e) => setShowRemoved(e.target.checked)}
          className="size-4 accent-[var(--color-destructive,#c0392b)]"
        />
        Show removed / deactivated accounts
      </label>

      {tab === "staff" ? (
        staff === undefined ? (
          <RowSkeleton rows={5} />
        ) : staffRows.length === 0 ? (
          <EmptyState
            title="No staff found"
            hint={
              q
                ? "Nothing matches that search."
                : "Create staff from the Staff & Wallets page."
            }
            action={
              <Button size="sm" variant="outline" onClick={() => navigate("/dashboard/staff")}>
                Open staff directory
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {staffRows.map((row) => (
              <button
                key={row._id}
                onClick={() => openTarget({ kind: "staff", row: row as StaffRow })}
                className="flex items-center justify-between gap-3 border-2 border-ink bg-card p-3 text-left shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-black">
                    {row.name}
                    {row.isSelf ? " · you" : ""}
                  </span>
                  <span className="block text-[11px] font-semibold text-muted-foreground">
                    {row.staffId} · {ROLE_LABELS[row.role as FsRole] ?? row.role} ·{" "}
                    {row.branch?.name ?? "All branches"}
                  </span>
                </span>
                <StatusChip status={row.status} />
              </button>
            ))}
          </div>
        )
      ) : clients === undefined ? (
        <RowSkeleton rows={5} />
      ) : clientRows.length === 0 ? (
        <EmptyState
          title="No clients found"
          hint={q ? "Nothing matches that search." : "The client book is empty."}
          action={
            <Button size="sm" onClick={() => navigate("/dashboard/clients/new")}>
              Add client
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {clientRows.map((row) => (
            <button
              key={row._id}
              onClick={() => openTarget({ kind: "client", row: row as ClientRow })}
              className="flex items-center justify-between gap-3 border-2 border-ink bg-card p-3 text-left shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-black">{row.name}</span>
                <span className="block text-[11px] font-semibold text-muted-foreground">
                  {row.code} · {row.village} · {row.mobile}
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  <StatusChip status={row.kycStatus} label={`KYC ${row.kycStatus.toLowerCase()}`} />
                  <StatusChip status={row.status} />
                </span>
              </span>
              <span className="shrink-0 text-right text-[11px] font-bold text-muted-foreground">
                {row.staffName}
              </span>
            </button>
          ))}
        </div>
      )}

      <SectionTitle>Safe deletion</SectionTitle>
      <p className="border-2 border-ink bg-sky p-3 text-xs font-bold">
        Removing a client deactivates the record and its live KYC/loan state
        while keeping receipts, ledger and audit history. Removing staff or a
        branch manager deactivates the profile and revokes every live session
        and device. SUPER_ADMIN cannot remove themselves or the last active
        SUPER_ADMIN.
      </p>

      {/* ---------------------------- Details ---------------------------- */}
      <BottomSheet
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
        title={selected?.row.name ?? ""}
        subtitle={
          selected
            ? selected.kind === "staff"
              ? `${selected.row.staffId} · ${ROLE_LABELS[selected.row.role as FsRole] ?? selected.row.role}`
              : `${selected.row.code} · client`
            : ""
        }
      >
        {selected?.kind === "staff" && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1">
              <StatusChip status={selected.row.status} />
              <StatusChip label={selected.row.role} />
            </div>
            <div>
              <KeyValue k="System ID" v={selected.row.staffId} mono />
              <KeyValue k="Branch" v={selected.row.branch?.name ?? "Organization-wide"} />
              <KeyValue k="Mobile" v={selected.row.mobile ?? "—"} mono />
              <KeyValue k="Email" v={selected.row.email ?? "—"} />
              <KeyValue k="Added" v={formatDateTime(selected.row.createdAt)} />
              <KeyValue
                k="Last sign-in"
                v={selected.row.lastLoginAt ? formatDateTime(selected.row.lastLoginAt) : "Never"}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={() => navigate(`/dashboard/staff/${selected.row._id}`)}
              >
                Open 360°
              </Button>
              {selected.row.status === "ACTIVE" ? (
                <Button
                  variant="outline"
                  disabled={selected.row.isSelf}
                  onClick={() => {
                    setReason("");
                    setPending({
                      action: "status",
                      target: selected,
                      next: "BLOCKED",
                    });
                  }}
                >
                  <Ban /> Block
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => {
                    setReason("");
                    setPending({
                      action: "status",
                      target: selected,
                      next: "ACTIVE",
                    });
                  }}
                >
                  <RotateCcw /> Reactivate
                </Button>
              )}
            </div>
            <Button
              variant="destructive"
              className="w-full"
              disabled={selected.row.isSelf}
              onClick={() => {
                setReason("");
                setPending({ action: "remove", target: selected });
              }}
            >
              <Trash2 /> Remove {selected.row.name}
            </Button>
            {selected.row.isSelf && (
              <p className="text-xs font-bold text-destructive">
                You cannot remove or block your own account.
              </p>
            )}
          </div>
        )}

        {selected?.kind === "client" && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1">
              <StatusChip status={selected.row.kycStatus} label={`KYC ${selected.row.kycStatus.toLowerCase()}`} />
              <StatusChip status={selected.row.status} />
            </div>
            <div>
              <KeyValue k="Client code" v={selected.row.code} mono />
              <KeyValue k="Mobile" v={selected.row.mobile} mono />
              <KeyValue k="Village" v={`${selected.row.village}, ${selected.row.district}`} />
              <KeyValue k="Assigned to" v={selected.row.staffName} />
              <KeyValue k="Centre" v={selected.row.centerName ?? "—"} />
              <KeyValue
                k="Active loans"
                v={`${selected.row.activeLoans} · ₹${selected.row.outstanding.toLocaleString("en-IN")}`}
              />
              <KeyValue k="Added" v={formatDateTime(selected.row.createdAt)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={() => navigate(`/dashboard/clients/${selected.row._id}`)}
              >
                Open client file
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setReason("");
                  setPending({ action: "remove", target: selected });
                }}
              >
                <Trash2 /> Remove
              </Button>
            </div>
          </div>
        )}
      </BottomSheet>

      {/* --------------------------- Confirmation ------------------------ */}
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => !open && setPending(null)}
        title={pendingTitle}
        tone="danger"
        loading={busy}
        confirmLabel={
          pending?.action === "remove" ? "Yes, remove" : "Confirm change"
        }
        message={pendingMessage}
        onConfirm={confirmPending}
      >
        <input
          className={inputCls}
          placeholder={
            pending?.action === "status" ? "Reason (required)" : "Reason (optional)"
          }
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="mt-2 flex items-start gap-2 text-[11px] font-bold text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          Confirming acts on {pendingName} · {pendingId} only — no other records
          are touched.
        </p>
      </ConfirmDialog>
    </div>
  );
}
