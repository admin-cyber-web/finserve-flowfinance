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
