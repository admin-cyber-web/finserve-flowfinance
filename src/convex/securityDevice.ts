/**
 * Cryptographic device enrollment + verification.
 *
 * These are the only unauthenticated security mutations, and they grant
 * nothing by themselves:
 *
 *   deviceChallenge  → server issues a single-use random challenge
 *   completeEnrollment → verifies an ECDSA P-256 signature proving possession
 *                        of the private key, then records a PENDING device
 *   verifyDevice      → verifies the signature again on every sign-in and, only
 *                        for an AUTHORIZED device, returns a short-lived
 *                        single-use proof that the KMC sign-in must consume
 *
 * A copied device id / localStorage blob is useless without the non-exportable
 * private key, and every challenge is burned on use.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { AppError, makeCode } from "../lib/server/convexHelpers";
import { appendSecurityAudit } from "../lib/server/securityAudit";
import {
  CHALLENGE_TTL_MS,
  ENROLLMENT_RE,
  ENROLL_WINDOW_LIMIT,
  ENROLL_WINDOW_MS,
  PROOF_TTL_MS,
  SIGNATURE_RE,
  browserFromUserAgent,
  categoryForUserAgent,
  deviceByEnrollment,
  logDeviceEvent,
  newEnrollmentId,
} from "../lib/server/securityDevice";
import { randomHex, sha256Hex } from "../lib/server/securityCrypto";

type Ctx = { db: MutationCtx["db"] };

/* --------------------------- key / signature utils ------------------------ */

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 → bytes without relying on atob (not provided by the V8 runtime). */
function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const index = B64_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Signature is not valid base64.");
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Validate the shape of an exported P-256 public JWK. */
function parsePublicJwk(raw: string): JsonWebKey {
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(raw) as JsonWebKey;
  } catch {
    throw new AppError("Device public key is not valid JSON.");
  }
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string" ||
    jwk.x.length < 40 ||
    jwk.y.length < 40 ||
    jwk.d !== undefined
  ) {
    throw new AppError("Device public key must be an ECDSA P-256 public key.");
  }
  return jwk;
}

/** Verify an ECDSA P-256 / SHA-256 signature over the challenge string. */
async function verifySignature(
  publicKeyJwk: string,
  challenge: string,
  signature: string,
): Promise<boolean> {
  try {
    const jwk = parsePublicJwk(publicKeyJwk);
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const bytes = decodeBase64(signature);
    if (bytes.length < 60 || bytes.length > 80) return false;
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      bytes as unknown as BufferSource,
      new TextEncoder().encode(challenge) as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

/* ------------------------------- challenges ------------------------------- */

async function issueChallenge(
  ctx: MutationCtx,
  args: {
    purpose: "ENROLL" | "VERIFY";
    enrollmentId?: string;
    deviceKey?: string;
    staffId?: string;
    profileId?: Doc<"profiles">["_id"];
    publicKeyJwk?: string;
  },
): Promise<{ ref: string; challenge: string; expiresAt: number }> {
  const challenge = randomHex(32);
  const ref = await makeCode(ctx, "securityChallenge", "CHL", 6);
  const now = Date.now();
  const expiresAt = now + CHALLENGE_TTL_MS;
  await ctx.db.insert("securityDeviceChallenges", {
    ref,
    purpose: args.purpose,
    challenge,
    challengeHash: await sha256Hex(challenge),
    enrollmentId: args.enrollmentId,
    deviceKey: args.deviceKey,
    staffId: args.staffId,
    profileId: args.profileId,
    publicKeyJwk: args.publicKeyJwk,
    issuedAt: now,
    expiresAt,
  });
  return { ref, challenge, expiresAt };
}

async function challengeByRef(ctx: Ctx, ref: string) {
  const row = await ctx.db
    .query("securityDeviceChallenges")
    .withIndex("by_ref", (q) => q.eq("ref", ref))
    .first();
  if (!row) throw new AppError("Device challenge not found. Try again.");
  if (row.usedAt) throw new AppError("This device challenge was already used.");
  if (row.expiresAt <= Date.now()) {
    throw new AppError("This device challenge expired. Try again.");
  }
  return row;
}

/**
 * Issue a challenge. Enrollment additionally requires a staff ID (or the email
 * registered to the staff account) and the exported public key.
 */
export const deviceChallenge = mutation({
  args: {
    purpose: v.string(), // ENROLL | VERIFY
    enrollmentId: v.optional(v.string()),
    staffId: v.optional(v.string()),
    staffEmail: v.optional(v.string()),
    publicKeyJwk: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const purpose = args.purpose === "ENROLL" ? "ENROLL" : args.purpose === "VERIFY" ? "VERIFY" : null;
    if (!purpose) throw new AppError("Unknown device challenge purpose.");

    if (purpose === "VERIFY") {
      const enrollmentId = (args.enrollmentId ?? "").trim();
      if (!ENROLLMENT_RE.test(enrollmentId)) {
        throw new AppError("Device enrollment id is not valid.");
      }
      const device = await deviceByEnrollment(ctx, enrollmentId);
      if (!device) {
        return { ok: false as const, reason: "unknown-device" as const };
      }
      const issued = await issueChallenge(ctx, {
        purpose,
        enrollmentId,
        deviceKey: device.deviceKey,
        staffId: device.staffId,
        profileId: device.profileId,
      });
      return {
        ok: true as const,
        ...issued,
        status: device.status,
        enrolledStaffId: device.staffId ?? null,
      };
    }

    const publicKeyJwk = args.publicKeyJwk ?? "";
    parsePublicJwk(publicKeyJwk);

    const staffId = (args.staffId ?? "").trim().toUpperCase();
    const staffEmail = (args.staffEmail ?? "").trim().toLowerCase();
    if (!staffId && !staffEmail) {
      throw new AppError("Enter your Staff ID before enrolling this device.");
    }
    const profiles = await ctx.db.query("profiles").collect();
    const profile = profiles.find((p) =>
      staffId
        ? p.staffId === staffId ||
          (p.legacyStaffIds ?? []).includes(staffId)
        : p.email?.toLowerCase() === staffEmail,
    );
    if (!profile || profile.role === "CLIENT") {
      throw new AppError("No staff account matches that Staff ID.");
    }
    if (profile.status !== "ACTIVE") {
      throw new AppError(`This staff account is ${profile.status.toLowerCase()}.`);
    }

    // Enrollment is intentionally rate limited per staff ID.
    const since = Date.now() - ENROLL_WINDOW_MS;
    const recent = await ctx.db
      .query("securityDeviceChallenges")
      .withIndex("by_staff", (q) => q.eq("staffId", profile.staffId))
      .collect();
    if (recent.filter((r) => r.purpose === "ENROLL" && r.issuedAt >= since).length >= ENROLL_WINDOW_LIMIT) {
      throw new AppError(
        "Too many device enrollment attempts for this Staff ID. Try again later.",
      );
    }

    const issued = await issueChallenge(ctx, {
      purpose,
      staffId: profile.staffId,
      profileId: profile._id,
      publicKeyJwk,
    });
    return {
      ok: true as const,
      ...issued,
      status: "ENROLLING" as const,
      enrolledStaffId: profile.staffId,
    };
  },
});

/* ------------------------------- enrollment ------------------------------- */

/**
 * Complete enrollment: verify the key actually signed the challenge, then
 * record the device as PENDING. It can never authorize itself.
 */
export const completeEnrollment = mutation({
  args: {
    challengeRef: v.string(),
    signature: v.string(),
    label: v.string(),
    platform: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    browser: v.optional(v.string()),
    browserVersion: v.optional(v.string()),
    os: v.optional(v.string()),
    category: v.optional(v.string()),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!SIGNATURE_RE.test(args.signature)) {
      throw new AppError("Device signature is malformed.");
    }
    const challenge = await challengeByRef(ctx, args.challengeRef);
    if (challenge.purpose !== "ENROLL" || !challenge.publicKeyJwk || !challenge.profileId) {
      throw new AppError("This challenge is not an enrollment challenge.");
    }
    const profile = await ctx.db.get(challenge.profileId);
    if (!profile) throw new AppError("The staff account no longer exists.");

    const signatureOk = await verifySignature(
      challenge.publicKeyJwk,
      challenge.challenge,
      args.signature,
    );
    if (!signatureOk) {
      await ctx.db.patch(challenge._id, { usedAt: Date.now() });
      await logDeviceEvent(ctx, {
        kind: "DEVICE_SIGNATURE_FAILED",
        deviceKey: challenge.staffId ?? "unknown",
        profileId: profile._id,
        staffId: profile.staffId,
        staffName: profile.name,
        ip: args.ip,
        userAgent: args.userAgent,
        detail: "Enrollment signature did not verify — device not registered",
        actor: "STAFF",
      });
      throw new AppError("Device signature verification failed. The device was not enrolled.");
    }

    const publicKeyFingerprint = await sha256Hex(challenge.publicKeyJwk);
    const now = Date.now();
    const ua = args.userAgent ?? "";
    const parsed = browserFromUserAgent(ua);

    // Same key already enrolled for this staff ID (e.g. local enrollment
    // metadata lost but the IndexedDB key survived): return the existing row
    // instead of creating a duplicate. It still cannot sign in unless it is
    // AUTHORIZED.
    const siblings = await ctx.db
      .query("securityDevices")
      .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
      .collect();
    const existing = siblings.find(
      (d) => d.publicKeyFingerprint === publicKeyFingerprint && d.status !== "REVOKED",
    );
    if (existing?.enrollmentId) {
      await ctx.db.patch(challenge._id, { usedAt: now });
      await ctx.db.patch(existing._id, {
        lastSeenAt: now,
        ip: args.ip,
        userAgent: args.userAgent || existing.userAgent,
        browser: args.browser ?? parsed.browser,
        browserVersion: args.browserVersion ?? parsed.browserVersion,
        os: args.os ?? parsed.os,
        category: args.category ?? categoryForUserAgent(ua),
      });
      return {
        ok: true as const,
        enrollmentId: existing.enrollmentId,
        status: existing.status,
        message: "This device key is already enrolled.",
      };
    }

    const enrollmentId = newEnrollmentId();
    const deviceKey = await sha256Hex(`${profile._id}:${enrollmentId}`);
    const eventRef = await makeCode(ctx, "securityEvent", "EVT", 6);

    await ctx.db.insert("securityDevices", {
      profileId: profile._id,
      staffId: profile.staffId,
      staffName: profile.name,
      role: profile.role,
      fingerprint: publicKeyFingerprint,
      deviceKey,
      enrollmentId,
      publicKeyJwk: challenge.publicKeyJwk,
      publicKeyFingerprint,
      browser: args.browser ?? parsed.browser,
      browserVersion: args.browserVersion ?? parsed.browserVersion,
      os: args.os ?? parsed.os,
      category: args.category ?? categoryForUserAgent(ua),
      reportedInfo: true,
      label: args.label.slice(0, 80) || "Unnamed device",
      platform: args.platform,
      userAgent: args.userAgent,
      status: "PENDING",
      source: "REGISTRATION",
      requestedAt: now,
      lastSeenAt: now,
      enrolledAt: now,
      ip: args.ip,
      eventRef,
    });

    await ctx.db.insert("securityDeviceEvents", {
      ref: eventRef,
      kind: "DEVICE_ENROLLED",
      deviceKey,
      profileId: profile._id,
      staffId: profile.staffId,
      staffName: profile.name,
      ip: args.ip,
      userAgent: args.userAgent,
      detail: `Cryptographic enrollment ${enrollmentId} — awaiting Security Department approval`,
      actor: "STAFF",
      at: now,
    });

    await appendSecurityAudit(ctx, {
      operatorId: `STAFF:${profile.staffId}`,
      operatorName: profile.name,
      action: "DEVICE_ENROLLED",
      targetType: "securityDevice",
      targetId: enrollmentId,
      previousState: "",
      newState: JSON.stringify({ status: "PENDING", category: args.category ?? categoryForUserAgent(ua) }),
      reason: "Cryptographic device enrollment with signed challenge",
      eventRef,
      ip: args.ip,
    });

    await ctx.db.patch(challenge._id, { usedAt: now });
    return {
      ok: true as const,
      enrollmentId,
      status: "PENDING" as const,
      message:
        "Device enrolled. A Security Operator must approve it before this device can sign in.",
    };
  },
});

/* ------------------------------ verification ------------------------------ */

/**
 * Verify a registered device: signature over the fresh challenge + status
 * check. Only an AUTHORIZED device receives a proof.
 */
export const verifyDevice = mutation({
  args: {
    challengeRef: v.string(),
    signature: v.string(),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!SIGNATURE_RE.test(args.signature)) {
      throw new AppError("Device signature is malformed.");
    }
    const challenge = await challengeByRef(ctx, args.challengeRef);
    if (challenge.purpose !== "VERIFY" || !challenge.enrollmentId) {
      throw new AppError("This challenge is not a device verification challenge.");
    }
    const device = await deviceByEnrollment(ctx, challenge.enrollmentId);
    if (!device) {
      await ctx.db.patch(challenge._id, { usedAt: Date.now() });
      return { status: "UNKNOWN" as const, message: "This device is not enrolled." };
    }
    if (!device.publicKeyJwk || !device.deviceKey) {
      await ctx.db.patch(challenge._id, { usedAt: Date.now() });
      return {
        status: "UNVERIFIED" as const,
        message: "This device has no cryptographic key on record. Re-enroll it.",
      };
    }

    const signatureOk = await verifySignature(
      device.publicKeyJwk,
      challenge.challenge,
      args.signature,
    );
    await ctx.db.patch(challenge._id, { usedAt: Date.now() });

    if (!signatureOk) {
      await logDeviceEvent(ctx, {
        kind: "DEVICE_SIGNATURE_FAILED",
        deviceKey: device.deviceKey,
        enrollmentId: device.enrollmentId,
        profileId: device.profileId,
        staffId: device.staffId,
        staffName: device.staffName,
        ip: args.ip,
        userAgent: args.userAgent,
        detail: "Device signature did not verify — access denied",
        actor: "STAFF",
      });
      return {
        status: "INVALID_SIGNATURE" as const,
        message: "Device signature verification failed.",
      };
    }

    if (device.status !== "AUTHORIZED") {
      await logDeviceEvent(ctx, {
        kind: "UNAUTHORIZED_ATTEMPT",
        deviceKey: device.deviceKey,
        enrollmentId: device.enrollmentId,
        profileId: device.profileId,
        staffId: device.staffId,
        staffName: device.staffName,
        ip: args.ip,
        userAgent: args.userAgent,
        detail: `Verified device is ${device.status.toLowerCase()} — access denied`,
        actor: "STAFF",
      });
      return {
        status: device.status,
        message:
          device.status === "PENDING"
            ? "This device is awaiting Security Department approval."
            : device.status === "BLOCKED"
              ? "This device is blocked by the Security Department."
              : device.status === "REJECTED"
                ? "The Security Department rejected this device."
                : "This device's authorization was revoked by the Security Department.",
      };
    }

    const now = Date.now();
    const proof = randomHex(32);
    await ctx.db.insert("securityDeviceProofs", {
      tokenHash: await sha256Hex(proof),
      enrollmentId: device.enrollmentId!,
      deviceKey: device.deviceKey,
      profileId: device.profileId,
      staffId: device.staffId ?? "",
      issuedAt: now,
      expiresAt: now + PROOF_TTL_MS,
      ip: args.ip,
    });
    await ctx.db.patch(device._id, {
      lastSeenAt: now,
      lastVerifiedAt: now,
      ip: args.ip ?? device.ip,
      userAgent: args.userAgent ?? device.userAgent,
    });
    return {
      status: "AUTHORIZED" as const,
      proof,
      enrollmentId: device.enrollmentId,
      expiresAt: now + PROOF_TTL_MS,
      message: "Device verified.",
    };
  },
});

/* -------------------------------- read side ------------------------------- */

/** Status for the browser's own enrollment chip (no secrets, no keys). */
export const deviceEnrollmentStatus = query({
  args: { enrollmentId: v.string() },
  handler: async (ctx, args) => {
    if (!ENROLLMENT_RE.test(args.enrollmentId)) return null;
    const device = await deviceByEnrollment(ctx, args.enrollmentId);
    if (!device) return null;
    return {
      enrollmentId: device.enrollmentId,
      staffId: device.staffId ?? null,
      label: device.label,
      status: device.status,
      category: device.category ?? null,
      lastVerifiedAt: device.lastVerifiedAt ?? null,
      decidedAt: device.decidedAt ?? null,
      reason: device.reason ?? null,
      publicKeyFingerprint: device.publicKeyFingerprint ?? null,
    };
  },
});

