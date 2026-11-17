/**
 * Shared server helpers for cryptographic device authorization.
 *
 * A device is identified by a WebCrypto ECDSA (P-256) key pair generated in the
 * browser. The private key never leaves the device (it is non-exportable and
 * stored in IndexedDB); the Security Department stores only the public JWK.
 *
 * Nothing here trusts a client-supplied device id on its own: authorization is
 * always "prove possession of the enrolled private key over a fresh server
 * challenge", then check the device row's status.
 */
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { makeCode } from "./convexHelpers";
import { sha256Hex } from "./securityCrypto";

export type DeviceCtx = QueryCtx | MutationCtx;

/** A challenge is usable once, for five minutes. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** The proof handed to the sign-in mutation is even shorter-lived. */
export const PROOF_TTL_MS = 3 * 60 * 1000;
/** Bounded number of enrollments a staff ID may request per window. */
export const ENROLL_WINDOW_MS = 15 * 60 * 1000;
export const ENROLL_WINDOW_LIMIT = 6;

export const ENROLLMENT_RE = /^DEV-[A-Z0-9]{10}$/;
export const DEVICE_KEY_RE = /^[a-f0-9]{64}$/;
export const SIGNATURE_RE = /^[A-Za-z0-9+/=]{40,200}$/;

/** Server-generated enrollment id — never accepted from the client. */
export function newEnrollmentId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return `DEV-${out}`;
}

/**
 * Device category from the browser's user-agent. This is REPORTED information,
 * not verified hardware identity — the portal labels it that way.
 */
export function categoryForUserAgent(userAgent: string): string {
  const ua = userAgent || "";
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return "Tablet";
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "Mobile";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Laptop";
  return "Desktop";
}

export function browserFromUserAgent(userAgent: string): {
  browser: string;
  browserVersion: string;
  os: string;
} {
  const ua = userAgent || "";
  const version = (re: RegExp) => re.exec(ua)?.[1] ?? "";
  if (/Edg\//.test(ua)) {
    return { browser: "Edge", browserVersion: version(/Edg\/([\d.]+)/), os: osFrom(ua) };
  }
  if (/OPR\//.test(ua)) {
    return { browser: "Opera", browserVersion: version(/OPR\/([\d.]+)/), os: osFrom(ua) };
  }
  if (/Chrome\//.test(ua)) {
    return {
      browser: "Chrome",
      browserVersion: version(/Chrome\/([\d.]+)/),
      os: osFrom(ua),
    };
  }
  if (/Firefox\//.test(ua)) {
    return {
      browser: "Firefox",
      browserVersion: version(/Firefox\/([\d.]+)/),
      os: osFrom(ua),
    };
  }
  if (/Safari\//.test(ua)) {
    return {
      browser: "Safari",
      browserVersion: version(/Version\/([\d.]+)/),
      os: osFrom(ua),
    };
  }
  return { browser: "Browser", browserVersion: "", os: osFrom(ua) };
}

function osFrom(ua: string): string {
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown";
}

/** Append one device-history row (independent of the security audit chain). */
export async function logDeviceEvent(
  ctx: MutationCtx,
  entry: {
    kind: string;
    deviceKey: string;
    enrollmentId?: string;
    profileId?: Id<"profiles">;
    staffId?: string;
    staffName: string;
    ip?: string;
    userAgent?: string;
    detail: string;
    actor: string;
  },
): Promise<string> {
  const ref = await makeCode(ctx, "securityEvent", "EVT", 6);
  await ctx.db.insert("securityDeviceEvents", {
    ref,
    kind: entry.kind,
    deviceKey: entry.deviceKey,
    profileId: entry.profileId,
    staffId: entry.staffId,
    staffName: entry.staffName,
    ip: entry.ip,
    userAgent: entry.userAgent,
    detail:
      entry.enrollmentId && !entry.detail.includes(entry.enrollmentId)
        ? `${entry.detail} · ${entry.enrollmentId}`
        : entry.detail,
    actor: entry.actor,
    at: Date.now(),
  });
  return ref;
}

export async function deviceByEnrollment(
  ctx: DeviceCtx,
  enrollmentId: string,
): Promise<Doc<"securityDevices"> | null> {
  const row = await ctx.db
    .query("securityDevices")
    .withIndex("by_enrollment", (q) => q.eq("enrollmentId", enrollmentId))
    .first();
  return row ?? null;
}

export interface ConsumeProofResult {
  ok: boolean;
  reason?: string;
  device?: Doc<"securityDevices">;
}

/**
 * Consume the single-use device proof handed to the sign-in mutation.
 *
 * The proof is bound to (device, profile) and expires in three minutes. It is
 * marked used in the same transaction that creates the KMC session, so a
 * copied proof cannot be replayed — and a copied device id without the private
 * key never produces a proof in the first place.
 */
export async function consumeDeviceProof(
  ctx: MutationCtx,
  args: {
    proof: string | undefined;
    enrollmentId: string | undefined;
    profile: Doc<"profiles">;
  },
): Promise<ConsumeProofResult> {
  const proof = (args.proof ?? "").trim();
  const enrollmentId = (args.enrollmentId ?? "").trim();
  if (!proof || !enrollmentId) {
    return { ok: false, reason: "device-proof-missing" };
  }
  if (!/^[a-f0-9]{64}$/.test(proof) || !ENROLLMENT_RE.test(enrollmentId)) {
    return { ok: false, reason: "device-proof-invalid" };
  }

  const tokenHash = await sha256Hex(proof);
  const row = await ctx.db
    .query("securityDeviceProofs")
    .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
    .first();
  if (!row) return { ok: false, reason: "device-proof-unknown" };
  if (row.usedAt) return { ok: false, reason: "device-proof-replayed" };
  if (row.expiresAt <= Date.now()) {
    return { ok: false, reason: "device-proof-expired" };
  }
  if (row.enrollmentId !== enrollmentId || row.profileId !== args.profile._id) {
    return { ok: false, reason: "device-proof-mismatch" };
  }

  const device = await deviceByEnrollment(ctx, enrollmentId);
  if (!device || device.profileId !== args.profile._id) {
    return { ok: false, reason: "device-unknown" };
  }
  if (device.status !== "AUTHORIZED") {
    return { ok: false, reason: `device-${device.status.toLowerCase()}` };
  }

  await ctx.db.patch(row._id, { usedAt: Date.now() });
  await ctx.db.patch(device._id, {
    lastSeenAt: Date.now(),
    lastVerifiedAt: Date.now(),
  });
  return { ok: true, device };
}

/** Human-readable refusal for the sign-in screen. */
export function proofFailureMessage(reason: string | undefined): string {
  switch (reason) {
    case "device-proof-missing":
    case "device-proof-unknown":
      return "Device authorization is required. This browser must be enrolled and approved by the Security Department before signing in.";
    case "device-proof-replayed":
      return "That device verification was already used. Verify the device again.";
    case "device-proof-expired":
      return "Device verification expired. Verify the device again.";
    case "device-proof-mismatch":
    case "device-unknown":
      return "This device is not enrolled for this staff ID. Enroll it and wait for Security Department approval.";
    case "device-pending":
      return "This device is awaiting Security Department approval.";
    case "device-blocked":
      return "This device is blocked by the Security Department.";
    case "device-revoked":
    case "device-replaced":
      return "This device's authorization was revoked by the Security Department.";
    case "device-rejected":
      return "The Security Department rejected this device.";
    default:
      return "Device authorization failed. Contact the Security Department.";
  }
}
