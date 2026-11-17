import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Check,
  Crop,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Reusable image cropper shown BEFORE an image is uploaded.
 *
 * One component serves every image upload in the app (client photo,
 * co-applicant photo, KYC documents, …). It never runs for PDFs — callers pass
 * only image files, so PDFs keep their original bytes and page structure.
 *
 * The visible stage IS the crop: the image is drawn behind it with the user's
 * pan / zoom / rotation, so what you see is exactly what is exported. Export
 * uses the crop's true pixel resolution (capped at a sane long edge), so
 * document text stays readable.
 *
 * Geo-tagging captures deliberately do NOT come through here.
 */

export interface CropAspectPreset {
  label: string;
  /** width / height, or null for a free (original) ratio. */
  value: number | null;
}

export const CROP_ASPECT_PRESETS: CropAspectPreset[] = [
  { label: "Free", value: null },
  { label: "1:1", value: 1 },
  { label: "3:4", value: 3 / 4 },
  { label: "4:3", value: 4 / 3 },
  { label: "A4", value: 1 / Math.SQRT2 },
  { label: "16:9", value: 16 / 9 },
];

/** Longest edge of the exported image — enough for ID document text. */
const MAX_OUTPUT_EDGE = 2400;
const MIN_OUTPUT_EDGE = 480;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function stageSize(rect: { width: number; height: number }) {
  // Never collapse to zero while the panel is still laying out.
  return {
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function croppedName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "") || "image";
  return `${base}-cropped.jpg`;
}

/**
 * Pixel size of the exported crop.
 *
 * The crop box is `stageWidth` CSS px wide; at cover × zoom scaling one source
 * pixel covers `cover * zoom` CSS px, so the crop's true source resolution is
 * `stageWidth / (cover * zoom)`. Exporting at that width keeps document text
 * readable instead of blurring it through an arbitrary resize.
 */
export function cropExportSize(input: {
  stageWidth: number;
  stageHeight: number;
  naturalWidth: number;
  naturalHeight: number;
  rotation: number;
  zoom: number;
  maxEdge?: number;
  minEdge?: number;
}): { width: number; height: number; cover: number } {
  const maxEdge = input.maxEdge ?? MAX_OUTPUT_EDGE;
  const minEdge = input.minEdge ?? MIN_OUTPUT_EDGE;
  const sideways = Math.abs(input.rotation % 180) === 90;
  const viewW = sideways ? input.naturalHeight : input.naturalWidth;
  const viewH = sideways ? input.naturalWidth : input.naturalHeight;
  const cover = Math.max(
    input.stageWidth / Math.max(1, viewW),
    input.stageHeight / Math.max(1, viewH),
  );
  const sourceWidth = input.stageWidth / (cover * Math.max(1, input.zoom));
  const width = Math.round(
    Math.min(maxEdge, Math.max(minEdge, sourceWidth)),
  );
  const height = Math.max(
    1,
    Math.round(width * (input.stageHeight / Math.max(1, input.stageWidth))),
  );
  return { width, height, cover };
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not export the crop.")),
      "image/jpeg",
      quality,
    );
  });
}

export function ImageCropDialog({
  open,
  file,
  title = "Crop image",
  defaultAspect = null,
  aspectPresets = CROP_ASPECT_PRESETS,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  file: File | null;
  title?: string;
  defaultAspect?: number | null;
  aspectPresets?: CropAspectPreset[];
  onCancel: () => void;
  onConfirm: (file: File) => void | Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());

  const [aspect, setAspect] = useState<number | null>(defaultAspect);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [size, setSize] = useState({ width: 1, height: 1 });
  // Natural pixels of the loaded image — the "Free" crop keeps this shape, so
  // portrait portraits and landscape documents are never forced into a box.
  const [natural, setNatural] = useState({ width: 4, height: 3 });

  /* --------------------------- load the image --------------------------- */
  useEffect(() => {
    if (!open || !file) {
      imageRef.current = null;
      setReady(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      imageRef.current = image;
      // Fresh selection: reset everything, honour the caller's ratio.
      setNatural({ width: image.naturalWidth, height: image.naturalHeight });
      setAspect(defaultAspect);
      setZoom(1);
      setRotation(0);
      setOffset({ x: 0, y: 0 });
      setError(null);
      setReady(true);
    };
    image.onerror = () => {
      if (cancelled) return;
      setError("This image could not be opened. Choose a JPEG, PNG or WebP file.");
      setReady(false);
    };
    image.src = url;
    return () => {
      cancelled = true;
      imageRef.current = null;
      URL.revokeObjectURL(url);
    };
  }, [open, file, defaultAspect]);

  /* ----------------------- keep the stage measured ---------------------- */
  const sideways = Math.abs(rotation % 180) === 90;
  const freeRatio = sideways
    ? natural.height / natural.width
    : natural.width / natural.height;
  const stageRatio = aspect ?? freeRatio;

  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setSize(stageSize(stage.getBoundingClientRect()));
    measure();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open, stageRatio]);

  /** Cover-scale for the (rotated) image, so the crop is always filled. */
  const drawTo = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      image: HTMLImageElement,
      stageW: number,
      stageH: number,
      scaleFactor: number,
    ) => {
      const rotated = Math.abs(rotation % 180) === 90;
      const viewW = rotated ? image.naturalHeight : image.naturalWidth;
      const viewH = rotated ? image.naturalWidth : image.naturalHeight;
      const cover = Math.max(stageW / viewW, stageH / viewH);
      const scale = cover * zoom * scaleFactor;
      const cx = (stageW / 2 + offset.x) * scaleFactor;
      const cy = (stageH / 2 + offset.y) * scaleFactor;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.scale(scale, scale);
      ctx.drawImage(
        image,
        -image.naturalWidth / 2,
        -image.naturalHeight / 2,
      );
      ctx.restore();
    },
    [rotation, zoom, offset.x, offset.y],
  );

  /* ---------------------------- live render ----------------------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !ready) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(size.width * dpr));
    canvas.height = Math.max(1, Math.round(size.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    drawTo(ctx, image, size.width, size.height, 1);
  }, [ready, size.width, size.height, drawTo]);

  /* ------------------------------- gestures ----------------------------- */
  const clampZoom = (value: number) =>
    Math.min(5, Math.max(1, Number(value.toFixed(2))));

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        zoom,
      };
      dragRef.current = null;
      return;
    }
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX - offset.x,
      y: event.clientY - offset.y,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const [a, b] = [...pointersRef.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchRef.current.distance > 0) {
        setZoom(
          clampZoom(
            pinchRef.current.zoom * (distance / pinchRef.current.distance),
          ),
        );
      }
      return;
    }

    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    setOffset({
      x: event.clientX - drag.x,
      y: event.clientY - drag.y,
    });
  };

  const endPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (dragRef.current?.id === event.pointerId) dragRef.current = null;
  };

  // Wheel-to-zoom needs a NON-passive listener (React attaches wheel passively
  // at the root, where preventDefault is ignored).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !open) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((current) => clampZoom(current - event.deltaY * 0.0015));
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [open]);

  const reset = () => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
  };

  /* -------------------------------- save -------------------------------- */
  const save = async () => {
    const image = imageRef.current;
    if (!image || !ready) return;
    setSaving(true);
    try {
      // Export at the crop's real pixel density so document text stays sharp.
      const { width: outW, height: outH } = cropExportSize({
        stageWidth: size.width,
        stageHeight: size.height,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        rotation,
        zoom,
      });

      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not prepare the crop.");
      const factor = outW / size.width;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, outW, outH);
      drawTo(ctx, image, size.width, size.height, factor);

      // Keep the upload under the backend's 5 MB cap without visible loss.
      let blob = await canvasBlob(canvas, 0.94);
      if (blob.size > MAX_UPLOAD_BYTES) blob = await canvasBlob(canvas, 0.86);
      if (blob.size > MAX_UPLOAD_BYTES) blob = await canvasBlob(canvas, 0.78);
      if (blob.size > MAX_UPLOAD_BYTES) {
        throw new Error("The cropped image is still larger than 5 MB — zoom out or pick a smaller photo.");
      }

      await onConfirm(
        new File([blob], croppedName(file?.name ?? "image.jpg"), {
          type: "image/jpeg",
          lastModified: Date.now(),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the crop.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/75 p-3 sm:items-center sm:p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <div className="w-full max-w-lg border-2 border-ink bg-card text-ink shadow-hard">
        {/* header */}
        <div className="flex items-center justify-between gap-2 border-b-2 border-ink bg-navy px-3 py-2 text-paper">
          <span className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em]">
            <Crop className="size-4" /> {title}
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel cropping"
            className="grid size-7 place-items-center border-2 border-paper/40 hover:bg-paper/10"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3 p-3">
          {error && (
            <p className="border-2 border-ink bg-blush px-2 py-1.5 text-[11px] font-bold">
              {error}
            </p>
          )}

          {/* crop stage — what you see is exactly what gets uploaded */}
          <div
            ref={stageRef}
            className="relative mx-auto w-full max-w-[420px] overflow-hidden border-2 border-ink bg-black"
            style={{ aspectRatio: String(stageRatio) }}
          >
            <canvas
              ref={canvasRef}
              className="block h-full w-full touch-none select-none"
              style={{ cursor: ready ? "grab" : "default" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
            />
            {/* thirds guide — overlay only, never exported */}
            {ready && (
              <div className="pointer-events-none absolute inset-0">
                <div className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
                <div className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
                <div className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
                <div className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
                <span className="absolute bottom-1 left-1 border border-white/40 bg-black/60 px-1.5 py-0.5 text-[9px] font-black uppercase text-white">
                  Preview — this is the final crop
                </span>
              </div>
            )}
            {!ready && !error && (
              <div className="absolute inset-0 grid place-items-center text-xs font-black uppercase text-white">
                <span className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" /> Opening image…
                </span>
              </div>
            )}
          </div>

          <p className="text-[10px] font-bold uppercase text-muted-foreground">
            Drag to reposition · pinch or slider to zoom · rotate / reset below
          </p>

          {/* zoom */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Zoom out"
              className="grid size-9 shrink-0 place-items-center border-2 border-ink bg-white shadow-hard-sm disabled:opacity-40"
              onClick={() => setZoom((z) => clampZoom(z - 0.15))}
              disabled={!ready || zoom <= 1}
            >
              <Minus className="size-4" />
            </button>
            <input
              type="range"
              min={1}
              max={5}
              step={0.01}
              value={zoom}
              disabled={!ready}
              onChange={(event) => setZoom(clampZoom(Number(event.target.value)))}
              aria-label="Zoom"
              className="h-2 w-full accent-[var(--color-royal)]"
            />
            <button
              type="button"
              aria-label="Zoom in"
              className="grid size-9 shrink-0 place-items-center border-2 border-ink bg-white shadow-hard-sm disabled:opacity-40"
              onClick={() => setZoom((z) => clampZoom(z + 0.15))}
              disabled={!ready || zoom >= 5}
            >
              <Plus className="size-4" />
            </button>
            <span className="w-10 shrink-0 text-right font-mono text-[11px] font-black">
              {Math.round(zoom * 100)}%
            </span>
          </div>

          {/* rotate / reset */}
          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!ready}
              onClick={() => setRotation((r) => (r + 270) % 360)}
            >
              <RotateCcw className="size-3.5" /> Left
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!ready}
              onClick={() => setRotation((r) => (r + 90) % 360)}
            >
              <RotateCw className="size-3.5" /> Right
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!ready}
              onClick={reset}
            >
              <Maximize2 className="size-3.5" /> Reset
            </Button>
          </div>

          {/* aspect ratios — no forced square */}
          <div>
            <p className="mb-1 text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">
              Aspect ratio
            </p>
            <div className="flex flex-wrap gap-1.5">
              {aspectPresets.map((preset) => {
                const active =
                  (preset.value === null && aspect === null) ||
                  (preset.value !== null &&
                    aspect !== null &&
                    Math.abs(preset.value - aspect) < 0.001);
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setAspect(preset.value);
                      setOffset({ x: 0, y: 0 });
                      setZoom(1);
                    }}
                    className={cn(
                      "border-2 border-ink px-2 py-1 text-[10px] font-black uppercase",
                      active ? "bg-gold text-ink" : "bg-white",
                    )}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* actions */}
          <div className="grid grid-cols-2 gap-2 border-t-2 border-ink/20 pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={!ready || saving}
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Preparing…
                </>
              ) : (
                <>
                  <Check className="size-4" /> Save &amp; Upload
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
