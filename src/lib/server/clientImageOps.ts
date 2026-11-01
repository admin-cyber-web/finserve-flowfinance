/**
 * Client image (photo / geo-tagging) rules shared by the API layer.
 *
 * ONE definition of "does this client have a valid saved image?" is used by
 *   • the client profile / loan screens (read), and
 *   • every loan mutation that must block without it (create, approve,
 *     disburse) — the backend is the actual enforcement point, never the UI.
 *
 * The answer is always derived from the SAVED backend record: the
 * `clientGeoPhotos` row for that exact client plus the storage document it
 * points at. A frontend flag (imageAvailable=true) is never trusted, and a
 * temporary upload that was never attached to the client never counts.
 */
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { Ctx, Mtx } from "./convexHelpers";
import { AppError } from "./convexHelpers";
import {
  MAX_CLIENT_PHOTO_BYTES,
  geoValidationError,
  isPlausibleFix,
  type GeoFix,
} from "../geo";
import {
  CLIENT_IMAGE_METHOD_LABELS,
  CLIENT_IMAGE_METHODS,
  CLIENT_IMAGE_REQUIRED_MESSAGE,
  type ClientImageMethod,
  type ClientImageState,
} from "../clientImage";

export {
  CLIENT_IMAGE_METHOD_LABELS,
  CLIENT_IMAGE_METHODS,
  CLIENT_IMAGE_REQUIRED_MESSAGE,
  type ClientImageMethod,
  type ClientImageState,
};

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const EMPTY: ClientImageState = {
  available: false,
  reason: "No client photo has been saved yet.",
  url: null,
  captureMethod: null,
  captureMethodLabel: null,
  hasGeo: false,
  latitude: null,
  longitude: null,
  accuracyMeters: null,
  capturedAt: null,
  uploadedAt: null,
};

/** Legacy rows predate `captureMethod` but always carry coordinates. */
export function imageMethodOf(row: {
  captureMethod?: string;
  latitude?: number;
}): ClientImageMethod {
  if (row.captureMethod === "PHOTO_UPLOAD") return "PHOTO_UPLOAD";
  if (row.captureMethod === "GEO_TAGGING") return "GEO_TAGGING";
  return row.latitude !== undefined ? "GEO_TAGGING" : "PHOTO_UPLOAD";
}

/** Latest APPLICANT image row (co-applicant captures never count). */
export async function latestClientImageRow(
  ctx: Ctx,
  clientId: Id<"clients">,
): Promise<Doc<"clientGeoPhotos"> | null> {
  const rows = await ctx.db
    .query("clientGeoPhotos")
    .withIndex("by_client", (q) => q.eq("clientId", clientId))
    .order("desc")
    .collect();
  return rows.find((r) => !r.coApplicant) ?? null;
}

/**
 * Actual saved-image status for a client.
 *
 * A row only counts when
 *   1. it belongs to THIS client (queried by clientId — never by code/name),
 *   2. its storage document still exists with an image content type and a
 *      non-zero size, and
 *   3. Convex storage can still mint a URL for it (i.e. it is accessible).
 * A GEO_TAGGING capture must additionally carry a plausible real fix, so a
 * geo capture that lost its coordinates can never pass as available.
 */
export async function clientImageState(
  ctx: Ctx,
  clientId: Id<"clients">,
): Promise<ClientImageState> {
  const row = await latestClientImageRow(ctx, clientId);
  if (!row) return EMPTY;

  const captureMethod = imageMethodOf(row);
  const base: ClientImageState = {
    ...EMPTY,
    captureMethod,
    captureMethodLabel: CLIENT_IMAGE_METHOD_LABELS[captureMethod],
    uploadedAt: row.uploadedAt,
    capturedAt: row.capturedAt ?? null,
  };

  const meta = await ctx.db.system.get("_storage", row.storageId);
  if (!meta) {
    return {
      ...base,
      reason:
        "The saved image file is no longer available. Please upload the photo or complete Geo Tagging again.",
    };
  }
  if (!meta.contentType || !ALLOWED_IMAGE_TYPES.includes(meta.contentType)) {
    return {
      ...base,
      reason:
        "The saved image is not a valid JPEG/PNG/WebP file. Please upload it again.",
    };
  }
  if (meta.size <= 0 || meta.size > MAX_CLIENT_PHOTO_BYTES) {
    return {
      ...base,
      reason: "The saved image has an invalid size. Please upload it again.",
    };
  }

  const url = await ctx.storage.getUrl(row.storageId);
  if (!url) {
    return {
      ...base,
      reason:
        "The saved image could not be opened. Please upload the photo or complete Geo Tagging again.",
    };
  }

  const hasGeo =
    captureMethod === "GEO_TAGGING" &&
    row.latitude !== undefined &&
    row.longitude !== undefined &&
    row.accuracyMeters !== undefined &&
    row.capturedAt !== undefined &&
    isPlausibleFix({
      latitude: row.latitude,
      longitude: row.longitude,
      accuracyMeters: row.accuracyMeters,
      capturedAt: row.capturedAt,
    });

  if (captureMethod === "GEO_TAGGING" && !hasGeo) {
    return {
      ...base,
      url,
      reason:
        "The Geo Tagging capture has no valid GPS fix. Please complete Geo Tagging again.",
    };
  }

  return {
    ...base,
    available: true,
    reason: null,
    url,
    hasGeo,
    latitude: hasGeo ? (row.latitude ?? null) : null,
    longitude: hasGeo ? (row.longitude ?? null) : null,
    accuracyMeters: hasGeo ? (row.accuracyMeters ?? null) : null,
    capturedAt: hasGeo ? (row.capturedAt ?? null) : null,
  };
}

/** Cheap boolean form for list/approval screens. */
export async function isClientImageAvailable(
  ctx: Ctx,
  clientId: Id<"clients">,
): Promise<boolean> {
  return (await clientImageState(ctx, clientId)).available;
}

/**
 * Server-side gate used by loan creation, approval and disbursement.
 *
 * Throws the ONE canonical error message, so the frontend can render it
 * verbatim without the backend ever leaking a different wording.
 */
export async function assertClientImageAvailable(
  ctx: Ctx,
  clientId: Id<"clients">,
): Promise<void> {
  const state = await clientImageState(ctx, clientId);
  if (!state.available) throw new AppError(CLIENT_IMAGE_REQUIRED_MESSAGE);
}

/**
 * Validate an uploaded image (and its GPS fix, for Geo Tagging) and build the
 * `clientGeoPhotos` row for it.
 *
 * The file was uploaded to private storage before the mutation ran; every
 * rejection path deletes it again so a refused capture never leaves an
 * orphaned file behind. A manually uploaded photo NEVER stores coordinates.
 */
export async function prepareClientImageRow(
  ctx: Mtx,
  args: {
    clientId: Id<"clients">;
    code: string;
    storageId: Id<"_storage">;
    method: ClientImageMethod;
    geo?: GeoFix | null;
    /** Photo frame time — kept separate from the GPS fix time. */
    photoCapturedAt?: number;
    uploadedBy: Id<"profiles">;
    branchId: Id<"branches">;
    device?: string;
    now: number;
    /** Marks a co-applicant capture (never surfaced as the client image). */
    coApplicant?: boolean;
  },
): Promise<Omit<Doc<"clientGeoPhotos">, "_id" | "_creationTime">> {
  const { method, geo } = args;

  const reject = async (message: string): Promise<never> => {
    await ctx.storage.delete(args.storageId);
    throw new AppError(message);
  };

  if (method === "GEO_TAGGING" && !geo) {
    return reject(
      "Client photo location is missing — capture the photo again with GPS on.",
    );
  }

  if (method === "GEO_TAGGING" && geo) {
    const geoError = geoValidationError(geo, args.now);
    if (geoError) {
      return reject(`Client photo location rejected: ${geoError}`);
    }
  }

  const meta = await ctx.db.system.get("_storage", args.storageId);
  if (!meta) {
    throw new AppError(
      "Uploaded client photo not found — capture and upload it again.",
    );
  }

  // A storage file may belong to exactly ONE client. Re-using a reference that
  // is already saved against another client (or the same client's earlier
  // capture) is refused, so one client's photograph can never be presented as
  // another client's image.
  const allRows = await ctx.db.query("clientGeoPhotos").collect();
  const reused = allRows.find(
    (r) => r.storageId === args.storageId && r.clientId !== args.clientId,
  );
  if (reused) {
    return reject(
      "This photo is already saved for another client — upload a different image.",
    );
  }

  if (!meta.contentType || !ALLOWED_IMAGE_TYPES.includes(meta.contentType)) {
    return reject("Client photo must be a JPEG, PNG or WebP image.");
  }
  if (meta.size <= 0 || meta.size > MAX_CLIENT_PHOTO_BYTES) {
    return reject(
      `Client photo must be between 1 byte and ${Math.round(MAX_CLIENT_PHOTO_BYTES / 1024 / 1024)} MB.`,
    );
  }

  const geoTagged =
    method === "GEO_TAGGING" && geo !== null && geo !== undefined;

  return {
    clientId: args.clientId,
    storageId: args.storageId,
    fileName: `${args.coApplicant ? "co-applicant" : "client"}-photo-${args.code}.jpg`,
    sizeBytes: meta.size,
    mimeType: meta.contentType,
    captureMethod: method,
    // Coordinates exist ONLY for a genuine Geo Tagging capture.
    latitude: geoTagged ? geo!.latitude : undefined,
    longitude: geoTagged ? geo!.longitude : undefined,
    accuracyMeters: geoTagged
      ? Math.round(geo!.accuracyMeters * 100) / 100
      : undefined,
    capturedAt: geoTagged ? geo!.capturedAt : undefined,
    photoCapturedAt: geoTagged
      ? (args.photoCapturedAt ?? geo!.capturedAt)
      : undefined,
    uploadedAt: args.now,
    uploadedBy: args.uploadedBy,
    branchId: args.branchId,
    permissionStatus: geoTagged ? (geo!.permissionStatus ?? "granted") : undefined,
    device: args.device,
    status: geoTagged ? "GEO_TAGGED" : "PHOTO_UPLOADED",
    coApplicant: args.coApplicant ? true : undefined,
  };
}
