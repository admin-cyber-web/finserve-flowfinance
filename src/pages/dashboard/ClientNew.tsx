import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PageHeader } from "@/components/fs/primitives";
import {
  ClientPhotoCapture,
  type CapturedClientPhoto,
} from "@/components/fs/ClientPhotoCapture";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useBusy } from "@/components/fs/primitives";
import { useMutation } from "convex/react";
import { useState, type ChangeEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

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

/** Convex surfaces thrown AppErrors with stack context — show only the message. */
function prettyError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : "Could not create the client — please retry.";
  const match = raw.match(/Uncaught AppError: ([^\n]*)/);
  return (match?.[1]?.trim() || raw.replace(/^Uncaught\s+/, "")).slice(0, 200);
}

export default function ClientNew() {
  const navigate = useNavigate();
  const create = useMutation(api.clients.create);
  const getUploadUrl = useMutation(api.clients.photoUploadUrl);
  const { busy, run } = useBusy();

  // Geo-tagged client photo — mandatory: camera capture + fresh GPS fix.
  const [photo, setPhoto] = useState<CapturedClientPhoto | null>(null);
  // Re-entry guard covering the WHOLE submit (upload URLs + uploads + create),
  // so repeated taps can never create duplicate clients.
  const [submitting, setSubmitting] = useState(false);
  // Mandatory stamp document — validated locally, uploaded to private
  // storage with the client. Only a real uploaded file counts, never a name.
  const [stamp, setStamp] = useState<{
    file: File;
    previewUrl: string | null;
  } | null>(null);

  const [f, setF] = useState({
    name: "",
    fatherName: "",
    age: "",
    gender: "FEMALE",
    mobile: "",
    address: "",
    village: "",
    district: "",
    pin: "",
    occupation: "",
    monthlyIncome: "",
    householdIncome: "",
    familyMembers: "4",
    kycDocType: "AADHAAR",
    kycDocRef: "",
    documentName: "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((s) => ({ ...s, [k]: e.target.value }));

  // KYC — Aadhaar mandatory (12 digits); other doc types need a reference.
  const kycRef = f.kycDocRef.trim();
  const kycRefValid =
    f.kycDocType === "AADHAAR" ? /^\d{12}$/.test(kycRef) : kycRef.length >= 3;

  const valid =
    f.name.trim().length >= 2 &&
    f.village.trim().length >= 1 &&
    f.occupation.trim().length >= 1 &&
    /^\d{10}$/.test(f.mobile.trim()) &&
    Number(f.age) >= 18 &&
    Number(f.age) <= 100 &&
    Number(f.familyMembers) >= 1 &&
    kycRefValid &&
    stamp !== null &&
    photo !== null;

  const STAMP_MAX_BYTES = 5 * 1024 * 1024;
  const onStampFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // re-selecting the same file replaces the previous one
    if (!file) return;
    const okTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!okTypes.includes(file.type)) {
      toast.error("Stamp must be a JPEG, PNG, WebP or PDF file.");
      return;
    }
    if (file.size <= 0 || file.size > STAMP_MAX_BYTES) {
      toast.error("Stamp file must be between 1 byte and 5 MB.");
      return;
    }
    if (stamp?.previewUrl) URL.revokeObjectURL(stamp.previewUrl);
    setStamp({
      file,
      previewUrl: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : null,
    });
  };

  const submit = async () => {
    if (submitting) return;
    if (!valid || !photo || !stamp) {
      toast.error(
        "Fill all required details — Aadhaar (12 digits), stamp upload, and the client photo with GPS.",
      );
      return;
    }
    setSubmitting(true);
    try {
      // 1. Server-issued, short-lived upload URL (RBAC-checked).
      const uploadUrl = await getUploadUrl({});
      // 2. Upload the stamped photo to private Convex storage.
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

      // 2b. Upload the stamp document to private Convex storage.
      const stampUploadUrl = await getUploadUrl({});
      const stampRes = await fetch(stampUploadUrl, {
        method: "POST",
        headers: { "Content-Type": stamp.file.type },
        body: stamp.file,
      });
      if (!stampRes.ok) {
        throw new Error(
          "Stamp upload failed — check your connection and retry (no client was created).",
        );
      }
      const { storageId: stampStorageId } = (await stampRes.json()) as {
        storageId: string;
      };

      // 3. Atomic create: client + geo photo link commit together, so a
      //    failure can never leave a duplicate or half-created client.
      const result = await run(() =>
        create({
          name: f.name.trim(),
          fatherName: f.fatherName.trim() || undefined,
          age: Number(f.age),
          gender: f.gender,
          mobile: f.mobile.trim(),
          address: f.address.trim() || undefined,
          village: f.village.trim(),
          district: f.district.trim() || undefined,
          pin: f.pin.trim() || undefined,
          occupation: f.occupation.trim(),
          monthlyIncome: Number(f.monthlyIncome || 0),
          householdIncome: Number(f.householdIncome || f.monthlyIncome || 0),
          familyMembers: Number(f.familyMembers || 1),
          kycDocType: f.kycDocType,
          kycDocRef: kycRef,
          documentName: f.documentName.trim() || undefined,
          photoStorageId: storageId as Id<"_storage">,
          stampStorageId: stampStorageId as Id<"_storage">,
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
        toast.success(
          `Client created — ${result.code} · GPS ${photo.geo.latitude}, ${photo.geo.longitude}`,
        );
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

  return (
    <div className="space-y-4 pb-8">
      <PageHeader
        title="Add client"
        subtitle="Field onboarding — KYC starts here"
        back="/dashboard/clients"
      />

      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          1 · Personal details
        </h2>
        <Field label="Full name" required>
          <input className={inputCls} value={f.name} onChange={set("name")} placeholder="e.g. Sunita Devi" />
        </Field>
        <Field label="Father / husband name">
          <input className={inputCls} value={f.fatherName} onChange={set("fatherName")} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Age" required>
            <input
              className={inputCls}
              inputMode="numeric"
              value={f.age}
              onChange={set("age")}
              placeholder="28"
            />
          </Field>
          <Field label="Gender" required>
            <select className={inputCls} value={f.gender} onChange={set("gender")}>
              <option value="FEMALE">Female</option>
              <option value="MALE">Male</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
        </div>
        <Field label="Mobile number" required hint="10 digits — used for receipts & alerts">
          <input
            className={inputCls}
            inputMode="numeric"
            value={f.mobile}
            onChange={(e) => setF((s) => ({ ...s, mobile: e.target.value.replace(/\D/g, "").slice(0, 10) }))}
            placeholder="9876543210"
          />
        </Field>
      </section>

      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          2 · Address
        </h2>
        <Field label="Village / locality" required>
          <input className={inputCls} value={f.village} onChange={set("village")} placeholder="Sunderpur" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="District">
            <input className={inputCls} value={f.district} onChange={set("district")} placeholder="Varanasi" />
          </Field>
          <Field label="PIN code">
            <input
              className={inputCls}
              inputMode="numeric"
              value={f.pin}
              onChange={(e) => setF((s) => ({ ...s, pin: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
            />
          </Field>
        </div>
        <Field label="Address">
          <textarea
            className="min-h-20 w-full border-2 border-ink bg-white px-3 py-2 text-sm font-semibold outline-none"
            value={f.address}
            onChange={set("address")}
          />
        </Field>
      </section>

      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          3 · Income & household
        </h2>
        <Field label="Occupation" required>
          <input className={inputCls} value={f.occupation} onChange={set("occupation")} placeholder="Weaver" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Monthly income ₹" required>
            <input
              className={inputCls}
              inputMode="numeric"
              value={f.monthlyIncome}
              onChange={(e) => setF((s) => ({ ...s, monthlyIncome: e.target.value.replace(/\D/g, "") }))}
              placeholder="12000"
            />
          </Field>
          <Field label="Household income ₹" hint="Defaults to monthly income">
            <input
              className={inputCls}
              inputMode="numeric"
              value={f.householdIncome}
              onChange={(e) => setF((s) => ({ ...s, householdIncome: e.target.value.replace(/\D/g, "") }))}
            />
          </Field>
        </div>
        <Field label="Family members" required>
          <input
            className={inputCls}
            inputMode="numeric"
            value={f.familyMembers}
            onChange={(e) => setF((s) => ({ ...s, familyMembers: e.target.value.replace(/\D/g, "") }))}
          />
        </Field>
      </section>

      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          Client Photo
        </h2>
        <ClientPhotoCapture value={photo} onChange={setPhoto} />
      </section>

      <section className="space-y-3 border-2 border-ink bg-card p-4 shadow-hard-sm">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-muted-foreground">
          5 · KYC
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Document type">
            <select className={inputCls} value={f.kycDocType} onChange={set("kycDocType")}>
              <option value="AADHAAR">Aadhaar</option>
              <option value="PAN">PAN</option>
              <option value="VOTER_ID">Voter ID</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>        <Field
          label={f.kycDocType === "AADHAAR" ? "Aadhaar number" : "Document number"}
          required
          hint={
            f.kycDocType === "AADHAAR"
              ? kycRef && !kycRefValid
                ? "Aadhaar must be exactly 12 digits."
                : "12 digits — mandatory for KYC"
              : "Required"
          }
        >
          <input
            className={inputCls}
            inputMode="numeric"
            value={f.kycDocRef}
            onChange={(e) =>
              setF((s) => ({
                ...s,
                kycDocRef: e.target.value.replace(/\D/g, "").slice(0, 12),
              }))
            }
            placeholder={f.kycDocType === "AADHAAR" ? "12-digit Aadhaar" : "Document number"}
          />
        </Field>
      </div>

      <Field
        label="Stamp Upload"
        required
        hint="Image (JPG/PNG/WebP) or PDF · max 5 MB"
      >
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="block w-full text-xs font-semibold file:mr-3 file:border-2 file:border-ink file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-black file:uppercase"
          onChange={onStampFile}
        />
      </Field>
      {stamp && (
        <div className="flex items-center gap-3 border-2 border-ink bg-white p-2">
          {stamp.previewUrl ? (
            <img
              src={stamp.previewUrl}
              alt="Stamp preview"
              className="size-14 shrink-0 border border-ink object-cover"
            />
          ) : (
            <span className="grid size-14 shrink-0 place-items-center border border-ink bg-muted text-[10px] font-black uppercase">
              PDF
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-black">
              {stamp.file.name}
            </span>
            <span className="block text-[10px] font-semibold text-muted-foreground">
              {(stamp.file.size / 1024).toFixed(0)} KB · ready to upload
            </span>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (stamp.previewUrl) URL.revokeObjectURL(stamp.previewUrl);
              setStamp(null);
            }}
          >
            Remove
          </Button>
        </div>
      )}
        <Field label="KYC file name" hint="e.g. aadhaar-front.jpg">
          <input className={inputCls} value={f.documentName} onChange={set("documentName")} />
        </Field>
      </section>

      <div className="sticky bottom-24 flex gap-2">
        <Button variant="outline" size="lg" className="flex-1" onClick={() => navigate("/dashboard/clients")}>
          Cancel
        </Button>          <Button size="lg" className="flex-[2]" disabled={!valid || busy || submitting} onClick={() => void submit()}>
            {busy || submitting ? "Saving…" : "Create client"}
          </Button>
      </div>
    </div>
  );
}
