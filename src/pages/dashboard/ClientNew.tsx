import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ClientPhotoCapture,
  type CapturedClientPhoto,
} from "@/components/fs/ClientPhotoCapture";
import { EmptyState, PageHeader, RowSkeleton } from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProfile } from "@/hooks/use-profile";
import { cn, fmtId, sentenceCase } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  Briefcase,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ClipboardCheck,
  HandCoins,
  HeartHandshake,
  Landmark,
  Loader2,
  Lock,
  Camera,
  Phone,
  Plus,
  Search,
  Trash2,
  UserPlus,
} from "lucide-react";
import { DocCapture, DOC_KIND_OPTIONS, type DocItem } from "@/components/fs/DocCapture";
import {
  FREQUENCIES,
  LOAN_PURPOSES,
  OFFICE_CREDIT,
  OFFICE_KYC,
  OFFICE_VERIFICATION,
} from "@/lib/finance/types";
import {
  ageFromDob,
  type BankAccountValue,
  type LoanRequestValue,
  type NomineeValue,
} from "@/lib/finance/validate";
import { useState, type Dispatch, type SetStateAction } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

type CenterOption = {
  _id: Id<"centers">;
  code: string;
  name: string;
  village: string;
};

const GENDERS = ["MALE", "FEMALE", "OTHER"] as const;

/** One character-reference row (Reference 1 / Reference 2). */
type ReferenceRow = { name: string; mobile: string };

const emptyReference = (): ReferenceRow => ({ name: "", mobile: "" });

/**
 * Date of birth — kept as separate day / month / year parts so a
 * half-finished selection survives re-renders. The Age field on the form is
 * DERIVED from these parts (read-only); the backend re-derives age from the
 * submitted DOB and never trusts a client-supplied age.
 */
type DobParts = { d: string; m: string; y: string };
const emptyDob = (): DobParts => ({ d: "", m: "", y: "" });
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Epoch ms of a complete, real calendar date — null when incomplete or
 * impossible (e.g. 31 Feb). Shared by both DOB pickers on this form. */
function dobTimestamp(parts: DobParts): number | null {
  if (!parts.d || !parts.m || !parts.y) return null;
  const y = Number(parts.y);
  const m = Number(parts.m);
  const d = Number(parts.d);
  const dt = new Date(y, m - 1, d);
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== m - 1 ||
    dt.getDate() !== d
  ) {
    return null;
  }
  return dt.getTime();
}

/** DD/MM/YYYY display for a DOB (blank until the selection is complete). */
function formatDob(parts: DobParts): string {
  if (!parts.d || !parts.m || !parts.y) return "";
  return `${parts.d.padStart(2, "0")}/${parts.m.padStart(2, "0")}/${parts.y}`;
}

/** Calculated age for a completed DOB selection — null while incomplete.
 * Uses the SAME helper the backend re-validates with. */
function ageIfComplete(parts: DobParts): number | null {
  const ts = dobTimestamp(parts);
  return ts !== null ? ageFromDob(ts) : null;
}

/** Date-of-birth picker with separate day / month / year dropdowns.
 * Future dates are disabled and impossible calendar days (31 Feb) can never
 * be completed; the chosen date is echoed back as DD/MM/YYYY. */
function DobPicker({
  parts,
  onChange,
  className,
}: {
  parts: DobParts;
  onChange: (next: DobParts) => void;
  className: string;
}) {
  const today = new Date();
  const thisYear = today.getFullYear();
  const thisMonth = today.getMonth() + 1;
  const thisDay = today.getDate();
  const years = Array.from({ length: 101 }, (_, i) => String(thisYear - i));
  const daysInMonth =
    parts.y && parts.m
      ? new Date(Number(parts.y), Number(parts.m), 0).getDate()
      : 31;
  const days = Array.from({ length: daysInMonth }, (_, i) => String(i + 1));
  const selectCls = cn(className, "h-[42px] min-w-0");

  // Changing month/year can invalidate the selected day (31 Jan → Feb, or
  // 29 Feb → a non-leap year) — clear it so an impossible date never forms.
  const setMonth = (m: string) => {
    const maxDays = parts.y ? new Date(Number(parts.y), Number(m), 0).getDate() : 31;
    onChange({
      ...parts,
      m,
      d: parts.d && Number(parts.d) > maxDays ? "" : parts.d,
    });
  };
  const setYear = (y: string) => {
    const maxDays = parts.m ? new Date(Number(y), Number(parts.m), 0).getDate() : 31;
    onChange({
      ...parts,
      y,
      d: parts.d && Number(parts.d) > maxDays ? "" : parts.d,
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Birth day"
        value={parts.d}
        onChange={(e) => onChange({ ...parts, d: e.target.value })}
        className={cn(selectCls, "w-20 shrink-0")}
      >
        <option value="">Day</option>
        {days.map((d) => (
          <option
            key={d}
            value={d}
            disabled={
              parts.y === String(thisYear) &&
              parts.m === String(thisMonth) &&
              Number(d) > thisDay
            }
          >
            {d.padStart(2, "0")}
          </option>
        ))}
      </select>
      <select
        aria-label="Birth month"
        value={parts.m}
        onChange={(e) => setMonth(e.target.value)}
        className={cn(selectCls, "w-24 shrink-0")}
      >
        <option value="">Month</option>
        {MONTH_SHORT.map((name, i) => (
          <option
            key={name}
            value={String(i + 1)}
            disabled={parts.y === String(thisYear) && i + 1 > thisMonth}
          >
            {name}
          </option>
        ))}
      </select>
      <select
        aria-label="Birth year"
        value={parts.y}
        onChange={(e) => setYear(e.target.value)}
        className={cn(selectCls, "w-24 shrink-0")}
      >
        <option value="">Year</option>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <span className="font-mono text-xs font-black tabular-nums text-muted-foreground">
        {formatDob(parts) || "DD/MM/YYYY"}
      </span>
    </div>
  );
}

/** "KYC documents available" checkboxes (Aadhaar / PAN / Voter ID / Other). */
function KycDocChecks({
  value,
  onChange,
}: {
  value: string[];
  onChange: Dispatch<SetStateAction<string[]>>;
}) {
  const toggle = (id: string, checked: boolean) =>
    onChange((cur) =>
      checked ? [...cur, id] : cur.filter((k) => k !== id),
    );
  return (
    <div className="flex flex-wrap gap-3 border-2 border-ink bg-white px-3 py-2">
      {DOC_KIND_OPTIONS.map((opt) => (
        <label
          key={opt.id}
          className="flex items-center gap-1.5 text-xs font-bold uppercase"
        >
          <input
            type="checkbox"
            className="size-4 accent-[var(--color-navy,#1b2a4a)]"
            checked={value.includes(opt.id)}
            onChange={(e) => toggle(opt.id, e.target.checked)}
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}

/**
 * New Client flow.
 *
 * Step 1 (popup): choose an existing centre by ID/name, or create a new
 * centre. The Centre ID is generated by the backend exactly once, when the
 * centre is created — never per client.
 *
 * Step 2: the Client Joining Form, with the selected centre locked in.
 * The centre is re-verified server-side on submit; if the client submission
 * fails, the selected centre stays so the user can safely retry.
 */
export default function ClientNew() {
  const { can } = useProfile();
  const navigate = useNavigate();

  // Step 1 — centre choice (popup)
  const [selected, setSelected] = useState<CenterOption | null>(null);
  const [q, setQ] = useState("");
  const [creatingCenter, setCreatingCenter] = useState(false);
  const [centerName, setCenterName] = useState("");
  const [centerVillage, setCenterVillage] = useState("");
  const [busy, setBusy] = useState(false);

  // Step 2 — joining form
  const [name, setName] = useState("");
  const [fatherName, setFatherName] = useState("");
  const [applicantFatherName, setApplicantFatherName] = useState("");
  const [maternalHomeAddress, setMaternalHomeAddress] = useState("");
  // Date of birth (day / month / year) — the Age field is derived from it,
  // read-only, and re-derived server-side on submit.
  const [dob, setDob] = useState<DobParts>(emptyDob());
  const [gender, setGender] = useState<(typeof GENDERS)[number]>("FEMALE");
  const [mobile, setMobile] = useState("");
  const [address, setAddress] = useState("");
  const [occupation, setOccupation] = useState("");
  const [monthlyIncome, setMonthlyIncome] = useState("");
  const [householdIncome, setHouseholdIncome] = useState("");
  const [kycDocRef, setKycDocRef] = useState("");
  const [panNumber, setPanNumber] = useState("");
  const [voterId, setVoterId] = useState("");
  const [kycDocs, setKycDocs] = useState<string[]>(["AADHAAR"]);

  // Co-applicant — section 2 of the application form. All fields are
  // controlled so everything typed here survives and is saved with the
  // application (it re-opens from the client page after submission).
  const [coName, setCoName] = useState("");
  const [coFatherName, setCoFatherName] = useState("");
  const [coRelationship, setCoRelationship] = useState("");
  const [coGender, setCoGender] = useState<(typeof GENDERS)[number]>("MALE");
  const [coDob, setCoDob] = useState<DobParts>(emptyDob());
  const [coMobile, setCoMobile] = useState("");
  const [coAddress, setCoAddress] = useState("");
  const [coAadhaar, setCoAadhaar] = useState("");
  const [coPan, setCoPan] = useState("");
  const [coVoter, setCoVoter] = useState("");
  const [coKycDocs, setCoKycDocs] = useState<string[]>(["AADHAAR"]);

  // Section 1 — Income & business details. "Estimated monthly income" is the
  // same `monthlyIncome` state collected in the applicant block above, so the
  // two inputs can never disagree.
  const [typeOfBusiness, setTypeOfBusiness] = useState("");
  const [businessAddress, setBusinessAddress] = useState("");
  const [householdExpenses, setHouseholdExpenses] = useState("");
  const [otherIncome, setOtherIncome] = useState("");
  const [existingLoanEmi, setExistingLoanEmi] = useState("");

  // Section 2 — loan details: a request recorded on the application only.
  const [loanAmount, setLoanAmount] = useState("");
  const [loanPurpose, setLoanPurpose] = useState("");
  const [loanTenure, setLoanTenure] = useState("");
  const [loanFrequency, setLoanFrequency] = useState("");
  const [loanInstallment, setLoanInstallment] = useState("");

  // Section 3 — bank account details (all five together or not at all).
  const [bankHolder, setBankHolder] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankBranch, setBankBranch] = useState("");
  const [bankAccountNo, setBankAccountNo] = useState("");
  const [bankIfsc, setBankIfsc] = useState("");

  // Section 4 — nominee details. Only name, relationship and age are
  // collected; nominee mobile/address were removed from the form.
  const [nomineeName, setNomineeName] = useState("");
  const [nomineeRelationship, setNomineeRelationship] = useState("");
  const [nomineeAge, setNomineeAge] = useState("");

  // Section 5 — two character references.
  const [references, setReferences] = useState<ReferenceRow[]>([
    emptyReference(),
    emptyReference(),
  ]);

  // Section 6 — FOR OFFICE USE ONLY (honoured only for authorised roles).
  const [officeOfficer, setOfficeOfficer] = useState("");
  const [officeCustomer, setOfficeCustomer] = useState("");
  const [officeKyc, setOfficeKyc] = useState("");
  const [officeCredit, setOfficeCredit] = useState("");
  const [officeApproved, setOfficeApproved] = useState("");

  // Applicant image — OPTIONAL at onboarding. Staff pick how it is captured
  // (Photo Upload or Geo Tagging); leaving it blank is allowed and the client
  // profile then shows "Image Not Available" until one is saved.
  const [photoMethod, setPhotoMethod] = useState<"" | "PHOTO_UPLOAD" | "GEO_TAGGING">("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [applicantPhoto, setApplicantPhoto] = useState<CapturedClientPhoto | null>(null);
  const [applicantDocs, setApplicantDocs] = useState<DocItem[]>([]);
  // Co-applicant image — same OPTIONAL rule as the applicant's: Photo Upload,
  // Geo Tagging, or nothing at all.
  const [coPhotoMethod, setCoPhotoMethod] = useState<"" | "PHOTO_UPLOAD" | "GEO_TAGGING">("");
  const [coPhotoFile, setCoPhotoFile] = useState<File | null>(null);
  const [coPhotoPreview, setCoPhotoPreview] = useState<string | null>(null);
  const [coApplicantPhoto, setCoApplicantPhoto] = useState<CapturedClientPhoto | null>(null);
  const [coApplicantDocs, setCoApplicantDocs] = useState<DocItem[]>([]);
  const [declaration, setDeclaration] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const getUploadUrl = useMutation(api.clients.photoUploadUrl);
  const createCenter = useMutation(api.clients.createCenter);
  const createClient = useMutation(api.clients.create);
  const centers = useQuery(
    api.clients.centerSearch,
    selected ? "skip" : (q.trim() ? { q: q.trim() } : "skip"),
  );

  // Show empty state when no query is entered
  const showNoResults = !selected && q.trim() && (!centers || centers.length === 0);

  // Ages are calculated live from the DOB pickers — both Age fields are
  // read-only displays and can never disagree with the chosen date.
  const applicantAge = ageIfComplete(dob);
  const coAge = ageIfComplete(coDob);

  if (!can("create_client")) {
    return (
      <div className="space-y-4">
        <PageHeader title="New client" subtitle="Client onboarding" />
        <EmptyState
          title="Not authorised"
          hint="Your role does not include the create-client permission."
          icon={<Lock className="size-5" />}
        />
      </div>
    );
  }

  const submitCenter = async () => {
    const trimmed = centerName.trim();
    if (trimmed.length < 3) {
      toast.error("Centre name must be at least 3 characters.");
      return;
    }
    setBusy(true);
    try {
      const { center } = await createCenter({
        name: trimmed,
        village: centerVillage.trim() || undefined,
      });
      setSelected({
        _id: center._id,
        code: center.code,
        name: center.name,
        village: center.village,
      });
      setCreatingCenter(false);
      setCenterName("");
      setCenterVillage("");
      setQ("");
      toast.success(`Centre ${center.name} created — Centre ID ${fmtId(center.code)}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Centre creation failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitClient = async () => {
    if (!selected) return;

    // Local validation mirrors the backend so mistakes surface instantly.
    if (name.trim().length < 2) return toast.error("Client name is required.");
    // Date of birth is required; the age shown on the form is calculated
    // from it and is re-derived server-side (the backend never trusts a
    // client-supplied age).
    const dobTs = dobTimestamp(dob);
    if (dobTs === null) {
      return toast.error(
        "Date of birth is required — pick the day, month and year.",
      );
    }
    if (dobTs > Date.now()) {
      return toast.error("Date of birth cannot be in the future.");
    }
    const ageNum = ageFromDob(dobTs);
    if (!Number.isInteger(ageNum) || ageNum < 18 || ageNum > 100) {
      return toast.error("Age must be between 18 and 100.");
    }
    if (!/^[6-9]\d{9}$/.test(mobile.trim())) {
      return toast.error("Enter a valid 10-digit Indian mobile number.");
    }
    if (!address.trim()) return toast.error("Permanent address is required.");
    if (!occupation.trim()) return toast.error("Occupation is required.");
    const monthly = Number(monthlyIncome);
    if (!Number.isFinite(monthly) || monthly < 0) {
      return toast.error("Monthly income must be a valid amount.");
    }
    const household = Number(householdIncome || 0);
    if (!Number.isFinite(household) || household < 0) {
      return toast.error("Household income must be a valid amount.");
    }
    if (!/^\d{12}$/.test(kycDocRef.trim())) {
      return toast.error("Aadhaar number must be exactly 12 digits.");
    }
    const pan = panNumber.trim().toUpperCase();
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
      return toast.error("PAN number must look like ABCDE1234F.");
    }
    const voter = voterId.trim().toUpperCase();
    if (voter && !/^[A-Z]{3}[0-9]{7}$/.test(voter)) {
      return toast.error("Voter ID must look like ABC1234567.");
    }
    // The client image is OPTIONAL here: no photo, a chosen-but-unfinished
    // Photo Upload, or an abandoned Geo Tagging capture must all still let the
    // client be created (it simply has no image yet).

    // Co-applicant block (form section 2) — name, relationship and the
    // geo-tagged photograph are mandatory, exactly as the form states.
    if (coName.trim().length < 2) {
      return toast.error("Co-applicant name is required.");
    }
    if (!coRelationship.trim()) {
      return toast.error(
        "Co-applicant relationship with the applicant is required.",
      );
    }
    // Co-applicant DOB — same rules as the applicant's: required, valid,
    // never in the future; age is calculated from it.
    const coDobTs = dobTimestamp(coDob);
    if (coDobTs === null) {
      return toast.error(
        "Co-applicant date of birth is required — pick the day, month and year.",
      );
    }
    if (coDobTs > Date.now()) {
      return toast.error("Co-applicant date of birth cannot be in the future.");
    }
    const coAgeNum = ageFromDob(coDobTs);
    if (!Number.isInteger(coAgeNum) || coAgeNum < 18 || coAgeNum > 100) {
      return toast.error("Co-applicant age must be between 18 and 100.");
    }
    if (coMobile.trim() && !/^[6-9]\d{9}$/.test(coMobile.trim())) {
      return toast.error("Enter a valid 10-digit co-applicant mobile number.");
    }
    if (coAadhaar.trim() && !/^\d{12}$/.test(coAadhaar.trim())) {
      return toast.error("Co-applicant Aadhaar must be exactly 12 digits.");
    }
    const coPanValue = coPan.trim().toUpperCase();
    if (coPanValue && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(coPanValue)) {
      return toast.error("Co-applicant PAN number must look like ABCDE1234F.");
    }
    const coVoterValue = coVoter.trim().toUpperCase();
    if (coVoterValue && !/^[A-Z]{3}[0-9]{7}$/.test(coVoterValue)) {
      return toast.error("Co-applicant Voter ID must look like ABC1234567.");
    }
    // The co-applicant photograph is optional too — it never gates anything.

    /* ---------------- Restored sections 1–5 + family ------------------ */

    // Section 1 — optional amounts, but a typed value must still be an
    // amount. Blank means "not provided", never zero.
    const expenses = householdExpenses.trim()
      ? Number(householdExpenses)
      : undefined;
    if (expenses !== undefined && (!Number.isFinite(expenses) || expenses < 0)) {
      return toast.error("Monthly household expenses must be a valid amount.");
    }
    const otherInc = otherIncome.trim() ? Number(otherIncome) : undefined;
    if (otherInc !== undefined && (!Number.isFinite(otherInc) || otherInc < 0)) {
      return toast.error("Other income must be a valid amount.");
    }
    const emi = existingLoanEmi.trim() ? Number(existingLoanEmi) : undefined;
    if (emi !== undefined && (!Number.isFinite(emi) || emi < 0)) {
      return toast.error("Existing loan / EMI must be a valid amount.");
    }

    // Section 2 — the loan block is optional, but half a request is not.
    let loanRequest: LoanRequestValue | undefined;
    const loanTouched =
      loanAmount.trim() !== "" ||
      loanPurpose !== "" ||
      loanTenure.trim() !== "" ||
      loanFrequency !== "" ||
      loanInstallment.trim() !== "";
    if (loanTouched) {
      const amount = Number(loanAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return toast.error("Loan amount requested must be greater than zero.");
      }
      if (!loanPurpose) return toast.error("Select a purpose of loan.");
      const tenure = Number(loanTenure);
      if (!Number.isInteger(tenure) || tenure < 1 || tenure > 120) {
        return toast.error("Loan tenure must be between 1 and 120 months.");
      }
      if (!loanFrequency) {
        return toast.error("Select a repayment frequency.");
      }
      const installment = loanInstallment.trim()
        ? Number(loanInstallment)
        : undefined;
      if (
        installment !== undefined &&
        (!Number.isFinite(installment) || installment < 0)
      ) {
        return toast.error("Estimated installment must be a valid amount.");
      }
      loanRequest = {
        amountRequested: amount,
        purpose: loanPurpose,
        tenureMonths: tenure,
        repaymentFrequency: loanFrequency,
        estimatedInstallment: installment,
      };
    }

    // Section 3 — all five bank fields together, or none at all.
    let bankAccount: BankAccountValue | undefined;
    const bankValues = [
      bankHolder.trim(),
      bankName.trim(),
      bankBranch.trim(),
      bankAccountNo.trim(),
      bankIfsc.trim(),
    ];
    const bankFilled = bankValues.filter((f) => f !== "").length;
    if (bankFilled > 0) {
      if (bankFilled < 5) {
        return toast.error(
          "Fill in all bank account details, or leave them all blank.",
        );
      }
      const accountNumber = bankAccountNo.replace(/\s/g, "");
      if (!/^\d{6,20}$/.test(accountNumber)) {
        return toast.error("Bank account number must be 6-20 digits.");
      }
      const ifscCode = bankIfsc.trim().toUpperCase();
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
        return toast.error("Invalid IFSC code — expected e.g. SBIN0001234.");
      }
      bankAccount = {
        accountHolderName: bankHolder.trim(),
        bankName: bankName.trim(),
        branch: bankBranch.trim(),
        accountNumber,
        ifscCode,
      };
    }

    // Section 4 — nominee: name, relationship and age travel together.
    let nominee: NomineeValue | undefined;
    const nomineeTouched =
      nomineeName.trim() !== "" ||
      nomineeRelationship.trim() !== "" ||
      nomineeAge.trim() !== "";
    if (nomineeTouched) {
      if (!nomineeName.trim() || !nomineeRelationship.trim()) {
        return toast.error(
          "Nominee name and relationship with the applicant are required.",
        );
      }
      const nomineeAgeNum = Number(nomineeAge);
      if (!Number.isInteger(nomineeAgeNum) || nomineeAgeNum < 1 || nomineeAgeNum > 120) {
        return toast.error("Nominee age must be between 1 and 120.");
      }
      nominee = {
        name: nomineeName.trim(),
        relationship: nomineeRelationship.trim(),
        age: nomineeAgeNum,
      };
    }

    // Section 5 — two reference rows: blank rows are ignored, half rows
    // (a name without a mobile, or the reverse) are rejected.
    const referenceValues = references
      .map((r) => ({ name: r.name.trim(), mobile: r.mobile.trim() }))
      .filter((r) => r.name !== "" || r.mobile !== "");
    for (let i = 0; i < referenceValues.length; i++) {
      const ref = referenceValues[i];
      if (!ref.name) {
        return toast.error(`Reference ${i + 1} name is required.`);
      }
      if (!/^[6-9]\d{9}$/.test(ref.mobile)) {
        return toast.error(
          `Reference ${i + 1} mobile must be a 10-digit Indian number.`,
        );
      }
    }
    // Family members are no longer part of the joining form — nothing is
    // collected or submitted for them.

    /* ---------------- Section 6 — FOR OFFICE USE ONLY ------------------ */
    const officeTouched =
      officeOfficer.trim() !== "" ||
      officeCustomer !== "" ||
      officeKyc !== "" ||
      officeCredit !== "" ||
      officeApproved.trim() !== "";
    let officeUse:
      | {
          fieldOfficerName?: string;
          customerVerification?: string;
          kycVerification?: string;
          creditAssessment?: string;
          approvedLoanAmount?: number;
        }
      | undefined;
    if (officeTouched) {
      const approved = officeApproved.trim() ? Number(officeApproved) : undefined;
      if (approved !== undefined && (!Number.isFinite(approved) || approved < 0)) {
        return toast.error("Approved loan amount must be a valid amount.");
      }
      officeUse = {
        fieldOfficerName: officeOfficer.trim() || undefined,
        customerVerification: officeCustomer || undefined,
        kycVerification: officeKyc || undefined,
        creditAssessment: officeCredit || undefined,
        approvedLoanAmount: approved,
      };
    }

    // Only fully-uploaded document rows are ever saved — an in-flight or
    // failed file is surfaced here instead of being silently dropped.
    if (
      applicantDocs.some((d) => d.status !== "uploaded" || !d.storageId) ||
      coApplicantDocs.some((d) => d.status !== "uploaded" || !d.storageId)
    ) {
      return toast.error(
        "Some document uploads have not finished — wait for them, or remove the failed ones.",
      );
    }

    if (!declaration) {
      return toast.error("Accept the declaration before submitting.");
    }

    setSubmitting(true);
    try {
      // 1) OPTIONAL client image. Only a genuinely completed capture is
      // uploaded: a chosen method with nothing captured sends NOTHING, so the
      // client is still created and its image status stays "not available"
      // until the photograph is actually saved from the profile.
      let photoStorageId: Id<"_storage"> | undefined;
      let photoGeo:
        | {
            latitude: number;
            longitude: number;
            accuracyMeters: number;
            capturedAt: number;
            photoCapturedAt: number;
            permissionStatus: string;
          }
        | undefined;
      let sentMethod: "PHOTO_UPLOAD" | "GEO_TAGGING" | undefined;

      if (photoMethod === "GEO_TAGGING" && applicantPhoto) {
        sentMethod = "GEO_TAGGING";
        photoGeo = {
          latitude: applicantPhoto.geo.latitude,
          longitude: applicantPhoto.geo.longitude,
          accuracyMeters: applicantPhoto.geo.accuracyMeters,
          capturedAt: applicantPhoto.geo.capturedAt,
          photoCapturedAt: applicantPhoto.frameAt,
          permissionStatus: applicantPhoto.geo.permissionStatus,
        };
      } else if (photoMethod === "PHOTO_UPLOAD" && photoFile) {
        sentMethod = "PHOTO_UPLOAD";
      }

      if (sentMethod) {
        const blob =
          sentMethod === "GEO_TAGGING" ? applicantPhoto!.blob : photoFile!;
        // Upload URL is server-issued and self-authenticating — same pattern
        // as DocCapture. The backend re-validates the stored file.
        const uploadUrl = await getUploadUrl({});
        const resp = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": blob.type || "image/jpeg" },
          body: blob,
        });
        if (!resp.ok) throw new Error("Photo upload failed — please retry.");
        const json = (await resp.json()) as { storageId: Id<"_storage"> };
        photoStorageId = json.storageId;
      }

      // Applicant KYC documents were uploaded the moment they were picked —
      // they only need collecting here (the guard above ensures storageId).
      const applicantDocsPayload = applicantDocs.map((d) => ({
        docKind: d.kind,
        fileName: d.file.name,
        storageId: d.storageId as Id<"_storage">,
      }));

      // Co-applicant image — uploaded only when actually captured. The GPS fix
      // travels with a Geo Tagging capture only, and is re-validated
      // server-side with the same rules as the applicant's photo.
      let coPhotoStorageId: Id<"_storage"> | undefined;
      let coPhotoGeo:
        | {
            latitude: number;
            longitude: number;
            accuracyMeters: number;
            capturedAt: number;
            photoCapturedAt: number;
            permissionStatus: string;
          }
        | undefined;
      const coBlob =
        coPhotoMethod === "GEO_TAGGING"
          ? coApplicantPhoto?.blob
          : coPhotoMethod === "PHOTO_UPLOAD"
            ? coPhotoFile
            : null;
      if (coBlob) {
        const capUrl = await getUploadUrl({});
        const capResp = await fetch(capUrl, {
          method: "POST",
          headers: { "Content-Type": coBlob.type || "image/jpeg" },
          body: coBlob,
        });
        if (!capResp.ok)
          throw new Error("Co-applicant photo upload failed — please retry.");
        const capJson = (await capResp.json()) as { storageId: Id<"_storage"> };
        coPhotoStorageId = capJson.storageId;
      }
      if (coPhotoMethod === "GEO_TAGGING" && coApplicantPhoto) {
        coPhotoGeo = {
          latitude: coApplicantPhoto.geo.latitude,
          longitude: coApplicantPhoto.geo.longitude,
          accuracyMeters: coApplicantPhoto.geo.accuracyMeters,
          capturedAt: coApplicantPhoto.geo.capturedAt,
          photoCapturedAt: coApplicantPhoto.frameAt,
          permissionStatus: coApplicantPhoto.geo.permissionStatus,
        };
      }

      const coDocsPayload = coApplicantDocs.map((d) => ({
        docKind: d.kind,
        fileName: d.file.name,
        storageId: d.storageId as Id<"_storage">,
      }));

      // 3) Submit the client, linked to the selected centre.
      const result = await createClient({
        name: name.trim(),
        fatherName: fatherName.trim() || undefined,
        applicantFatherName: applicantFatherName.trim() || undefined,
        maternalHomeAddress: maternalHomeAddress.trim() || undefined,
        dob: dobTs,
        age: ageNum, // re-derived server-side from `dob`
        gender,
        mobile: mobile.trim(),
        address: address.trim(),
        occupation: occupation.trim(),
        monthlyIncome: monthly,
        householdIncome: household,
        panNumber: pan || undefined,
        voterId: voter || undefined,
        kycDocuments: kycDocs.length > 0 ? kycDocs : undefined,
        kycDocType: "AADHAAR",
        kycDocRef: kycDocRef.trim(),
        centerCode: selected.code,
        // Optional image — omitted entirely when nothing was captured, so the
        // backend stores no image row (and never invents one).
        photoStorageId,
        photoMethod: sentMethod,
        geo: photoGeo,
        // Applicant KYC document photos — normal captures, no geo-tagging,
        // saved against THIS applicant's side of the application.
        documents: applicantDocsPayload,
        // Co-applicant: details + geo-tagged photograph + normal KYC
        // documents, all kept attached to the co-applicant block.
        coApplicant: {
          name: coName.trim(),
          fatherName: coFatherName.trim() || undefined,
          relationship: coRelationship.trim(),
          dob: coDobTs,
          age: coAgeNum, // re-derived server-side from `dob`
          gender: coGender,
          mobile: coMobile.trim() || undefined,
          address: coAddress.trim() || undefined,
          aadhaarNumber: coAadhaar.trim() || undefined,
          panNumber: coPanValue || undefined,
          voterId: coVoterValue || undefined,
          kycDocuments: coKycDocs.length > 0 ? coKycDocs : undefined,
          // Geo capture → stamped file + its real fix; plain upload → the file
          // only (the backend stores no coordinates for it).
          coGpsStorageId: coPhotoGeo ? coPhotoStorageId : undefined,
          coGpsGeo: coPhotoGeo,
          photoStorageId: coPhotoGeo ? undefined : coPhotoStorageId,
          documents: coDocsPayload,
        },
        // Restored application sections 1–5. Every value typed into the form
        // travels to the backend, which re-validates it before it lands on
        // the client record.
        typeOfBusiness: typeOfBusiness.trim() || undefined,
        businessAddress: businessAddress.trim() || undefined,
        householdExpenses: expenses,
        otherIncome: otherInc,
        existingLoanEmi: emi,
        loanRequest,
        bankAccount,
        nominee,
        references: referenceValues.length > 0 ? referenceValues : undefined,
        // Section 6 — server-side, this is only honoured for SUPER_ADMIN /
        // BRANCH_MANAGER: a field officer's entry can never mark a client
        // verified, recommended or approved.
        officeUse,
        declarationAccepted: true,
      });

      toast.success(
        `${fmtId(result.code)} joined ${selected.name} (${fmtId(selected.code)})`,
      );
      navigate(`/dashboard/clients/${result.clientId}`);
    } catch (err) {
      // The centre was created/selected in its own step — it survives a
      // failed client submission, so the form stays open for a safe retry.
      toast.error(
        err instanceof Error ? err.message : "Client submission failed.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  /* ------------------------------ Step 1: popup ------------------------- */

  if (!selected) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="New client"
          subtitle="Step 1 of 2 — choose a centre for this client"
        />
        <div className="border-2 border-ink bg-sky p-3 text-xs font-bold">
          Every client joins a centre. Pick an existing centre or create a
          new one — the Centre ID is generated automatically when a centre is
          created.
        </div>
        <div className="flex min-h-[40vh] items-start justify-center pt-4">
          <div className="w-full max-w-md border-2 border-ink bg-paper shadow-hard">
            <div className="flex items-center justify-between border-b-2 border-ink bg-navy px-4 py-3 text-paper">
              <span className="flex items-center gap-2 text-sm font-black uppercase">
                <Building2 className="size-4 text-gold" />
                {creatingCenter ? "Create new centre" : "Choose a centre"}
              </span>
              <span className="font-mono text-[10px] font-bold uppercase text-gold">
                New client
              </span>
            </div>

            {creatingCenter ? (
              <div className="space-y-3 p-4">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-black uppercase">
                    Centre name *
                  </span>
                  <Input
                    value={centerName}
                    onChange={(e) => setCenterName(e.target.value)}
                    placeholder="e.g. Ballia"
                    autoFocus
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-black uppercase">
                    Village / area
                  </span>
                  <Input
                    value={centerVillage}
                    onChange={(e) => setCenterVillage(e.target.value)}
                    placeholder="e.g. Ballia town"
                  />
                </label>
                <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
                  A unique six-digit Centre ID (e.g. 257510) is generated and saved
                  with the centre.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setCreatingCenter(false)}
                    disabled={busy}
                  >
                    Back
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={submitCenter}
                    disabled={busy}
                  >
                    {busy ? <Loader2 className="animate-spin" /> : <Plus />}
                    Create
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3 p-4">
                <div className="flex items-center border-2 border-ink bg-white shadow-hard-sm">
                  <Search className="ml-3 size-4 shrink-0 text-muted-foreground" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search Centre ID or name…"
                    className="h-11 w-full bg-transparent px-3 text-sm font-bold outline-none"
                  />
                </div>

                <div className="max-h-64 overflow-y-auto">
                  {centers === undefined ? (
                    <RowSkeleton rows={3} />
                  ) : !q.trim() ? (
                    // No search query entered — show nothing (search-only behavior)
                    <p className="border-2 border-dashed border-ink p-3 text-center text-xs font-bold text-muted-foreground">
                      Enter a Centre Name or Centre ID to search.
                    </p>
                  ) : centers.length === 0 ? (
                    // Search query entered but no matches found
                    <p className="border-2 border-dashed border-ink p-3 text-center text-xs font-bold text-muted-foreground">
                      No matching centre found.
                    </p>
                  ) : (
                    // Query entered and matches found
                    <div className="flex flex-col gap-2">
                      {centers.map((c) => (
                        <button
                          key={c._id}
                          onClick={() => setSelected(c)}
                          className="flex items-center justify-between gap-2 border-2 border-ink bg-card px-3 py-2 text-left shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-black">
                              {c.name}
                            </span>
                            <span className="block text-[11px] font-semibold text-muted-foreground">
                              {c.village || "—"}
                            </span>
                          </span>
                          <span className="shrink-0 border-2 border-ink bg-navy px-2 py-1 font-mono text-[10px] font-black text-gold">
                            {fmtId(c.code)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  onClick={() => setCreatingCenter(true)}
                  className="flex w-full items-center justify-center gap-2 border-2 border-ink bg-gold px-3 py-3 text-xs font-black uppercase shadow-hard-sm transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
                >
                  <Plus className="size-4" /> Create New Center
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ---------------------- Step 2: client joining form ------------------- */

  const field =
    "w-full border-2 border-ink bg-white px-3 py-2 text-sm font-bold outline-none focus:bg-sky/30";
  const label = "mb-1 block text-[11px] font-black uppercase";

  return (
    <div className="space-y-4 pb-10">
      <PageHeader
        title="Client joining form"
        subtitle={`Step 2 of 2 — join client to ${selected.name}`}
        action={
          <Button size="sm" variant="outline" onClick={() => setSelected(null)}>
            <ChevronLeft /> Change centre
          </Button>
        }
      />

      {/* Locked centre — preselected, no Centre ID to re-enter. */}
      <div className="flex items-center justify-between gap-2 border-2 border-ink bg-navy px-3 py-3 text-paper shadow-hard">
        <span className="min-w-0">
          <span className="block truncate text-sm font-black uppercase">
            {selected.name}
          </span>
          <span className="block text-[11px] font-semibold text-paper/70">
            {selected.village || "Centre locked for this application"}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Lock className="size-3 text-gold" />
          <span className="border-2 border-gold px-2 py-1 font-mono text-xs font-black text-gold">
            {fmtId(selected.code)}
          </span>
        </span>
      </div>

      <div className="border-2 border-ink bg-card p-3 shadow-hard">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className={label}>Full name *</span>
            <Input
              className={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="As per Aadhaar"
            />
          </label>
          <label className="block">
            <span className={label}>Husband name</span>
            <Input
              className={field}
              value={fatherName}
              onChange={(e) => setFatherName(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={label}>Father name</span>
            <Input
              className={field}
              value={applicantFatherName}
              onChange={(e) => setApplicantFatherName(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={label}>Mobile number *</span>
            <Input
              className={field}
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              inputMode="numeric"
              maxLength={10}
              placeholder="9876543210"
            />
          </label>
          <div className="block sm:col-span-2">
            <span className={label}>Date of birth * (day / month / year)</span>
            <DobPicker parts={dob} onChange={setDob} className={field} />
          </div>
          <label className="block">
            <span className={label}>Age (18–100) *</span>
            <Input
              className={field}
              value={applicantAge ?? ""}
              readOnly
              aria-readonly="true"
              placeholder="Auto-calculated"
              inputMode="numeric"
              maxLength={3}
            />
          </label>
          <label className="block">
            <span className={label}>Gender *</span>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value as (typeof GENDERS)[number])}
              className={cn(field, "h-[42px]")}
            >
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className={label}>Permanent address *</span>
            <textarea
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              rows={2}
              placeholder="House, village, post, district"
              className={cn(field, "resize-y")}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={label}>Maternal home address</span>
            <textarea
              value={maternalHomeAddress}
              onChange={(e) => setMaternalHomeAddress(e.target.value)}
              rows={2}
              placeholder="Father's home — house, village, post, district"
              className={cn(field, "resize-y")}
            />
          </label>
          <label className="block">
            <span className={label}>Occupation *</span>
            <Input
              className={field}
              value={occupation}
              onChange={(e) => setOccupation(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={label}>Monthly income (₹) *</span>
            <Input
              className={field}
              value={monthlyIncome}
              onChange={(e) => setMonthlyIncome(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </label>
          <label className="block">
            <span className={label}>Household income (₹) *</span>
            <Input
              className={field}
              value={householdIncome}
              onChange={(e) => setHouseholdIncome(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </label>
          <label className="block">
            <span className={label}>Aadhaar number (12 digits) *</span>
            <Input
              className={field}
              value={kycDocRef}
              onChange={(e) => setKycDocRef(e.target.value)}
              inputMode="numeric"
              maxLength={12}
              placeholder="XXXX XXXX XXXX"
            />
          </label>
          <label className="block">
            <span className={label}>PAN number (if available)</span>
            <Input
              className={field}
              value={panNumber}
              onChange={(e) => setPanNumber(e.target.value)}
              maxLength={10}
              placeholder="ABCDE1234F"
            />
          </label>
          <label className="block">
            <span className={label}>Voter ID (if available)</span>
            <Input
              className={field}
              value={voterId}
              onChange={(e) => setVoterId(e.target.value)}
              maxLength={10}
              placeholder="ABC1234567"
            />
          </label>
          <div className="sm:col-span-2">
            <span className={label}>KYC documents available</span>
            <KycDocChecks value={kycDocs} onChange={setKycDocs} />
          </div>
        </div>
      </div>

      {/* Client Photo / Geo Tagging — OPTIONAL at onboarding */}
      <div className="border-2 border-ink bg-card p-3 shadow-hard">
        <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase">
          <Camera className="size-4" /> Client Photo / Geo Tagging
        </div>
        <label className="block">
          <span className={label}>Capture method (optional)</span>
          <select
            className={cn(field, "h-[42px]")}
            value={photoMethod}
            onChange={(e) => {
              const next = e.target.value as "" | "PHOTO_UPLOAD" | "GEO_TAGGING";
              setPhotoMethod(next);
              // Switching methods discards the other path's pending capture so
              // only ONE real image can ever be submitted.
              if (next !== "GEO_TAGGING") setApplicantPhoto(null);
              if (next !== "PHOTO_UPLOAD") {
                setPhotoFile(null);
                if (photoPreview) URL.revokeObjectURL(photoPreview);
                setPhotoPreview(null);
              }
            }}
          >
            <option value="">Not now — image can be added later</option>
            <option value="PHOTO_UPLOAD">Photo Upload</option>
            <option value="GEO_TAGGING">Geo Tagging</option>
          </select>
        </label>

        {photoMethod === "PHOTO_UPLOAD" && (
          <div className="mt-3 space-y-2">
            <p className="text-[11px] font-bold text-muted-foreground">
              Select a client photograph from the device. No GPS is recorded
              for a manually uploaded photo.
            </p>
            <label className="flex w-full cursor-pointer items-center justify-center gap-2 border-2 border-ink bg-white px-3 py-2.5 text-xs font-black uppercase shadow-hard-sm">
              <Camera className="size-4" />
              {photoFile ? "Choose a different photo" : "Select photo"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  if (!file) return;
                  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
                    toast.error("Choose a JPEG, PNG or WebP image.");
                    return;
                  }
                  if (file.size <= 0 || file.size > 5 * 1024 * 1024) {
                    toast.error("Photo must be smaller than 5 MB.");
                    return;
                  }
                  if (photoPreview) URL.revokeObjectURL(photoPreview);
                  setPhotoFile(file);
                  setPhotoPreview(URL.createObjectURL(file));
                }}
              />
            </label>
            {photoPreview && (
              <div className="space-y-2">
                <img
                  src={photoPreview}
                  alt="Selected client photo"
                  className="block w-full border-2 border-ink object-cover"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    if (photoPreview) URL.revokeObjectURL(photoPreview);
                    setPhotoFile(null);
                    setPhotoPreview(null);
                  }}
                >
                  <Trash2 className="size-4" /> Remove photo
                </Button>
              </div>
            )}
          </div>
        )}

        {photoMethod === "GEO_TAGGING" && (
          <div className="mt-3">
            <ClientPhotoCapture value={applicantPhoto} onChange={setApplicantPhoto} />
          </div>
        )}

        {photoMethod === "" && (
          <p className="mt-2 text-[11px] font-bold text-muted-foreground">
            No image will be saved. The client profile will show "Image Not
            Available" and a photograph becomes compulsory only when this client
            enters loan processing.
          </p>
        )}
      </div>

      {/* Applicant KYC documents — normal photos/PDFs, no geo */}
      <DocCapture
        label="Applicant KYC document photos"
        hint="Normal photos or PDF — no geo-tagging. Add, preview, retake or remove before submitting."
        value={applicantDocs}
        setValue={setApplicantDocs}
        geoRequired={false}
      />

      {/* Co-applicant */}
      <div className="border-2 border-ink bg-card p-3 shadow-hard">
        <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase">
          <UserPlus className="size-4 text-foreground" /> Co-applicant
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className={label}>Co-applicant name *</span>
            <Input
              className={field}
              value={coName}
              onChange={(e) => setCoName(e.target.value)}
              placeholder="As per Aadhaar"
            />
          </label>
          <label className="block">
            <span className={label}>Father name</span>
            <Input
              className={field}
              value={coFatherName}
              onChange={(e) => setCoFatherName(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={label}>Relationship with applicant *</span>
            <Input
              className={field}
              value={coRelationship}
              onChange={(e) => setCoRelationship(e.target.value)}
              placeholder="e.g. Husband"
            />
          </label>
          <label className="block">
            <span className={label}>Gender *</span>
            <select
              value={coGender}
              onChange={(e) =>
                setCoGender(e.target.value as (typeof GENDERS)[number])
              }
              className={cn(field, "h-[42px]")}
            >
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Mobile number</span>
            <Input
              className={field}
              value={coMobile}
              onChange={(e) => setCoMobile(e.target.value)}
              inputMode="numeric"
              maxLength={10}
              placeholder="9876543210"
            />
          </label>
          <div className="block sm:col-span-2">
            <span className={label}>Date of birth * (day / month / year)</span>
            <DobPicker parts={coDob} onChange={setCoDob} className={field} />
          </div>
          <label className="block">
            <span className={label}>Age (18–100) *</span>
            <Input
              className={field}
              value={coAge ?? ""}
              readOnly
              aria-readonly="true"
              placeholder="Auto-calculated"
              inputMode="numeric"
              maxLength={3}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={label}>Complete address</span>
            <textarea
              value={coAddress}
              onChange={(e) => setCoAddress(e.target.value)}
              rows={2}
              placeholder="House, village, post, district"
              className={cn(field, "resize-y")}
            />
          </label>
          <label className="block">
            <span className={label}>Aadhaar number</span>
            <Input
              className={field}
              value={coAadhaar}
              onChange={(e) => setCoAadhaar(e.target.value)}
              inputMode="numeric"
              maxLength={12}
              placeholder="XXXX XXXX XXXX"
            />
          </label>
          <label className="block">
            <span className={label}>PAN number (if available)</span>
            <Input
              className={field}
              value={coPan}
              onChange={(e) => setCoPan(e.target.value)}
              maxLength={10}
              placeholder="ABCDE1234F"
            />
          </label>
          <label className="block">
            <span className={label}>Voter ID (if available)</span>
            <Input
              className={field}
              value={coVoter}
              onChange={(e) => setCoVoter(e.target.value)}
              maxLength={10}
              placeholder="ABC1234567"
            />
          </label>
          <div className="sm:col-span-2">
            <span className={label}>KYC documents available</span>
            <KycDocChecks value={coKycDocs} onChange={setCoKycDocs} />
          </div>
        </div>
      </div>

      {/* Co-applicant Photo / Geo Tagging — also OPTIONAL */}
      <div className="border-2 border-ink bg-card p-3 shadow-hard">
        <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase">
          <Camera className="size-4" /> Co-applicant Photo / Geo Tagging
        </div>
        <label className="block">
          <span className={label}>Capture method (optional)</span>
          <select
            className={cn(field, "h-[42px]")}
            value={coPhotoMethod}
            onChange={(e) => {
              const next = e.target.value as "" | "PHOTO_UPLOAD" | "GEO_TAGGING";
              setCoPhotoMethod(next);
              if (next !== "GEO_TAGGING") setCoApplicantPhoto(null);
              if (next !== "PHOTO_UPLOAD") {
                setCoPhotoFile(null);
                if (coPhotoPreview) URL.revokeObjectURL(coPhotoPreview);
                setCoPhotoPreview(null);
              }
            }}
          >
            <option value="">Not now — image can be added later</option>
            <option value="PHOTO_UPLOAD">Photo Upload</option>
            <option value="GEO_TAGGING">Geo Tagging</option>
          </select>
        </label>

        {coPhotoMethod === "PHOTO_UPLOAD" && (
          <div className="mt-3 space-y-2">
            <label className="flex w-full cursor-pointer items-center justify-center gap-2 border-2 border-ink bg-white px-3 py-2.5 text-xs font-black uppercase shadow-hard-sm">
              <Camera className="size-4" />
              {coPhotoFile ? "Choose a different photo" : "Select photo"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  if (!file) return;
                  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
                    toast.error("Choose a JPEG, PNG or WebP image.");
                    return;
                  }
                  if (file.size <= 0 || file.size > 5 * 1024 * 1024) {
                    toast.error("Photo must be smaller than 5 MB.");
                    return;
                  }
                  if (coPhotoPreview) URL.revokeObjectURL(coPhotoPreview);
                  setCoPhotoFile(file);
                  setCoPhotoPreview(URL.createObjectURL(file));
                }}
              />
            </label>
            {coPhotoPreview && (
              <img
                src={coPhotoPreview}
                alt="Selected co-applicant photo"
                className="block w-full border-2 border-ink object-cover"
              />
            )}
          </div>
        )}

        {coPhotoMethod === "GEO_TAGGING" && (
          <div className="mt-3">
            <ClientPhotoCapture value={coApplicantPhoto} onChange={setCoApplicantPhoto} />
          </div>
        )}
      </div>

      {/* Co-applicant KYC documents — normal photos/PDFs, no geo */}
      <DocCapture
        label="Co-applicant KYC document photos"
        hint="Normal photos or PDF — no geo-tagging. Add, preview, retake or remove before submitting."
        value={coApplicantDocs}
        setValue={setCoApplicantDocs}
        geoRequired={false}
      />

      {/* Section 1 — Income & business details */}
      <div className="border-2 border-ink bg-card p-3 shadow-hard">
        <div className="mb-3 flex items-center gap-2 text-xs font-black uppercase">
          <Briefcase className="size-4 text-foreground" /> Income &amp; business details
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={label}>Type of business</span>
            <Input
              className={field}
              value={typeOfBusiness}
              onChange={(e) => setTypeOfBusiness(e.target.value)}
              placeholder="e.g. Kirana store"
            />
          </label>
          <label className="block">
            <span className={label}>Estimated monthly income (₹) *</span>
            <Input
              className={field}
              value={monthlyIncome}
              onChange={(e) => setMonthlyIncome(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </label>
          <label className="block">
            <span className={label}>Monthly household expenses (₹)</span>
            <Input
              className={field}
              value={householdExpenses}
              onChange={(e) => setHouseholdExpenses(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </label>
          <label className="block">
            <span className={label}>Other income (₹)</span>
            <Input
              className={field}
              value={otherIncome}
              onChange={(e) => setOtherIncome(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </label>
          <label className="block">
            <span className={label}>Existing loan / EMI (₹)</span>
            <Input
              className={field}
              value={existingLoanEmi}
              onChange={(e) => setExistingLoanEmi(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className={label}>Business address</span>
            <textarea
              value={businessAddress}
              onChange={(e) => setBusinessAddress(e.target.value)}
              rows={2}
              placeholder="Shop / plot, village, post, district"
              className={cn(field, "resize-y")}
            />
          </label>
        </div>
      </div>

      {/* Section 2 — Loan details: a request on the application only */}
      <div className="border-2 border-ink bg-card p-3 shadow-hard">
        <div className="mb-1 flex items-center gap-2 text-xs font-black uppercase">
          <HandCoins className="size-4 text-foreground" /> Loan details
        </div>
        <p className="mb-3 border-2 border-ink bg-sky p-2 text-[11px] font-bold">
          Recorded as a request on this application — no loan is created,
          approved or disbursed from this form.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={label}>Loan amount requested (₹)</span>
            <Input
              className={field}
              value={loanAmount}
              onChange={(e) => setLoanAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </label>
          <label className="block">
            <span className={label}>Purpose of loan</span>
            <select
              value={loanPurpose}
              onChange={(e) => setLoanPurpose(e.target.value)}
              className={cn(field, "h-[42px]")}
            >
              <option value="">Select purpose…</option>
              {LOAN_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {sentenceCase(p)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Loan tenure (months)</span>
            <Input
              className={field}
              value={loanTenure}
              onChange={(e) => setLoanTenure(e.target.value)}
              inputMode="numeric"
              maxLength={3}
              placeholder="e.g. 12"
            />
          </label>
          <label className="block">
            <span className={label}>Repayment frequency</span>
            <select
              value={loanFrequency}
              onChange={(e) => setLoanFrequency(e.target.value)}
              className={cn(field, "h-[42px]")}
            >
              <option value="">Select frequency…</option>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {sentenceCase(f)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Estimated installment (₹)</span>
            <Input
              className={field}
              value={loanInstallment}
              onChange={(e) => setLoanInstallment(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </label>
        </div>
      </div>

      {/* Section 3 — Bank account details */}
      <div className="border-2 border-ink bg-card p-3 shadow-hard">
        <div className="mb-3 flex items-center gap-2 text-xs font-black uppercase">
          <Landmark className="size-4 text-foreground" /> Bank account details
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className={label}>Account holder name</span>
            <Input
              className={field}
              value={bankHolder}
              onChange={(e) => setBankHolder(e.target.value)}
              placeholder="As per bank records"
            />
          </label>
          <label className="block">
            <span className={label}>Bank name</span>
            <Input
              className={field}
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder="e.g. State Bank of India"
            />
          </label>
          <label className="block">
            <span className={label}>Branch</span>
            <Input
              className={field}
              value={bankBranch}
              onChange={(e) => setBankBranch(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={label}>Account number (6–20 digits)</span>
            <Input
              className={field}
              value={bankAccountNo}
              onChange={(e) => setBankAccountNo(e.target.value)}
              inputMode="numeric"
              maxLength={24}
              placeholder="000000000000"
            />
          </label>
          <label className="block">
            <span className={label}>IFSC code</span>
            <Input
              className={field}
              value={bankIfsc}
              onChange={(e) => setBankIfsc(e.target.value)}
              maxLength={11}
              placeholder="SBIN0001234"
            />
          </label>
          <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold sm:col-span-2">
            Leave all five fields blank when the applicant has no account yet —
            a partially filled block is rejected.
          </p>
        </div>
      </div>

      {/* Section 4 — Nominee details */}
      <div className="border-2 border-ink bg-card p-3 shadow-hard">
        <div className="mb-3 flex items-center gap-2 text-xs font-black uppercase">
          <HeartHandshake className="size-4 text-foreground" /> Nominee details
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className={label}>Nominee name</span>
            <Input
              className={field}
              value={nomineeName}
              onChange={(e) => setNomineeName(e.target.value)}
              placeholder="As per Aadhaar"
            />
          </label>
          <label className="block">
            <span className={label}>Relationship with applicant</span>
            <Input
              className={field}
              value={nomineeRelationship}
              onChange={(e) => setNomineeRelationship(e.target.value)}
              placeholder="e.g. Husband"
            />
          </label>
          <label className="block">
            <span className={label}>Age</span>
            <Input
              className={field}
              value={nomineeAge}
              onChange={(e) => setNomineeAge(e.target.value)}
              inputMode="numeric"
              maxLength={3}
              placeholder="0"
            />
          </label>
        </div>
        <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
          Optional block — when you start it, the nominee's name, relationship
          and age are all required.
        </p>
      </div>

      {/* Section 5 — Reference details (two entries) */}
      <div className="border-2 border-ink bg-card p-3 shadow-hard">
        <div className="mb-3 flex items-center gap-2 text-xs font-black uppercase">
          <Phone className="size-4 text-foreground" /> Reference details
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="border-2 border-ink bg-white p-2">
              <div className="mb-1.5 text-[10px] font-black uppercase tracking-[0.14em]">
                Reference {i + 1}
              </div>
              <label className="mb-2 block">
                <span className={label}>Reference name</span>
                <Input
                  className={field}
                  value={references[i].name}
                  onChange={(e) =>
                    setReferences((cur) =>
                      cur.map((r, j) =>
                        j === i ? { ...r, name: e.target.value } : r,
                      ),
                    )
                  }
                />
              </label>
              <label className="block">
                <span className={label}>Reference mobile number</span>
                <Input
                  className={field}
                  value={references[i].mobile}
                  onChange={(e) =>
                    setReferences((cur) =>
                      cur.map((r, j) =>
                        j === i ? { ...r, mobile: e.target.value } : r,
                      ),
                    )
                  }
                  inputMode="numeric"
                  maxLength={10}
                  placeholder="9876543210"
                />
              </label>
            </div>
          ))}
        </div>
        <p className="mt-2 border-2 border-ink bg-sky p-2 text-[11px] font-bold">
          Both rows may be left blank — a row with only a name or only a
          mobile number is rejected.
        </p>
      </div>

      <label className="flex cursor-pointer items-start gap-2 border-2 border-ink bg-sky p-3">
        <input
          type="checkbox"
          checked={declaration}
          onChange={(e) => setDeclaration(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--color-navy,#1b2a4a)]"
        />
        <span className="text-xs font-bold">
          I declare that the details above are true and the client has agreed
          to this application. *
        </span>
      </label>

      {/* Section 6 — FOR OFFICE USE ONLY, immediately after the declaration */}
      <div className="border-2 border-ink bg-gold p-3 shadow-hard">
        <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase">
          <ClipboardCheck className="size-4" /> For office use only
        </div>
        <p className="mb-3 border-2 border-ink bg-white p-2 text-[11px] font-bold">
          Optional. Server-side these entries are recorded only for authorised
          roles (branch manager / super admin) — a field officer's submission
          can never mark a client verified or approved.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className={label}>Field officer name</span>
            <Input
              className={field}
              value={officeOfficer}
              onChange={(e) => setOfficeOfficer(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={label}>Customer / group verification</span>
            <select
              value={officeCustomer}
              onChange={(e) => setOfficeCustomer(e.target.value)}
              className={cn(field, "h-[42px]")}
            >
              <option value="">Not assessed</option>
              {OFFICE_VERIFICATION.map((o) => (
                <option key={o} value={o}>
                  {sentenceCase(o)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>KYC verification</span>
            <select
              value={officeKyc}
              onChange={(e) => setOfficeKyc(e.target.value)}
              className={cn(field, "h-[42px]")}
            >
              <option value="">Not assessed</option>
              {OFFICE_KYC.map((o) => (
                <option key={o} value={o}>
                  {sentenceCase(o)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Credit assessment</span>
            <select
              value={officeCredit}
              onChange={(e) => setOfficeCredit(e.target.value)}
              className={cn(field, "h-[42px]")}
            >
              <option value="">Not assessed</option>
              {OFFICE_CREDIT.map((o) => (
                <option key={o} value={o}>
                  {sentenceCase(o)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Approved loan amount (₹)</span>
            <Input
              className={field}
              value={officeApproved}
              onChange={(e) => setOfficeApproved(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </label>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => navigate("/dashboard/clients")}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button className="flex-1" onClick={submitClient} disabled={submitting}>
          {submitting ? (
            <Loader2 className="animate-spin" />
          ) : (
            <UserPlus className="size-4" />
          )}            Submit — join {fmtId(selected.code)}
        </Button>
      </div>

      <p className="flex items-center gap-2 border-2 border-ink bg-white p-3 text-[11px] font-bold text-muted-foreground">
        <CheckCircle2 className="size-4 shrink-0 text-foreground" />
        The centre is re-verified on the server. If submission fails, this
        centre stays selected — fix the error and submit again.
      </p>
    </div>
  );
}
