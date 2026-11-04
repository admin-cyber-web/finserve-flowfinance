import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  FREQUENCIES,
  LOAN_PURPOSES,
  OFFICE_CREDIT,
  OFFICE_KYC,
  OFFICE_VERIFICATION,
} from "@/lib/finance/types";
import type {
  BankAccountValue,
  LoanRequestValue,
  NomineeValue,
} from "@/lib/finance/validate";
import { cn, fmtId, sentenceCase } from "@/lib/utils";
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
            System ID {fmtId(target?.staffId)} — the ID, sign-in credential and account
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
      // Branch is only sent when it actually changed: the backend refuses a
      // self branch move, so re-saving an untouched form must not trip it.
      const branchChanged =
        !!form.branchId && form.branchId !== String(target.branchId ?? "");
      await updateStaff({
        profileId: target._id,
        name: form.name.trim(),
        ...(form.mobile.trim() ? { mobile: form.mobile.trim() } : {}),
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
        ...(branchChanged ? { branchId: form.branchId as Id<"branches"> } : {}),
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
                {b.code ? `${fmtId(b.code)} · ` : ""}
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
  maternalHomeAddress?: string | null;
  village: string;
  occupation: string;
  monthlyIncome: number;
  householdIncome: number;
  familyMembers: number;
  // Application sections from the joining form. Rows built from
  // `clients.list` carry them all; other callers may simply omit them.
  typeOfBusiness?: string | null;
  businessAddress?: string | null;
  otherIncome?: number | null;
  householdExpenses?: number | null;
  existingLoanEmi?: number | null;
  loanRequest?: {
    amountRequested: number;
    purpose: string;
    tenureMonths: number;
    repaymentFrequency: string;
    estimatedInstallment?: number;
  } | null;
  bankAccount?: {
    accountHolderName: string;
    bankName: string;
    branch: string;
    accountNumber: string;
    ifscCode: string;
  } | null;
  nominee?: {
    name: string;
    relationship: string;
    age: number;
    mobile?: string | null;
    address?: string | null;
  } | null;
  references?: { name: string; mobile: string }[] | null;
  officeUse?: {
    fieldOfficerName?: string | null;
    customerVerification?: string | null;
    kycVerification?: string | null;
    creditAssessment?: string | null;
    approvedLoanAmount?: number | null;
  } | null;
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
            {fmtId(target?.code)} — KYC status, branch and loan history are untouched by
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
  const updateOfficeUse = useMutation(api.clients.updateOfficeUse);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: target.name,
    fatherName: target.fatherName ?? "",
    mobile: target.mobile,
    address: target.address ?? "",
    maternalHomeAddress: target.maternalHomeAddress ?? "",
    village: target.village,
    occupation: target.occupation,
    monthlyIncome: String(target.monthlyIncome ?? ""),
    householdIncome: String(target.householdIncome ?? ""),
    // Restored application sections — prefilled from the saved record so an
    // edit opens with exactly what is stored in the database.
    typeOfBusiness: target.typeOfBusiness ?? "",
    businessAddress: target.businessAddress ?? "",
    otherIncome:
      target.otherIncome != null ? String(target.otherIncome) : "",
    householdExpenses:
      target.householdExpenses != null ? String(target.householdExpenses) : "",
    existingLoanEmi:
      target.existingLoanEmi != null ? String(target.existingLoanEmi) : "",
    loanAmount:
      target.loanRequest?.amountRequested != null
        ? String(target.loanRequest.amountRequested)
        : "",
    loanPurpose: target.loanRequest?.purpose ?? "",
    loanTenure:
      target.loanRequest?.tenureMonths != null
        ? String(target.loanRequest.tenureMonths)
        : "",
    loanFrequency: target.loanRequest?.repaymentFrequency ?? "",
    loanInstallment:
      target.loanRequest?.estimatedInstallment != null
        ? String(target.loanRequest.estimatedInstallment)
        : "",
    bankHolder: target.bankAccount?.accountHolderName ?? "",
    bankName: target.bankAccount?.bankName ?? "",
    bankBranch: target.bankAccount?.branch ?? "",
    bankAccountNo: target.bankAccount?.accountNumber ?? "",
    bankIfsc: target.bankAccount?.ifscCode ?? "",
    nomineeName: target.nominee?.name ?? "",
    nomineeRelationship: target.nominee?.relationship ?? "",
    nomineeAge: target.nominee?.age != null ? String(target.nominee.age) : "",
    ref1Name: target.references?.[0]?.name ?? "",
    ref1Mobile: target.references?.[0]?.mobile ?? "",
    ref2Name: target.references?.[1]?.name ?? "",
    ref2Mobile: target.references?.[1]?.mobile ?? "",
    officeOfficer: target.officeUse?.fieldOfficerName ?? "",
    officeCustomer: target.officeUse?.customerVerification ?? "",
    officeKyc: target.officeUse?.kycVerification ?? "",
    officeCredit: target.officeUse?.creditAssessment ?? "",
    officeApproved:
      target.officeUse?.approvedLoanAmount != null
        ? String(target.officeUse.approvedLoanAmount)
        : "",
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
    if (!Number.isFinite(monthly) || monthly < 0 || !Number.isFinite(household) || household < 0) {
      toast.error("Income must be a number.");
      return;
    }

    /* ------------- Restored sections 1–6 — same rules as the form ------ */
    const numOrNull = (raw: string) =>
      raw.trim() === "" ? null : Number(raw.trim());
    const otherInc = numOrNull(form.otherIncome);
    const expenses = numOrNull(form.householdExpenses);
    const emi = numOrNull(form.existingLoanEmi);
    const amounts: [string, number | null][] = [
      ["Other income", otherInc],
      ["Monthly household expenses", expenses],
      ["Existing loan / EMI", emi],
    ];
    for (const [amountLabel, value] of amounts) {
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        toast.error(`${amountLabel} must be a valid amount.`);
        return;
      }
    }

    const loanTouched =
      form.loanAmount.trim() !== "" ||
      form.loanPurpose !== "" ||
      form.loanTenure.trim() !== "" ||
      form.loanFrequency !== "" ||
      form.loanInstallment.trim() !== "";
    let loanRequest: LoanRequestValue | null = null;
    if (loanTouched) {
      const amount = Number(form.loanAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        toast.error("Loan amount requested must be greater than zero.");
        return;
      }
      if (!form.loanPurpose) {
        toast.error("Select a purpose of loan.");
        return;
      }
      const tenure = Number(form.loanTenure);
      if (!Number.isInteger(tenure) || tenure < 1 || tenure > 120) {
        toast.error("Loan tenure must be between 1 and 120 months.");
        return;
      }
      if (!form.loanFrequency) {
        toast.error("Select a repayment frequency.");
        return;
      }
      const installment = numOrNull(form.loanInstallment);
      if (installment !== null && (!Number.isFinite(installment) || installment < 0)) {
        toast.error("Estimated installment must be a valid amount.");
        return;
      }
      loanRequest = {
        amountRequested: amount,
        purpose: form.loanPurpose,
        tenureMonths: tenure,
        repaymentFrequency: form.loanFrequency,
        estimatedInstallment: installment ?? undefined,
      };
    }

    const bankValues = [
      form.bankHolder.trim(),
      form.bankName.trim(),
      form.bankBranch.trim(),
      form.bankAccountNo.trim(),
      form.bankIfsc.trim(),
    ];
    const bankFilled = bankValues.filter((f) => f !== "").length;
    let bankAccount: BankAccountValue | null = null;
    if (bankFilled > 0) {
      if (bankFilled < 5) {
        toast.error("Fill in all bank account details, or leave them all blank.");
        return;
      }
      const accountNumber = form.bankAccountNo.replace(/\s/g, "");
      if (!/^\d{6,20}$/.test(accountNumber)) {
        toast.error("Bank account number must be 6-20 digits.");
        return;
      }
      const ifscCode = form.bankIfsc.trim().toUpperCase();
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
        toast.error("Invalid IFSC code — expected e.g. SBIN0001234.");
        return;
      }
      bankAccount = {
        accountHolderName: form.bankHolder.trim(),
        bankName: form.bankName.trim(),
        branch: form.bankBranch.trim(),
        accountNumber,
        ifscCode,
      };
    }

    const nomineeTouched =
      form.nomineeName.trim() !== "" ||
      form.nomineeRelationship.trim() !== "" ||
      form.nomineeAge.trim() !== "";
    let nominee: NomineeValue | null = null;
    if (nomineeTouched) {
      if (!form.nomineeName.trim() || !form.nomineeRelationship.trim()) {
        toast.error(
          "Nominee name and relationship with the applicant are required.",
        );
        return;
      }
      const nomineeAge = Number(form.nomineeAge);
      if (!Number.isInteger(nomineeAge) || nomineeAge < 1 || nomineeAge > 120) {
        toast.error("Nominee age must be between 1 and 120.");
        return;
      }
      nominee = {
        name: form.nomineeName.trim(),
        relationship: form.nomineeRelationship.trim(),
        age: nomineeAge,
      };
    }

    const referenceRows: { name: string; mobile: string }[] = [];
    const rawReferences = [
      { name: form.ref1Name.trim(), mobile: form.ref1Mobile.trim() },
      { name: form.ref2Name.trim(), mobile: form.ref2Mobile.trim() },
    ];
    for (let i = 0; i < rawReferences.length; i++) {
      const ref = rawReferences[i];
      if (!ref.name && !ref.mobile) continue;
      if (!ref.name) {
        toast.error(`Reference ${i + 1} name is required.`);
        return;
      }
      if (!/^[6-9]\d{9}$/.test(ref.mobile)) {
        toast.error(`Reference ${i + 1} mobile must be a 10-digit Indian number.`);
        return;
      }
      referenceRows.push(ref);
    }

    const officeTouched =
      form.officeOfficer.trim() !== "" ||
      form.officeCustomer !== "" ||
      form.officeKyc !== "" ||
      form.officeCredit !== "" ||
      form.officeApproved.trim() !== "";
    const approved = numOrNull(form.officeApproved);
    if (approved !== null && (!Number.isFinite(approved) || approved < 0)) {
      toast.error("Approved loan amount must be a valid amount.");
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
        // Only sent when it actually differs from what was loaded, so a
        // caller that did not supply the stored value can never wipe it by
        // saving the rest of the form. An explicit clear (loaded value,
        // emptied field) is sent as "" and the server drops it.
        ...(form.maternalHomeAddress.trim() !==
        (target.maternalHomeAddress ?? "").trim()
          ? { maternalHomeAddress: form.maternalHomeAddress.trim() }
          : {}),
        village: form.village.trim(),
        occupation: form.occupation.trim(),
        monthlyIncome: monthly,
        householdIncome: household,
        // Restored application sections. Blank strings / nulls clear a value,
        // untouched objects replace their block; the server re-validates all
        // of it with the same rules the joining form applies.
        typeOfBusiness: form.typeOfBusiness.trim(),
        businessAddress: form.businessAddress.trim(),
        otherIncome: otherInc,
        householdExpenses: expenses,
        existingLoanEmi: emi,
        loanRequest,
        bankAccount,
        nominee,
        references: referenceRows,
      });
      // FOR OFFICE USE ONLY has its own role-gated mutation (SUPER_ADMIN /
      // BRANCH_MANAGER) — only touched when the block carries a value or the
      // record already has one, so no empty office block is ever created.
      if (officeTouched || target.officeUse) {
        await updateOfficeUse({
          clientId: target._id,
          fieldOfficerName: form.officeOfficer.trim() || undefined,
          customerVerification: form.officeCustomer || undefined,
          kycVerification: form.officeKyc || undefined,
          creditAssessment: form.officeCredit || undefined,
          approvedLoanAmount: approved ?? undefined,
        });
      }
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
        <label className={labelCls} htmlFor="client-edit-maternal">
          Maternal home address
        </label>
        <textarea
          id="client-edit-maternal"
          className={cn(inputCls, "min-h-14 resize-y py-2")}
          value={form.maternalHomeAddress}
          onChange={(e) => set("maternalHomeAddress")(e.target.value)}
          rows={2}
          placeholder="Father's home — house, village, post, district"
        />
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
      </div>

      {/* Section 1 — Income & business details */}
      <div className="border-2 border-ink bg-sky p-2 text-[10px] font-black uppercase tracking-wide">
        Income &amp; business details
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="client-edit-business">
            Type of business
          </label>
          <input
            id="client-edit-business"
            className={inputCls}
            value={form.typeOfBusiness}
            onChange={(e) => set("typeOfBusiness")(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="client-edit-business-address">
            Business address
          </label>
          <input
            id="client-edit-business-address"
            className={inputCls}
            value={form.businessAddress}
            onChange={(e) => set("businessAddress")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-expenses">
            Monthly household expenses ₹
          </label>
          <input
            id="client-edit-expenses"
            className={inputCls}
            inputMode="decimal"
            value={form.householdExpenses}
            onChange={(e) =>
              set("householdExpenses")(e.target.value.replace(/[^\d.]/g, ""))
            }
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-other">
            Other income ₹
          </label>
          <input
            id="client-edit-other"
            className={inputCls}
            inputMode="decimal"
            value={form.otherIncome}
            onChange={(e) =>
              set("otherIncome")(e.target.value.replace(/[^\d.]/g, ""))
            }
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-emi">
            Existing loan / EMI ₹
          </label>
          <input
            id="client-edit-emi"
            className={inputCls}
            inputMode="decimal"
            value={form.existingLoanEmi}
            onChange={(e) =>
              set("existingLoanEmi")(e.target.value.replace(/[^\d.]/g, ""))
            }
          />
        </div>
      </div>

      {/* Section 2 — Loan details (request only, never a real loan) */}
      <div className="border-2 border-ink bg-sky p-2 text-[10px] font-black uppercase tracking-wide">
        Loan details — request only
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="client-edit-loan-amount">
            Loan amount requested ₹
          </label>
          <input
            id="client-edit-loan-amount"
            className={inputCls}
            inputMode="decimal"
            value={form.loanAmount}
            onChange={(e) =>
              set("loanAmount")(e.target.value.replace(/[^\d.]/g, ""))
            }
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-loan-purpose">
            Purpose of loan
          </label>
          <select
            id="client-edit-loan-purpose"
            className={inputCls}
            value={form.loanPurpose}
            onChange={(e) => set("loanPurpose")(e.target.value)}
          >
            <option value="">Select purpose…</option>
            {LOAN_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {sentenceCase(p)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-loan-tenure">
            Loan tenure (months)
          </label>
          <input
            id="client-edit-loan-tenure"
            className={inputCls}
            inputMode="numeric"
            value={form.loanTenure}
            onChange={(e) =>
              set("loanTenure")(e.target.value.replace(/[^\d]/g, ""))
            }
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-loan-freq">
            Repayment frequency
          </label>
          <select
            id="client-edit-loan-freq"
            className={inputCls}
            value={form.loanFrequency}
            onChange={(e) => set("loanFrequency")(e.target.value)}
          >
            <option value="">Select frequency…</option>
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {sentenceCase(f)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-loan-instal">
            Estimated installment ₹
          </label>
          <input
            id="client-edit-loan-instal"
            className={inputCls}
            inputMode="decimal"
            value={form.loanInstallment}
            onChange={(e) =>
              set("loanInstallment")(e.target.value.replace(/[^\d.]/g, ""))
            }
          />
        </div>
      </div>

      {/* Section 3 — Bank account details */}
      <div className="border-2 border-ink bg-sky p-2 text-[10px] font-black uppercase tracking-wide">
        Bank account details
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="client-edit-bank-holder">
            Account holder name
          </label>
          <input
            id="client-edit-bank-holder"
            className={inputCls}
            value={form.bankHolder}
            onChange={(e) => set("bankHolder")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-bank-name">
            Bank name
          </label>
          <input
            id="client-edit-bank-name"
            className={inputCls}
            value={form.bankName}
            onChange={(e) => set("bankName")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-bank-branch">
            Branch
          </label>
          <input
            id="client-edit-bank-branch"
            className={inputCls}
            value={form.bankBranch}
            onChange={(e) => set("bankBranch")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-bank-acc">
            Account number (6–20 digits)
          </label>
          <input
            id="client-edit-bank-acc"
            className={inputCls}
            inputMode="numeric"
            value={form.bankAccountNo}
            onChange={(e) => set("bankAccountNo")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-bank-ifsc">
            IFSC code
          </label>
          <input
            id="client-edit-bank-ifsc"
            className={inputCls}
            value={form.bankIfsc}
            onChange={(e) => set("bankIfsc")(e.target.value)}
          />
        </div>
      </div>

      {/* Section 4 — Nominee details */}
      <div className="border-2 border-ink bg-sky p-2 text-[10px] font-black uppercase tracking-wide">
        Nominee details
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="client-edit-nom-name">
            Nominee name
          </label>
          <input
            id="client-edit-nom-name"
            className={inputCls}
            value={form.nomineeName}
            onChange={(e) => set("nomineeName")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-nom-rel">
            Relationship with applicant
          </label>
          <input
            id="client-edit-nom-rel"
            className={inputCls}
            value={form.nomineeRelationship}
            onChange={(e) => set("nomineeRelationship")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-nom-age">
            Age
          </label>
          <input
            id="client-edit-nom-age"
            className={inputCls}
            inputMode="numeric"
            value={form.nomineeAge}
            onChange={(e) =>
              set("nomineeAge")(e.target.value.replace(/[^\d]/g, ""))
            }
          />
        </div>
      </div>

      {/* Section 5 — Reference details (two entries) */}
      <div className="border-2 border-ink bg-sky p-2 text-[10px] font-black uppercase tracking-wide">
        Reference details
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="client-edit-ref1-name">
            Reference 1 name
          </label>
          <input
            id="client-edit-ref1-name"
            className={inputCls}
            value={form.ref1Name}
            onChange={(e) => set("ref1Name")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-ref1-mobile">
            Reference 1 mobile
          </label>
          <input
            id="client-edit-ref1-mobile"
            className={inputCls}
            inputMode="numeric"
            value={form.ref1Mobile}
            onChange={(e) => set("ref1Mobile")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-ref2-name">
            Reference 2 name
          </label>
          <input
            id="client-edit-ref2-name"
            className={inputCls}
            value={form.ref2Name}
            onChange={(e) => set("ref2Name")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-ref2-mobile">
            Reference 2 mobile
          </label>
          <input
            id="client-edit-ref2-mobile"
            className={inputCls}
            inputMode="numeric"
            value={form.ref2Mobile}
            onChange={(e) => set("ref2Mobile")(e.target.value)}
          />
        </div>
      </div>

      {/* Section 6 — FOR OFFICE USE ONLY */}
      <div className="border-2 border-ink bg-gold p-2 text-[10px] font-black uppercase tracking-wide">
        For office use only
      </div>
      <p className="text-[11px] font-semibold text-muted-foreground">
        Server-side this block is recorded only for authorised roles (branch
        manager / super admin) — a field officer can never mark a client
        verified or approved.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="client-edit-office-officer">
            Field officer name
          </label>
          <input
            id="client-edit-office-officer"
            className={inputCls}
            value={form.officeOfficer}
            onChange={(e) => set("officeOfficer")(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-office-cust">
            Customer / group verification
          </label>
          <select
            id="client-edit-office-cust"
            className={inputCls}
            value={form.officeCustomer}
            onChange={(e) => set("officeCustomer")(e.target.value)}
          >
            <option value="">Not assessed</option>
            {OFFICE_VERIFICATION.map((o) => (
              <option key={o} value={o}>
                {sentenceCase(o)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-office-kyc">
            KYC verification
          </label>
          <select
            id="client-edit-office-kyc"
            className={inputCls}
            value={form.officeKyc}
            onChange={(e) => set("officeKyc")(e.target.value)}
          >
            <option value="">Not assessed</option>
            {OFFICE_KYC.map((o) => (
              <option key={o} value={o}>
                {sentenceCase(o)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-office-credit">
            Credit assessment
          </label>
          <select
            id="client-edit-office-credit"
            className={inputCls}
            value={form.officeCredit}
            onChange={(e) => set("officeCredit")(e.target.value)}
          >
            <option value="">Not assessed</option>
            {OFFICE_CREDIT.map((o) => (
              <option key={o} value={o}>
                {sentenceCase(o)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="client-edit-office-amount">
            Approved loan amount ₹
          </label>
          <input
            id="client-edit-office-amount"
            className={inputCls}
            inputMode="decimal"
            value={form.officeApproved}
            onChange={(e) =>
              set("officeApproved")(e.target.value.replace(/[^\d.]/g, ""))
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
