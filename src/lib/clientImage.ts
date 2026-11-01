/**
 * Client image vocabulary shared by the frontend and the backend.
 *
 * Deliberately dependency-free: the Loan section, the client profile and the
 * approvals screen all import these strings, so the exact wording the backend
 * throws is the exact wording the UI shows.
 */

/** How a client image was obtained — stored on every capture row. */
export const CLIENT_IMAGE_METHODS = ["PHOTO_UPLOAD", "GEO_TAGGING"] as const;
export type ClientImageMethod = (typeof CLIENT_IMAGE_METHODS)[number];

export const CLIENT_IMAGE_METHOD_LABELS: Record<ClientImageMethod, string> = {
  PHOTO_UPLOAD: "Photo Upload",
  GEO_TAGGING: "Geo Tagging",
};

/** The exact message shown when a client has no valid saved image. */
export const CLIENT_IMAGE_REQUIRED_MESSAGE =
  "Client Geo-Tagging Image Not Available. Please upload the client photo or complete Geo Tagging before proceeding with the loan.";

/** Shape returned by `clients.imageStatus`. */
export type ClientImageState = {
  /** True only when a valid, still-accessible image belongs to this client. */
  available: boolean;
  /** Why it is unavailable — null when available. */
  reason: string | null;
  /** Short-lived signed URL (never a public link). */
  url: string | null;
  captureMethod: ClientImageMethod | null;
  captureMethodLabel: string | null;
  /** GPS is reported ONLY when it was genuinely captured with the photo. */
  hasGeo: boolean;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  capturedAt: number | null;
  uploadedAt: number | null;
};
