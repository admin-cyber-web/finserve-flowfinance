import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useMutation } from "convex/react";
import {
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Camera, FileText, Upload } from "lucide-react";
import { toast } from "sonner";
import { ImageCropDialog } from "@/components/fs/ImageCropDialog";

/**
 * Document capture + upload for the client application form.
 *
 * Each picked file is uploaded to private Convex storage the moment it is
 * chosen, so every row shows a REAL status (uploading / uploaded / failed +
 * retry). Only uploaded rows are ever saved with the application — an
 * in-flight or failed file can never be silently dropped at submit time.
 *
 * Reused across the Applicant and Co-applicant sections on the Client-New
 * form (camera capture + device file picker are both offered for each).
 */

export interface DocItem {
  key: string;
  kind: string; // AADHAAR | PAN | VOTER_ID | OTHER
  file: File;
  previewUrl: string;
  status: "uploading" | "uploaded" | "error";
  storageId?: Id<"_storage">;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const DOC_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

/** Mirrors the server-side per-document upload cap (5 MB). */
const DOC_MAX_BYTES = 5 * 1024 * 1024;

/** Candidate document types rendered in the doc-picker dropdown. */
export const DOC_KIND_OPTIONS: { id: string; label: string }[] = [
  { id: "AADHAAR", label: "Aadhaar" },
  { id: "PAN", label: "PAN" },
  { id: "VOTER_ID", label: "Voter ID" },
  { id: "OTHER", label: "Other" },
];

/** A fresh, unique key for each in-flight / uploaded row of docs. */
export function newDocKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Validate a picked doc file against the same rules the backend enforces. */
export function validateDocFile(
  file: File,
  subject: string,
): string | null {
  if (!DOC_TYPES.includes(file.type)) {
    return `${subject} must be a JPEG, PNG, WebP or PDF file.`;
  }
  if (file.size <= 0 || file.size > DOC_MAX_BYTES) {
    return `${subject} must be between 1 byte and ${Math.round(DOC_MAX_BYTES / 1024 / 1024)} MB.`;
  }
  return null;
}

/** Which set of kinds the field currently shows (Aadhaar/PAN/Voter/Other). */
export function selectedKinds(): { id: string; label: string }[] {
  return DOC_KIND_OPTIONS;
}

interface DocCaptureProps {
  label: string;
  hint?: string;
  value: DocItem[];
  setValue: Dispatch<SetStateAction<DocItem[]>>;
  kindOptions?: { id: string; label: string }[];
  /** Which capture source the camera button uses (default documents). */
  cameraFit?: "environment" | "user";
  /** Whether KYC photos need geo-tagging (default: no). */
  geoRequired?: boolean;
}

/** How long a pending "Retake" choice stays valid after the camera opens. */
const RETAKE_WINDOW_MS = 2 * 60 * 1000;

export function DocCapture({
  label,
  hint,
  value,
  setValue,
  kindOptions = DOC_KIND_OPTIONS,
  cameraFit = "environment",
  geoRequired = false,
}: DocCaptureProps) {
  const getUploadUrl = useMutation(api.clients.photoUploadUrl);
  const [kind, setKind] = useState<string>(kindOptions[0]?.id ?? "OTHER");
  // Picked image awaiting the crop step. PDFs never enter this state.
  const [pendingCrop, setPendingCrop] = useState<{
    file: File;
    retakeKey: string | null;
  } | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  // Set by a per-row "Retake" click: the next camera capture REPLACES that
  // row in place (new preview + fresh upload) instead of appending another.
  // Cleared on pick, on cancel, or as soon as the window lapses — so a
  // never-captured retake can never silently swap a later, unrelated pick.
  const retakeRef = useRef<{ key: string; at: number } | null>(null);

  const startRetake = (key: string) => {
    if (!value.some((d) => d.key === key)) return;
    retakeRef.current = { key, at: Date.now() };
    cameraInputRef.current?.click();
  };

  const upload = async (key: string, file: File) => {
    try {
      const url = await getUploadUrl({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      const parsed = (await res.json()) as { storageId: string };
      setValue((cur) =>
        cur.map((d) =>
          d.key === key
            ? {
                ...d,
                status: "uploaded",
                storageId: parsed.storageId as Id<"_storage">,
              }
            : d,
        ),
      );
    } catch {
      setValue((cur) =>
        cur.map((d) => (d.key === key ? { ...d, status: "error" } : d)),
      );
      toast.error(`Upload failed for "${file.name}" — retry or remove it.`);
    }
  };

  /**
   * Accepts the FINAL file (already cropped when it is an image) and either
   * replaces a retake target in place or appends a new row.
   *
   * These are always normal captures: documents are NEVER geo-tagged,
   * regardless of how the person's photograph (which IS geo-tagged) was
   * captured.
   */
  const acceptFile = (file: File, retakeKey: string | null) => {
    if (retakeKey && value.some((d) => d.key === retakeKey)) {
      setValue((cur) =>
        cur.map((d) => {
          if (d.key !== retakeKey) return d;
          URL.revokeObjectURL(d.previewUrl);
          return {
            ...d,
            file,
            previewUrl: URL.createObjectURL(file),
            status: "uploading" as const,
            storageId: undefined,
          };
        }),
      );
      void upload(retakeKey, file);
      return;
    }
    const key = newDocKey();
    setValue((cur) => [
      ...cur,
      {
        key,
        kind,
        file,
        previewUrl: URL.createObjectURL(file),
        status: "uploading",
      },
    ]);
    void upload(key, file);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = validateDocFile(file, "Document");
    if (problem) {
      toast.error(problem);
      return;
    }
    // A recent "Retake" click replaces its row in place — resolved now, so a
    // cancelled crop cannot leak the retake onto a later, unrelated pick.
    const retake = retakeRef.current;
    retakeRef.current = null;
    const retakeKey =
      retake &&
      Date.now() - retake.at <= RETAKE_WINDOW_MS &&
      value.some((d) => d.key === retake.key)
        ? retake.key
        : null;

    // Images go through the crop step first; PDFs keep their original bytes
    // and pages and upload immediately.
    if (IMAGE_TYPES.includes(file.type)) {
      setPendingCrop({ file, retakeKey });
      return;
    }
    acceptFile(file, retakeKey);
  };

  const remove = (key: string) =>
    setValue((cur) => {
      const target = cur.find((d) => d.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return cur.filter((d) => d.key !== key);
    });

  const retry = (key: string) => {
    const target = value.find((d) => d.key === key);
    if (!target) return;
    setValue((cur) =>
      cur.map((d) => (d.key === key ? { ...d, status: "uploading" } : d)),
    );
    void upload(key, target.file);
  };

  return (
    <div className="space-y-2">
      <Label className="text-xs font-black uppercase tracking-wider">
        {label}
      </Label>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`${label} document type`}
          className="h-9 border-2 border-ink bg-white px-2 text-xs font-black uppercase outline-none"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          {kindOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
        <label
          className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-3 py-1.5 text-xs font-black uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink"
          onPointerDown={() => {
            // A direct click on "Take photo" always appends — clear any
            // retake left over from an abandoned camera prompt. (Retake's
            // programmatic input.click() fires a click, never a pointerdown,
            // so it does NOT trigger this clear.)
            retakeRef.current = null;
          }}
        >
          <Camera className="size-3.5" />
          Take photo
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture={cameraFit}
            className="sr-only"
            onChange={onPick}
          />
        </label>
        <label
          className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-3 py-1.5 text-xs font-black uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink"
          onPointerDown={() => {
            retakeRef.current = null;
          }}
        >
          <Upload className="size-3.5" />
          Upload file
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="sr-only"
            onChange={onPick}
          />
        </label>
      </div>

      {hint && <p className="text-[11px] font-semibold text-muted-foreground">{hint}</p>}

      <ImageCropDialog
        open={pendingCrop !== null}
        file={pendingCrop?.file ?? null}
        title={`Crop ${label.toLowerCase()}`}
        defaultAspect={null}
        onCancel={() => setPendingCrop(null)}
        onConfirm={(cropped) => {
          const pending = pendingCrop;
          setPendingCrop(null);
          if (pending) acceptFile(cropped, pending.retakeKey);
        }}
      />

      {value.length > 0 && (
        <ul className="space-y-1.5">
          {value.map((d) => {
            const isImage = IMAGE_TYPES.includes(d.file.type);
            return (
              <li
                key={d.key}
                className="flex flex-wrap items-center gap-2 border-2 border-ink bg-white px-2 py-1.5"
              >
                {isImage ? (
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
                  {kindOptions.find((o) => o.id === d.kind)?.label ?? d.kind}
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
                      Upload failed
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => retry(d.key)}
                    >
                      Retry
                    </Button>
                  </>
                )}
                {isImage && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => startRetake(d.key)}
                    aria-label={`Retake ${d.file.name}`}
                  >
                    Retake
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => remove(d.key)}
                  aria-label={`Remove ${d.file.name}`}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
