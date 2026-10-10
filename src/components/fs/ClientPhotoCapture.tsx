import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Camera,
  Check,
  Loader2,
  RefreshCw,
  SwitchCamera,
  Trash2,
} from "lucide-react";
import {
  GEO_ACQUIRE_WINDOW_MS,
  GEO_TIMEOUT_MS,
  MAX_GEO_ACCURACY_M,
  acceptableFixAtCapture,
  betterFix,
  geoStampLines,
  isPlausibleFix,
  type AcquiredFix,
} from "@/lib/geo";

/**
 * Client photo live capture.
 *
 * GPS runs in the background via `watchPosition` (enableHighAccuracy,
 * maximumAge: 0) from the moment the camera opens. Successive readings are
 * kept as a best-accuracy fix; the photo is finalized only once a reading
 * meets the accuracy limit AND is fresh relative to the frame instant, so
 * an initial 5000 m reading never aborts the flow — a better reading can
 * still arrive within the acquisition window. The stamp always carries the
 * actual GPS values of the accepted reading.
 *
 * UI is quiet by design: a small spinner while acquiring, a compact
 * success row when ready, and a compact actionable error row (with Retry)
 * only when user action is needed.
 */

export interface CapturedClientPhoto {
  blob: Blob;
  previewUrl: string;
  /** GPS fix — its capturedAt is the FIX timestamp, kept separate. */
  geo: AcquiredFix & { permissionStatus: string };
  /** Photo frame timestamp — preserved separately from the GPS fix time. */
  frameAt: number;
}

type Phase = "idle" | "starting" | "live" | "locating";

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Draw the frame + readable location stamp (full coordinates, never truncated). */
function drawStamped(
  source: CanvasImageSource,
  width: number,
  height: number,
  geo: CapturedClientPhoto["geo"],
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
  const frameAtRef = useRef<number | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const bestRef = useRef<AcquiredFix | null>(null);
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalizingRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  // Small live GPS readout while the camera is open: null = still acquiring.
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  // Downscaled frozen-frame thumbnail, encoded once at capture time.
  const [frozenPreview, setFrozenPreview] = useState<string | null>(null);

  const stopWatch = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (deadlineRef.current !== null) {
      clearTimeout(deadlineRef.current);
      deadlineRef.current = null;
    }
  }, []);

  // Stop watch + camera stream when the component goes away.
  useEffect(() => {
    return () => {
      stopWatch();
      stopStream(streamRef.current);
    };
  }, [stopWatch]);

  const finalize = useCallback(
    async (fix: AcquiredFix) => {
      const frame = frameRef.current;
      if (!frame || finalizingRef.current) return;
      finalizingRef.current = true;
      const frameAt = frameAtRef.current ?? Date.now();
      stopWatch();
      try {
        const geo = { ...fix, permissionStatus: "granted" };
        const stamped = drawStamped(frame, frame.width, frame.height, geo);
        const blob = await canvasToJpegBlob(stamped);
        const previewUrl = URL.createObjectURL(blob);
        frameRef.current = null;
        frameAtRef.current = null;
        bestRef.current = null;
        setGeoError(null);
        setGpsAccuracy(null);
        setFrozenPreview(null);
        setPhase("idle");
        onChange({ blob, previewUrl, geo, frameAt });
      } finally {
        finalizingRef.current = false;
      }
    },
    [onChange, stopWatch],
  );

  /** Called on every watchPosition reading: track best, accept when ready. */
  const onPosition = useCallback(
    (position: GeolocationPosition) => {
      const candidate: AcquiredFix = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy,
        capturedAt: position.timestamp,
      };
      if (!isPlausibleFix(candidate)) return;
      bestRef.current = betterFix(bestRef.current, candidate);
      setGpsAccuracy(bestRef.current.accuracyMeters);
      // Accept as soon as ANY acceptable fix exists: the fresh candidate
      // itself OR the retained best. A stale-but-accurate best must never
      // block acceptance of a fresh acceptable reading, and a valid fix
      // (e.g. 47 m) must never be rejected while waiting for "better".
      if (frameAtRef.current !== null) {
        const accepted =
          acceptableFixAtCapture(candidate, frameAtRef.current) ??
          acceptableFixAtCapture(bestRef.current, frameAtRef.current);
        if (accepted) void finalize(accepted);
      }
    },
    [finalize],
  );

  /** Acquisition window expired — compact actionable error, never misleading. */
  const failAcquisition = useCallback(() => {
    stopWatch();
    if (!frameRef.current) return; // already finalized or cancelled
    const best = bestRef.current;
    setGeoError(
      !best
        ? "Could not get a GPS fix — location services may be off. Turn GPS ON and Retry."
        : best.accuracyMeters > MAX_GEO_ACCURACY_M
          ? `Best GPS accuracy was ${Math.round(best.accuracyMeters)} m — need ≤ ${MAX_GEO_ACCURACY_M} m. Move to open air (or near a window) and Retry.`
          : "The GPS fix was too old for this photo. Tap Retry to get a fresh fix.",
    );
    setPhase("idle");
  }, [stopWatch]);

  const armDeadline = useCallback(() => {
    if (deadlineRef.current === null) {
      deadlineRef.current = setTimeout(failAcquisition, GEO_ACQUIRE_WINDOW_MS);
    }
  }, [failAcquisition]);

  const startWatch = useCallback((): boolean => {
    if (watchIdRef.current !== null) return true; // never double-prompt
    if (!("geolocation" in navigator)) {
      setGeoError(
        "This device or browser does not support location services (GPS).",
      );
      return false;
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      onPosition,
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          stopWatch();
          setGeoError(
            "Location permission denied — client photo capture ke liye Location/GPS ON karein aur permission allow karein.",
          );
          setFrozenPreview(null);
          frameRef.current = null;
          frameAtRef.current = null;
          setPhase("idle");
        }
        // UNAVAILABLE / TIMEOUT: keep watching — a better reading may arrive.
      },
      { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 0 },
    );
    return true;
  }, [onPosition, stopWatch]);

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
    frameRef.current = null;
    frameAtRef.current = null;
    bestRef.current = null;
    setFrozenPreview(null);
    // GPS acquisition starts in the background alongside the camera.
    startWatch();
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
  }, [facing, startWatch, stopStream]);

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
    frameAtRef.current = Date.now();
    setFrozenPreview(frame.toDataURL("image/jpeg", 0.5));
    stopStream(streamRef.current);
    streamRef.current = null;
    setGeoError(null);
    setPhase("locating");
    if (!startWatch()) {
      // No location services at all — surface the error, skip the wait.
      frameRef.current = null;
      frameAtRef.current = null;
      setFrozenPreview(null);
      setPhase("idle");
      return;
    }
    // A fresh accurate fix may already be in hand — accept immediately
    // (a 47 m fix acquired while the camera was open must NOT be rejected).
    if (bestRef.current) {
      const accepted = acceptableFixAtCapture(bestRef.current, frameAtRef.current);
      if (accepted) {
        await finalize(accepted);
        return;
      }
    }
    // Best fix is not acceptable (too old / too inaccurate): restart the
    // watch so the browser issues a FRESH reading — a stationary device may
    // never re-fire an already-running watch on its own.
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    startWatch();
    armDeadline();
  }, [armDeadline, finalize, startWatch, stopStream]);

  const retryGps = useCallback(() => {
    setGeoError(null);
    if (frameRef.current) {
      setPhase("locating");
      // Force a fresh reading — restart the watch rather than relying on an
      // idle one that may never re-fire on a stationary device.
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      startWatch();
      if (bestRef.current && frameAtRef.current !== null) {
        const accepted = acceptableFixAtCapture(bestRef.current, frameAtRef.current);
        if (accepted) {
          void finalize(accepted);
          return;
        }
      }
      armDeadline();
    } else {
      startWatch();
    }
  }, [armDeadline, finalize, startWatch]);

  const retake = useCallback(() => {
    if (value) URL.revokeObjectURL(value.previewUrl);
    onChange(null);
    frameRef.current = null;
    frameAtRef.current = null;
    bestRef.current = null;
    setGeoError(null);
    setGpsAccuracy(null);
    setFrozenPreview(null);
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
    setGpsAccuracy(null);
  }, [onChange, value]);

  const cancelFrozen = useCallback(() => {
    stopWatch();
    frameRef.current = null;
    frameAtRef.current = null;
    bestRef.current = null;
    setGpsAccuracy(null);
    setFrozenPreview(null);
    setGeoError(null);
    setPhase("idle");
  }, [stopWatch]);

  /* ------------------------------ PREVIEW ------------------------------- */
  if (value) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 border-2 border-ink bg-mint px-2 py-1.5 text-[11px] font-black uppercase">
          <Check className="size-3.5 shrink-0" /> Photo + GPS ready · accuracy{" "}
          {Math.round(value.geo.accuracyMeters)} m
        </div>
        <div className="relative border-2 border-ink bg-white">
          <img
            src={value.previewUrl}
            alt="Captured client photo with location stamp"
            className="block w-full object-cover"
          />
        </div>
        <div className="border-2 border-ink bg-card p-3 font-mono text-xs font-bold">
          <p>Latitude: {value.geo.latitude}</p>
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

  /* --------------------- FROZEN FRAME WHILE LOCATING -------------------- */
  if (frozenPreview && phase === "locating") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <img
            alt="Frozen capture awaiting GPS"
            className="w-24 shrink-0 border-2 border-ink object-cover"
            src={frozenPreview}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <span className="flex items-center gap-2 text-[11px] font-black uppercase">
              <Loader2 className="size-3.5 animate-spin" /> Acquiring GPS…
              {gpsAccuracy !== null && (
                <span className="font-mono normal-case text-muted-foreground">
                  best {Math.round(gpsAccuracy)} m
                </span>
              )}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={cancelFrozen}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  /* --------------------------- LIVE CAMERA ------------------------------ */
  return (
    <div className="space-y-2">
      {phase === "idle" && !cameraError && !geoError && (
        <Button
          type="button"
          className="w-full"
          onClick={() => void startCamera()}
        >
          <Camera className="size-4" /> Client Photo
        </Button>
      )}

      {(phase === "starting" || phase === "live") && (
        <>
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
          </div>
          <div className="flex items-center gap-2">
            {gpsAccuracy === null ? (
              <span className="flex flex-1 items-center gap-1.5 text-[11px] font-black uppercase text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> GPS acquiring…
              </span>
            ) : (
              <span
                className={`flex flex-1 items-center gap-1.5 text-[11px] font-black uppercase ${
                  gpsAccuracy <= MAX_GEO_ACCURACY_M
                    ? "text-green-700"
                    : "text-muted-foreground"
                }`}
              >
                <span className="font-mono normal-case">
                  GPS {Math.round(gpsAccuracy)} m
                  {gpsAccuracy <= MAX_GEO_ACCURACY_M ? " ✓" : " — waiting for better"}
                </span>
              </span>
            )}
            <Button
              type="button"
              size="sm"
              className="shrink-0"
              disabled={phase !== "live"}
              onClick={() => void captureFrame()}
            >
              <Camera className="size-4" /> Capture
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={phase !== "live"}
              onClick={switchCamera}
              aria-label="Switch camera"
            >
              <SwitchCamera className="size-4" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
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
        </>
      )}

      {phase === "idle" && (cameraError || geoError) && (
        <Button
          type="button"
          className="w-full"
          onClick={() => void startCamera()}
        >
          <Camera className="size-4" /> Client Photo
        </Button>
      )}

      {/* Compact actionable errors — only when user action is needed. */}
      {cameraError && (
        <div className="flex items-center gap-2 border-2 border-ink bg-blush px-3 py-2 text-[11px] font-bold">
          <span className="flex-1">{cameraError}</span>
          <Button size="sm" variant="outline" onClick={() => void startCamera()}>
            Retry
          </Button>
        </div>
      )}
      {geoError && (
        <div className="flex items-center gap-2 border-2 border-ink bg-blush px-3 py-2 text-[11px] font-bold">
          <span className="flex-1">{geoError}</span>
          <Button size="sm" variant="outline" onClick={retryGps}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        </div>
      )}
    </div>
  );
}
