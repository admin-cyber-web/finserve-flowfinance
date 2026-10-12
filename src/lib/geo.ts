/**
 * Geo-tagging rules for client photo capture.
 *
 * Isomorphic (browser + Convex backend): the SAME validation runs in the
 * capture UI before a photo is accepted and in `clients.create` server-side,
 * so a tampered client can never attach coordinates the server would reject.
 *
 * The stored fix is a DEVICE-REPORTED browser location — never presented as
 * an independently verified physical position.
 */

/** Worst acceptable horizontal accuracy, in metres. */
export const MAX_GEO_ACCURACY_M = 100;
/** getCurrentPosition timeout for a high-accuracy fix. */
export const GEO_TIMEOUT_MS = 20_000;
/** A fix older than this is stale — force a fresh capture. */
export const GEO_MAX_AGE_MS = 30 * 60 * 1000;
/** Tolerated clock skew into the future. */
export const GEO_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Largest accepted client photo (JPEG/PNG/WebP). */
export const MAX_CLIENT_PHOTO_BYTES = 5 * 1024 * 1024;

export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  /** Device-reported epoch-ms timestamp of the capture. */
  capturedAt: number;
  /** Geolocation permission status observed at capture time. */
  permissionStatus: string;
}

/**
 * Returns a user-readable validation error, or null when the fix is
 * acceptable. Never fabricates values: (0, 0), stale fixes and poor
 * accuracy are all rejected.
 */
export function geoValidationError(
  geo: Partial<GeoFix> | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!geo) return "Location data is missing — capture the photo with GPS on.";
  const { latitude, longitude, accuracyMeters, capturedAt } = geo;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return "Invalid GPS latitude.";
  }
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return "Invalid GPS longitude.";
  }
  if (latitude === 0 && longitude === 0) {
    return "GPS returned invalid coordinates (0, 0) — try again in open air.";
  }
  if (typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters) || accuracyMeters <= 0) {
    return "GPS accuracy is missing or invalid.";
  }
  if (accuracyMeters > MAX_GEO_ACCURACY_M) {
    return `GPS accuracy ${Math.round(accuracyMeters)} m is worse than the ${MAX_GEO_ACCURACY_M} m limit. Move to open air (or near a window) and retry.`;
  }
  if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt)) {
    return "Capture timestamp is missing.";
  }
  if (capturedAt > now + GEO_FUTURE_SKEW_MS) {
    return "Capture timestamp is in the future — check the device clock.";
  }
  if (now - capturedAt > GEO_MAX_AGE_MS) {
    return "The GPS fix is too old — capture the photo again.";
  }
  return null;
}

/* ------------------------ watchPosition acquisition --------------------- */

/** Post-frame window to wait for an acceptable fix (spec: up to ~40 s). */
export const GEO_ACQUIRE_WINDOW_MS = 40_000;
/**
 * Freshness policy: a fix may correspond to the photo if it is within this
 * window EITHER SIDE of the frame instant. The stamp and database always
 * carry the GPS fix's own timestamp (`capturedAt`) — separate from the photo
 * frame time (`photoCapturedAt`) — so the two are never conflated. A valid
 * accurate fix is accepted even if it arrived shortly before the photo; a
 * fix arriving shortly after the photo is equally valid.
 */
export const GEO_FIX_FRAME_WINDOW_MS = 60_000;
/**
 * When a frozen frame is already waiting for a fresh fix (photo captured
 * before an accurate fix landed), keep the acquisition window open longer so
 * a valid reading that arrives at 40–80 s is still accepted instead of
 * surfacing a misleading "best accuracy was … m" failure.
 *
 * Accuracy requirement itself is never relaxed — this only affects how long
 * we wait for the device to produce an acceptable reading.
 */
export const GEO_ACQUIRE_EXTRA_MS = 40_000;
/** Total patience while a frozen frame is awaiting a fresh GPS fix. */
export const GEO_ACQUIRE_WINDOW_WITH_FROZEN_FRAME_MS =
  GEO_ACQUIRE_WINDOW_MS + GEO_ACQUIRE_EXTRA_MS;

export interface AcquiredFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: number;
}

/** Structurally valid coordinates + positive accuracy (not yet accuracy-limited). */
export function isPlausibleFix(fix: {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: number;
}): fix is AcquiredFix {
  return (
    Number.isFinite(fix.latitude) &&
    fix.latitude >= -90 &&
    fix.latitude <= 90 &&
    Number.isFinite(fix.longitude) &&
    fix.longitude >= -180 &&
    fix.longitude <= 180 &&
    !(fix.latitude === 0 && fix.longitude === 0) &&
    Number.isFinite(fix.accuracyMeters) &&
    fix.accuracyMeters > 0 &&
    Number.isFinite(fix.capturedAt)
  );
}

/** Keep whichever fix is more accurate — successive watchPosition readings. */
export function betterFix(
  current: AcquiredFix | null,
  candidate: AcquiredFix,
): AcquiredFix {
  return !current || candidate.accuracyMeters < current.accuracyMeters
    ? candidate
    : current;
}

/**
 * A fix may be stamped only when it meets the accuracy limit (0 < accuracy
 * ≤ 100 m, inclusive) AND falls inside the freshness window around the photo
 * frame. Fixes that arrive after the photo are fine; the stored timestamp is
 * always the fix's own. Never relaxes the accuracy limit; never fabricates.
 */
export function acceptableFixAtCapture(
  fix: AcquiredFix | null,
  frameAt: number,
): AcquiredFix | null {
  if (!fix) return null;
  if (!isPlausibleFix(fix)) return null; // ranges, (0, 0), positive accuracy
  if (fix.accuracyMeters > MAX_GEO_ACCURACY_M) return null;
  const skew = frameAt - fix.capturedAt;
  if (skew > GEO_FIX_FRAME_WINDOW_MS) return null; // fix too old for this frame
  if (skew < -GEO_FIX_FRAME_WINDOW_MS) return null; // fix absurdly ahead (clock skew)
  return fix;
}

/**
 * Like `acceptableFixAtCapture`, but permits a fix whose timestamp is future-
 * relative to the frame instant by up to `GEO_FIX_FUTURE_TOLERANCE_MS`. This
 * is used only for the frozen-frame-while-waiting path, where the phone's
 * clock may drift a little relative to the capture instant and we still want
 * to accept a genuinely fresh fix rather than failing the whole flow.
 */
export function acceptableFixAtCaptureWithFutureTolerance(
  fix: AcquiredFix | null,
  frameAt: number,
  toleranceMs: number = 40_000,
): AcquiredFix | null {
  if (!fix) return null;
  if (!isPlausibleFix(fix)) return null;
  if (fix.accuracyMeters > MAX_GEO_ACCURACY_M) return null;
  const skew = frameAt - fix.capturedAt;
  if (skew > GEO_FIX_FRAME_WINDOW_MS) return null; // fix too old for this frame
  if (skew < -toleranceMs) return null; // fix too far ahead (clock drift)
  return fix;
}

/** Lines rendered into the on-photo location stamp (full coordinates). */
export function geoStampLines(geo: GeoFix): string[] {
  const captured = new Date(geo.capturedAt).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return [
    "FINServe — CLIENT PHOTO",
    `Latitude: ${geo.latitude}`,
    `Longitude: ${geo.longitude}`,
    `Accuracy: ${Math.round(geo.accuracyMeters)} m`,
    `Captured: ${captured}`,
  ];
}
