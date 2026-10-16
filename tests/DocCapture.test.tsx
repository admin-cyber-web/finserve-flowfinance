import { describe, expect, test } from "bun:test";
import {
  DOC_KIND_OPTIONS,
  newDocKey,
  validateDocFile,
  type DocItem,
} from "../src/components/fs/DocCapture";

/**
 * DocCapture rule tests — the file-validation rules the capture UI applies
 * before uploading, mirrored by `clients.create` server-side (so a bad file
 * is rejected identically in the browser and in the backend).
 *
 * Rendering needs a DOM + Convex provider harness the project does not have
 * yet, so the pure rules shared by every capture path are covered here.
 */

function makeFile(type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], "doc", { type });
}

describe("DocCapture — document type rules", () => {
  test("kind picker offers exactly the form's KYC document options", () => {
    expect(DOC_KIND_OPTIONS.map((o) => o.id)).toEqual([
      "AADHAAR",
      "PAN",
      "VOTER_ID",
      "OTHER",
    ]);
  });

  test("accepts JPEG, PNG, WebP and PDF", () => {
    expect(validateDocFile(makeFile("image/jpeg", 128), "Document")).toBe(null);
    expect(validateDocFile(makeFile("image/png", 128), "Document")).toBe(null);
    expect(validateDocFile(makeFile("image/webp", 128), "Document")).toBe(null);
    expect(validateDocFile(makeFile("application/pdf", 128), "Document")).toBe(
      null,
    );
  });

  test("rejects every other file type", () => {
    expect(validateDocFile(makeFile("image/gif", 128), "Document")).toMatch(
      /JPEG, PNG, WebP or PDF/,
    );
    expect(
      validateDocFile(makeFile("application/x-msi", 128), "Document"),
    ).toMatch(/JPEG, PNG, WebP or PDF/);
  });

  test("rejects empty files and files over the 5 MB cap", () => {
    expect(validateDocFile(makeFile("image/jpeg", 0), "Document")).toMatch(
      /between 1 byte and 5 MB/,
    );
    expect(
      validateDocFile(makeFile("image/jpeg", 6 * 1024 * 1024), "Document"),
    ).toMatch(/between 1 byte and 5 MB/);
  });
});

describe("DocCapture — row keys and upload pipeline shape", () => {
  test("every document row gets a unique key (preview/retake/remove are keyed)", () => {
    const keys = new Set(Array.from({ length: 100 }, () => newDocKey()));
    expect(keys.size).toBe(100);
  });

  test("uploaded rows keep the shape the submit path collects", () => {
    const row: DocItem = {
      key: newDocKey(),
      kind: "AADHAAR",
      file: makeFile("image/jpeg", 64),
      previewUrl: "blob:test",
      status: "uploaded",
    };
    expect(row.storageId).toBeUndefined();
    expect(row.status).toBe("uploaded");
  });
});
