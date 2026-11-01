import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ClientPhotoCapture,
  type CapturedClientPhoto,
} from "@/components/fs/ClientPhotoCapture";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  Camera,
  Check,
  ImageOff,
  Loader2,
  MapPin,
  Navigation,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * Client image (photograph) panel — the ONLY place a client photo can be
 * uploaded or geo-tagged after onboarding.
 *
 * It reads the actual saved backend record (`clients.imageStatus`) rather than
 * any frontend flag, so:
 *   • "Image Available" appears only when a valid, accessible image really
 *     belongs to this client, and
 *   • saving a photo here immediately clears the loan block in the separate
 *     Loan section (both subscribe to the same reactive query).
 *
 * Deliberately contains NO loan logic — the Loan section links back here.
 */
export function ClientImagePanel({
  clientId,
  clientName,
}: {
  clientId: Id<"clients">;
  clientName: string;
}) {
  const status = useQuery(api.clients.imageStatus, { clientId });
  const getUploadUrl = useMutation(api.clients.photoUploadUrl);
  const attachPhoto = useMutation(api.clients.attachPhoto);

  // The Loan section links here with #client-image so "Open Client Profile"
  // lands directly on the capture controls.
  const [editing, setEditing] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#client-image",
  );
  const [method, setMethod] = useState<"PHOTO_UPLOAD" | "GEO_TAGGING">("PHOTO_UPLOAD");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [captured, setCaptured] = useState<CapturedClientPhoto | null>(null);
  const [busy, setBusy] = useState(false);

  const resetEditor = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setFile(null);
    setCaptured(null);
  };

  const save = async () => {
    const usingUpload = method === "PHOTO_UPLOAD";
    const blob = usingUpload ? file : captured?.blob ?? null;
    if (!blob) {
      toast.error(
        usingUpload
          ? "Select a client photograph first."
          : "Capture the client photo first.",
      );
      return;
    }
    setBusy(true);
    try {
      const uploadUrl = await getUploadUrl({});
      const resp = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": blob.type || "image/jpeg" },
        body: blob,
      });
      if (!resp.ok) throw new Error("Photo upload failed — please retry.");
      const { storageId } = (await resp.json()) as { storageId: Id<"_storage"> };

      await attachPhoto({
        clientId,
        photoStorageId: storageId,
        photoMethod: method,
        device: navigator.userAgent.slice(0, 60),
        // GPS travels ONLY with a genuine Geo Tagging capture — a manually
        // uploaded photo never claims coordinates.
        geo:
          !usingUpload && captured
            ? {
                latitude: captured.geo.latitude,
                longitude: captured.geo.longitude,
                accuracyMeters: captured.geo.accuracyMeters,
                capturedAt: captured.geo.capturedAt,
                photoCapturedAt: captured.frameAt,
                permissionStatus: captured.geo.permissionStatus,
              }
            : undefined,
      });

      toast.success(
        usingUpload
          ? "Client photograph saved — Image Available."
          : "Geo-tagged client photograph saved — Image Available.",
      );
      resetEditor();
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the image.");
    } finally {
      setBusy(false);
    }
  };

  const available = status?.available === true;

  return (
    <section id="client-image" className="scroll-mt-24 border-2 border-ink bg-card p-4 shadow-hard-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-black uppercase tracking-[0.14em]">
          Client image
        </h3>
        {status !== undefined && status !== null && (
          <span
            className={cn(
              "flex items-center gap-1.5 border-2 border-ink px-2 py-1 text-[10px] font-black uppercase",
              available ? "bg-mint text-ink" : "bg-blush text-ink",
            )}
          >
            {available ? <Check className="size-3.5" /> : <ImageOff className="size-3.5" />}
            {available ? "Image Available" : "Image Not Available"}
          </span>
        )}
      </div>

      {status === undefined ? (
        <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking saved image…
        </div>
      ) : !available ? (
        <div className="space-y-3">
          <p className="border-2 border-ink bg-blush px-3 py-2 text-[11px] font-bold">
            {status?.reason ?? "No client photo has been saved yet."}
          </p>
          <Button className="w-full" onClick={() => setEditing(true)} disabled={busy}>
            <Camera className="size-4" /> Upload Photo / Complete Geo Tagging
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {status.url && (
            <img
              src={status.url}
              alt={`Saved photograph of ${clientName}`}
              className="block w-full border-2 border-ink object-cover"
            />
          )}
          <div className="flex flex-wrap gap-2 text-[10px] font-black uppercase">
            <span className="border-2 border-ink bg-sky px-2 py-1">
              {status.captureMethodLabel}
            </span>
            {status.hasGeo && (
              <span className="border-2 border-ink bg-gold px-2 py-1">
                GPS recorded
              </span>
            )}
          </div>
          {/* GPS is displayed ONLY when it was genuinely captured. */}
          {status.hasGeo &&
            status.latitude !== null &&
            status.longitude !== null && (
              <div className="space-y-2">
                <div className="border-2 border-ink bg-card p-2 font-mono text-xs font-bold">
                  <p>Latitude: {status.latitude}</p>
                  <p>Longitude: {status.longitude}</p>
                  <p>Accuracy: {Math.round(status.accuracyMeters ?? 0)} m</p>
                </div>
                <p className="border-2 border-ink bg-sky p-2 text-[11px] font-bold">
                  Device-reported GPS capture at photo time — not an
                  independently verified location.
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" asChild>
                    <a
                      href={`https://www.google.com/maps?q=${status.latitude},${status.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <MapPin className="size-4" /> View on map
                    </a>
                  </Button>
                  <Button variant="outline" className="flex-1" asChild>
                    <a
                      href={`https://www.google.com/maps/dir/?api=1&destination=${status.latitude},${status.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Navigation className="size-4" /> Navigate
                    </a>
                  </Button>
                </div>
              </div>
            )}
          {!editing && (
            <Button variant="outline" className="w-full" onClick={() => setEditing(true)}>
              <Camera className="size-4" /> Replace photo
            </Button>
          )}
        </div>
      )}

      {editing && (
        <div className="mt-3 space-y-3 border-t-2 border-ink/20 pt-3">
          <div className="grid grid-cols-2 gap-2">
            {(["PHOTO_UPLOAD", "GEO_TAGGING"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMethod(m);
                  resetEditor();
                }}
                className={cn(
                  "border-2 border-ink px-2 py-2 text-[11px] font-black uppercase shadow-hard-sm",
                  method === m ? "bg-gold" : "bg-white",
                )}
              >
                {m === "PHOTO_UPLOAD" ? "Photo Upload" : "Geo Tagging"}
              </button>
            ))}
          </div>

          {method === "PHOTO_UPLOAD" ? (
            <div className="space-y-2">
              <label className="flex w-full cursor-pointer items-center justify-center gap-2 border-2 border-ink bg-white px-3 py-2.5 text-xs font-black uppercase shadow-hard-sm">
                <Upload className="size-4" />
                {file ? "Choose a different photo" : "Select photo"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const picked = e.target.files?.[0] ?? null;
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
                    if (preview) URL.revokeObjectURL(preview);
                    setFile(picked);
                    setPreview(URL.createObjectURL(picked));
                  }}
                />
              </label>
              {preview && (
                <>
                  <img
                    src={preview}
                    alt="Selected client photograph"
                    className="block w-full border-2 border-ink object-cover"
                  />
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={resetEditor}
                    disabled={busy}
                  >
                    <Trash2 className="size-4" /> Remove photo
                  </Button>
                </>
              )}
            </div>
          ) : (
            <ClientPhotoCapture value={captured} onChange={setCaptured} />
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                resetEditor();
                setEditing(false);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              className="flex-[2]"
              onClick={() => void save()}
              disabled={busy || (method === "PHOTO_UPLOAD" ? !file : !captured)}
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Check className="size-4" /> Save client image
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
