import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PageHeader, useBusy } from "@/components/fs/primitives";
import {
  ClientPhotoCapture,
  type CapturedClientPhoto,
} from "@/components/fs/ClientPhotoCapture";
import { Button } from "@/components/ui/button";
import {
  newDocKey,
  type DocItem,
  DOC_MAX_BYTES,
  DOC_TYPES,
  validateDocFile,
} from "@/components/fs/DocCapture";
import { useProfile } from "@/hooks/use-profile";
import { ageFromDob } from "@/lib/finance/validate";
import {
  FREQUENCIES,
  LOAN_PURPOSES,
  LOAN_PURPOSE_LABELS,
  OFFICE_CREDIT,
  OFFICE_KYC,
  OFFICE_VERIFICATION,
} from "@/lib/finance/types";
import { useMutation } from "convex/react";
import { useState, type ChangeEvent, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useNavigate } from "react-router";
import { Camera, CheckCircle2, FileText, Loader2, Upload } from "lucide-react";
import { geoValidationError, GEO_TIMEOUT_MS } from "@/lib/geo";
import { toast } from "sonner";

/**
 * Client onboarding application — the complete field form (applicant,
 * co-applicant, geo-tagged photo, family, income, loan request, bank,
 * nominee, declaration, office-use). Everything commits atomically in
 * `clients.create`; nothing here creates a loan or a financial transaction.
 */

function Field({
  label,
  children,
  required,
  hint,
}: {
  label: string;
  children: ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs font-black uppercase tracking-wider">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] font-semibold text-muted-foreground">{hint}</p>}
    </div>
  );
}

const inputCls =
  "h-11 w-full border-2 border-ink bg-white px-3 text-sm font-semibold outline-none focus:shadow-hard-sm";
const areaCls =
  "min-h-16 w-full border-2 border-ink bg-white px-3 py-2 text-sm font-semibold outline-none focus:shadow-hard-sm";

/** Convex surfaces thrown AppErrors with stack context — show only the message. */
function prettyError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : "Could not save the application — please retry.";
  const match = raw.match(/Uncaught AppError: ([^\\n]*)/);
  return (match?.[1]?.trim() || raw.replace(/^Uncaught\\s+/, "")).slice(0, 200);
}

/** Generic per-field binder for a flat string state slice. */
function bind<T>(set: Dispatch<SetStateAction<T>>, k: keyof T) {
  return (e: { target: { value: string } }) =>
    set((s) => ({ ...s, [k]: e.target.value }));
}

function digits(set: Dispatch<SetStateAction<Readonly<Record<string, string>>>, k: string, max: number) {
  return (e: ChangeEvent<HTMLInputElement>) =>
    set((s) => ({ ...s, [k]: e.target.value.replace(/\\D/g, "").slice(0, max) }));
}

const KYC_DOC_OPTIONS = [
  { id: "AADHAAR", label: "Aadhaar" },
  { id: "PAN", label: "PAN" },
  { id: "VOTER_ID", label: "Voter ID" },
  { id: "OTHER", label: "Other" },
] as const;

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const VOTER_RE = /^[A-Z]{3}[0-9]{7}$/;
const MOBILE_RE = /^[6-9]\\d{9}$/;
const AADHAAR_RE = /^\\d{12}$/;

interface FamilyRow {
  name: string;
  age: string;
  relationship: string;
  occupation: string;
}

const emptyFamilyRow = (): FamilyRow => ({
  name: "",
  age: "",
  relationship: "",
  occupation: "",
});

const todayIso = new Date().toISOString().slice(0, 10);

export default function ClientNew() {
  const navigate = useNavigate();
  const { profile } = useProfile();
  const create = useMutation(api.clients.create);
  const getUploadUrl = useMutation(api.clients.photoUploadUrl);
  const { busy, run } = useBusy();

  // Office-use edits are restricted to BM / admin — enforced server-side too.
  const canOffice =
    profile?.role === "SUPER_ADMIN" || profile?.role === "BRANCH_MANAGER";

  /* ------------------------------ form state ----------------------------- */

  const [applicant, setApplicant] = useState({
    name: "",
    husbandName: "",
    fatherName: "",
    dob: "",
    gender: "FEMALE",
    mobile: "",
    permanentAddress: "",
    fatherAddress: "",
    aadhaar: "",
    pan: "",
    voterId: "",
  });
  const [kycDocs, setKycDocs] = useState<string[]>(["AADHAAR"]);

  // Geo-tagged applicant photo — camera capture + fresh GPS fix (mandatory).
  const [photo, setPhoto] = useState<CapturedClientPhoto | null>(null);

  const [coEnabled, setCoEnabled] = useState(false);
  const [co, setCo] = useState({
    name: "",
    fatherName: "",
    relationship: "",
    dob: "",
    gender: "FEMALE",
    mobile: "",
    address: "",
    aadhaar: "",
    pan: "",
    voterId: "",
  });
  const [coKycDocs, setCoKycDocs] = useState<string[]>([]);
  const [coPhoto, setCoPhoto] = useState<{
    file: File;
    previewUrl: string;
  } | null>(null);
  // Co-applicant documents — uploaded the moment they are picked, so each row
  // shows a real status; only uploaded files are ever saved with the
  // application (never silently discarded).
  const [coDocKind, setCoDocKind] = useState<string>("AADHAAR");
  const [coDocs, setCoDocs] = useState<DocItem[]>([]);
  // Co-applicant GPS photo — the photograph is captured with a fresh device
  // GPS fix (≤ 100 m accuracy); a bad or stale fix is rejected outright.
  const [coGps, setCoGps] = useState<{
    key: string;
    file: File;
    previewUrl: string;
    status: "locating" | "uploading" | "uploaded" | "error";
    fix?: { latitude: number; longitude: number; accuracyMeters: number; capturedAt: number; permissionStatus: string; storageId?: Id<"_storage"> };
    frameAt: number;
  } | null>(null);
  // Applicant documents — photographed or picked; the same secure storage
  // path as co-applicant documents, so nothing is silently dropped.
  const [applicantDocKind, setApplicantDocKind] = useState<string>("AADHAAR");
  const [applicantDocs, setApplicantDocs] = useState<DocItem[]>([]);

  const [family, setFamily] = useState<FamilyRow[]>([
    emptyFamilyRow(),
    emptyFamilyRow(),
    emptyFamilyRow(),
    emptyFamilyRow(),
  ]);

  const [biz, setBiz] = useState({
    typeOfBusiness: "",
    businessAddress: "",
    monthlyIncome: "",
    householdExpenses: "",
    otherIncome: "",
    existingEmi: "",
  });

  const [loan, setLoan] = useState({
    amount: "",
    purpose: "BUSINESS",
    tenure: "",
    frequency: "MONTHLY",
    installment: "",
  });

  const [bank, setBank] = useState({
    holder: "",
    bankName: "",
    branch: "",
    accountNumber: "",
    ifsc: "",
  });

  const [nominee, setNominee] = useState({
    name: "",
    relationship: "",
    age: "",
    mobile: "",
    address: "",
  });

  const [declaration, setDeclaration] = useState(false);

  const [office, setOffice] = useState({
    fieldOfficerName: "",
    customerVerification: "",
    kycVerification: "",
    creditAssessment: "",
    approvedAmount: "",
    remarks: "",
  });

  // Re-entry guard covering the WHOLE submit (uploads + create), so repeated
  // taps can never create duplicate clients.
  const [submitting, setSubmitting] = useState(false);

  /* ------------------------------ validation ----------------------------- */

  const applicantAge = applicant.dob
    ? ageFromDob(new Date(applicant.dob).getTime())
    : null;
  const coAge = co.dob ? ageFromDob(new Date(co.dob).getTime()) : null;

  const aadhaarOk = AADHAAR_RE.test(applicant.aadhaar.trim());
  const panOk = !applicant.pan.trim() || PAN_RE.test(applicant.pan.trim().toUpperCase());
  const voterOk =
    !applicant.voterId.trim() || VOTER_RE.test(applicant.voterId.trim().toUpperCase());
  const mobileOk = MOBILE_RE.test(applicant.mobile.trim());
  const ageOk = applicantAge !== null && applicantAge >= 18 && applicantAge <= 100;

  // Family rows: incomplete rows are ignored; at least one complete row.
  const filledFamily = family.filter(
    (r) => r.name.trim() || r.relationship.trim() || r.age.trim() || r.occupation.trim(),
  );
  const familyOk =
    filledFamily.length >= 1 &&
    filledFamily.every(
      (r) => r.name.trim().length >= 2 && r.relationship.trim().length >= 1,
    ) &&
    filledFamily.every((r) => {
      const age = Number(r.age);
      return !r.age.trim() || (Number.isFinite(age) && age >= 1 && age <= 100);
    });

  // Co-applicant is optional; when enabled, name + relationship required.
  const coTouched =
    co.name.trim() || co.relationship.trim() || co.fatherName.trim() || co.mobile.trim();
  const coOk = !coEnabled
    ? true
    : Boolean(
        co.name.trim().length >= 2 &&
          co.relationship.trim() &&
          (!co.mobile.trim() || MOBILE_RE.test(co.mobile.trim())) &&
          (!co.aadhaar.trim() || AADHAAR_RE.test(co.aadhaar.trim())) &&
          (!co.pan.trim() || PAN_RE.test(co.pan.trim().toUpperCase())) &&
          (!co.voterId.trim() || VOTER_RE.test(co.voterId.trim().toUpperCase())) &&
          (coAge === null || (coAge >= 18 && coAge <= 100)),
      );

  // Every selected co-applicant document must have finished uploading — an
  // in-flight or failed upload can never be silently dropped at submission.
  const coDocsOk = coDocs.every((d) => d.status === "uploaded");

  // Applicant documents: every picked file must finish uploading.
  const applicantDocsOk = applicantDocs.every((d) => d.status === "uploaded");

  // Co-applicant GPS photo: must be fully uploaded when present.
  const coGpsOk = !coGps || coGps.status === "uploaded";

  // Loan request: optional, but internally consistent when started.
  const loanStarted = loan.amount.trim() !== "";
  const loanOk =
    !loanStarted ||
    Boolean(
      Number(loan.amount) > 0 &&
        loan.purpose &&
        Number(loan.tenure) >= 1 &&
        Number(loan.tenure) <= 120 &&
        loan.frequency,
    );

  // Bank details: all-or-nothing with format checks.
  const bankTouched = Object.values(bank).some((v) => v.trim());
  const bankOk =
    !bankTouched ||
    Boolean(
      bank.holder.trim() &&
        bank.bankName.trim() &&
        bank.branch.trim() &&
        /^\\d{6,20}$/.test(bank.accountNumber.trim()) &&
        /^[A-Z]{4}0[A-Z0-9]{6}$/.test(bank.ifsc.trim().toUpperCase()),
    );

  // Nominee: optional; when started, name + relationship + age required.
  const nomineeTouched = nominee.name.trim() || nominee.relationship.trim();
  const nomineeOk =
    !nomineeTouched ||
    Boolean(
      nominee.name.trim().length >= 2 &&
        nominee.relationship.trim() &&
        Number(nominee.age) >= 1 &&
        Number(nominee.age) <= 120 &&
        (!nominee.mobile.trim() || MOBILE_RE.test(nominee.mobile.trim())),
    );

  const valid =
    applicant.name.trim().length >= 2 &&
    applicant.permanentAddress.trim().length >= 3 &&
    mobileOk &&
    ageOk &&
    aadhaarOk &&
    panOk &&
    voterOk &&
    kycDocs.length >= 1 &&
    photo !== null &&
    biz.typeOfBusiness.trim().length >= 2 &&
    Number(biz.monthlyIncome || 0) >= 0 &&
    familyOk &&
    coOk &&
    coDocsOk &&
    applicantDocsOk &&
    coGpsOk &&
    loanOk &&
    bankOk &&
    nomineeOk &&
    declaration;

  /* ------------------------------- co photo ------------------------------ */

  const CO_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
  const onCoPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Co-applicant photo must be a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size <= 0 || file.size > CO_PHOTO_MAX_BYTES) {
      toast.error("Co-applicant photo must be between 1 byte and 5 MB.");
      return;
    }
    if (coPhoto?.previewUrl) URL.revokeObjectURL(coPhoto.previewUrl);
    setCoPhoto({ file, previewUrl: URL.createObjectURL(file) });
  };

  /* ---------- applicant documents (photographed or picked) ---------- */

  const onApplicantDoc = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = validateDocFile(file, "Applicant document");
    if (problem) {
      toast.error(problem);
      return;
    }
    const key = newDocKey();
    setApplicantDocs((cur) => [
      ...cur,
      {
        key,
        kind: applicantDocKind,
        file,
        previewUrl: URL.createObjectURL(file),
        status: "uploading",
      },
    ]);
    void uploadCoDoc(key, file);
  };

  /* ---------- co-applicant documents (photographed or picked) ---------- */

  const uploadCoDoc = async (key: string, file: File) => {
    try {
      const url = await getUploadUrl({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      const parsed = (await res.json()) as { storageId: string };
      setCoDocs((cur) =>
        cur.map((d) =>
          d.key === key
            ? { ...d, status: "uploaded", storageId: parsed.storageId as Id<"_storage"> }
            : d,
        ),
      );
    } catch {
      setCoDocs((cur) =>
        cur.map((d) => (d.key === key ? { ...d, status: "error" } : d)),
      );
      toast.error(`Upload failed for "${file.name}" — retry or remove it.`);
    }
  };

  const onCoDoc = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = validateDocFile(file, "Co-applicant document");
    if (problem) {
      toast.error(problem);
      return;
    }
    const key = newDocKey();
    setCoDocs((cur) => [
      ...cur,
      {
        key,
        kind: coDocKind,
        file,
        previewUrl: URL.createObjectURL(file),
        status: "uploading",
      },
    ]);
    void uploadCoDoc(key, file);
  };

  const removeCoDoc = (key: string) =>
    setCoDocs((cur) => cur.filter((d) => d.key !== key));

  const removeApplicantDoc = (key: string) =>
    setApplicantDocs((cur) => cur.filter((d) => d.key !== key));

  /* ---------- co-applicant GPS photo capture ---------- */

  const onCoGpsPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Co-applicant photo must be a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size <= 0 || file.size > CO_PHOTO_MAX_BYTES) {
      toast.error("Co-applicant photo must be between 1 byte and 5 MB.");
      return;
    }
    const key = newDocKey();
    // Stamp the photo with a real device GPS fix — captured here, validated
    // by the SAME server rules as the applicant photo.
    setCoGps({
      key,
      file,
      previewUrl: URL.createObjectURL(file),
      status: "locating",
      frameAt: Date.now(),
    });
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        const w = navigator.geolocation.watchPosition(
          (p) => {
            navigator.geolocation.clearWatch(w);
            resolve(p);
          },
          reject,
          { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 0 },
        );
        setTimeout(() => navigator.geolocation.clearWatch(w), GEO_TIMEOUT_MS);
      });
      const fix = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracyMeters: pos.coords.accuracy,
        capturedAt: pos.timestamp,
        permissionStatus: "granted",
      };
      const err = geoValidationError(fix, Date.now());
      if (err) {
        setCoGps((prev) => (prev?.key === key ? { ...prev, status: "error" } : prev));
        toast.error(
          "Co-applicant photo GPS is too inaccurate or stale — try again in open air.",
        );
        return;
      }
      setCoGps({
        key,
        file,
        previewUrl: URL.createObjectURL(file),
        status: "uploading",
        fix,
        frameAt: Date.now(),
      });
      const url = await getUploadUrl({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      const parsed = (await res.json()) as { storageId: string };
      setCoGps({
        key,
        file,
        previewUrl: URL.createObjectURL(file),
        status: "uploaded",
        fix: { ...fix, storageId: parsed.storageId as Id<"_storage"> },
        frameAt: Date.now(),
      });
    } catch (err) {
      setCoGps((prev) => (prev?.key === key ? { ...prev, status: "error" } : prev));
      toast.error(
        err instanceof Error ? err.message : "Co-applicant GPS photo capture failed",
      );
    }
  };

  /* ---------- co-applicant removal guard ---------- */

  const toggleKycDoc = (id: string, list: string[], setList: Dispatch<SetStateAction<string[]>>) =>
    setList((cur) =>
      cur.includes(id) ? cur.filter((d) => d !== id) : [...cur, id],
    );

  /* -------------------------------- submit ------------------------------- */

  const submit = async () => {
    if (submitting) return;
    if (coDocs.some((d) => d.status !== "uploaded")) {
      toast.error(
        "Co-applicant documents are still uploading — retry or remove any failed file.",
      );
      return;
    }
    if (coDocs.length > 0 && !(coEnabled && co.name.trim())) {
      toast.error(
        "Co-applicant documents were added — keep the co-applicant enabled, or remove the files.",
      );
      return;
    }
    if (applicantDocs.some((d) => d.status !== "uploaded")) {
      toast.error(
        "Applicant documents are still uploading — retry or remove any failed file.",
      );
      return;
    }
    if (coGps && coGps.status !== "uploaded") {
      toast.error(
        "Co-applicant GPS photo capture is still in progress or failed — retry or remove it.",
      );
      return;
    }
    if (!valid || !photo || applicantAge === null) {
      toast.error(
        "Fill all required details — Aadhaar, declaration, and the applicant photo with GPS.",
      );
      return;
    }
    setSubmitting(true);
    try {
      // 1. Server-issued, short-lived upload URL (RBAC-checked).
      const uploadUrl = await getUploadUrl({});
      // 2. Upload the stamped applicant photo to private Convex storage.
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": photo.blob.type || "image/jpeg" },
        body: photo.blob,
      });
      if (!res.ok) {
        throw new Error(
          "Photo upload failed — check your connection and retry (no client was created).",
        );
      }
      const { storageId } = (await res.json()) as { storageId: string };

      // 2b. Optional co-applicant photo — a real upload, never a file name.
      let coPhotoStorageId: Id<"_storage"> | undefined;
      if (coPhoto) {
        const coUploadUrl = await getUploadUrl({});
        const coRes = await fetch(coUploadUrl, {
          method: "POST",
          headers: { "Content-Type": coPhoto.file.type },
          body: coPhoto.file,
        });
        if (!coRes.ok) {
          throw new Error(
            "Co-applicant photo upload failed — retry (no client was created).",
          );
        }
        const parsed = (await coRes.json()) as { storageId: string };
        coPhotoStorageId = parsed.storageId as Id<"_storage">;
      }

      // 2c. Co-applicant GPS photo — a real device fix, uploaded + stored.
      let coGpsStorageId: Id<"_storage"> | undefined;
      let coGpsGeo: {
        latitude: number;
        longitude: number;
        accuracyMeters: number;
        capturedAt: number;
        permissionStatus: string;
      } | undefined;
      if (coGps && coGps.status === "uploaded" && coGps.fix) {
        const gUrl = await getUploadUrl({});
        const gRes = await fetch(gUrl, {
          method: "POST",
          "Content-Type": coGps.file.type || "image/jpeg"
          body: coGps.file,
        });
        if (gRes.ok) {
          const parsed = (await gRes.json()) as { storageId: string };
          coGpsStorageId = parsed.storageId as Id<"_storage">;
          coGpsGeo = {
            latitude: coGps.fix.latitude,
            longitude: coGps.fix.longitude,
            accuracyMeters: coGps.fix.accuracyMeters,
            capturedAt: coGps.fix.capturedAt,
            permissionStatus: coGps.fix.permissionStatus,
          };
        }
      }

      // 2d. Applicant documents — uploaded the moment they are picked; only
      //     completed uploads are ever saved with the application.
      let applicantDocuments:
        | { docKind: string; fileName: string; storageId: Id<"_storage"> }[]
        | undefined;
      if (applicantDocsOk) {
        applicantDocuments = applicantDocs.map((d) => ({
          docKind: d.kind,
          fileName: d.file.name,
          storageId: d.storageId as Id<"_storage">,
        }));
      }

      const familyRows = filledFamily.map((r) => ({
        name: r.name.trim(),
        age: r.age.trim() ? Number(r.age) : undefined,
        relationship: r.relationship.trim(),
        occupation: r.occupation.trim() || undefined,
      }));

      // 3. Atomic create: client + photo link + family rows + documents commit
      //    together, so a failure can never leave a duplicate or half-created
      //    client.
      const result = await run(() =>
        create({
          name: applicant.name.trim(),
          fatherName: applicant.fatherName.trim() || undefined,
          husbandName: applicant.husbandName.trim() || undefined,
          fatherAddress: applicant.fatherAddress.trim() || undefined,
          dob: new Date(applicant.dob).getTime(),
          age: applicantAge,
          gender: applicant.gender,
          mobile: applicant.mobile.trim(),
          address: applicant.permanentAddress.trim(),
          occupation: biz.typeOfBusiness.trim(),
          typeOfBusiness: biz.typeOfBusiness.trim(),
          businessAddress: biz.businessAddress.trim() || undefined,
          monthlyIncome: Number(biz.monthlyIncome || 0),
          householdIncome: Number(biz.householdExpenses || biz.monthlyIncome || 0),
          otherIncome: Number(biz.otherIncome || 0),
          existingLoanEmi: Number(biz.existingEmi || 0),
          familyRows,
          kycDocType: "AADHAAR",
          kycDocRef: applicant.aadhaar.trim(),
          panNumber: applicant.pan.trim().toUpperCase() || undefined,
          voterId: applicant.voterId.trim().toUpperCase() || undefined,
          kycDocuments: kycDocs,
          coApplicant:
            coEnabled && co.name.trim()
              ? {
                  name: co.name.trim(),
                  fatherName: co.fatherName.trim() || undefined,
                  relationship: co.relationship.trim(),
                  dob: co.dob ? new Date(co.dob).getTime() : undefined,
                  age: coAge ?? undefined,
                  gender: co.gender,
                  mobile: co.mobile.trim() || undefined,
                  address: co.address.trim() || undefined,
                  aadhaarNumber: co.aadhaar.trim() || undefined,
                  panNumber: co.pan.trim().toUpperCase() || undefined,
                  voterId: co.voterId.trim().toUpperCase() || undefined,
                  kycDocuments: coKycDocs.length > 0 ? coKycDocs : undefined,
                  photoStorageId: coPhotoStorageId,
                  documents: coDocsOk
                    ? coDocs.map((d) => ({
                        docKind: d.kind,
                        fileName: d.file.name,
                        storageId: d.storageId as Id<"_storage">,
                      }))
                    : undefined,
                  coGpsStorageId,
                  coGpsGeo,
                }
              : undefined,
          applicantDocuments,
          loanRequest: loanStarted
            ? {
                amountRequested: Number(loan.amount),
                purpose: loan.purpose,
                tenureMonths: Number(loan.tenure),
                repaymentFrequency: loan.frequency,
                estimatedInstallment: loan.installment.trim()
                  ? Number(loan.installment)
                  : undefined,
              }
            : undefined,
          bankAccount: bankOk && bankTouched
            ? {
                accountHolderName: bank.holder.trim(),
                bankName: bank.bankName.trim(),
                branch: bank.branch.trim(),
                accountNumber: bank.accountNumber.trim(),
                ifscCode: bank.ifsc.trim().toUpperCase(),
              }
            : undefined,
          nominee: nomineeOk && nomineeTouched
            ? {
                name: nominee.name.trim(),
                relationship: nominee.relationship.trim(),
                age: Number(nominee.age),
                mobile: nominee.mobile.trim() || undefined,
                address: nominee.address.trim() || undefined,
              }
            : undefined,
          declarationAccepted: declaration,
          officeUse:
            canOffice &&
            (office.fieldOfficerName.trim() ||
              office.customerVerification ||
              office.kycVerification ||
              office.creditAssessment ||
              office.approvedAmount.trim() ||
              office.remarks.trim())
              ? {
                  fieldOfficerName: office.fieldOfficerName.trim() || undefined,
                  customerVerification: office.customerVerification || undefined,
                  kycVerification: office.kycVerification || undefined,
                  creditAssessment: office.creditAssessment || undefined,
                  approvedLoanAmount: office.approvedAmount.trim()
                    ? Number(office.approvedAmount)
                    : undefined,
                  remarks: office.remarks.trim() || undefined,
                }
              : undefined,
          photoStorageId: storageId as Id<"_storage">,
          geo: {
            latitude: photo.geo.latitude,
            longitude: photo.geo.longitude,
            accuracyMeters: photo.geo.accuracyMeters,
            capturedAt: photo.geo.capturedAt,
            photoCapturedAt: photo.frameAt,
            permissionStatus: photo.geo.permissionStatus ?? "granted",
          },
          device: navigator.userAgent.slice(0, 60),
        }),
      );
      if (result) {
        toast.success(`Client application saved — ${result.code}`);
        // Back to the Clients list: the reactive query shows the new client
        // immediately — no manual refresh needed.
        navigate("/dashboard/clients");
      }
    } catch (err) {
      // Form and captured photo stay intact so the user can simply retry.
      toast.error(prettyError(err));
    } finally {
      setSubmitting(false);
    }
  };

  /* --------------------------------- UI ---------------------------------- */

  return (
    <div className="space-y-4 pb-8">
      <PageHeader
        title="Client application"
        subtitle="Field onboarding — full application form"
        back="/dashboard/clients"
      />

      {/* 1 · APPLICANT DETAILS */}
      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          1 · Applicant details
        </h2>
        <Field label="Applicant name" required>
          <input
            className={inputCls}
            value={applicant.name}
            onChange={bind(setApplicant, "name")}
            placeholder="e.g. Sunita Devi"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Husband name">
            <input
              className={inputCls}
              value={applicant.husbandName}
              onChange={bind(setApplicant, "husbandName")}
            />
          </Field>
          <Field label="Father name">
            <input
              className={inputCls}
              value={applicant.fatherName}
              onChange={bind(setApplicant, "fatherName")}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Date of birth"
            required
            hint={ageOk ? `Age ${applicantAge} years` : applicantAge !== null ? `Age ${applicantAge} — must be 18–100` : "Age calculated automatically"}
          >
            <input
              type="date"
              className={inputCls}
              max={todayIso}
              value={applicant.dob}
              onChange={bind(setApplicant, "dob")}
            />
          </Field>
          <Field label="Gender" required>
            <select
              className={inputCls}
              value={applicant.gender}
              onChange={bind(setApplicant, "gender")}
            >
              <option value="FEMALE">Female</option>
              <option value="MALE">Male</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
        </div>
        <Field
          label="Mobile number"
          required
          hint={
            applicant.mobile.trim() && !mobileOk
              ? "Enter a valid 10-digit mobile number."
              : "10 digits — used for receipts & alerts"
          }
        >
          <input
            className={inputCls}
            inputMode="numeric"
            value={applicant.mobile}
            onChange={(e) =>
              setApplicant((s) => ({
                ...s,
                mobile: e.target.value.replace(/\\D/g, "").slice(0, 10),
              }))
            }
            placeholder="9876543210"
          />
        </Field>
        <Field label="Permanent address" required>
          <textarea
            className={areaCls}
            value={applicant.permanentAddress}
            onChange={bind(setApplicant, "permanentAddress")}
            placeholder="Village, post, police station, district"
          />
        </Field>
        <Field label="Father's address">
          <textarea
            className={areaCls}
            value={applicant.fatherAddress}
            onChange={bind(setApplicant, "fatherAddress")}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Aadhaar number"
            required
            hint={
              applicant.aadhaar.trim() && !aadhaarOk
                ? "Aadhaar must be exactly 12 digits."
                : "12 digits — mandatory for KYC"
            }
          >
            <input
              className={inputCls}
              inputMode="numeric"
              value={applicant.aadhaar}
              onChange={(e) =>
                setApplicant((s) => ({
                  ...s,
                  aadhaar: e.target.value.replace(/\\D/g, "").slice(0, 12),
                }))
              }
              placeholder="12-digit Aadhaar"
            />
          </Field>
          <Field
            label="PAN number"
            hint={
              applicant.pan.trim() && !panOk
                ? "PAN must look like ABCDE1234F."
                : "If available"
            }
          >
            <input
              className={inputCls}
              value={applicant.pan}
              onChange={(e) =>
                setApplicant((s) => ({ ...s, pan: e.target.value.toUpperCase().slice(0, 10) }))
              }
              placeholder="ABCDE1234F"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Voter ID"
            hint={
              applicant.voterId.trim() && !voterOk
                ? "Voter ID must look like ABC1234567."
                : undefined
            }
          >
            <input
              className={inputCls}
              value={applicant.voterId}
              onChange={(e) =>
                setApplicant((s) => ({ ...s, voterId: e.target.value.toUpperCase().slice(0, 10) }))
              }
              placeholder="ABC1234567"
            />
          </Field>
          <Field label="KYC documents" required>
            <div className="flex flex-wrap gap-1.5">
              {KYC_DOC_OPTIONS.map((opt) => (
                <label
                  key={opt.id}
                  className={`flex cursor-pointer items-center gap-1.5 border-2 border-ink px-2 py-1.5 text-[11px] font-black uppercase ${\n                    kycDocs.includes(opt.id) ? "bg-gold" : "bg-white"\n                  }`}
                >
                  <input
                    type="checkbox"
                    className="size-3.5 accent-ink"
                    checked={kycDocs.includes(opt.id)}
                    onChange={() => toggleKycDoc(opt.id, kycDocs, setKycDocs)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </Field>
        </div>

        {/* 3 · Applicant documents — photograph or upload */}
        <Field
          label="Applicant documents"
          hint="Photograph a document or upload an existing file · JPEG/PNG/WebP/PDF · max 5 MB each"
        >
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Applicant document type"
              className="h-9 border-2 border-ink bg-white px-2 text-xs font-bold uppercase outline-none"
              value={applicantDocKind}
              onChange={(e) => setApplicantDocKind(e.target.value)}
            >
              {KYC_DOC_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
            <label className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-3 py-1.5 text-xs font-bold uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink">
              <Camera className="size-3.5" />
              Take photo
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                className="sr-only"
                onChange={onApplicantDoc}
              />
            </label>
            <label className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-3 py-1.5 text-xs font-bold uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink">
              <Upload className="size-3.5" />
              Upload file
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="sr-only"
                onChange={onApplicantDoc}
              />
            </label>
          </div>
          {applicantDocs.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {applicantDocs.map((d) => (
                <li
                  key={d.key}
                  className="flex flex-wrap items-center gap-2 border-2 border-ink bg-white px-2 py-1.5"
                >
                  {["image/jpeg", "image/png", "image/webp"].includes(d.file.type) ? (
                    <img
                      src={d.previewUrl}
                      alt={`Preview of ${d.file.name}`}
                      className="size-12 shrink-0 border border-ink object-cover"
                    />
                  ) : (
                    <span className="grid size-12 shrink-0 place-items-center border border-ink bg-muted">
                      <FileText className="size-5" />
                    </span>
                  )}
                  <span className="shrink-0 border border-ink bg-gold px-1.5 py-0.5 text-[10px] font-black uppercase">
                    {KYC_DOC_OPTIONS.find((o) => o.id === d.kind)?.label ?? d.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-bold">
                    {d.file.name}
                    <span className="text-muted-foreground">
                      {" "}
                      · {(d.file.size / 1024).toFixed(0)} KB
                    </span>
                  </span>
                  {d.status === "uploading" && (
                    <span className="shrink-0 animate-pulse text-[10px] font-black uppercase text-muted-foreground">
                      Uploading…
                    </span>
                  )}
                  {d.status === "uploaded" && (
                    <span className="shrink-0 border-2 border-ink bg-mint px-1.5 py-0.5 text-[10px] font-black uppercase">
                      Uploaded
                    </span>
                  )}
                  {d.status === "error" && (
                    <>
                      <span className="shrink-0 border-2 border-ink bg-blush px-1.5 py-0.5 text-[10px] font-black uppercase">
                        Failed
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setApplicantDocs((cur) =>
                            cur.map((x) =>
                              x.key === d.key ? { ...x, status: "uploading" } : x,
                            ),
                          );
                          void uploadCoDoc(d.key, d.file);
                        }
                      >
                        Retry
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => removeApplicantDoc(d.key)}
                    aria-label={`Remove ${d.file.name}`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Field>

        {/* 4 · Camera photo + live GPS — the existing capture component,
            integrated into Applicant Details per the application format. */}
        <h2 className="pt-1 text-[11px] font-black uppercase tracking-[0.14em] text-muted-foreground">
          4 · Camera photo + live GPS
        </h2>
        <Field
          label="Applicant Photo"
          required
          hint="Camera capture with live GPS — accuracy within 100 m required"
        >
          <ClientPhotoCapture value={photo} onChange={setPhoto} />
        </Field>
      </section>

      {/* 2 · CO-APPLICANT DETAILS */}
      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
            2 · Co-applicant details
          </h2>
          <label className="flex cursor-pointer items-center gap-2 text-[11px] font-bold uppercase">
            <input
              type="checkbox"
              className="size-4 accent-ink"
              checked={coEnabled}
              onChange={(e) => setCoEnabled(e.target.checked)}
            />
            Add co-applicant
          </label>
        </div>
        {coEnabled && (
          <>
            {coTouched && !coOk && (
              <p className="border-2 border-ink bg-blush px-2 py-1.5 text-[11px] font-bold">
                Co-applicant: name and relationship are required; mobile/Aadhaar/PAN
                formats must be valid when provided.
              </p>
            )}
            <Field label="Co-applicant name" required={coEnabled}>
              <input
                className={inputCls}
                value={co.name}
                onChange={bind(setCo, "name")}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Father name">
                <input
                  className={inputCls}
                  value={co.fatherName}
                  onChange={bind(setCo, "fatherName")}
                />
              </Field>
              <Field label="Relationship with applicant" required={coEnabled}>
                <input
                  className={inputCls}
                  value={co.relationship}
                  onChange={bind(setCo, "relationship")}
                  placeholder="e.g. Husband"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Date of birth"
                hint={coAge !== null ? `Age ${coAge} years` : "Age calculated automatically"}
              >
                <input
                  type="date"
                  className={inputCls}
                  max={todayIso}
                  value={co.dob}
                  onChange={bind(setCo, "dob")}
                />
              </Field>
              <Field label="Gender">
                <select
                  className={inputCls}
                  value={co.gender}
                  onChange={bind(setCo, "gender")}
                >
                  <option value="FEMALE">Female</option>
                  <option value="MALE">Male</option>
                  <option value="OTHER">Other</option>
                </select>
              </Field>
            </div>
            <Field
              label="Mobile number"
              hint={co.mobile.trim() && !MOBILE_RE.test(co.mobile.trim()) ? "Enter a valid 10-digit mobile number." : undefined}
            >
              <input
                className={inputCls}
                inputMode="numeric"
                value={co.mobile}
                onChange={(e) =>
                  setCo((s) => ({ ...s, mobile: e.target.value.replace(/\\D/g, "").slice(0, 10) }))
                }
              />
            </Field>
            <Field label="Address">
              <textarea
                className={areaCls}
                value={co.address}
                onChange={bind(setCo, "address")}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Aadhaar number"
                hint={co.aadhaar.trim() && !AADHAAR_RE.test(co.aadhaar.trim()) ? "12 digits." : undefined}
              >
                <input
                  className={inputCls}
                  inputMode="numeric"
                  value={co.aadhaar}
                  onChange={(e) =>
                    setCo((s) => ({ ...s, aadhaar: e.target.value.replace(/\\D/g, "").slice(0, 12) }))
                  }
                />
              </Field>
              <Field
                label="PAN number"
                hint={co.pan.trim() && !PAN_RE.test(co.pan.trim().toUpperCase()) ? "ABCDE1234F" : "If available"}
              >
                <input
                  className={inputCls}
                  value={co.pan}
                  onChange={(e) => setCo((s) => ({ ...s, pan: e.target.value.toUpperCase().slice(0, 10) }))}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Voter ID"
                hint={co.voterId.trim() && !VOTER_RE.test(co.voterId.trim().toUpperCase()) ? "ABC1234567" : undefined}
              >
                <input
                  className={inputCls}
                  value={co.voterId}
                  onChange={(e) => setCo((s) => ({ ...s, voterId: e.target.value.toUpperCase().slice(0, 10) }))}
                />
              </Field>
              <Field label="KYC documents">
                <div className="flex flex-wrap gap-1.5">
                  {KYC_DOC_OPTIONS.map((opt) => (
                    <label
                      key={opt.id}
                      className={`flex cursor-pointer items-center gap-1.5 border-2 border-ink px-2 py-1.5 text-[11px] font-black uppercase ${\n                        coKycDocs.includes(opt.id) ? "bg-gold" : "bg-white"\n                      }`}
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 accent-ink"
                        checked={coKycDocs.includes(opt.id)}
                        onChange={() => toggleKycDoc(opt.id, coKycDocs, setCoKycDocs)}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </Field>
            </div>

            {/* Co-applicant photo — camera capture with file-upload fallback. */}
            <Field
              label="Co-applicant photo"
              hint="Optional · camera or file upload · JPEG/PNG/WebP · max 5 MB"
            >
              {!coPhoto ? (
                <div className="flex flex-wrap gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-3 py-2 text-xs font-bold uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink">
                    <Camera className="size-3.5" />
                    Take photo
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      capture="user"
                      className="sr-only"
                      onChange={onCoPhoto}
                    />
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-3 py-2 text-xs font-bold uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink">
                    <Upload className="size-3.5" />
                    Upload file
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="sr-only"
                      onChange={onCoPhoto}
                    />
                  </label>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3 border-2 border-ink bg-white p-2">
                  <img
                    src={coPhoto.previewUrl}
                    alt="Co-applicant photo preview"
                    className="size-14 shrink-0 border border-ink object-cover"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold">
                      {coPhoto.file.name}
                    </span>
                    <span className="block text-[10px] font-semibold text-muted-foreground">
                      {(coPhoto.file.size / 1024).toFixed(0)} KB · selected
                    </span>
                  </span>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-2 py-1.5 text-[11px] font-bold uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink">
                    <Camera className="size-3.5" />
                    Retake
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      capture="user"
                      className="sr-only"
                      onChange={onCoPhoto}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (coPhoto.previewUrl) URL.revokeObjectURL(coPhoto.previewUrl);
                      setCoPhoto(null);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </Field>

            {/* Co-applicant GPS photo — camera capture with real GPS fix. */}
            <Field
              label="Co-applicant GPS photo"
              hint="Optional · photograph + live GPS (≤ 100 m accuracy) · JPEG/PNG/WebP · max 5 MB"
            >
              {!coGps ? (
                <div className="flex flex-wrap gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-3 py-2 text-xs font-bold uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink">
                    <Camera className="size-3.5" />
                    Take GPS photo
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      capture="environment"
                      className="sr-only"
                      onChange={(e) => {
                        e.target.value = "";
                        if (!e.target.files?.[0]) return;
                        const file = e.target.files[0];
                        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
                          toast.error("Co-applicant photo must be a JPEG, PNG or WebP image.");
                          return;
                        }
                        if (file.size <= 0 || file.size > CO_PHOTO_MAX_BYTES) {
                          toast.error("Co-applicant photo must be between 1 byte and 5 MB.");
                          return;
                        }
                        const key = newDocKey();
                        setCoGps({
                          key,
                          file,
                          previewUrl: URL.createObjectURL(file),
                          status: "locating",
                          frameAt: Date.now(),
                        });
                        void (async () => {
                          try {
                            const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
                              const w = navigator.geolocation.watchPosition(
                                (p) => {
                                  navigator.geolocation.clearWatch(w);
                                  resolve(p);
                                },
                                reject,
                                { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 0 },
                              );
                              setTimeout(() => navigator.geolocation.clearWatch(w), GEO_TIMEOUT_MS);
                            });
                            const fix = {
                              latitude: pos.coords.latitude,
                              longitude: pos.coords.longitude,
                              accuracyMeters: pos.coords.accuracy,
                              capturedAt: pos.timestamp,
                              permissionStatus: "granted",
                            };
                            const err = geoValidationError(fix, Date.now());
                            if (err) {
                              setCoGps((prev) => (prev?.key === key ? { ...prev, status: "error" } : prev));
                              toast.error(
                                "Co-applicant photo GPS is too inaccurate or stale — try again in open air.",
                              );
                              return;
                            }
                            setCoGps({
                              key,
                              file,
                              previewUrl: URL.createObjectURL(file),
                              status: "uploading",
                              fix,
                              frameAt: Date.now(),
                            });
                            const url = await getUploadUrl({});
                            const res = await fetch(url, {
                              method: "POST",
                              headers: { "Content-Type": file.type || "image/jpeg" },
                              body: file,
                            });
                            if (!res.ok) throw new Error(`upload failed (${res.status})`);
                            const parsed = (await res.json()) as { storageId: string };
                            setCoGps({
                              key,
                              file,
                              previewUrl: URL.createObjectURL(file),
                              status: "uploaded",
                              fix: { ...fix, storageId: parsed.storageId as Id<"_storage"> },
                              frameAt: Date.now(),
                            });
                          } catch (err) {
                            setCoGps((prev) => (prev?.key === key ? { ...prev, status: "error" } : prev));
                            toast.error(
                              err instanceof Error ? err.message : "Co-applicant GPS photo capture failed",
                            );
                          }
                        })();
                      }}
                    />
                  </label>
                  {coGps && (
                    <span className="text-[11px] font-semibold text-muted-foreground self-center">
                      {coGps.status === "locating" ? "Getting GPS fix…" : coGps.status === "uploading" ? "Uploading…" : coGps.status === "uploaded" ? "Uploaded" : coGps.status === "error" ? "Capture failed — retry" : ""}
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3 border-2 border-ink bg-white p-2">
                  <img
                    src={coGps.previewUrl}
                    alt="Co-applicant GPS photo preview"
                    className="size-14 shrink-0 border border-ink object-cover"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold">
                      {coGps.file.name}
                    </span>
                    {coGps.status === "uploaded" && coGps.fix && (
                      <span className="block text-[10px] font-semibold text-muted-foreground">
                        {coGps.fix.latitude.toFixed(5)}, {coGps.fix.longitude.toFixed(5)} ·
                        ±{Math.round(coGps.fix.accuracyMeters)} m ·
                        {new Date(coGps.fix.capturedAt).toLocaleString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                          hour12: false,
                        })}
                      </span>
                    )}
                    {coGps.status !== "uploaded" && (
                      <span className="block text-[10px] font-semibold text-muted-foreground">
                        {coGps.status === "locating" ? "Acquiring GPS fix…" : coGps.status === "uploading" ? "Uploading photograph…" : coGps.status === "error" ? "Capture failed — retry" : ""}
                      </span>
                    )}
                  </span>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-2 py-1.5 text-[11px] font-bold uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink">
                    <Camera className="size-3.5" />
                    Retake
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      capture="environment"
                      className="sr-only"
                      onChange={(e) => {
                        e.target.value = "";
                        if (!e.target.files?.[0]) return;
                        const file = e.target.files[0];
                        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
                          toast.error("Co-applicant photo must be a JPEG, PNG or WebP image.");
                          return;
                        }
                        if (file.size <= 0 || file.size > CO_PHOTO_MAX_BYTES) {
                          toast.error("Co-applicant photo must be between 1 byte and 5 MB.");
                          return;
                        }
                        setCoGps(null);
                        const prev = coGps;
                        setCoGps(null);
                        URL.revokeObjectURL(prev?.previewUrl ?? "");
                        const key = newDocKey();
                        setCoGps({
                          key,
                          file,
                          previewUrl: URL.createObjectURL(file),
                          status: "locating",
                          frameAt: Date.now(),
                        });
                        void (async () => {
                          try {
                            const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
                              const w = navigator.geolocation.watchPosition(
                                (p) => {
                                  navigator.geolocation.clearWatch(w);
                                  resolve(p);
                                },
                                reject,
                                { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 0 },
                              );
                              setTimeout(() => navigator.geolocation.clearWatch(w), GEO_TIMEOUT_MS);
                            });
                            const fix = {
                              latitude: pos.coords.latitude,
                              longitude: pos.coords.longitude,
                              accuracyMeters: pos.coords.accuracy,
                              capturedAt: pos.timestamp,
                              permissionStatus: "granted",
                            };
                            const err = geoValidationError(fix, Date.now());
                            if (err) {
                              setCoGps((p) => (p?.key === key ? { ...p, status: "error" } : p));
                              toast.error(
                                "Co-applicant photo GPS is too inaccurate or stale — try again in open air.",
                              );
                              return;
                            }
                            setCoGps({
                              key,
                              file,
                              previewUrl: URL.createObjectURL(file),
                              status: "uploading",
                              fix,
                              frameAt: Date.now(),
                            });
                            const url = await getUploadUrl({});
                            const res = await fetch(url, {
                              method: "POST",
                              headers: { "Content-Type": file.type || "image/jpeg" },
                              body: file,
                            });
                            if (!res.ok) throw new Error(`upload failed (${res.status})`);
                            const parsed = (await res.json()) as { storageId: string };
                            setCoGps({
                              key,
                              file,
                              previewUrl: URL.createObjectURL(file),
                              status: "uploaded",
                              fix: { ...fix, storageId: parsed.storageId as Id<"_storage"> },
                              frameAt: Date.now(),
                            });
                          } catch (err) {
                            setCoGps((p) => (p?.key === key ? { ...p, status: "error" } : p));
                            toast.error(
                              err instanceof Error ? err.message : "Co-applicant GPS photo capture failed",
                            );
                          }
                        })();
                      }}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (coGps?.previewUrl) URL.revokeObjectURL(coGps.previewUrl);
                      setCoGps(null);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </Field>

            {/* Co-applicant documents — real uploads with per-file status. */}
            <Field
              label="Co-applicant documents"
              hint="Aadhaar · PAN · Voter ID · other supporting files — JPEG/PNG/WebP/PDF, max 5 MB each"
            >
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Co-applicant document type"
                  className="h-9 border-2 border-ink bg-white px-2 text-xs font-bold uppercase outline-none"
                  value={coDocKind}
                  onChange={(e) => setCoDocKind(e.target.value)}
                >
                  {KYC_DOC_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <label className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-3 py-1.5 text-xs font-bold uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink">
                  <Camera className="size-3.5" />
                  Take photo
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    className="sr-only"
                    onChange={onCoDoc}
                  />
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-3 py-1.5 text-xs font-bold uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink">
                  <Upload className="size-3.5" />
                  Upload document
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    className="sr-only"
                    onChange={onCoDoc}
                  />
                </label>
              </div>
              {coDocs.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {coDocs.map((d) => (
                    <li
                      key={d.key}
                      className="flex flex-wrap items-center gap-2 border-2 border-ink bg-white px-2 py-1.5"
                    >
                      {["image/jpeg", "image/png", "image/webp"].includes(d.file.type) ? (
                        <img
                          src={d.previewUrl}
                          alt={`Preview of ${d.file.name}`}
                          className="size-12 shrink-0 border border-ink object-cover"
                        />
                      ) : (
                        <span className="grid size-12 shrink-0 place-items-center border border-ink bg-muted">
                          <FileText className="size-5" />
                        </span>
                      )}
                      <span className="shrink-0 border border-ink bg-gold px-1.5 py-0.5 text-[10px] font-black uppercase">
                        {KYC_DOC_OPTIONS.find((o) => o.id === d.kind)?.label ?? d.kind}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-bold">
                        {d.file.name}
                        <span className="text-muted-foreground">
                          {" "}
                          · {(d.file.size / 1024).toFixed(0)} KB
                        </span>
                      </span>
                      {d.status === "uploading" && (
                        <span className="shrink-0 animate-pulse text-[10px] font-black uppercase text-muted-foreground">
                          Uploading…
                        </span>
                      )}
                      {d.status === "uploaded" && (
                        <span className="shrink-0 border-2 border-ink bg-mint px-1.5 py-0.5 text-[10px] font-black uppercase">
                          Uploaded
                        </span>
                      )}
                      {d.status === "error" && (
                        <>
                          <span className="shrink-0 border-2 border-ink bg-blush px-1.5 py-0.5 text-[10px] font-black uppercase">
                            Failed
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setCoDocs((cur) =>
                                cur.map((x) =>
                                  x.key === d.key ? { ...x, status: "uploading" } : x,
                                ),
                              );
                              void uploadCoDoc(d.key, d.file);
                            }
                          >
                            Retry
                          </Button>
                        </>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => removeCoDoc(d.key)}
                        aria-label={`Remove ${d.file.name}`}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          </>
        )}
      </section>

      {/* 3 · FAMILY DETAILS */}
      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          3 · Family details
        </h2>
        <div className="space-y-2">
          <div className="grid grid-cols-[2rem_1.4fr_3.5rem_1fr_1.2fr_2rem] gap-1 text-[10px] font-black uppercase text-muted-foreground">
            <span>S.No.</span>
            <span>Member name</span>
            <span>Age</span>
            <span>Relationship</span>
            <span>Occupation / income</span>
            <span />
          </div>
          {family.map((row, i) => (
            <div
              key={i}
              className="grid grid-cols-[2rem_1.4fr_3.5rem_1fr_1.2fr_2rem] items-center gap-1"
            >
              <span className="text-xs font-black">{i + 1}</span>
              <input
                className="h-10 w-full border-2 border-ink bg-white px-2 text-xs font-semibold outline-none"
                value={row.name}
                placeholder="Name"
                onChange={(e) =>
                  setFamily((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)),
                  )
                }
              />
              <input
                className="h-10 w-full border-2 border-ink bg-white px-1 text-xs font-semibold outline-none"
                inputMode="numeric"
                value={row.age}
                placeholder="Age"
                onChange={(e) =>
                  setFamily((rows) =>
                    rows.map((r, j) =>
                      j === i
                        ? { ...r, age: e.target.value.replace(/\\D/g, "").slice(0, 3) }
                        : r,
                    ),
                  )
                }
              />
              <input
                className="h-10 w-full border-2 border-ink bg-white px-2 text-xs font-semibold outline-none"
                value={row.relationship}
                placeholder="Relation"
                onChange={(e) =>
                  setFamily((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, relationship: e.target.value } : r)),
                  )
                }
              />
              <input
                className="h-10 w-full border-2 border-ink bg-white px-2 text-xs font-semibold outline-none"
                value={row.occupation}
                placeholder="Occupation / income"
                onChange={(e) =>
                  setFamily((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, occupation: e.target.value } : r)),
                  )
                }
              />
              <button
                type="button"
                aria-label={`Remove family member ${i + 1}`}
                className="grid size-8 place-items-center border-2 border-ink bg-blush text-xs font-black disabled:opacity-40"
                disabled={family.length <= 1}
                onClick={() => setFamily((rows) => rows.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        {filledFamily.length > 0 && !familyOk && (
          <p className="text-[11px] font-bold text-destructive">
            Each filled row needs a member name and relationship.
          </p>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setFamily((rows) => [...rows, emptyFamilyRow()])}
        >
          + Add member
        </Button>
      </section>

      {/* 4 · INCOME & BUSINESS DETAILS */}
      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          4 · Income & business details
        </h2>
        <Field label="Type of business" required>
          <input
            className={inputCls}
            value={biz.typeOfBusiness}
            onChange={bind(setBiz, "typeOfBusiness")}
            placeholder="e.g. Saree weaving"
          />
        </Field>
        <Field label="Business address">
          <textarea
            className={areaCls}
            value={biz.businessAddress}
            onChange={bind(setBiz, "businessAddress")}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Estimated monthly income ₹" required>
            <input
              className={inputCls}
              inputMode="numeric"
              value={biz.monthlyIncome}
              onChange={digits(setBiz as Dispatch<SetStateAction<Readonly<typeof biz>>>, "monthlyIncome", 8)}
              placeholder="12000"
            />
          </Field>
          <Field label="Monthly household expenses ₹">
            <input
              className={inputCls}
              inputMode="numeric"
              value={biz.householdExpenses}
              onChange={digits(setBiz as Dispatch<SetStateAction<Readonly<typeof biz>>>, "householdExpenses", 8)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Other income ₹">
            <input
              className={inputCls}
              inputMode="numeric"
              value={biz.otherIncome}
              onChange={digits(setBiz as Dispatch<SetStateAction<Readonly<typeof biz>>>, "otherIncome", 8)}
            />
          </Field>
          <Field label="Existing loan / EMI ₹">
            <input
              className={inputCls}
              inputMode="numeric"
              value={biz.existingEmi}
              onChange={digits(setBiz as Dispatch<SetStateAction<Readonly<typeof biz>>>, "existingEmi", 8)}
            />
          </Field>
        </div>
      </section>

      {/* 5 · LOAN DETAILS */}
      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          5 · Loan details
        </h2>
        <p className="text-[11px] font-semibold text-muted-foreground">
          Request captured with the application — approval and disbursement
          happen only through the authorized loan workflow.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Loan amount requested ₹">
            <input
              className={inputCls}
              inputMode="numeric"
              value={loan.amount}
              onChange={digits(setLoan as Dispatch<SetStateAction<Readonly<typeof loan>>>, "amount", 8)}
              placeholder="50000"
            />
          </Field>
          <Field label="Purpose of loan">
            <select className={inputCls} value={loan.purpose} onChange={bind(setLoan, "purpose")}>
              {LOAN_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {LOAN_PURPOSE_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Tenure (months)">
            <input
              className={inputCls}
              inputMode="numeric"
              value={loan.tenure}
              onChange={digits(setLoan as Dispatch<SetStateAction<Readonly<typeof loan>>>, "tenure", 3)}
              placeholder="12"
            />
          </Field>
          <Field label="Repayment frequency">
            <select
              className={inputCls}
              value={loan.frequency}
              onChange={bind(setLoan, "frequency")}
            >
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {f.charAt(0) + f.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Est. installment ₹">
            <input
              className={inputCls}
              inputMode="numeric"
              value={loan.installment}
              onChange={digits(setLoan as Dispatch<SetStateAction<Readonly<typeof loan>>>, "installment", 7)}
            />
          </Field>
        </div>
        {loanStarted && !loanOk && (
          <p className="text-[11px] font-bold text-destructive">
            Amount, purpose and tenure (1–120 months) are required once a loan
            request is started.
          </p>
        )}
      </section>

      {/* 6 · BANK ACCOUNT DETAILS */}
      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          6 · Bank account details
        </h2>
        <Field label="Account holder name">
          <input className={inputCls} value={bank.holder} onChange={bind(setBank, "holder")} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank name">
            <input
              className={inputCls}
              value={bank.bankName}
              onChange={bind(setBank, "bankName")}
            />
          </Field>
          <Field label="Branch">
            <input className={inputCls} value={bank.branch} onChange={bind(setBank, "branch")} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Account number"
            hint={
              bank.accountNumber.trim() && !/^\\d{6,20}$/.test(bank.accountNumber.trim())
                ? "6–20 digits."
                : undefined
            }
          >
            <input
              className={inputCls}
              inputMode="numeric"
              value={bank.accountNumber}
              onChange={digits(setBank as Dispatch<SetStateAction<Readonly<typeof bank>>>, "accountNumber", 20)}
              placeholder="6–20 digit account number"
            />
          </Field>
          <Field
            label="IFSC code"
            hint={
              bank.ifsc.trim() &&
              !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bank.ifsc.trim().toUpperCase())
                ? "e.g. SBIN0001234"
                : undefined
            }
          >
            <input
              className={inputCls}
              value={bank.ifsc}
              onChange={(e) =>
                setBank((s) => ({ ...s, ifsc: e.target.value.toUpperCase().slice(0, 11) }))
              }
              placeholder="SBIN0001234"
            />
          </Field>
        </div>
        {bankTouched && !bankOk && (
          <p className="text-[11px] font-bold text-destructive">
            Fill all bank fields with valid formats, or clear them to skip.
          </p>
        )}
      </section>

      {/* 8 · DECLARATION */}
      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          7 · Declaration
        </h2>
        <p className="border-2 border-ink bg-sky p-3 text-sm font-semibold">
          “I hereby declare that all information provided in this application is
          true and complete to the best of my knowledge. I agree to use the loan
          amount for the stated purpose and to repay all installments and other
          dues on time as per the terms and conditions of the institution.”
        </p>
        <label className="flex cursor-pointer items-start gap-2 text-sm font-bold">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-ink"
            checked={declaration}
            onChange={(e) => setDeclaration(e.target.checked)}
          />
          I accept the declaration
        </label>
      </section>

      {/* 9 · FOR OFFICE USE ONLY */}
      {canOffice && (
        <section className="space-y-3 border-2 border-ink bg-gold p-4 shadow-hard-sm">
          <h2 className="text-xs font-black uppercase tracking-[0.14em]">
            8 · For office use only
          </h2>
          <p className="text-[11px] font-semibold">
            Editable only by branch managers and admins — every change is
            audit-logged. Nothing here is auto-set to verified or approved.
          </p>
          <Field label="Field officer name">
            <input
              className={inputCls}
              value={office.fieldOfficerName}
              onChange={bind(setOffice, "fieldOfficerName")}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Customer / group verification">
              <select
                className={inputCls}
                value={office.customerVerification}
                onChange={bind(setOffice, "customerVerification")}
              >
                <option value="">— Not assessed —</option>
                {OFFICE_VERIFICATION.map((v) => (
                  <option key={v} value={v}>
                    {v === "VERIFIED" ? "Verified" : "Not verified"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="KYC verification">
              <select
                className={inputCls}
                value={office.kycVerification}
                onChange={bind(setOffice, "kycVerification")}
              >
                <option value="">— Not assessed —</option>
                {OFFICE_KYC.map((v) => (
                  <option key={v} value={v}>
                    {v === "COMPLETE" ? "Complete" : "Incomplete"}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Credit assessment">
              <select
                className={inputCls}
                value={office.creditAssessment}
                onChange={bind(setOffice, "creditAssessment")}
              >
                <option value="">— Not assessed —</option>
                {OFFICE_CREDIT.map((v) => (
                  <option key={v} value={v}>
                    {v === "RECOMMENDED" ? "Recommended" : "Not recommended"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Approved loan amount ₹">
              <input
                className={inputCls}
                inputMode="numeric"
                value={office.approvedAmount}
                onChange={digits(setOffice as Dispatch<SetStateAction<Readonly<typeof office>>>, "approvedAmount", 8)}
              />
            </Field>
          </div>
          <Field label="Branch manager remarks">
            <textarea
              className={areaCls}
              value={office.remarks}
              onChange={bind(setOffice, "remarks")}
            />
          </Field>
        </section>
      )}

      <div className="sticky bottom-24 flex gap-2">
        <Button
          variant="outline"
          size="lg"
          className="flex-1"
          onClick={() => navigate("/dashboard/clients")}
        >
          Cancel
        </Button>
        <Button
          size="lg"
          className="flex-[2]"
          disabled={!valid || busy || submitting}
          onClick={() => void submit()}
        >
          {busy || submitting ? "Saving…" : "Submit application"}
        </Button>
      </div>
    </div>
  );
}
