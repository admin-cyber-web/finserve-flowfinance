import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMutation } from "convex/react";
import { Pencil, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

const inputCls =
  "h-11 w-full border-2 border-ink bg-white px-3 text-sm font-semibold outline-none";
const labelCls = "text-[10px] font-black uppercase tracking-wide text-muted-foreground";

/**
 * Edit + Remove affordances shown next to a record. These are only rendered
 * by the caller when the viewer is a SUPER_ADMIN, and the mutations behind
 * them re-check that server-side.
 */
export function RecordActions({
  label,
  busy = false,
  onEdit,
  onDelete,
}: {
  label: string;
  busy?: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1 self-center pr-2">
      <button
        type="button"
        aria-label={`Edit ${label}`}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        className="grid size-9 place-items-center border-2 border-ink bg-white shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-50"
      >
        <Pencil className="size-4" />
      </button>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="grid size-9 place-items-center border-2 border-ink bg-blush text-destructive shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-50"
      >
        <Trash2 className="size-4" />
      </button>
    </span>
  );
}

type StaffEditTarget = {
  _id: Id<"profiles">;
  name: string;
  staffId: string;
  mobile?: string | null;
  email?: string | null;
  role: string;
  branchId?: Id<"branches"> | null;
};

type BranchOption = { _id: string; name: string; code?: string };

const ROLE_OPTIONS = [
  { id: "SUPER_ADMIN", label: "Super admin" },
  { id: "BRANCH_MANAGER", label: "Branch manager" },
  { id: "FIELD_STAFF", label: "Field staff" },
  { id: "ACCOUNTANT", label: "Accountant" },
];

/** SUPER_ADMIN edit form for a staff / branch-manager / admin profile. */
export function StaffEditDialog({
  open,
  onOpenChange,
  target,
  branches,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: StaffEditTarget | null;
  branches: BranchOption[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto border-2 border-ink bg-card shadow-hard">
        <DialogHeader>
          <DialogTitle className="text-lg font-black uppercase tracking-tight">
            Edit {target?.name ?? "user"}
          </DialogTitle>
          <DialogDescription className="text-sm font-semibold">
            System ID {target?.staffId} — the ID, sign-in credential and account
            status are never changed by an edit.
          </DialogDescription>
        </DialogHeader>
        {target && (
          <StaffEditForm
            key={target._id}
            target={target}
            branches={branches}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function StaffEditForm({
  target,
  branches,
  onDone,
}: {
  target: StaffEditTarget;
  branches: BranchOption[];
  onDone: () => void;
}) {
  const updateStaff = useMutation(api.admin.updateStaff);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: target.name,
    mobile: target.mobile ?? "",
    email: target.email ?? "",
    role: target.role,
    branchId: String(target.branchId ?? branches[0]?._id ?? ""),
  });
  const set = (k: keyof typeof form) => (value: string) =>
    setForm((s) => ({ ...s, [k]: value }));

  const save = async () => {
    if (!form.name.trim()) {
      toast.error("Name is required.");
      return;
    }
    if (form.mobile.trim() && !/^[6-9]\d{9}$/.test(form.mobile.trim())) {
      toast.error("Mobile must be a 10-digit Indian number.");
      return;
    }
    setBusy(true);
    try {
      await updateStaff({
        profileId: target._id,
        name: form.name.trim(),
        ...(form.mobile.trim() ? { mobile: form.mobile.trim() } : {}),
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
        ...(form.branchId ? { branchId: form.branchId as Id<"branches"> } : {}),
        role: form.role,
      });
      toast.success(`${form.name.trim()} updated`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save changes");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls} htmlFor="staff-edit-name">
          Name
        </label>
        <input
          id="staff-edit-name"
          className={inputCls}
          value={form.name}
          onChange={(e) => set("name")(e.target.value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="staff-edit-mobile">
            Mobile
          </label>
          <input
            id="staff-edit-mobile"
            className={inputCls}
            inputMode="numeric"
            value={form.mobile}
            onChange={(e) =>
              set("mobile")(e.target.value.replace(/[^\d+]/g, "").slice(0, 16))
            }
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="staff-edit-email">
            Email
          </label>
          <input
            id="staff-edit-email"
            className={inputCls}
            value={form.email}
            onChange={(e) => set("email")(e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="staff-edit-role">
            Role
          </label>
          <select
            id="staff-edit-role"
            className={inputCls}
            value={form.role}
            onChange={(e) => set("role")(e.target.value)}
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
            {!ROLE_OPTIONS.some((r) => r.id === form.role) && (
              <option value={form.role}>{form.role}</option>
            )}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="staff-edit-branch">
            Branch
          </label>
          <select
            id="staff-edit-branch"
            className={inputCls}
            value={form.branchId}
            onChange={(e) => set("branchId")(e.target.value)}
          >
            <option value="">No branch (organization-wide)</option>
            {branches.map((b) => (
              <option key={b._id} value={b._id}>
                {b.code ? `${b.code} · ` : ""}
                {b.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <DialogFooter className="gap-2 sm:gap-2">
        <Button variant="outline" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </div>
  );
}

type ClientEditTarget = {
  _id: Id<"clients">;
  code: string;
  name: string;
  fatherName?: string | null;
  mobile: string;
  address?: string | null;
  village: string;
  occupation: string;
  monthlyIncome: number;
  householdIncome: number;
  familyMembers: number;
};

/** SUPER_ADMIN edit form for a client record (fields `clients.update` owns). */
export function ClientEditDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ClientEditTarget | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto border-2 border-ink bg-card shadow-hard">
        <DialogHeader>
          <DialogTitle className="text-lg font-black uppercase tracking-tight">
            Edit {target?.name ?? "client"}
          </DialogTitle>
          <DialogDescription className="text-sm font-semibold">
            {target?.code} — KYC status, branch and loan history are untouched by
            an edit.
          </DialogDescription>
        </DialogHeader>
        {target && (
          <ClientEditForm
            key={target._id}
            target={target}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ClientEditForm({
  target,
  onDone,
}: {
  target: ClientEditTarget;
  onDone: () => void;
}) {
  const updateClient = useMutation(api.clients.update);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: target.name,
    fatherName: target.fatherName ?? "",
    mobile: target.mobile,
    address: target.address ?? "",
    village: target.village,
    occupation: target.occupation,
    monthlyIncome: String(target.monthlyIncome ?? ""),
    householdIncome: String(target.householdIncome ?? ""),
    familyMembers: String(target.familyMembers ?? 1),
  });
  const set = (k: keyof typeof form) => (value: string) =>
    setForm((s) => ({ ...s, [k]: value }));

  const save = async () => {
    if (!form.name.trim()) {
      toast.error("Name is required.");
      return;
    }
    if (!/^[6-9]\d{9}$/.test(form.mobile.trim())) {
      toast.error("Mobile must be a 10-digit Indian number.");
      return;
    }
    if (!form.village.trim() || !form.occupation.trim()) {
      toast.error("Village and occupation are required.");
      return;
    }
    const monthly = Number(form.monthlyIncome);
    const household = Number(form.householdIncome);
    const family = Number(form.familyMembers);
    if (!Number.isFinite(monthly) || monthly < 0 || !Number.isFinite(household) || household < 0) {
      toast.error("Income must be a number.");
      return;
    }
    if (!Number.isInteger(family) || family < 1 || family > 30) {
      toast.error("Family members must be between 1 and 30.");
      return;
    }

    setBusy(true);
    try {
      await updateClient({
        clientId: target._id,
        name: form.name.trim(),
        fatherName: form.fatherName.trim(),
        mobile: form.mobile.trim(),
        address: form.address.trim(),
        village: form.village.trim(),
        occupation: form.occupation.trim(),
        monthlyIncome: monthly,
        householdIncome: household,
        familyMembers: family,
      });
      toast.success(`${form.name.trim()} updated`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save changes");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls} htmlFor="client-edit-name">
          Name
        </label>
        <input
          id="client-edit-name"
          className={inputCls}
          value={form.name}
          onChange={(e) => set("name")(e.target.value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="client-edit-father">
            Father / husband
          </label>
          <input
            id="client-edit-father"
            className={inputCls}
            value={form.fatherName}
            onChange={(e) => set("fatherName")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-mobile">
            Mobile
          </label>
          <input
            id="client-edit-mobile"
            className={inputCls}
            inputMode="numeric"
            value={form.mobile}
            onChange={(e) =>
              set("mobile")(e.target.value.replace(/[^\d+]/g, "").slice(0, 16))
            }
          />
        </div>
      </div>
      <div>
        <label className={labelCls} htmlFor="client-edit-address">
          Address
        </label>
        <input
          id="client-edit-address"
          className={inputCls}
          value={form.address}
          onChange={(e) => set("address")(e.target.value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="client-edit-village">
            Village
          </label>
          <input
            id="client-edit-village"
            className={inputCls}
            value={form.village}
            onChange={(e) => set("village")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-occupation">
            Occupation
          </label>
          <input
            id="client-edit-occupation"
            className={inputCls}
            value={form.occupation}
            onChange={(e) => set("occupation")(e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={labelCls} htmlFor="client-edit-monthly">
            Monthly income ₹
          </label>
          <input
            id="client-edit-monthly"
            className={inputCls}
            inputMode="numeric"
            value={form.monthlyIncome}
            onChange={(e) =>
              set("monthlyIncome")(e.target.value.replace(/[^\d]/g, ""))
            }
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-household">
            Household ₹
          </label>
          <input
            id="client-edit-household"
            className={inputCls}
            inputMode="numeric"
            value={form.householdIncome}
            onChange={(e) =>
              set("householdIncome")(e.target.value.replace(/[^\d]/g, ""))
            }
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-family">
            Family members
          </label>
          <input
            id="client-edit-family"
            className={inputCls}
            inputMode="numeric"
            value={form.familyMembers}
            onChange={(e) =>
              set("familyMembers")(e.target.value.replace(/[^\d]/g, ""))
            }
          />
        </div>
      </div>
      <DialogFooter className="gap-2 sm:gap-2">
        <Button variant="outline" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </div>
  );
}

/** Shared confirm copy for a removal dialog (name + ID always shown). */
export function RemoveConfirm({
  open,
  onOpenChange,
  title,
  name,
  id,
  impact,
  loading,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  name: string;
  id: string;
  impact: string;
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm border-2 border-ink bg-card shadow-hard">
        <DialogHeader>
          <DialogTitle className="text-lg font-black uppercase tracking-tight">
            {title}
          </DialogTitle>
          <DialogDescription className="text-sm font-semibold">
            {name} · {id} — {impact} This is recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={loading} onClick={onConfirm}>
            {loading ? "Working…" : "Yes, remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
