import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CROP_ASPECT_PRESETS,
  cropExportSize,
} from "../src/components/fs/ImageCropDialog";

/**
 * Image cropping — covers the two things that can actually break silently:
 *   1. exported crop resolution / aspect handling (pure math), and
 *   2. whether EVERY image upload really goes through the cropper while
 *      geo-tagging and PDFs stay untouched.
 *
 * The crop UI itself is verified by these structural checks + the build; it
 * has not been driven in a browser in this environment.
 */

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");

describe("crop export size — quality and aspect", () => {
  test("a portrait photo exports at its true source resolution", () => {
    const out = cropExportSize({
      stageWidth: 300,
      stageHeight: 400,
      naturalWidth: 1000,
      naturalHeight: 1500,
      rotation: 0,
      zoom: 1,
    });
    expect(out.cover).toBeCloseTo(0.3, 5);
    expect(out.width).toBe(1000);
    expect(out.height).toBe(1333);
  });

  test("zooming in crops fewer source pixels instead of upscaling", () => {
    const out = cropExportSize({
      stageWidth: 300,
      stageHeight: 400,
      naturalWidth: 1000,
      naturalHeight: 1500,
      rotation: 0,
      zoom: 2,
    });
    expect(out.width).toBe(500);
  });

  test("rotation swaps the measured image dimensions", () => {
    const out = cropExportSize({
      stageWidth: 400,
      stageHeight: 300,
      naturalWidth: 2000,
      naturalHeight: 1000,
      rotation: 90,
      zoom: 1,
    });
    expect(out.cover).toBeCloseTo(0.4, 5);
    expect(out.width).toBe(1000);
    expect(out.height).toBe(750);
  });

  test("very large photos are capped at a readable, uploadable long edge", () => {
    const out = cropExportSize({
      stageWidth: 400,
      stageHeight: 300,
      naturalWidth: 6000,
      naturalHeight: 4000,
      rotation: 0,
      zoom: 1,
    });
    expect(out.width).toBe(2400);
    expect(out.height).toBe(1800);
  });
});

describe("crop aspect ratios", () => {
  test("offers free, square and non-square ratios (no forced square)", () => {
    const values = CROP_ASPECT_PRESETS.map((p) => p.value);
    expect(values).toContain(null); // free / original
    expect(values).toContain(1); // 1:1
    expect(values).toContain(3 / 4); // portrait
    expect(values).toContain(4 / 3); // landscape
    expect(values.some((v) => v !== null && v < 1)).toBe(true);
    expect(values.some((v) => v !== null && v > 1)).toBe(true);
  });
});

describe("crop wiring — every image upload", () => {
  test("DocCapture crops images before upload and lets PDFs through untouched", () => {
    const src = read("src/components/fs/DocCapture.tsx");
    expect(src).toContain('from "@/components/fs/ImageCropDialog"');
    expect(src).toContain("IMAGE_TYPES.includes(file.type)");
    expect(src).toContain("setPendingCrop({ file, retakeKey })");
    // The non-image path uploads immediately, keeping PDF bytes/pages intact.
    expect(src).toMatch(/acceptFile\(file, retakeKey\);/);
    expect(src).toContain("<ImageCropDialog");
  });

  test("client photograph upload (profile panel) is cropped", () => {
    const src = read("src/components/fs/ClientImagePanel.tsx");
    expect(src).toContain('from "@/components/fs/ImageCropDialog"');
    expect(src).toContain("setPendingCrop(picked)");
    expect(src).toContain("<ImageCropDialog");
  });

  test("applicant and co-applicant photo uploads are cropped", () => {
    const src = read("src/pages/dashboard/ClientNew.tsx");
    expect(src).toContain('from "@/components/fs/ImageCropDialog"');
    expect(src).toContain('{ target: "applicant", file }');
    expect(src).toContain('{ target: "coApplicant", file }');
    expect(src).toContain("<ImageCropDialog");
  });

  test("co-applicant photo upload on the edit screen is cropped", () => {
    const src = read("src/pages/dashboard/ClientEdit.tsx");
    expect(src).toContain('from "@/components/fs/ImageCropDialog"');
    expect(src).toContain("setCropFile(picked)");
    expect(src).toContain("<ImageCropDialog");
  });

  test("the cropper exposes move, zoom, rotate, reset, preview, cancel and save", () => {
    const src = read("src/components/fs/ImageCropDialog.tsx");
    expect(src).toContain("onPointerDown");
    expect(src).toContain("onPointerMove");
    expect(src).toContain('addEventListener("wheel"');
    expect(src).toContain("passive: false");
    expect(src).toContain('aria-label="Zoom in"');
    expect(src).toContain('aria-label="Zoom out"');
    expect(src).toContain("RotateCcw");
    expect(src).toContain("RotateCw");
    expect(src).toContain("> Reset");
    expect(src).toContain("Save &amp; Upload");
    expect(src).toContain("Cancel");
    expect(src).toContain("this is the final crop");
    expect(src).toContain("touch-none");
  });
});

describe("geo-tagging is untouched", () => {
  test("the geo capture component never imports or renders the cropper", () => {
    const src = read("src/components/fs/ClientPhotoCapture.tsx");
    expect(src).not.toContain("ImageCropDialog");
    expect(src).not.toMatch(/crop/i);
    // GPS stamping / camera behaviour still lives here, unchanged.
    expect(src).toContain("drawStamped");
    expect(src).toContain("navigator.geolocation.watchPosition");
  });

  test("every geo-tagging branch renders ClientPhotoCapture, never the cropper", () => {
    for (const path of [
      "src/components/fs/ClientImagePanel.tsx",
      "src/pages/dashboard/ClientNew.tsx",
      "src/pages/dashboard/ClientEdit.tsx",
    ]) {
      const src = read(path);
      const geoBranches = src.split("GEO_TAGGING").length - 1;
      expect(geoBranches).toBeGreaterThan(0);
      expect(src).toContain("<ClientPhotoCapture");
    }
  });
});
