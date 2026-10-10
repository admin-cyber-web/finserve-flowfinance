import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Camera,
  Loader2,
  MapPin,
  RefreshCw,
  SwitchCamera,
  Trash2,
} from "lucide-react";
import {
  GEO_TIMEOUT_MS,
  geoStampLines,
  geoValidationError,
  type GeoFix,
} from "@/lib/geo";

/**
 * Client photo live capture.
 *
 * Opens the device camera via `getUserMedia` (front/rear switchable), grabs a
 * frame, then requires a fresh high-accuracy GPS fix BEFORE accepting the
 * photo. The accepted frame is stamped with the location box on a canvas —
 * the blob handed to the parent is the stamped image, and the coordinates in
 * the stamp are the exact coordinates stored with the client record.
 *
 * Nothing here silently bypasses: if camera or GPS is
 * unavailable/denied/inaccurate, the user gets a clear error and retry path,
 * and the client form cannot be submitted.
 */

export interface CapturedClientPhoto {
  blob: Blob;
  previewUrl: string;
  geo: GeoFix;
}

type Phase = "idle" | "starting" | "live" | "locating" | "geo-error";

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Promisified high-accuracy GPS fix — one prompt per capture attempt. */
function getGeoFix(): Promise<GeoFix> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(
        new Error(
          "This device or browser does not support location services (GPS).",
        ),
      );
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
          capturedAt: pos.timestamp,
          permissionStatus: "granted",
        }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(
            new Error(
              "Location permission denied — client photo capture ke liye Location/GPS ON karein aur permission allow karein.",
            ),
          );
        } else if (err.code === err.TIMEOUT) {
          reject(
            new Error(
              "Timed out waiting for a GPS fix. Move to open air (or near a window) and retry.",
            ),
          );
        } else {
          reject(
            new Error(
              "Location unavailable right now. Move to open air (or near a window) and retry.",
            ),
          );
        }
      },
      { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 0 },
    );
  });
}

/** Draw the frame + readable location stamp (full coordinates, never truncated). */
function drawStamped(
  source: CanvasImageSource,
  width: number,
  height: number,
  geo: GeoFix,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, width, height);

  const lines = geoStampLines(geo);
  const pad = Math.round(width * 0.03);
  const lineHeight = Math.max(20, Math.round(width * 0.045));
  const boxHeight = lineHeight * lines.length + pad * 2;

  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.fillRect(0, height - boxHeight, width, boxHeight);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "top";
  ctx.font = `bold ${Math.round(lineHeight * 0.78)}px ui-monospace, SFMono-Regular, monospace`;
  lines.forEach((line, i) => {
    // maxWidth squeezes (never truncates) so full coordinates stay readable.
    ctx.fillText(
      line,
      pad,
      height - boxHeight + pad + i * lineHeight,
      width - pad * 2,
    );
  });
  return canvas;
}

function canvasToJpegBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Could not encode the captured photo.")),
      "image/jpeg",
      0.85,
    );
  });
}

export function ClientPhotoCapture({
  value,
  onChange,
}: {
  value: CapturedClientPhoto | null;
  onChange: (next: CapturedClientPhoto | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<HTMLCanvasElement | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);

  // Stop the camera stream when the component goes away.
  useEffect(() => {
    return () => stopStream(streamRef.current);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    setGeoError(null);
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setCameraError(
        "Camera needs a secure connection (HTTPS). Is page ko HTTPS par kholein — mobile browsers camera sirf secure context mein allow karte hain.",
      );
      setPhase("idle");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        "This browser does not support camera access. Try a recent Chrome or Safari.",
      );
      setPhase("idle");
      return;
    }
    setPhase("starting");
    stopStream(streamRef.current);
    streamRef.current = null;
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: facing,
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
      } catch (firstErr) {
        // Some devices have no rear camera — fall back to any camera once.
        if (
          firstErr instanceof DOMException &&
          firstErr.name === "OverconstrainedError"
        ) {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        } else {
          throw firstErr;
        }
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setPhase("live");
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setCameraError(
        name === "NotAllowedError"
          ? "Camera permission denied. Allow camera access for this site in your browser settings, then try again."
          : name === "NotFoundError"
            ? "No camera found on this device."
            : name === "NotReadableError"
              ? "The camera is busy in another app. Close it and try again."
              : "Could not open the camera — please try again.",
      );
      setPhase("idle");
    }
  }, [facing]);

  const finishWithGeo = useCallback(
    async (frame: HTMLCanvasElement) => {
      setGeoError(null);
      setPhase("locating");
      try {
        const geo = await getGeoFix();
        const invalid = geoValidationError(geo);
        if (invalid) throw new Error(invalid);
        const stamped = drawStamped(frame, frame.width, frame.height, geo);
        const blob = await canvasToJpegBlob(stamped);
        const previewUrl = URL.createObjectURL(blob);
        frameRef.current = null;
        setPhase("idle");
        onChange({ blob, previewUrl, geo });
      } catch (err) {
        // Keep the frozen frame so GPS can be retried without recapturing.
        setGeoError(
          err instanceof Error ? err.message : "Could not get a GPS fix.",
        );
        setPhase("geo-error");
      }
    },
    [onChange],
  );

  const captureFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setCameraError(
        "The camera stream is not ready yet — try again in a second.",
      );
      setPhase("idle");
      return;
    }
    const frame = document.createElement("canvas");
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    frame.getContext("2d")!.drawImage(video, 0, 0, frame.width, frame.height);
    frameRef.current = frame;
    stopStream(streamRef.current);
    streamRef.current = null;
    await finishWithGeo(frame);
  }, [finishWithGeo]);

  const retake = useCallback(() => {
    if (value) URL.revokeObjectURL(value.previewUrl);
    onChange(null);
    setGeoError(null);
    void startCamera();
  }, [onChange, startCamera, value]);

  const switchCamera = useCallback(() => {
    setFacing((f) => (f === "environment" ? "user" : "environment"));
    // Restart with the other camera if currently live.
    if (streamRef.current) void startCamera();
  }, [startCamera]);

  const remove = useCallback(() => {
    if (value) URL.revokeObjectURL(value.previewUrl);
    onChange(null);
    setGeoError(null);
    setCameraError(null);
  }, [onChange, value]);

  /* ------------------------------ PREVIEW ------------------------------- */
  if (value) {
    return (
      <div className="space-y-2">
        <div className="relative border-2 border-ink bg-white">
          <img
            src={value.previewUrl}
            alt="Captured client photo with location stamp"
            className="block w-full object-cover"
          />
        </div>
        <div className="border-2 border-ink bg-mint p-3 font-mono text-xs font-bold">
          <div className="flex items-center gap-1.5 font-sans text-[11px] font-black uppercase tracking-wider">
            <MapPin className="size-3.5" /> GPS captured (device-reported)
          </div>
          <p className="mt-1">Latitude: {value.geo.latitude}</p>
          <p>Longitude: {value.geo.longitude}</p>
          <p>Accuracy: {Math.round(value.geo.accuracyMeters)} m</p>
          <p>
            Captured:{" "}
            {new Date(value.geo.capturedAt).toLocaleString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            })}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={retake}
          >
            <RefreshCw className="size-4" /> Retake
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="flex-1"
            onClick={remove}
          >
            <Trash2 className="size-4" /> Remove
          </Button>
        </div>
      </div>
    );
  }

  /* --------------------------- CAMERA / ERRORS -------------------------- */
  if (
    phase === "live" ||
    phase === "starting" ||
    phase === "locating" ||
    phase === "geo-error"
  ) {
    return (
      <div className="space-y-2">
        <div className="relative border-2 border-ink bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className={`block w-full ${phase === "live" ? "" : "opacity-40"}`}
            style={{ aspectRatio: "3 / 4", objectFit: "cover" }}
          />
          {phase === "starting" && (
            <div className="absolute inset-0 grid place-items-center text-xs font-black uppercase text-white">
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> Opening camera…
              </span>
            </div>
          )}
          {phase === "locating" && (
            <div className="absolute inset-0 grid place-items-center bg-black/60 p-4 text-center">
              <div>
                <span className="flex items-center justify-center gap-2 text-xs font-black uppercase text-white">
                  <Loader2 className="size-4 animate-spin" /> Getting GPS fix…
                </span>
                <p className="mt-2 text-[11px] font-semibold text-white/80">
                  Photo accept hone se pehle accurate location milti hai — phone
                  ko client ke paas rakhein.
                </p>
              </div>
            </div>
          )}
          {phase === "geo-error" && (
            <div className="absolute inset-0 grid place-items-center bg-black/70 p-4 text-center">
              <div className="space-y-2">
                <p className="text-[11px] font-bold text-white">{geoError}</p>
                <div className="flex justify-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      frameRef.current && void finishWithGeo(frameRef.current)
                    }
                  >
                    <RefreshCw className="size-3.5" /> Retry GPS
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={retake}
                  >
                    <Camera className="size-3.5" /> Retake photo
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            className="flex-1"
            disabled={phase !== "live"}
            onClick={() => void captureFrame()}
          >
            <Camera className="size-4" /> Capture photo
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={phase !== "live"}
            onClick={switchCamera}
            aria-label="Switch camera"
          >
            <SwitchCamera className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={phase === "locating"}
            onClick={() => {
              stopStream(streamRef.current);
              streamRef.current = null;
              setPhase("idle");
            }}
            aria-label="Close camera"
          >
            ✕
          </Button>
        </div>
        {cameraError && (
          <p className="border-2 border-ink bg-blush p-2 text-xs font-bold">
            {cameraError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="lg"
        className="w-full"
        onClick={() => void startCamera()}
      >
        <Camera className="size-4" /> Open camera / Capture client photo
      </Button>
      <p className="text-[11px] font-semibold text-muted-foreground">
        Camera + GPS dono chahiye: photo par location stamp lagega aur accurate
        GPS fix (≤ 100 m) ke bina submit nahi hoga.
      </p>
      {cameraError && (
        <p className="border-2 border-ink bg-blush p-2 text-xs font-bold">
          {cameraError}
        </p>
      )}
    </div>
  );
}
