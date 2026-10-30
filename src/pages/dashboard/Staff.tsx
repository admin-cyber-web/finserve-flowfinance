import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/fs/primitives";
import {
  RecordActions,
  RemoveConfirm,
  StaffEditDialog,
} from "@/components/fs/RecordEdits";
import { useProfile } from "@/hooks/use-profile";
import { ROLE_LABELS, type FsRole } from "@/lib/finance/types";
import { cn, fmtId } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { Plus, UserCog } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

const ROLE_FILTERS = ["ALL", "FIELD_STAFF", "BRANCH_MANAGER", "ACCOUNTANT"] as const;

const inputCls =
  "h-11 w-full border-2 border-ink bg-white px-3 text-sm font-semibold outline-none";

export default function Staff() {
  const navigate = useNavigate();
  const { profile, can } = useProfile();
  const staff = useQuery(api.profiles.listStaff, { includeInactive: false });
  const createStaff = useMutation(api.users.createStaffUser);
  const removeStaff = useMutation(api.admin.deleteStaff);

  const [roleFilter, setRoleFilter] = useState<(typeof ROLE_FILTERS)[number]>("ALL");
  const [editTarget, setEditTarget] = useState<StaffRow | null>(null);
  const [removeTarget, setRemoveTarget] = useState<StaffRow | null>(null);

  /** Edit/Remove are admin controls: rendered only for SUPER_ADMIN and
   * re-authorized server-side by admin.updateStaff / admin.deleteStaff. */
  const isAdmin = profile?.role === "SUPER_ADMIN";
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    staffId: string;
    name: string;
    role: string;
    initialCredential: string | null;
  } | null>(null);

  const [form, setForm] = useState({
    name: "",
    mobile: "",
    email: "",
    role: "FIELD_STAFF",
    branchId: "",
    walletLimit: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((s) => ({ ...s, [k]: e.target.value }));

  // Branches are known through the staff directory + your own branch.
  const branches = useMemo(() => {
    const map = new Map<string, { _id: string; name: string }>();
    for (const row of staff ?? []) {
      if (row.branch) map.set(row.branch._id, row.branch);
    }
    if (profile?.branch) map.set(profile.branch._id, profile.branch);
    return [...map.values()];
  }, [staff, profile]);

  const rows = (staff ?? []).filter(
    (r) => roleFilter === "ALL" || r.profile.role === roleFilter,
  );

  const submit = async () => {
    if (!form.name.trim() || !/^\d{10}$/.test(form.mobile.trim())) {
      toast.error("Name and a 10-digit mobile are required.");
      return;
    }
    const branchId = (form.branchId || branches[0]?._id) as Id<"branches"> | undefined;
    if (!branchId) {
      toast.error("No branch available.");
      return;
    }
    setBusy(true);
    try {
      const roleName = form.role === "FIELD_STAFF" ? "Field staff" : form.role === "BRANCH_MANAGER" ? "Branch manager" : "Accountant";
      const result = await createStaff({
        name: form.name.trim(),
        mobile: form.mobile.trim(),
        email: form.email.trim() || undefined,
        role: form.role,
        branchId,
        walletLimit: form.role === "FIELD_STAFF" && form.walletLimit ? Number(form.walletLimit) : undefined,
      });
      setOpen(false);
      setCreated({
        staffId: result.staffId,
        name: form.name.trim(),
        role: roleName,
        initialCredential: result.initialCredential,
      });
      setForm({ name: "", mobile: "", email: "", role: "FIELD_STAFF", branchId: "", walletLimit: "" });
      toast.success(`${roleName} created — ${fmtId(result.staffId)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create staff");
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget || busy) return;
    setBusy(true);
    try {
      // The backend deactivates the account, revokes every session/device
      // and preserves wallet + audit history — and the list query is
      // reactive, so the row disappears the moment the mutation commits.
      const result = await removeStaff({
        profileId: removeTarget._id,
        reason: "Removed by SUPER_ADMIN",
      });
      toast.success(
        `${result.name} (${fmtId(result.staffId)}) removed — account deactivated, wallet and audit history preserved`,
      );
      setRemoveTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove account");
    } finally {
      setBusy(false);
    }
  };

  type StaffRow = NonNullable<typeof staff>[number]["profile"];

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Staff & wallets"
        subtitle={`${staff?.length ?? 0} team members`}
        action={
          can("staff_management") ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus /> Add staff
            </Button>
          ) : undefined
        }
      />

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {ROLE_FILTERS.map((r) => (
          <button
            key={r}
            onClick={() => setRoleFilter(r)}
            className={cn(
              "shrink-0 border-2 border-ink px-2.5 py-1.5 text-[11px] font-black uppercase",
              roleFilter === r ? "bg-navy text-paper shadow-hard-sm" : "bg-white",
            )}
          >
            {r === "ALL" ? "All" : ROLE_LABELS[r as FsRole]}
          </button>
        ))}
      </div>

      {staff === undefined ? (
        <RowSkeleton rows={5} />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div
              key={r.profile._id}
              className="flex items-stretch border-2 border-ink bg-card shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
            <button
              onClick={() => navigate(`/dashboard/staff/${r.profile._id}`)}
              className="flex min-w-0 flex-1 items-center justify-between gap-3 p-3 text-left"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-black">{r.profile.name}</span>
                <span className="block text-[11px] font-semibold text-muted-foreground">
                  {fmtId(r.profile.staffId)} · {ROLE_LABELS[r.profile.role as FsRole]} ·{" "}
                  {r.branch?.name ?? "—"}
                </span>
                <span className="mt-1 flex gap-1">
                  <StatusChip status={r.profile.status} />
                  <StatusChip label={`${r.clients} clients`} tone="info" />
                  <StatusChip label={`${r.activeLoans} loans`} tone="ok" />
                </span>
              </span>
              <span className="shrink-0 text-right">
                {r.wallet ? (
                  <>
                    <span className="block text-[10px] font-black uppercase text-muted-foreground">
                      Wallet limit
                    </span>
                    <Money value={r.wallet.walletLimit} className="block text-base" />
                  </>
                ) : (
                  <span className="text-[10px] font-black uppercase text-muted-foreground">
                    No wallet
                  </span>
                )}
              </span>
            </button>
              {isAdmin && (
                <RecordActions
                  label={r.profile.name}
                  busy={busy}
                  onEdit={() => setEditTarget(r.profile)}
                  onDelete={() => setRemoveTarget(r.profile)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <SectionTitle>Wallet policy</SectionTitle>
      <p className="border-2 border-ink bg-sky p-3 text-xs font-bold">
        Wallet limits are approved amounts, not balances. Balances are derived
        from each wallet's immutable transaction ledger — open a profile to see
        it.
      </p>

      {/* Create staff */}
      <BottomSheet open={open} onOpenChange={setOpen} title="Add staff member" subtitle="Provision a workspace login">
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-black uppercase">Full name *</label>
            <input className={inputCls} value={form.name} onChange={set("name")} placeholder="Anil Verma" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-black uppercase">Mobile *</label>
              <input
                className={inputCls}
                inputMode="numeric"
                value={form.mobile}
                onChange={(e) =>
                  setForm((s) => ({ ...s, mobile: e.target.value.replace(/\D/g, "").slice(0, 10) }))
                }
                placeholder="9876543210"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-black uppercase">Email</label>
              <input className={inputCls} value={form.email} onChange={set("email")} placeholder="for OTP sign-in" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-black uppercase">Role</label>
              <select className={inputCls} value={form.role} onChange={set("role")}>
                <option value="FIELD_STAFF">Field staff</option>
                <option value="BRANCH_MANAGER">Branch manager</option>
                <option value="ACCOUNTANT">Accountant</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-black uppercase">Branch</label>
              <select className={inputCls} value={form.branchId} onChange={set("branchId")}>
                {branches.map((b) => (
                  <option key={b._id} value={b._id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {form.role === "FIELD_STAFF" && (
            <div className="space-y-1">
              <label className="text-xs font-black uppercase">Opening wallet limit ₹</label>
              <input
                className={inputCls}
                inputMode="numeric"
                value={form.walletLimit}
                onChange={(e) =>
                  setForm((s) => ({ ...s, walletLimit: e.target.value.replace(/\D/g, "") }))
                }
                placeholder="200000"
              />
            </div>
          )}
          <Button className="w-full" size="lg" disabled={busy} onClick={() => void submit()}>
            <UserCog className="size-4" /> {busy ? "Creating…" : "Create staff"}
          </Button>
        </div>
      </BottomSheet>

      {/* One-time credential handover — shown exactly once per creation */}
      <BottomSheet
        open={created !== null}
        onOpenChange={(o) => {
          if (!o) setCreated(null);
        }}
        title="Staff created"
        subtitle="Sign-in credentials — shown only once"
      >
        {created && (
          <div className="space-y-3">
            <div className="border-2 border-ink bg-mint p-3">
              <p className="text-xs font-black uppercase tracking-wider">{created.name} · {created.role}</p>
              <p className="mt-2 text-[11px] font-black uppercase text-muted-foreground">System ID</p>
              <p className="font-mono text-xl font-black tracking-wider">{fmtId(created.staffId)}</p>
              {created.initialCredential ? (
                <>
                  <p className="mt-2 text-[11px] font-black uppercase text-muted-foreground">Initial PIN</p>
                  <p className="font-mono text-xl font-black tracking-[0.3em]">{created.initialCredential}</p>
                </>
              ) : (
                <p className="mt-2 text-xs font-bold">
                  This account was created with an administrator-set credential — no temporary PIN was generated.
                </p>
              )}
            </div>
            <p className="border-2 border-ink bg-blush p-3 text-xs font-bold">
              This PIN is displayed only once and is not recoverable. Share it
              with the staff member over a secure channel, and ask them to
              change it after first sign-in.
            </p>
            <Button className="w-full" size="lg" onClick={() => setCreated(null)}>
              I have saved the credentials
            </Button>
          </div>
        )}
      </BottomSheet>

      {/* Admin edit / remove — SUPER_ADMIN only */}
      <StaffEditDialog
        open={!!editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        target={editTarget}
        branches={branches}
      />
      <RemoveConfirm
        open={!!removeTarget}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title={`Remove ${removeTarget?.name ?? "account"}?`}
        name={removeTarget?.name ?? ""}
        id={removeTarget?.staffId ?? ""}
        impact="The profile is deactivated and every session and device is revoked; wallet and audit history are preserved."
        loading={busy}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  );
}
