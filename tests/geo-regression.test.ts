import { describe, expect, test } from "bun:test";
import {
  MAX_GEO_ACCURACY_M,
  acceptableFixAtCapture,
  acceptableFixAtCaptureWithFutureTolerance,
  geoValidationError,
  isPlausibleFix,
  betterFix,
  type AcquiredFix,
} from "../src/lib/geo";
import { ageFromDob } from "../src/lib/finance/validate";

const LAT = 25.3211;
const LNG = 82.9861;

function fix(overrides: Partial<AcquiredFix> = {}): AcquiredFix {
  return {
    latitude: LAT,
    longitude: LNG,
    accuracyMeters: 47,
    capturedAt: Date.now(),
    ...overrides,
  };
}

describe("geo acquisition regression — core decision logic", () => {
  test("accepts a 47 m fix immediately when it is already available", () => {
    const f = fix({ accuracyMeters: 47 });
    expect(acceptableFixAtCaptureWithFutureTolerance(f, Date.now())).toEqual(f);
  });

  test("rejects a 200000 m fix even when it is fresh", () => {
    expect(
      acceptableFixAtCaptureWithFutureTolerance(
        fix({ accuracyMeters: 200_000 }),
        Date.now(),
      ),
    ).toBeNull();
  });

  test("rejects a 101 m fix; accepts a 100 m fix (limit is inclusive)", () => {
    const bad = fix({ accuracyMeters: 101 });
    const good = fix({ accuracyMeters: 100 });
    expect(acceptableFixAtCaptureWithFutureTolerance(bad, Date.now())).toBeNull();
    expect(acceptableFixAtCaptureWithFutureTolerance(good, Date.now())).toEqual(good);
    expect(MAX_GEO_ACCURACY_M).toBe(100);
  });

  test("rejects a stale fix whose timestamp is too old relative to the frame", () => {
    const stale = fix({ capturedAt: Date.now() - 61_000 });
    expect(acceptableFixAtCaptureWithFutureTolerance(stale, Date.now())).toBeNull();
  });

  test("accepts a future-dated fix within the tolerance window", () => {
    const ahead = fix({ capturedAt: Date.now() + 20_000 });
    expect(acceptableFixAtCaptureWithFutureTolerance(ahead, Date.now())).toEqual(ahead);
  });

  test("rejects a future-dated fix outside the tolerance window", () => {
    const wayAhead = fix({ capturedAt: Date.now() + 60_000 });
    expect(
      acceptableFixAtCaptureWithFutureTolerance(wayAhead, Date.now()),
    ).toBeNull();
  });

  test("strict capture check tolerates ±60 s skew, rejects beyond it", () => {
    const slightlyAhead = fix({ capturedAt: Date.now() + 20_000 });
    expect(acceptableFixAtCapture(slightlyAhead, Date.now())).toEqual(slightlyAhead);
    const wayAhead = fix({ capturedAt: Date.now() + 61_000 });
    expect(acceptableFixAtCapture(wayAhead, Date.now())).toBeNull();
  });

  test("plausibility rejects (0, 0) and non-finite values", () => {
    expect(isPlausibleFix(fix({ latitude: 0, longitude: 0 }))).toBe(false);
    expect(isPlausibleFix(fix({ latitude: NaN }))).toBe(false);
    expect(isPlausibleFix(fix({ accuracyMeters: -1 }))).toBe(false);
    expect(isPlausibleFix(fix())).toBe(true);
  });

  test("betterFix keeps the more accurate reading", () => {
    const first = fix({ accuracyMeters: 80 });
    const second = fix({ accuracyMeters: 25 });
    expect(betterFix(first, second)).toEqual(second);
    expect(betterFix(null, second)).toEqual(second);
    expect(betterFix(second, first)).toEqual(second);
  });
});

describe("geoValidationError — server-side re-validation", () => {
  const now = Date.now();

  test("accepts a valid 47 m device fix", () => {
    const f = { ...fix({ accuracyMeters: 47 }), permissionStatus: "granted" };
    expect(geoValidationError(f, now)).toBeNull();
  });

  test("rejects a 101 m fix with an actionable message", () => {
    const f = { ...fix({ accuracyMeters: 101 }), permissionStatus: "granted" };
    const err = geoValidationError(f, now);
    expect(err).toMatch(/101 m/);
  });

  test("rejects missing coords, (0, 0), bad accuracy and stale timestamps", () => {
    expect(geoValidationError(null, now)).toMatch(/Location data is missing/);
    expect(
      geoValidationError({ ...fix({ latitude: 0, longitude: 0 }), permissionStatus: "granted" }, now),
    ).toMatch(/0, 0/);
    expect(
      geoValidationError({ ...fix({ accuracyMeters: 0 }), permissionStatus: "granted" }, now),
    ).toMatch(/accuracy/);
    expect(
      geoValidationError(
        { ...fix({ capturedAt: now - 31 * 60 * 1000 }), permissionStatus: "granted" },
        now,
      ),
    ).toMatch(/too old/);
    expect(
      geoValidationError(
        { ...fix({ capturedAt: now + 6 * 60 * 1000 }), permissionStatus: "granted" },
        now,
      ),
    ).toMatch(/future/);
  });
});

describe("ageFromDob — automatic age from the date picker", () => {
  test("computes completed years relative to today", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    expect(ageFromDob(Date.parse("1998-10-12T00:00:00Z"), now)).toBe(28);
    expect(ageFromDob(Date.parse("1998-10-13T00:00:00Z"), now)).toBe(27);
    expect(ageFromDob(Date.parse("1998-09-30T00:00:00Z"), now)).toBe(28);
    expect(ageFromDob(Date.parse("2010-05-01T00:00:00Z"), now)).toBe(16);
  });
});
