import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useMutation } from "convex/react";
import { useState, type ChangeEvent, type Dispatch, type SetStateAction } from "react";
import { Camera, FileText, Upload } from "lucide-react";
import { toast } from "sonner";

/**
 * Document capture + upload for the client application form.
 *
 * Each file is uploaded to private Convex storage the moment it is picked so
 * every row shows a REAL status (uploading / uploaded / failed + retry) —
 * only uploaded rows are ever saved with the application, so an in-flight or
 * failed file can never be silently discarded at submission.
 *
 * Used twice on the Client-New form: once for the Applicant section and
 * once for the Co-applicant section (camera capture and device file picker
 * are both offered for each).
 */

export interface DocItem {
  key: string;
  kind: string; // AADHAAR | PAN | VOTER_ID | OTHER
  file: File;
  previewUrl: string;
  status: "uploading" | "uploaded" | "error";
  storageId?: Id<"_storage">;
}

export const DOC_KIND_OPTIONS = [
  { id: "AADHAAR", label: "Aadhaar" },
  { id: "PAN", label: "PAN" },
  { id: "VOTER_ID", label: "Voter ID" },
  { id: "OTHER", label: "Other" },
] as const;

export const DOC_MAX_BYTES = 5 * 1024 * 1024;
const DOC_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function newDocKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Validate a picked file against the same rules the backend enforces. */
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

interface DocCaptureProps {
  label: string;
  hint?: string;
  value: DocItem[];
  setValue: Dispatch<SetStateAction<DocItem[]>>;
  kindOptions?: { id: string; label: string }[];
  /** Which capture source the camera button uses (default documents). */
  cameraFit?: "environment" | "user";
}

export function DocCapture({
  label,
  hint,
  value,
  setValue,
  kindOptions = DOC_KIND_OPTIONS,
  cameraFit = "environment",
}: DocCaptureProps) {
  const getUploadUrl = useMutation(api.clients.photoUploadUrl);
  const [kind, setKind] = useState<string>(kindOptions[0]?.id ?? "OTHER");

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

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = validateDocFile(file, "Document");
    if (problem) {
      toast.error(problem);
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
        <label className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-3 py-1.5 text-xs font-black uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink">
          <Camera className="size-3.5" />
          Take photo
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture={cameraFit}
            className="sr-only"
            onChange={onPick}
          />
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 border-2 border-ink bg-white px-3 py-1.5 text-xs font-black uppercase shadow-hard-sm transition-colors hover:bg-gold focus-within:ring-2 focus-within:ring-ink">
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
