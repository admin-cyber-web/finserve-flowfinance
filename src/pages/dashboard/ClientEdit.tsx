import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { DocCapture, type DocItem } from "@/components/fs/DocCapture";
import { ClientImagePanel } from "@/components/fs/ClientImagePanel";
import { ImageCropDialog } from "@/components/fs/ImageCropDialog";
import {
  ClientPhotoCapture,
  type CapturedClientPhoto,
} from "@/components/fs/ClientPhotoCapture";
import { EmptyState, PageHeader, RowSkeleton } from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProfile } from "@/hooks/use-profile";
import {
  FREQUENCIES,
  LOAN_PURPOSES,
  OFFICE_CREDIT,
  OFFICE_KYC,
  OFFICE_VERIFICATION,
} from "@/lib/finance/types";
import { ageFromDob } from "@/lib/finance/validate";
import { cn, fmtId, sentenceCase } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  Camera,
  Check,
  ImageOff,
  Loader2,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

/**
 * FULL client edit — the complete joining form for an already-submitted client.
 *
 * Every value is prefilled from the saved record, saved back to the same
 * client row (`clients.updateFull`), and reacts immediately in Client 360°.
 * The Client ID, branch, assignee, KYC status/verification and all loan /
 * approval records are never part of this page.
 */

const GENDERS = ["MALE", "FEMALE", "OTHER"] as const;
const KYC_TYPES = ["AADHAAR", "PAN", "VOTER_ID", "OTHER"] as const;
const DOC_KINDS = [
  { id: "AADHAAR", label: "Aadhaar" },
  { id: "PAN", label: "PAN" },
  { id: "VOTER_ID", label: "Voter ID" },
  { id: "OTHER", label: "Other" },
];

const label = "mb-1 block text-[11px] font-black uppercase tracking-wide";
const field = "h-10";

/** Epoch ms → `yyyy-mm-dd` for a native date input (local calendar day). */
function toDateInput(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** `yyyy-mm-dd` → epoch ms of that local calendar day (null when empty). */
function fromDateInput(value: string): number | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return null;
  }
  return dt.getTime();
}

type ClientDoc = Doc<"clients">;

export default function ClientEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profile, can } = useProfile();
  const clientId = id as Id<"clients">;
  const data = useQuery(api.clients.get, { clientId });

  if (!can("edit_client")) {
    return (
      <EmptyState
        title="Not allowed"
        hint="Your role does not have permission to edit client records."
      />
    );
  }

  if (data === undefined) return <RowSkeleton rows={8} />;
  if (!data) {
    return (
      <EmptyState
        title="Client not found"
        hint="The client may have been removed from this branch."
      />
    );
  }

  const canManageKyc =
    profile?.role === "SUPER_ADMIN" || profile?.role === "BRANCH_MANAGER";

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Edit ${data.client.name}`}
        subtitle={`${fmtId(data.client.code)} — every field of the joining form`}
      />
      <button
        type="button"
        onClick={() => navigate(`/dashboard/clients/${clientId}`)}
        className="flex items-center gap-2 text-xs font-black uppercase text-muted-foreground"
      >
        <ArrowLeft className="size-4" /> Back to Client 360°
      </button>
      <ClientEditForm
        key={data.client._id}
        client={data.client}
        documents={data.documents}
        centerName={data.center?.name ?? null}
        coApplicantPhotoUrl={data.coApplicantPhotoUrl ?? null}
        canManageKyc={canManageKyc}
        hasOfficeUse={Boolean(data.client.officeUse)}
        onDone={() => navigate(`/dashboard/clients/${clientId}`)}
      />
    </div>
  );
}

function ClientEditForm({
  client,
  documents,
  centerName,
  coApplicantPhotoUrl,
  canManageKyc,
  hasOfficeUse,
  onDone,
}: {
  client: ClientDoc;
  documents: ({ url: string | null } & Doc<"clientDocuments">)[];
  centerName: string | null;
  coApplicantPhotoUrl: string | null;
  canManageKyc: boolean;
  hasOfficeUse: boolean;
  onDone: () => void;
}) {
  const updateFull = useMutation(api.clients.updateFull);
  const updateOfficeUse = useMutation(api.clients.updateOfficeUse);
  const addClientDocuments = useMutation(api.clients.addClientDocuments);
  const getPhotoUploadUrl = useMutation(api.clients.photoUploadUrl);
  const attachCoApplicantPhoto = useMutation(api.clients.attachCoApplicantPhoto);

  const co = client.coApplicant;

  const [form, setForm] = useState<Record<string, string>>({
    name: client.name,
    fatherName: client.fatherName ?? "",
    applicantFatherName: client.applicantFatherName ?? "",
    husbandName: client.husbandName ?? "",
    fatherAddress: client.fatherAddress ?? "",
    maternalHomeAddress: client.maternalHomeAddress ?? "",
    dob: toDateInput(client.dob),
    gender: client.gender,
    mobile: client.mobile,
    altMobile: client.altMobile ?? "",
    address: client.address ?? "",
    village: client.village,
    district: client.district === "—" ? "" : client.district,
    state: client.state === "—" ? "" : client.state,
    pin: client.pin === "000000" ? "" : client.pin,
    centerCode: client.centerCode ?? "",
    groupCode: client.groupCode ?? "",
    kycDocType: client.kycDocType ?? "AADHAAR",
    kycDocRef: client.kycDocRef ?? "",
    panNumber: client.panNumber ?? "",
    voterId: client.voterId ?? "",
    occupation: client.occupation,
    typeOfBusiness: client.typeOfBusiness ?? "",
    businessAddress: client.businessAddress ?? "",
    monthlyIncome: String(client.monthlyIncome ?? ""),
    householdIncome: String(client.householdIncome ?? ""),
    householdExpenses:
      client.householdExpenses != null ? String(client.householdExpenses) : "",
    otherIncome: client.otherIncome != null ? String(client.otherIncome) : "",
    existingLoanEmi:
      client.existingLoanEmi != null ? String(client.existingLoanEmi) : "",
    loanAmount:
      client.loanRequest?.amountRequested != null
        ? String(client.loanRequest.amountRequested)
        : "",
    loanPurpose: client.loanRequest?.purpose ?? "",
    loanTenure:
      client.loanRequest?.tenureMonths != null
        ? String(client.loanRequest.tenureMonths)
        : "",
    loanFrequency: client.loanRequest?.repaymentFrequency ?? "",
    loanInstallment:
      client.loanRequest?.estimatedInstallment != null
        ? String(client.loanRequest.estimatedInstallment)
        : "",
    bankHolder: client.bankAccount?.accountHolderName ?? "",
    bankName: client.bankAccount?.bankName ?? "",
    bankBranch: client.bankAccount?.branch ?? "",
    bankAccountNo: client.bankAccount?.accountNumber ?? "",
    bankIfsc: client.bankAccount?.ifscCode ?? "",
    nomineeName: client.nominee?.name ?? "",
    nomineeRelationship: client.nominee?.relationship ?? "",
    nomineeAge: client.nominee?.age != null ? String(client.nominee.age) : "",
    ref1Name: client.references?.[0]?.name ?? "",
    ref1Mobile: client.references?.[0]?.mobile ?? "",
    ref2Name: client.references?.[1]?.name ?? "",
    ref2Mobile: client.references?.[1]?.mobile ?? "",
    coName: co?.name ?? "",
    coFatherName: co?.fatherName ?? "",
    coRelationship: co?.relationship ?? "",
    coDob: toDateInput(co?.dob),
    coGender: co?.gender ?? "MALE",
    coMobile: co?.mobile ?? "",
    coAddress: co?.address ?? "",
    coAadhaar: co?.aadhaarNumber ?? "",
    coPan: co?.panNumber ?? "",
    coVoter: co?.voterId ?? "",
    officeOfficer: client.officeUse?.fieldOfficerName ?? "",
    officeCustomer: client.officeUse?.customerVerification ?? "",
    officeKyc: client.officeUse?.kycVerification ?? "",
    officeCredit: client.officeUse?.creditAssessment ?? "",
    officeApproved:
      client.officeUse?.approvedLoanAmount != null
        ? String(client.officeUse.approvedLoanAmount)
        : "",
    officeRemarks: client.officeUse?.remarks ?? "",
  });
  const [kycDocs, setKycDocs] = useState<string[]>(client.kycDocuments ?? []);
  const [coKycDocs, setCoKycDocs] = useState<string[]>(
    co?.kycDocuments ?? [],
  );
  const [hasCo, setHasCo] = useState(Boolean(co));
  const [applicantDocs, setApplicantDocs] = useState<DocItem[]>([]);
  const [coDocs, setCoDocs] = useState<DocItem[]>([]);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Co-applicant photo — captured (geo-tagged) or uploaded, saved with the
  // rest of the form. `coPhotoMethod` decides which source is used.
  const [coPhotoMethod, setCoPhotoMethod] = useState<
    "GEO_TAGGING" | "PHOTO_UPLOAD"
  >("GEO_TAGGING");
  const [coPhoto, setCoPhoto] = useState<CapturedClientPhoto | null>(null);
  const [coPhotoFile, setCoPhotoFile] = useState<File | null>(null);
  const [coPhotoPreview, setCoPhotoPreview] = useState<string | null>(null);

  const set = (k: string) => (value: string) =>
    setForm((s) => ({ ...s, [k]: value }));

  const numOrNull = (raw: string) => {
    const t = raw.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };

  const removeDocument = async (docId: Id<"clientDocuments">, isCo: boolean) => {
    setBusy(true);
    try {
      await addClientDocuments({
        clientId: client._id,
        coApplicant: isCo,
        removeDocumentIds: [docId],
        device: navigator.userAgent.slice(0, 60),
      });
      toast.success("Document removed");
      setPendingRemoval(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the document");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    /* ----------------------------- validation ---------------------------- */
    if (!form.name.trim()) return toast.error("Name is required.");
    if (!/^[6-9]\d{9}$/.test(form.mobile.trim())) {
      return toast.error("Mobile must be a 10-digit Indian number.");
    }
    if (!form.occupation.trim()) return toast.error("Occupation is required.");
    if (!form.village.trim()) return toast.error("Village is required.");

    const dobTs = form.dob ? fromDateInput(form.dob) : null;
    if (form.dob && dobTs === null) return toast.error("Invalid date of birth.");
    if (dobTs !== null && dobTs > Date.now()) {
      return toast.error("Date of birth cannot be in the future.");
    }
    if (dobTs === null && client.age < 18) {
      return toast.error("Enter the client's date of birth.");
    }
    if (dobTs !== null && ageFromDob(dobTs) < 18) {
      return toast.error("Client must be at least 18 years old.");
    }

    const kycRef = form.kycDocRef.trim();
    if (!kycRef) return toast.error("KYC document number is required.");
    if (form.kycDocType === "AADHAAR" && !/^\d{12}$/.test(kycRef)) {
      return toast.error("Aadhaar must be exactly 12 digits.");
    }
    const pan = form.panNumber.trim().toUpperCase();
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
      return toast.error("PAN number must look like ABCDE1234F.");
    }
    const voter = form.voterId.trim().toUpperCase();
    if (voter && !/^[A-Z]{3}[0-9]{7}$/.test(voter)) {
      return toast.error("Voter ID must look like ABC1234567.");
    }

    const monthly = Number(form.monthlyIncome);
    const household = Number(form.householdIncome);
    if (!Number.isFinite(monthly) || monthly < 0) {
      return toast.error("Monthly income must be a valid amount.");
    }
    if (!Number.isFinite(household) || household < 0) {
      return toast.error("Household income must be a valid amount.");
    }
    const otherInc = numOrNull(form.otherIncome);
    const expenses = numOrNull(form.householdExpenses);
    const emi = numOrNull(form.existingLoanEmi);
    for (const [lbl, v] of [
      ["Other income", otherInc],
      ["Monthly household expenses", expenses],
      ["Existing loan / EMI", emi],
    ] as [string, number | null][]) {
      if (v !== null && (Number.isNaN(v) || v < 0)) {
        return toast.error(`${lbl} must be a valid amount.`);
      }
    }

    // Bank — all five together or none.
    const bankValues = [
      form.bankHolder.trim(),
      form.bankName.trim(),
      form.bankBranch.trim(),
      form.bankAccountNo.trim(),
      form.bankIfsc.trim(),
    ];
    const bankFilled = bankValues.filter((v) => v !== "").length;
    let bankAccount:
      | {
          accountHolderName: string;
          bankName: string;
          branch: string;
          accountNumber: string;
          ifscCode: string;
        }
      | null = null;
    if (bankFilled > 0) {
      if (bankFilled < 5) {
        return toast.error("Fill in all bank details, or leave them all blank.");
      }
      const accountNumber = form.bankAccountNo.replace(/\s/g, "");
      if (!/^\d{6,20}$/.test(accountNumber)) {
        return toast.error("Bank account number must be 6-20 digits.");
      }
      const ifscCode = form.bankIfsc.trim().toUpperCase();
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
        return toast.error("Invalid IFSC code — expected e.g. SBIN0001234.");
      }
      bankAccount = {
        accountHolderName: form.bankHolder.trim(),
        bankName: form.bankName.trim(),
        branch: form.bankBranch.trim(),
        accountNumber,
        ifscCode,
      };
    }

    // Loan request — optional block, but never half of one.
    const loanTouched =
      form.loanAmount.trim() !== "" || form.loanPurpose !== "" ||
      form.loanTenure.trim() !== "" || form.loanFrequency !== "";
    let loanRequest:
      | {
          amountRequested: number;
          purpose: string;
          tenureMonths: number;
          repaymentFrequency: string;
          estimatedInstallment?: number;
        }
      | null = null;
    if (loanTouched) {
      const amount = Number(form.loanAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return toast.error("Loan amount requested must be greater than zero.");
      }
      if (!form.loanPurpose) return toast.error("Select a purpose of loan.");
      const tenure = Number(form.loanTenure);
      if (!Number.isInteger(tenure) || tenure < 1 || tenure > 120) {
        return toast.error("Loan tenure must be between 1 and 120 months.");
      }
      if (!form.loanFrequency) return toast.error("Select a repayment frequency.");
      const installment = numOrNull(form.loanInstallment);
      if (installment !== null && (Number.isNaN(installment) || installment < 0)) {
        return toast.error("Estimated installment must be a valid amount.");
      }
      loanRequest = {
        amountRequested: amount,
        purpose: form.loanPurpose,
        tenureMonths: tenure,
        repaymentFrequency: form.loanFrequency,
        estimatedInstallment: installment ?? undefined,
      };
    }

    // Nominee — name, relationship and age together.
    const nomineeTouched =
      form.nomineeName.trim() !== "" ||
      form.nomineeRelationship.trim() !== "" ||
      form.nomineeAge.trim() !== "";
    let nominee: { name: string; relationship: string; age: number } | null = null;
    if (nomineeTouched) {
      if (!form.nomineeName.trim() || !form.nomineeRelationship.trim()) {
        return toast.error(
          "Nominee name and relationship with the applicant are required.",
        );
      }
      const age = Number(form.nomineeAge);
      if (!Number.isInteger(age) || age < 1 || age > 120) {
        return toast.error("Nominee age must be between 1 and 120.");
      }
      nominee = {
        name: form.nomineeName.trim(),
        relationship: form.nomineeRelationship.trim(),
        age,
      };
    }

    // References — blank rows are dropped, half rows rejected.
    const refs: { name: string; mobile: string }[] = [];
    const rawRefs = [
      { name: form.ref1Name.trim(), mobile: form.ref1Mobile.trim() },
      { name: form.ref2Name.trim(), mobile: form.ref2Mobile.trim() },
    ];
    for (let i = 0; i < rawRefs.length; i++) {
      const r = rawRefs[i];
      if (!r.name && !r.mobile) continue;
      if (!r.name) return toast.error(`Reference ${i + 1} name is required.`);
      if (!/^[6-9]\d{9}$/.test(r.mobile)) {
        return toast.error(`Reference ${i + 1} mobile must be a 10-digit number.`);
      }
      refs.push(r);
    }

    // Co-applicant — replace or remove the whole block.
    let coApplicant:
      | {
          name: string;
          fatherName?: string;
          relationship: string;
          dob: number;
          age?: number;
          gender?: string;
          mobile?: string;
          address?: string;
          aadhaarNumber?: string;
          panNumber?: string;
          voterId?: string;
          kycDocuments?: string[];
        }
      | null = null;
    if (hasCo) {
      if (!form.coName.trim()) return toast.error("Co-applicant name is required.");
      if (!form.coRelationship.trim()) {
        return toast.error("Co-applicant relationship is required.");
      }
      const coDob = fromDateInput(form.coDob);
      if (coDob === null) {
        return toast.error("Co-applicant date of birth is required.");
      }
      if (coDob > Date.now()) {
        return toast.error("Co-applicant date of birth cannot be in the future.");
      }
      if (ageFromDob(coDob) < 18) {
        return toast.error("Co-applicant must be at least 18 years old.");
      }
      const coAadhaar = form.coAadhaar.trim();
      if (coAadhaar && !/^\d{12}$/.test(coAadhaar)) {
        return toast.error("Co-applicant Aadhaar must be exactly 12 digits.");
      }
      const coPanValue = form.coPan.trim().toUpperCase();
      if (coPanValue && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(coPanValue)) {
        return toast.error("Co-applicant PAN must look like ABCDE1234F.");
      }
      const coVoterValue = form.coVoter.trim().toUpperCase();
      if (coVoterValue && !/^[A-Z]{3}[0-9]{7}$/.test(coVoterValue)) {
        return toast.error("Co-applicant Voter ID must look like ABC1234567.");
      }
      coApplicant = {
        name: form.coName.trim(),
        fatherName: form.coFatherName.trim() || undefined,
        relationship: form.coRelationship.trim(),
        dob: coDob,
        gender: form.coGender,
        mobile: form.coMobile.trim() || undefined,
        address: form.coAddress.trim() || undefined,
        aadhaarNumber: coAadhaar || undefined,
        panNumber: coPanValue || undefined,
        voterId: coVoterValue || undefined,
        kycDocuments: coKycDocs.length > 0 ? coKycDocs : undefined,
      };
    }

    const approved = numOrNull(form.officeApproved);
    if (approved !== null && (Number.isNaN(approved) || approved < 0)) {
      return toast.error("Approved loan amount must be a valid amount.");
    }

    /* ------------------------------- save -------------------------------- */
    setBusy(true);
    try {
      await updateFull({
        clientId: client._id,
        name: form.name.trim(),
        fatherName: form.fatherName.trim(),
        applicantFatherName: form.applicantFatherName.trim(),
        husbandName: form.husbandName.trim(),
        fatherAddress: form.fatherAddress.trim(),
        maternalHomeAddress: form.maternalHomeAddress.trim(),
        ...(dobTs !== null ? { dob: dobTs } : {}),
        gender: form.gender,
        mobile: form.mobile.trim(),
        altMobile: form.altMobile.trim() || null,
        address: form.address.trim(),
        village: form.village.trim(),
        district: form.district.trim(),
        state: form.state.trim(),
        pin: form.pin.trim(),
        centerCode: form.centerCode.trim() || null,
        groupCode: form.groupCode.trim() || null,
        kycDocType: form.kycDocType,
        kycDocRef: kycRef,
        panNumber: pan || null,
        voterId: voter || null,
        kycDocuments: kycDocs,
        occupation: form.occupation.trim(),
        typeOfBusiness: form.typeOfBusiness.trim(),
        businessAddress: form.businessAddress.trim(),
        monthlyIncome: monthly,
        householdIncome: household,
        householdExpenses: expenses,
        otherIncome: otherInc,
        existingLoanEmi: emi,
        loanRequest,
        bankAccount,
        nominee,
        references: refs,
        coApplicant,
        device: navigator.userAgent.slice(0, 60),
      });

      // FOR OFFICE USE ONLY — its own role-gated mutation.
      if (canManageKyc || hasOfficeUse || form.officeRemarks.trim()) {
        await updateOfficeUse({
          clientId: client._id,
          fieldOfficerName: form.officeOfficer.trim() || undefined,
          customerVerification: form.officeCustomer || undefined,
          kycVerification: form.officeKyc || undefined,
          creditAssessment: form.officeCredit || undefined,
          approvedLoanAmount: approved ?? undefined,
          remarks: form.officeRemarks.trim() || undefined,
          device: navigator.userAgent.slice(0, 60),
        });
      }

      // Newly uploaded KYC files (applicant and co-applicant).
      const applicantUploads = applicantDocs
        .filter((d) => d.status === "uploaded" && d.storageId)
        .map((d) => ({
          docKind: d.kind,
          fileName: d.file.name,
          storageId: d.storageId!,
        }));
      if (applicantUploads.length > 0) {
        await addClientDocuments({
          clientId: client._id,
          documents: applicantUploads,
          device: navigator.userAgent.slice(0, 60),
        });
      }
      const coUploads = coDocs
        .filter((d) => d.status === "uploaded" && d.storageId)
        .map((d) => ({
          docKind: d.kind,
          fileName: d.file.name,
          storageId: d.storageId!,
        }));
      if (coUploads.length > 0) {
        await addClientDocuments({
          clientId: client._id,
          coApplicant: true,
          documents: coUploads,
          device: navigator.userAgent.slice(0, 60),
        });
      }

      // Co-applicant photograph — only when a NEW capture/upload is pending
      // and the co-applicant block still exists. The file and (for Take Photo)
      // the GPS fix are re-validated server-side; a manual upload never claims
      // coordinates.
      const coPhotoBlob =
        coPhotoMethod === "GEO_TAGGING" ? coPhoto?.blob ?? null : coPhotoFile;
      if (hasCo && coPhotoBlob) {
        const uploadUrl = await getPhotoUploadUrl({});
        const resp = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": coPhotoBlob.type || "image/jpeg" },
          body: coPhotoBlob,
        });
        if (!resp.ok) {
          throw new Error("Co-applicant photo upload failed — please retry.");
        }
        const { storageId } = (await resp.json()) as {
          storageId: Id<"_storage">;
        };
        await attachCoApplicantPhoto({
          clientId: client._id,
          photoStorageId: storageId,
          photoMethod: coPhotoMethod,
          device: navigator.userAgent.slice(0, 60),
          geo:
            coPhotoMethod === "GEO_TAGGING" && coPhoto
              ? {
                  latitude: coPhoto.geo.latitude,
                  longitude: coPhoto.geo.longitude,
                  accuracyMeters: coPhoto.geo.accuracyMeters,
                  capturedAt: coPhoto.geo.capturedAt,
                  photoCapturedAt: coPhoto.frameAt,
                  permissionStatus: coPhoto.geo.permissionStatus,
                }
              : undefined,
        });
      }

      toast.success(
        hasCo && coPhotoBlob
          ? `${form.name.trim()} updated — co-applicant photo saved`
          : `${form.name.trim()} updated`,
      );
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save changes");
    } finally {
      setBusy(false);
    }
  };

  const text = (
    key: string,
    lbl: string,
    opts: {
      placeholder?: string;
      numeric?: boolean;
      className?: string;
      maxLength?: number;
    } = {},
  ) => (
    <label className={cn("block", opts.className)}>
      <span className={label}>{lbl}</span>
      <Input
        className={field}
        value={form[key] ?? ""}
        placeholder={opts.placeholder}
        inputMode={opts.numeric ? "numeric" : undefined}
        maxLength={opts.maxLength}
        onChange={(e) =>
          set(key)(
            opts.numeric ? e.target.value.replace(/[^\d.]/g, "") : e.target.value,
          )
        }
      />
    </label>
  );

  const ownDocs = documents.filter((d) => !d.coApplicant);
  const coApplicantDocs = documents.filter((d) => d.coApplicant);

  return (
    <div className="space-y-4 pb-24">
      <div className="border-2 border-ink bg-sky p-3 text-xs font-bold">
        Client ID {fmtId(client.code)} and KYC status are never changed by an
        edit. Loans, approvals and collections are untouched.
      </div>

      {/* ---------------------------- Photograph ------------------------- */}
      <section className="border-2 border-ink bg-card p-3 shadow-hard">
        <div className="mb-2 text-xs font-black uppercase">Client photograph</div>
        <ClientImagePanel clientId={client._id} clientName={client.name} />
      </section>

      {/* --------------------------- Personal ---------------------------- */}
      <Section title="Personal details">
        <div className="grid gap-3 sm:grid-cols-2">
          {text("name", "Full name *")}
          {text("fatherName", "Husband / legacy father name")}
          {text("applicantFatherName", "Applicant's father name")}
          {text("husbandName", "Husband name")}
          <label className="block">
            <span className={label}>Date of birth</span>
            <Input
              className={field}
              type="date"
              value={form.dob}
              max={toDateInput(Date.now())}
              onChange={(e) => set("dob")(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={label}>Gender</span>
            <select
              className={cn(field, "w-full border-2 border-ink bg-white px-2 text-sm font-bold")}
              value={form.gender}
              onChange={(e) => set("gender")(e.target.value)}
            >
              {GENDERS.map((g) => (
                <option key={g} value={g}>
                  {sentenceCase(g)}
                </option>
              ))}
            </select>
          </label>
          {text("mobile", "Mobile *", { numeric: true, maxLength: 10 })}
          {text("altMobile", "Alternate mobile", { numeric: true, maxLength: 10 })}
        </div>
      </Section>

      {/* ---------------------------- Address ---------------------------- */}
      <Section title="Address & centre">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className={label}>Permanent address</span>
            <textarea
              className="min-h-16 w-full resize-y border-2 border-ink bg-white px-2 py-1.5 text-sm font-semibold outline-none"
              value={form.address}
              onChange={(e) => set("address")(e.target.value)}
              rows={2}
            />
          </label>
          {text("fatherAddress", "Father's address")}
          {text("maternalHomeAddress", "Maternal home address")}
          {text("village", "Village / area *")}
          {text("district", "District")}
          {text("state", "State")}
          {text("pin", "PIN code", { numeric: true, maxLength: 8 })}
          {text("centerCode", "Centre ID", {
            placeholder: centerName ? `${client.centerCode} — ${centerName}` : "e.g. 257510",
          })}
          {text("groupCode", "Group code")}
        </div>
      </Section>

      {/* ------------------------- KYC identifiers ----------------------- */}
      <Section title="Aadhaar / PAN / Voter ID">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={label}>KYC document type</span>
            <select
              className={cn(field, "w-full border-2 border-ink bg-white px-2 text-sm font-bold")}
              value={form.kycDocType}
              onChange={(e) => set("kycDocType")(e.target.value)}
            >
              {KYC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === "VOTER_ID" ? "Voter ID" : sentenceCase(t)}
                </option>
              ))}
            </select>
          </label>
          {text("kycDocRef", "Document number *", { maxLength: 40 })}
          {text("panNumber", "PAN number", { maxLength: 10 })}
          {text("voterId", "Voter ID", { maxLength: 20 })}
        </div>
        <div className="mt-2 flex flex-wrap gap-3">
          {DOC_KINDS.map((k) => (
            <label key={k.id} className="flex items-center gap-1.5 text-[11px] font-bold uppercase">
              <input
                type="checkbox"
                checked={kycDocs.includes(k.id)}
                onChange={(e) =>
                  setKycDocs((cur) =>
                    e.target.checked ? [...cur, k.id] : cur.filter((x) => x !== k.id),
                  )
                }
              />
              {k.label}
            </label>
          ))}
        </div>
      </Section>

      {/* --------------------- Income & business ------------------------- */}
      <Section title="Income & business details">
        <div className="grid gap-3 sm:grid-cols-2">
          {text("occupation", "Occupation *")}
          {text("typeOfBusiness", "Type of business")}
          {text("businessAddress", "Business address", { className: "sm:col-span-2" })}
          {text("monthlyIncome", "Estimated monthly income ₹", { numeric: true })}
          {text("householdIncome", "Household income ₹", { numeric: true })}
          {text("householdExpenses", "Monthly household expenses ₹", { numeric: true })}
          {text("otherIncome", "Other income ₹", { numeric: true })}
          {text("existingLoanEmi", "Existing loan / EMI ₹", { numeric: true })}
        </div>
      </Section>

      {/* ------------------------ Loan request --------------------------- */}
      <Section title="Loan details — request only">
        <div className="grid gap-3 sm:grid-cols-2">
          {text("loanAmount", "Loan amount requested ₹", { numeric: true })}
          <label className="block">
            <span className={label}>Purpose of loan</span>
            <select
              className={cn(field, "w-full border-2 border-ink bg-white px-2 text-sm font-bold")}
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
          </label>
          {text("loanTenure", "Tenure (months)", { numeric: true })}
          <label className="block">
            <span className={label}>Repayment frequency</span>
            <select
              className={cn(field, "w-full border-2 border-ink bg-white px-2 text-sm font-bold")}
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
          </label>
          {text("loanInstallment", "Estimated installment ₹", { numeric: true })}
        </div>
        <p className="mt-2 border-2 border-ink bg-sky p-2 text-[11px] font-bold">
          This is the application's request only — it never creates or changes a
          loan, approval or disbursement.
        </p>
      </Section>

      {/* ------------------------- Bank details -------------------------- */}
      <Section title="Bank account details">
        <div className="grid gap-3 sm:grid-cols-2">
          {text("bankHolder", "Account holder name")}
          {text("bankName", "Bank name")}
          {text("bankBranch", "Branch")}
          {text("bankAccountNo", "Account number", { numeric: true, maxLength: 24 })}
          {text("bankIfsc", "IFSC code", { maxLength: 11 })}
        </div>
      </Section>

      {/* --------------------------- Nominee ----------------------------- */}
      <Section title="Nominee details">
        <div className="grid gap-3 sm:grid-cols-2">
          {text("nomineeName", "Nominee name", { className: "sm:col-span-2" })}
          {text("nomineeRelationship", "Relationship with applicant")}
          {text("nomineeAge", "Age", { numeric: true, maxLength: 3 })}
        </div>
      </Section>

      {/* -------------------------- References ---------------------------- */}
      <Section title="Reference details">
        <div className="grid gap-3 sm:grid-cols-2">
          {text("ref1Name", "Reference 1 name")}
          {text("ref1Mobile", "Reference 1 mobile", { numeric: true, maxLength: 10 })}
          {text("ref2Name", "Reference 2 name")}
          {text("ref2Mobile", "Reference 2 mobile", { numeric: true, maxLength: 10 })}
        </div>
      </Section>

      {/* ------------------------- Co-applicant -------------------------- */}
      <Section title="Co-applicant details">
        <label className="mb-3 flex items-center gap-2 text-xs font-bold">
          <input
            type="checkbox"
            checked={hasCo}
            onChange={(e) => setHasCo(e.target.checked)}
          />
          This client has a co-applicant
        </label>
        {hasCo && (
          <div className="grid gap-3 sm:grid-cols-2">
            {text("coName", "Co-applicant name *")}
            {text("coFatherName", "Father / husband name")}
            {text("coRelationship", "Relationship with applicant *")}
            <label className="block">
              <span className={label}>Date of birth *</span>
              <Input
                className={field}
                type="date"
                value={form.coDob}
                max={toDateInput(Date.now())}
                onChange={(e) => set("coDob")(e.target.value)}
              />
            </label>
            <label className="block">
              <span className={label}>Gender</span>
              <select
                className={cn(field, "w-full border-2 border-ink bg-white px-2 text-sm font-bold")}
                value={form.coGender}
                onChange={(e) => set("coGender")(e.target.value)}
              >
                {GENDERS.map((g) => (
                  <option key={g} value={g}>
                    {sentenceCase(g)}
                  </option>
                ))}
              </select>
            </label>
            {text("coMobile", "Mobile", { numeric: true, maxLength: 10 })}
            {text("coAddress", "Address", { className: "sm:col-span-2" })}
            {text("coAadhaar", "Aadhaar number", { numeric: true, maxLength: 12 })}
            {text("coPan", "PAN number", { maxLength: 10 })}
            {text("coVoter", "Voter ID", { maxLength: 20 })}
          </div>
        )}
        {hasCo && (
          <div className="mt-2 flex flex-wrap gap-3">
            {DOC_KINDS.map((k) => (
              <label
                key={k.id}
                className="flex items-center gap-1.5 text-[11px] font-bold uppercase"
              >
                <input
                  type="checkbox"
                  checked={coKycDocs.includes(k.id)}
                  onChange={(e) =>
                    setCoKycDocs((cur) =>
                      e.target.checked ? [...cur, k.id] : cur.filter((x) => x !== k.id),
                    )
                  }
                />
                {k.label}
              </label>
            ))}
          </div>
        )}
        {hasCo && (
          <CoApplicantPhotoEditor
            existingUrl={coApplicantPhotoUrl}
            method={coPhotoMethod}
            setMethod={setCoPhotoMethod}
            captured={coPhoto}
            setCaptured={setCoPhoto}
            file={coPhotoFile}
            setFile={setCoPhotoFile}
            preview={coPhotoPreview}
            setPreview={setCoPhotoPreview}
            disabled={busy}
          />
        )}
      </Section>

      {/* --------------------------- Documents --------------------------- */}
      <Section title="KYC files & uploaded documents">
        <DocList
          title="Applicant documents"
          docs={ownDocs}
          busy={busy}
          pendingRemoval={pendingRemoval}
          setPendingRemoval={setPendingRemoval}
          onRemove={(docId) => void removeDocument(docId, false)}
        />
        {canManageKyc ? (
          <div className="mt-3">
            <DocCapture
              label="Upload / replace applicant KYC files"
              hint="Aadhaar, PAN, Voter ID or Other — JPEG, PNG, WebP or PDF up to 5 MB."
              value={applicantDocs}
              setValue={setApplicantDocs}
            />
          </div>
        ) : (
          <p className="mt-2 text-[11px] font-bold text-muted-foreground">
            Only a SUPER_ADMIN or Branch Manager can add or replace KYC files.
          </p>
        )}

        {hasCo && (
          <>
            <div className="mt-5 border-t-2 border-ink pt-3">
              <DocList
                title="Co-applicant documents"
                docs={coApplicantDocs}
                busy={busy}
                pendingRemoval={pendingRemoval}
                setPendingRemoval={setPendingRemoval}
                onRemove={(docId) => void removeDocument(docId, true)}
              />
              {canManageKyc && (
                <div className="mt-3">
                  <DocCapture
                    label="Upload / replace co-applicant KYC files"
                    hint="Co-applicant Aadhaar, PAN, Voter ID or Other — JPEG, PNG, WebP or PDF up to 5 MB."
                    value={coDocs}
                    setValue={setCoDocs}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </Section>

      {/* -------------------------- Office use --------------------------- */}
      {(canManageKyc || hasOfficeUse) && (
        <Section title="For office use only">
          <div className="grid gap-3 sm:grid-cols-2">
            {text("officeOfficer", "Field officer name")}
            <Select
              lbl="Customer verification"
              value={form.officeCustomer}
              opts={OFFICE_VERIFICATION}
              onChange={set("officeCustomer")}
            />
            <Select
              lbl="KYC verification"
              value={form.officeKyc}
              opts={OFFICE_KYC}
              onChange={set("officeKyc")}
            />
            <Select
              lbl="Credit assessment"
              value={form.officeCredit}
              opts={OFFICE_CREDIT}
              onChange={set("officeCredit")}
            />
            {text("officeApproved", "Approved loan amount ₹", { numeric: true })}
            {text("officeRemarks", "Remarks", { className: "sm:col-span-2" })}
          </div>
        </Section>
      )}

      <div className="sticky bottom-2 flex gap-2 border-2 border-ink bg-paper p-2 shadow-hard">
        <Button variant="outline" className="flex-1" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button className="flex-1" onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          Save changes
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-2 border-ink bg-card p-3 shadow-hard">
      <div className="mb-3 text-xs font-black uppercase tracking-wide">{title}</div>
      {children}
    </section>
  );
}

function Select({
  lbl,
  value,
  opts,
  onChange,
}: {
  lbl: string;
  value: string;
  opts: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className={label}>{lbl}</span>
      <select
        className={cn(field, "w-full border-2 border-ink bg-white px-2 text-sm font-bold")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o} value={o}>
            {sentenceCase(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Co-applicant photograph — "Take Photo" (device camera with live GPS; the
 * capture is geo-stamped and location permission is required) or "Upload
 * File" (an existing JPEG/PNG/WebP, never carrying coordinates).
 *
 * The selection is saved only when the main Save runs, so it can be retaken,
 * replaced or removed first. A saved photo can be replaced but is never
 * deleted by this form.
 */
function CoApplicantPhotoEditor({
  existingUrl,
  method,
  setMethod,
  captured,
  setCaptured,
  file,
  setFile,
  preview,
  setPreview,
  disabled,
}: {
  existingUrl: string | null;
  method: "GEO_TAGGING" | "PHOTO_UPLOAD";
  setMethod: (m: "GEO_TAGGING" | "PHOTO_UPLOAD") => void;
  captured: CapturedClientPhoto | null;
  setCaptured: (v: CapturedClientPhoto | null) => void;
  file: File | null;
  setFile: (f: File | null) => void;
  preview: string | null;
  setPreview: (p: string | null) => void;
  disabled: boolean;
}) {
  // Picked upload waiting for the crop step (geo-tagging bypasses this).
  const [cropFile, setCropFile] = useState<File | null>(null);

  const clearUpload = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setFile(null);
  };

  const pending = method === "GEO_TAGGING" ? Boolean(captured) : Boolean(file);

  const tab = (value: "GEO_TAGGING" | "PHOTO_UPLOAD", text: string, icon: ReactNode) => (
    <button
      type="button"
      onClick={() => {
        if (method === value) return;
        setMethod(value);
        if (value === "PHOTO_UPLOAD") setCaptured(null);
        else clearUpload();
      }}
      className={cn(
        "flex items-center justify-center gap-1.5 border-2 border-ink px-2 py-2 text-[11px] font-black uppercase shadow-hard-sm",
        method === value ? "bg-gold" : "bg-white",
      )}
    >
      {icon} {text}
    </button>
  );

  return (
    <div className="mt-4 border-t-2 border-ink pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-black uppercase tracking-wide">
          Co-applicant photo
        </span>
        <span
          className={cn(
            "flex items-center gap-1 border-2 border-ink px-2 py-0.5 text-[10px] font-black uppercase",
            existingUrl ? "bg-mint" : "bg-blush",
          )}
        >
          {existingUrl ? <Check className="size-3" /> : <ImageOff className="size-3" />}
          {existingUrl ? "Photo on record" : "No photo"}
        </span>
      </div>

      {existingUrl && (
        <div className="mb-3 space-y-1">
          <img
            src={existingUrl}
            alt="Saved co-applicant photograph"
            className="block w-32 border-2 border-ink object-cover"
          />
          <p className="text-[10px] font-bold uppercase text-muted-foreground">
            Saved — choose a new photo below to replace it.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {tab("GEO_TAGGING", "Take Photo", <Camera className="size-3.5" />)}
        {tab("PHOTO_UPLOAD", "Upload File", <Upload className="size-3.5" />)}
      </div>

      <p className="mt-2 text-[10px] font-bold uppercase text-muted-foreground">
        {method === "GEO_TAGGING"
          ? "Live camera capture with device GPS — location permission required. The photo is stamped with the actual fix."
          : "Existing photograph — JPEG, PNG or WebP up to 5 MB. No GPS is recorded for an upload."}
      </p>

      {method === "GEO_TAGGING" ? (
        <div className="mt-2">
          <ClientPhotoCapture value={captured} onChange={setCaptured} />
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <label className="flex w-full cursor-pointer items-center justify-center gap-2 border-2 border-ink bg-white px-3 py-2.5 text-xs font-black uppercase shadow-hard-sm">
            <Upload className="size-4" />
            {file ? "Choose a different photo" : "Select photo"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              disabled={disabled}
              onChange={(e) => {
                const picked = e.target.files?.[0] ?? null;
                e.target.value = "";
                if (!picked) return;
                if (
                  !["image/jpeg", "image/png", "image/webp"].includes(picked.type)
                ) {
                  toast.error("Choose a JPEG, PNG or WebP image.");
                  return;
                }
                if (picked.size <= 0 || picked.size > 5 * 1024 * 1024) {
                  toast.error("Photo must be smaller than 5 MB.");
                  return;
                }
                setCropFile(picked);
              }}
            />
          </label>
          {preview && (
            <>
              <img
                src={preview}
                alt="Selected co-applicant photograph"
                className="block w-full border-2 border-ink object-cover"
              />
              <Button
                variant="outline"
                className="w-full"
                onClick={clearUpload}
                disabled={disabled}
              >
                <Trash2 className="size-4" /> Remove photo
              </Button>
            </>
          )}
        </div>
      )}

      <p className="mt-2 border-2 border-ink bg-sky p-2 text-[10px] font-bold">
        {pending
          ? "Will be saved against this co-applicant when you press Save changes."
          : "Nothing new selected — the existing photo (if any) stays unchanged."}
      </p>

      <ImageCropDialog
        open={cropFile !== null}
        file={cropFile}
        title="Crop co-applicant photograph"
        defaultAspect={3 / 4}
        onCancel={() => setCropFile(null)}
        onConfirm={(cropped) => {
          if (preview) URL.revokeObjectURL(preview);
          setFile(cropped);
          setPreview(URL.createObjectURL(cropped));
          setCropFile(null);
        }}
      />
    </div>
  );
}

function DocList({
  title,
  docs,
  busy,
  pendingRemoval,
  setPendingRemoval,
  onRemove,
}: {
  title: string;
  docs: ({ url: string | null } & Doc<"clientDocuments">)[];
  busy: boolean;
  pendingRemoval: string | null;
  setPendingRemoval: (id: string | null) => void;
  onRemove: (id: Id<"clientDocuments">) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-black uppercase tracking-wide">{title}</div>
      {docs.length === 0 ? (
        <p className="text-xs font-semibold text-muted-foreground">
          No files uploaded yet.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {docs.map((d) => (
            <div
              key={d._id}
              className="flex items-center justify-between gap-2 border-2 border-ink bg-white px-2 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-black">
                  {d.docKind ?? d.type} · {d.fileName}
                </div>
                <div className="text-[10px] font-bold uppercase text-muted-foreground">
                  {new Date(d.createdAt).toLocaleDateString("en-IN")} ·{" "}
                  {d.status.replace("_", " ").toLowerCase()}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {d.url && (
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    className="border-2 border-ink bg-sky px-2 py-1 text-[10px] font-black uppercase"
                  >
                    View
                  </a>
                )}
                {pendingRemoval === d._id ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRemove(d._id)}
                    className="border-2 border-ink bg-blush px-2 py-1 text-[10px] font-black uppercase text-destructive"
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPendingRemoval(d._id)}
                    className="border-2 border-ink bg-white px-2 py-1 text-[10px] font-black uppercase"
                    aria-label="Remove document"
                  >
                    <Trash2 className="size-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
