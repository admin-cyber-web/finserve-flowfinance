import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Money,
  PageHeader,
  RowSkeleton,
  SectionTitle,
  StatusChip,
  formatDate,
} from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/fs/primitives";
import { useProfile } from "@/hooks/use-profile";
import { ROLE_LABELS, type FsRole } from "@/lib/finance/types";
import { cn } from "@/lib/utils";
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

  const [roleFilter, setRoleFilter] = useState<(typeof ROLE_FILTERS)[number]>("ALL");
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
      toast.success(`${roleName} created — ${result.staffId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create staff");
    } finally {
      setBusy(false);
    }
  };

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
            <button
              key={r.profile._id}
              onClick={() => navigate(`/dashboard/staff/${r.profile._id}`)}
              className="flex items-center justify-between gap-3 border-2 border-ink bg-card p-3 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-black">{r.profile.name}</span>
                <span className="block text-[11px] font-semibold text-muted-foreground">
                  {r.profile.staffId} · {ROLE_LABELS[r.profile.role as FsRole]} ·{" "}
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
              <p className="font-mono text-xl font-black tracking-wider">{created.staffId}</p>
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
    </div>
  );
}
