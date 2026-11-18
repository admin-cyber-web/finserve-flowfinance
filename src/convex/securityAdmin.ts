/** KAM IMC — SUPER_ADMIN Device Management + Registration Links (backend)

 * Authorized KMC staff path (separate from the independent Security Operator
 * portal).  The caller must be a signed-in SUPER_ADMIN; the independent
 * Security Department keeps its own operator sessions and its own authority
 * (security.ts / securityDevice.ts are never touched by this module).
 *
 * This module reuses the SAME device rows (`securityDevices`) that the
 * Security Department approves, blocks and revokes, so a SUPER_ADMIN action
 * and a Security Operator action both move one source of truth.  The actor
 * recorded for audit is the SUPER_ADMIN staff identity, never a Security
 * Operator token.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  AppError,
  requireProfile,
  requirePermission,
  makeCode,
  revokeUserSessions,
  logAudit,
} from "../lib/server/convexHelpers";
import {
  appendSecurityAudit as appendAudit,
  type SecurityAuditEntry,
} from "../lib/server/securityAudit";
import {
  sha256Hex,
  randomHex,
  auditHash,
  auditPayload,
} from "../lib/server/securityCrypto";
import { hasSuperAdminGrant } from "../lib/finance/permissions";

/* ------------------------------- helpers --------------------------------- */

const SINGLETON = "kmc-security";
const LINK_BYTES = 32;
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days default

/** Build the public portal URL for a registration link.
 *
 * Mutations cannot read deployment env directly through `ctx.params`, so derive
 * the portal host from the site URL the browser would use.  If the site URL is
 * unavailable this link shape will still be valid for the dashboard copy.
 */
function portalLink(host: string | undefined, token: string): string {
  const base = host ?? "";
  const portalHost = base
    .replace(/\.convex\.cloud\/?$/, ".convex.site")
    .replace(/\/$/, "");
  return `${portalHost}/security/register/${token}`;
}

function readConfig(ctx: any) {
  return ctx.db
    .query("securityConfig")
    .withIndex("by_singleton", (q: any) => q.eq("singleton", SINGLETON))
    .unique();
}

async function latestAuditHash(ctx: any): Promise<string> {
  const last = await ctx.db
    .query("securityAudit")
    .withIndex("by_seq")
    .order("desc")
    .first();
  return last?.hash ?? "GENESIS";
}

/** SUPER_ADMIN-only backstop. */
async function requireSuperAdmin(ctx: any): Promise<Doc<"profiles">> {
  const profile = await requireProfile(ctx);
  if (!hasSuperAdminGrant(profile)) {
    throw new AppError("Only SUPER_ADMIN can perform this action.");
  }
  return profile;
}

/** Convenience: one author entry used by several mutations below. */
async function appendAuditEntry(
  ctx: any,
  actor: Doc<"profiles">,
  entry: Omit<SecurityAuditEntry, "operatorId" | "operatorName">,
): Promise<{ ref: string; at: number }> {
  return appendAudit(ctx, {
    ...entry,
    operatorId: actor.staffId ?? actor._id,
    operatorName: actor.name,
  });
}

/** Resolve the staff user id for session revocation, since device rows
 *  reference a profile, but session revocation keys against the user. */
async function userIdForProfile(ctx: any, profileId: Id<"profiles">): Promise<Id<"users"> | null> {
  const profile = await ctx.db.get(profileId);
  return profile?.userId ?? null;
}

/* --------------------------- registration links --------------------------- */

export const generateRegistrationLink = mutation({
  args: {
    staffId: v.string(),
    deviceLabel: v.string(),
    deviceType: v.optional(v.string()),
    immediateApproval: v.optional(v.boolean()),
    expiresInHours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);

    const trimmedStaffId = args.staffId.trim().toUpperCase();
    if (!trimmedStaffId) throw new AppError("A staff ID is required.");

    // Resolve the intended staff account server-side (never trust the name
    // or role sent from the browser).
    const profiles = await ctx.db.query("profiles").collect();
    const profile = profiles.find(
      (p: any) =>
        p.role !== "CLIENT" &&
        (p.staffId === trimmedStaffId ||
          (p.legacyStaffIds ?? []).includes(trimmedStaffId)),
    );
    if (!profile) throw new AppError("No active staff account matches that Staff ID.");
    if (profile.status !== "ACTIVE") {
      throw new AppError(`That staff account is ${profile.status.toLowerCase()}.`);
    }

    const expiresAt = Date.now() +
      Math.max(1, Math.min(720, args.expiresInHours ?? 168)) * 3600 * 1000;

    const token = randomHex(LINK_BYTES);
    const tokenHash = await sha256Hex(`reg-link:${token}`);

    const linkId = await ctx.db.insert("securityRegistrationLinks", {
      token,
      profileId: profile._id,
      staffId: profile.staffId,
      staffName: profile.name,
      role: profile.role,
      branchId: profile.branchId ?? undefined,
      branchName: profile.branchId ? undefined : undefined,
      mobile: profile.mobile ?? undefined,
      deviceLabel: args.deviceLabel.trim().slice(0, 120) || profile.name,
      deviceType: args.deviceType?.trim().slice(0, 60) ?? undefined,
      immediateApproval: args.immediateApproval ?? false,
      status: "UNUSED",
      expiresAt,
      generatedBy: profile.staffId,
      generatedByType: "SUPER_ADMIN",
      generatedAt: Date.now(),
    });

    // Branch name is resolved here for display/notification purposes only.
    if (profile.branchId) {
      const branch = await ctx.db.get(profile.branchId);
      if (branch) {
        await ctx.db.patch(linkId, { branchName: branch.name });
      }
    }

    await appendAuditEntry(ctx, actor, {
      action: "REGISTRATION_LINK_GENERATED",
      targetType: "securityRegistrationLink",
      targetId: token.slice(0, 12) + "…",
      previousState: "",
      newState: JSON.stringify({
        staffId: profile.staffId,
        immediateApproval: args.immediateApproval ?? false,
        expiresAt,
      }),
      reason: `Link generated for ${profile.staffId} · ${profile.name}`,
      ip: undefined,
    });

    const link = portalLink(undefined, token);

    return {
      link,
      token,
      staffId: profile.staffId,
      staffName: profile.name,
      role: profile.role,
      branchName: profile.branchId
        ? ((await ctx.db.get(profile.branchId)) as any)?.name ?? "Organization-wide"
        : "Organization-wide",
      deviceLabel: args.deviceLabel.trim().slice(0, 120) || profile.name,
      deviceType: args.deviceType?.trim().slice(0, 60) ?? "Web",
      immediateApproval: args.immediateApproval ?? false,
      expiresAt,
      status: "UNUSED",
    };
  },
});

export const validateRegistrationToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const token = (args.token ?? "").trim();
    if (!token) return null;
    const tokenHash = await sha256Hex(`reg-link:${token}`);
    const row = await ctx.db
      .query("securityRegistrationLinks")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", tokenHash))
      .first();
    // The public face never returns the raw token or hashes.
    if (!row || row.status !== "UNUSED" || row.expiresAt <= Date.now()) {
      return null;
    }
    return {
      staffId: row.staffId,
      staffName: row.staffName,
      role: row.role,
      deviceLabel: row.deviceLabel,
      deviceType: row.deviceType ?? "Web",
      immediateApproval: row.immediateApproval,
      expiresAt: row.expiresAt,
      status: row.status,
    };
  },
});

export const revokeRegistrationLink = mutation({
  args: { token: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const token = (args.token ?? "").trim();
    if (!token) throw new AppError("A registration token is required.");
    const tokenHash = await sha256Hex(`reg-link:${token}`);
    const row = await ctx.db
      .query("securityRegistrationLinks")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", tokenHash))
      .first();
    if (!row) throw new AppError("That registration link does not exist.");
    if (row.status !== "UNUSED") {
      throw new AppError(
        `That registration link is already ${row.status.toLowerCase()}.`,
      );
    }
    const before = row.status;
    await ctx.db.patch(row._id, {
      status: "REVOKED",
      revokedAt: Date.now(),
      revokedBy: (await requireSuperAdmin(ctx)).staffId,
    });
    await appendAuditEntry(ctx, await requireSuperAdmin(ctx), {
      action: "REGISTRATION_LINK_REVOKED",
      targetType: "securityRegistrationLink",
      targetId: row.token.slice(0, 12) + "…",
      previousState: JSON.stringify({ status: before }),
      newState: JSON.stringify({ status: "REVOKED" }),
      reason: args.reason ?? "Revoked by SUPER_ADMIN",
      ip: undefined,
    });
    return { ok: true, status: "REVOKED" };
  },
});

export const listRegistrationRequests = query({
  args: {
    status: v.optional(v.string()),
    staffId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const requested = await ctx.db
      .query("securityDevices")
      .withIndex("by_status", (q) => q.eq("status", "PENDING"))
      .collect();

    let rows = requested;
    if (args.staffId) {
      const sid = (args.staffId ?? "").trim().toUpperCase();
      rows = rows.filter(
        (d) => d.staffId === sid,
      );
    }
    rows = rows.sort((a, b) => a.requestedAt - b.requestedAt);
    const limit = Math.max(1, Math.min(200, args.limit ?? 50));
    return rows.slice(0, limit).map((d, idx) => ({
      idx: idx + 1,
      _id: d._id,
      enrollmentId: d.enrollmentId,
      staffId: d.staffId,
      staffName: d.staffName,
      role: d.role,
      label: d.label,
      os: d.os ?? null,
      browser: d.browser ?? null,
      browserVersion: d.browserVersion ?? null,
      category: d.category ?? null,
      status: d.status,
      requestedAt: d.requestedAt,
      lastSeenAt: d.lastSeenAt,
      enrolledAt: d.enrolledAt ?? null,
      decidedAt: d.decidedAt ?? null,
      decidedBy: d.decidedBy ?? null,
      reason: d.reason ?? null,
      source: d.source,
      ip: d.ip ?? null,
      userAgent: d.userAgent ?? null,
    }));
  },
});

export const listRegistrationLinks = query({
  args: {
    status: v.optional(v.string()),
    staffId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const all = await ctx.db.query("securityRegistrationLinks").collect();
    let rows = all;
    if (args.status && args.status !== "ALL") {
      rows = rows.filter((r: any) => r.status === args.status);
    }
    if (args.staffId) {
      const sid = (args.staffId ?? "").trim().toUpperCase();
      rows = rows.filter(
        (r: any) => r.staffId === sid || r.staffId === sid,
      );
    }
    rows = rows.sort((a: any, b: any) => b.generatedAt - a.generatedAt);
    const limit = Math.max(1, Math.min(200, args.limit ?? 50));
    return rows.slice(0, limit).map((r: any) => ({
      _id: r._id,
      token: r.token.slice(0, 8) + "…",
      staffId: r.staffId,
      staffName: r.staffName,
      role: r.role,
      branchName: r.branchName ?? null,
      deviceLabel: r.deviceLabel,
      deviceType: r.deviceType ?? null,
      immediateApproval: r.immediateApproval,
      status: r.status,
      expiresAt: r.expiresAt,
      generatedBy: r.generatedBy,
      generatedByType: r.generatedByType,
      generatedAt: r.generatedAt,
      usedAt: r.usedAt ?? null,
      revokedAt: r.revokedAt ?? null,
    }));
  },
});

/* ---------------------- SUPER_ADMIN device administration -------------------- */

/** SUPER_ADMIN mirrors the Security Operator device view for the dashboard. */
export const superadminDevices = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const all = await ctx.db.query("securityDevices").collect();
    const rows = (args.status && args.status !== "ALL"
      ? all.filter((d) => d.status === args.status)
      : all)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);

    const conflict = new Map<string, number>();
    for (const d of all) {
      if (d.status === "AUTHORIZED") {
        conflict.set(d.profileId, (conflict.get(d.profileId) ?? 0) + 1);
      }
    }

    return rows.map((d) => ({
      _id: d._id,
      staffId: d.staffId ?? null,
      staffName: d.staffName,
      role: d.role,
      label: d.label,
      platform: d.platform ?? null,
      fingerprintShort: `${d.fingerprint.slice(0, 8)}…${d.fingerprint.slice(-4)}`,
      enrollmentId: d.enrollmentId ?? null,
      publicKeyFingerprint: d.publicKeyFingerprint ?? null,
      browser: d.browser ?? null,
      browserVersion: d.browserVersion ?? null,
      os: d.os ?? null,
      category: d.category ?? null,
      reportedInfo: d.reportedInfo ?? true,
      status: d.status,
      priorStatus: d.priorStatus ?? null,
      source: d.source,
      requestedAt: d.requestedAt,
      lastSeenAt: d.lastSeenAt,
      enrolledAt: d.enrolledAt ?? null,
      lastVerifiedAt: d.lastVerifiedAt ?? null,
      revokedAt: d.revokedAt ?? null,
      revokeReason: d.revokeReason ?? null,
      decidedAt: d.decidedAt ?? null,
      decidedBy: d.decidedBy ?? null,
      reason: d.reason ?? null,
      ip: d.ip ?? null,
      userAgent: d.userAgent ?? null,
      multipleAuthorized: (conflict.get(d.profileId) ?? 0) > 1,
    }));
  },
});

export const superadminDeviceDetails = query({
  args: {
    deviceId: v.optional(v.id("securityDevices")),
    enrollmentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    let device =
      args.deviceId ? await ctx.db.get(args.deviceId) : null;

    if (!device && args.enrollmentId) {
      const byEnrollment = await ctx.db
        .query("securityDevices")
        .withIndex("by_enrollment", (q) => q.eq("enrollmentId", args.enrollmentId))
        .first();
      device = byEnrollment ?? null;
    }
    if (!device) throw new AppError("Device record not found.");

    const events = await ctx.db
      .query("securityDeviceEvents")
      .withIndex("by_device", (q) => q.eq("deviceKey", device.deviceKey))
      .order("desc")
      .take(40);

    return {
      device: {
        _id: device._id,
        staffId: device.staffId ?? null,
        staffName: device.staffName,
        role: device.role,
        label: device.label,
        platform: device.platform ?? null,
        fingerprintShort: `${device.fingerprint.slice(0, 8)}…${device.fingerprint.slice(-4)}`,
        enrollmentId: device.enrollmentId ?? null,
        publicKeyFingerprint: device.publicKeyFingerprint ?? null,
        browser: device.browser ?? null,
        browserVersion: device.browserVersion ?? null,
        os: device.os ?? null,
        category: device.category ?? null,
        reportedInfo: device.reportedInfo ?? true,
        status: device.status,
        priorStatus: device.priorStatus ?? null,
        source: device.source,
        requestedAt: device.requestedAt,
        lastSeenAt: device.lastSeenAt,
        enrolledAt: device.enrolledAt ?? null,
        lastVerifiedAt: device.lastVerifiedAt ?? null,
        revokedAt: device.revokedAt ?? null,
        revokeReason: device.revokeReason ?? null,
        decidedAt: device.decidedAt ?? null,
        decidedBy: device.decidedBy ?? null,
        reason: device.reason ?? null,
        ip: device.ip ?? null,
        userAgent: device.userAgent ?? null,
      },
      history: events.map((e) => ({
        ref: e.ref,
        kind: e.kind,
        staffId: e.staffId ?? null,
        staffName: e.staffName,
        ip: e.ip ?? null,
        userAgent: e.userAgent ?? null,
        detail: e.detail,
        actor: e.actor,
        at: e.at,
      })),
    };
  },
});

export const superadminApproveDevice = mutation({
  args: {
    deviceId: v.id("securityDevices"),
    reason: v.optional(v.string()),
    replaceActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const device = await ctx.db.get(args.deviceId);
    if (!device) throw new AppError("Device record not found.");
    if (device.status === "AUTHORIZED") {
      throw new AppError("That device is already authorized.");
    }
    if (device.status === "BLOCKED") {
      throw new AppError("Blocked devices must be unblocked first.");
    }
    const siblings = await ctx.db
      .query("securityDevices")
      .withIndex("by_profile", (q) => q.eq("profileId", device.profileId))
      .collect();

    if (device.status !== "PENDING") {
      throw new AppError(
        "Only pending registration requests can be approved.",
      );
    }
    const active = siblings.filter(
      (d) => d.status === "AUTHORIZED" && d._id !== device._id,
    );
    if (active.length > 0 && !args.replaceActive) {
      throw new AppError(
        `${device.staffName} already has an authorized device. Use Replace to move authorization.`,
      );
    }

    const now = Date.now();
    const before = JSON.stringify({
      status: device.status,
      staffId: device.staffId ?? null,
      fingerprint: device.fingerprint.slice(0, 12),
      decidedBy: device.decidedBy ?? null,
      reason: device.reason ?? null,
    });

    for (const old of active) {
      await ctx.db.patch(old._id, {
        status: "REPLACED",
        decidedAt: now,
        decidedBy: actor.staffId,
        reason: args.reason ?? "Replaced during device approval",
      });
      await ctx.db.insert("securityDeviceEvents", {
        ref: await makeCode(ctx, "securityEvent", "EVT", 6),
        kind: "DEVICE_REPLACED",
        deviceKey: old.deviceKey,
        profileId: old.profileId,
        staffId: old.staffId,
        staffName: old.staffName,
        detail: `Device replaced by ${actor.staffId} during approval`,
        actor: actor.staffId,
        at: now,
      });
    }

    await ctx.db.patch(device._id, {
      status: "AUTHORIZED",
      priorStatus: undefined,
      source: active.length > 0 ? "REPLACEMENT" : "IMMEDIATE_APPROVAL",
      decidedAt: now,
      decidedBy: actor.staffId,
      reason: args.reason ?? undefined,
      revokedAt: undefined,
      revokeReason: undefined,
    });

    const updated = await ctx.db.get(args.deviceId);
    if (!updated) throw new AppError("Device record disappeared.");

    if (updated.source === "IMMEDIATE_APPROVAL") {
      await ctx.db.patch(device._id, {
        source: "IMMEDIATE_APPROVAL",
      });
      await ctx.db.insert("securityDeviceEvents", {
        ref: await makeCode(ctx, "securityEvent", "EVT", 6),
        kind: "DEVICE_APPROVED",
        deviceKey: device.deviceKey,
        profileId: device.profileId,
        staffId: device.staffId,
        staffName: device.staffName,
        detail: `Approved by ${actor.staffId} via immediate approval — registration link skipped the pending queue`,
        actor: actor.staffId,
        at: now,
      });
      await appendAuditEntry(ctx, actor, {
        action: "DEVICE_APPROVED",
        targetType: "securityDevice",
        targetId: device.deviceKey,
        previousState: before,
        newState: JSON.stringify({
          status: "AUTHORIZED",
          staffId: device.staffId ?? null,
          fingerprint: device.fingerprint.slice(0, 12),
          decidedBy: actor.staffId,
          reason: args.reason ?? "          Logical immediate approval".slice(0, 200),
        }),
        reason: args.reason ?? "Immediate approval",
        ip: undefined,
      });
    }

    const eventRef = await makeCode(ctx, "securityEvent", "EVT", 6);
    await ctx.db.insert("securityDeviceEvents", {
      ref: eventRef,
      kind: "DEVICE_APPROVED",
      deviceKey: device.deviceKey,
      profileId: device.profileId,
      staffId: device.staffId,
      staffName: device.staffName,
      detail: `Approved by ${actor.staffId}`,
      actor: actor.staffId,
      at: now,
    });

    await appendAuditEntry(ctx, actor, {
      action: "DEVICE_APPROVED",
      targetType: "securityDevice",
      targetId: device.deviceKey,
      previousState: before,
      newState: JSON.stringify({
        status: "AUTHORIZED",
        staffId: device.staffId ?? null,
        fingerprint: device.fingerprint.slice(0, 12),
        decidedBy: actor.staffId,
        reason: args.reason ?? "",
      }),
      reason: args.reason ?? "Approved by SUPER_ADMIN",
      eventRef,
      ip: undefined,
    });

    return { ok: true, eventRef, decidedBy: actor.staffId };
  },
});

export const superadminRejectDevice = mutation({
  args: { deviceId: v.id("securityDevices"), reason: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const device = await ctx.db.get(args.deviceId);
    if (!device) throw new AppError("Device record not found.");
    if (device.status !== "PENDING") {
      throw new AppError("Only pending device requests can be rejected.");
    }
    const before = JSON.stringify({
      status: device.status,
      staffId: device.staffId ?? null,
      fingerprint: device.fingerprint.slice(0, 12),
      decidedBy: device.decidedBy ?? null,
      reason: device.reason ?? null,
    });
    const now = Date.now();
    await ctx.db.patch(device._id, {
      status: "REJECTED",
      decidedAt: now,
      decidedBy: actor.staffId,
      reason: args.reason,
    });
    await appendAuditEntry(ctx, actor, {
      action: "DEVICE_REJECTED",
      targetType: "securityDevice",
      targetId: device.deviceKey,
      previousState: before,
      newState: JSON.stringify({
        status: "REJECTED",
        staffId: device.staffId ?? null,
        fingerprint: device.fingerprint.slice(0, 12),
        decidedBy: actor.staffId,
        reason: args.reason,
      }),
      reason: args.reason,
      ip: undefined,
    });
    return { ok: true, decidedBy: actor.staffId };
  },
});

export const superadminBlockDevice = mutation({
  args: { deviceId: v.id("securityDevices"), reason: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const device = await ctx.db.get(args.deviceId);
    if (!device) throw new AppError("Device record not found.");

    const before = JSON.stringify({
      status: device.status,
      staffId: device.staffId ?? null,
      fingerprint: device.fingerprint.slice(0, 12),
      decidedBy: device.decidedBy ?? null,
      reason: device.reason ?? null,
    });
    const now = Date.now();
    await ctx.db.patch(device._id, {
      status: "BLOCKED",
      priorStatus: device.status,
      decidedAt: now,
      decidedBy: actor.staffId,
      reason: args.reason,
    });

    // Invalidate every live KMC session for the staff behind this device.
    const userId = await userIdForProfile(ctx, device.profileId);
    const revoked = userId ? await revokeUserSessions(ctx, userId) : 0;
    await ctx.db.insert("securityDeviceEvents", {
      ref: await makeCode(ctx, "securityEvent", "EVT", 6),
      kind: "DEVICE_BLOCKED",
      deviceKey: device.deviceKey,
      profileId: device.profileId,
      staffId: device.staffId,
      staffName: device.staffName,
      detail: `${args.reason} — ${revoked} staff session(s) invalidated`,
      actor: actor.staffId,
      at: now,
    });

    await appendAuditEntry(ctx, actor, {
      action: "DEVICE_BLOCKED",
      targetType: "securityDevice",
      targetId: device.deviceKey,
      previousState: before,
      newState: JSON.stringify({
        status: "BLOCKED",
        staffId: device.staffId ?? null,
        fingerprint: device.fingerprint.slice(0, 12),
        decidedBy: actor.staffId,
        reason: args.reason,
      }),
      reason: args.reason,
      eventRef: await makeCode(ctx, "securityEvent", "EVT", 6),
      ip: undefined,
    });

    return { ok: true, sessionsRevoked: revoked, decidedBy: actor.staffId };
  },
});

export const superadminRevokeDevice = mutation({
  args: { deviceId: v.id("securityDevices"), reason: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const device = await ctx.db.get(args.deviceId);
    if (!device) throw new AppError("Device record not found.");
    if (device.status === "REVOKED") {
      throw new AppError("That device is already revoked.");
    }

    const before = JSON.stringify({
      status: device.status,
      staffId: device.staffId ?? null,
      fingerprint: device.fingerprint.slice(0, 12),
      decidedBy: device.decidedBy ?? null,
      reason: device.reason ?? null,
    });
    const now = Date.now();
    await ctx.db.patch(device._id, {
      status: "REVOKED",
      priorStatus: device.status,
      decidedAt: now,
      decidedBy: actor.staffId,
      reason: args.reason,
      revokedAt: now,
      revokeReason: args.reason,
    });

    const userId = await userIdForProfile(ctx, device.profileId);
    const revoked = userId ? await revokeUserSessions(ctx, userId) : 0;
    await ctx.db.insert("securityDeviceEvents", {
      ref: await makeCode(ctx, "securityEvent", "EVT", 6),
      kind: "DEVICE_REVOKED",
      deviceKey: device.deviceKey,
      profileId: device.profileId,
      staffId: device.staffId,
      staffName: device.staffName,
      detail: `${args.reason} — ${revoked} staff session(s) invalidated`,
      actor: actor.staffId,
      at: now,
    });

    await appendAuditEntry(ctx, actor, {
      action: "DEVICE_REVOKED",
      targetType: "securityDevice",
      targetId: device.deviceKey,
      previousState: before,
      newState: JSON.stringify({
        status: "REVOKED",
        staffId: device.staffId ?? null,
        fingerprint: device.fingerprint.slice(0, 12),
        decidedBy: actor.staffId,
        reason: args.reason,
      }),
      reason: args.reason,
      eventRef: await makeCode(ctx, "securityEvent", "EVT", 6),
      ip: undefined,
    });

    return { ok: true, sessionsRevoked: revoked, decidedBy: actor.staffId };
  },
});

export const superadminReactivateDevice = mutation({
  args: { deviceId: v.id("securityDevices"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await requireSuperAdmin(ctx);
    const device = await ctx.db.get(args.deviceId);
    if (!device) throw new AppError("Device record not found.");
    if (device.status !== "REVOKED" && device.status !== "REJECTED") {
      throw new AppError(
        "Only revoked or rejected devices can be reactivated as pending.",
      );
    }
    const before = JSON.stringify({
      status: device.status,
      staffId: device.staffId ?? null,
      fingerprint: device.fingerprint.slice(0, 12),
      decidedBy: device.decidedBy ?? null,
      reason: device.reason ?? null,
    });
    const now = Date.now();
    await ctx.db.patch(device._id, {
      status: "PENDING",
      priorStatus: undefined,
      decidedAt: now,
      decidedBy: actor.staffId,
      reason: args.reason ?? "Reactivated by SUPER_ADMIN",
      revokedAt: undefined,
      revokeReason: undefined,
    });
    await appendAuditEntry(ctx, actor, {
      action: "DEVICE_REACTIVATED",
      targetType: "securityDevice",
      targetId: device.deviceKey,
      previousState: before,
      newState: JSON.stringify({
        status: "PENDING",
        staffId: device.staffId ?? null,
        fingerprint: device.fingerprint.slice(0, 12),
        decidedBy: actor.staffId,
        reason: args.reason ?? "",
      }),
      reason: args.reason ?? "Reactivated by SUPER_ADMIN",
      ip: undefined,
    });
    return { ok: true, status: "PENDING", decidedBy: actor.staffId };
  },
});

export const superadminAuditLog = query({
  args: { limit: v.optional(v.number()), offset: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const limit = Math.max(1, Math.min(200, args.limit ?? 50));
    const offset = Math.max(0, args.offset ?? 0);
    const all = await ctx.db
      .query("securityAudit")
      .withIndex("by_seq")
      .order("desc")
      .take(limit + 1);
    const rows = all.slice(0, limit);
    const hasMore = all.length > limit;

    // Verify the hash chain for the returned rows.
    let chainOk = true;
    let firstBrokenRef: string | null = null;
    let checked = 0;
    let prevHash = "GENESIS";
    for (const row of rows) {
      const payload = auditPayload(row);
      const expected = await auditHash(prevHash, payload);
      if (row.hash !== expected) {
        chainOk = false;
        if (!firstBrokenRef) firstBrokenRef = row.ref;
        break;
      }
      prevHash = row.hash;
      checked += 1;
    }

    return {
      entries: rows.map((r) => ({
        _id: r._id,
        seq: r.seq,
        ref: r.ref,
        operatorId: r.operatorId,
        operatorName: r.operatorName,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        previousState: r.previousState,
        newState: r.newState,
        reason: r.reason,
        eventRef: r.eventRef ?? null,
        ip: r.ip ?? null,
        at: r.at,
        prevHash: r.prevHash,
        hash: r.hash,
      })),
      integrity: {
        ok: chainOk,
        checked,
        firstBrokenRef,
      },
      hasMore,
      total: all.length,
    };
  },
});

export const redeemRegistrationLink = mutation({
  args: {
    token: v.string(),
    deviceId: v.id("securityDevices"),
    fingerprint: v.string(),
    label: v.string(),
    platform: v.optional(v.string()),
    browser: v.optional(v.string()),
    browserVersion: v.optional(v.string()),
    os: v.optional(v.string()),
    category: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Redemption is intentionally PUBLIC: the single-use link is the credential.
    // The bearer does NOT need to be a SUPER_ADMIN. The link binds the request
    // to one staff account; the device itself is enrolled through the encrypted
    // enroll-on-device flow (securityDevice.completeEnrollment) before this is
    // called, so no unauthenticated party can mint arbitrary PENDING devices.
    const token = (args.token ?? "").trim();
    if (!token) throw new AppError("A registration token is required.");
    const tokenHash = await sha256Hex(`reg-link:${token}`);
    const link = await ctx.db
      .query("securityRegistrationLinks")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", tokenHash))
      .first();
    if (!link) throw new AppError("That registration link is not valid.");
    if (link.status !== "UNUSED") {
      throw new AppError(
        `That registration link has already been ${link.status.toLowerCase()}.`,
      );
    }
    if (link.expiresAt <= Date.now()) {
      await ctx.db.patch(link._id, { status: "EXPIRED" });
      throw new AppError("That registration link has expired.");
    }

    const device = await ctx.db.get(args.deviceId);
    if (!device) throw new AppError("Device record not found.");
    if (device.profileId !== link.profileId) {
      throw new AppError("That device does not belong to the staff account this link was issued for.");
    }
    if (device.status !== "PENDING") {
      throw new AppError(
        "The device must be enrolled (PENDING) before the registration link can be redeemed.",
      );
    }

    const now = Date.now();
    const profile = await ctx.db.get(link.profileId);
    if (!profile) throw new AppError("The intended staff account no longer exists.");

    // Attach any device metadata the browser supplied during enrollment, then
    // mark the link USED so it can never be reused.
    await ctx.db.patch(device._id, {
      fingerprint: device.fingerprint || args.fingerprint.trim().slice(0, 120),
      browser: args.browser?.trim().slice(0, 60) ?? device.browser,
      browserVersion: args.browserVersion?.trim().slice(0, 20) ?? device.browserVersion,
      os: args.os?.trim().slice(0, 40) ?? device.os,
      category: args.category?.trim().slice(0, 20) ?? device.category,
      label: args.label.trim().slice(0, 120) || link.deviceLabel,
      platform: args.platform?.trim().slice(0, 40) ?? device.platform,
      userAgent: args.userAgent?.trim().slice(0, 300) ?? device.userAgent,
      ip: args.ip ?? device.ip,
      lastSeenAt: now,
    });
    await ctx.db.patch(link._id, {
      status: "USED",
      usedAt: now,
      usedBy: profile.staffId,
    });

    await ctx.db.insert("securityDeviceEvents", {
      ref: await makeCode(ctx, "securityEvent", "EVT", 6),
      kind: "DEVICE_REQUESTED",
      deviceKey: device.deviceKey,
      profileId: device.profileId,
      staffId: device.staffId,
      staffName: device.staffName,
      ip: args.ip,
      userAgent: args.userAgent,
      detail: `Registration link redeemed by ${profile.staffId} — pending Security Department approval`,
      actor: "SYSTEM",
      at: now,
    });

    await appendAuditEntry(ctx, profile, {
      action: "REGISTRATION_LINK_USED",
      targetType: "securityRegistrationLink",
      targetId: link.token.slice(0, 12) + "…",
      previousState: JSON.stringify({ status: "UNUSED" }),
      newState: JSON.stringify({
        status: "USED",
        deviceId: device._id,
        staffId: profile.staffId,
      }),
      reason: `Link used to register ${profile.staffId} · ${profile.name}`,
      ip: args.ip,
    });

    return {
      ok: true,
      staffId: profile.staffId,
      staffName: profile.name,
      deviceId: device._id,
      status: "PENDING",
      message: "Registration link redeemed. Awaiting Security Department approval.",
    };
  },
});

export const verifyAuditChain = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const rows = await ctx.db
      .query("securityAudit")
      .withIndex("by_seq")
      .order("desc")
      .take(500);
    let prevHash = "GENESIS";
    let checked = 0;
    let firstBrokenRef: string | null = null;
    let ok = true;
    for (const row of rows) {
      const payload = auditPayload(row);
      const expected = await auditHash(prevHash, payload);
      if (row.hash !== expected) {
        ok = false;
        if (!firstBrokenRef) firstBrokenRef = row.ref;
        break;
      }
      prevHash = row.hash;
      checked += 1;
    }
    return {
      ok,
      checked,
      total: rows.length,
      firstBrokenRef,
      tipHash: prevHash,
    };
  },
});
