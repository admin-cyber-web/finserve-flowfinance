import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  AppError,
  getActor,
  logAudit,
  nextStaffNumber,
  requirePermission,
  requireProfile,
  writeWalletTx,
  type Mtx,
} from "../lib/server/convexHelpers";
import { FS_ROLES, USER_STATUSES } from "../lib/finance/types";
import { oneOf, requiredString, optionalString, money } from "../lib/finance/validate";
import { normalizeCredential, hashCredential, verifyCredential } from "../lib/server/credentials";
import { hasOwnerAuthority } from "../lib/finance/permissions";
import { staffIdMatches } from "../lib/server/idMatch";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { appendSecurityAudit } from "../lib/server/securityAudit";
import {
  consumeDeviceProof,
  logDeviceEvent,
  proofFailureMessage,
} from "../lib/server/securityDevice";

export const SUPER_ADMIN_EMAIL = "tiwarijhumki@gmail.com";

/**
 * Record a KMC staff login attempt for the Security Department.
 *
 * Every attempt lands in the security attempt log; successful logins, denied
 * devices and lockouts also append to the hash-chained security audit. The
 * actor is prefixed `SYSTEM:` so it can never be mistaken for an operator.
 */
async function recordStaffLogin(
  ctx: MutationCtx,
  args: {
    profile?: Doc<"profiles">;
    staffId: string;
    staffName?: string;
    action: string;
    outcome: "SUCCESS" | "FAILED" | "LOCKED";
    reason?: string;
    deviceKey?: string;
    deviceLabel?: string;
  },
): Promise<void> {
  await ctx.db.insert("securityLoginAttempts", {
    kind: args.profile?.role === "SUPER_ADMIN" ? "SUPER_ADMIN_LOGIN" : "STAFF_LOGIN",
    outcome: args.outcome,
    operatorId: args.profile?.staffId ?? args.staffId,
    detail: [args.reason, args.deviceLabel].filter(Boolean).join(" · ") || undefined,
    at: Date.now(),
  });
  if (args.outcome === "FAILED" && args.reason?.startsWith("Invalid")) return;
  await appendSecurityAudit(ctx, {
    operatorId: `SYSTEM:${args.staffId || "login"}`,
    operatorName: args.staffName ?? args.staffId ?? "Unknown staff",
    action: args.action,
    targetType: "staffLogin",
    targetId: args.deviceKey ?? args.profile?.staffId ?? args.staffId,
    previousState: "",
    newState: JSON.stringify({ outcome: args.outcome }),
    reason: [args.reason, args.deviceLabel].filter(Boolean).join(" · "),
  });
}


export const me = query({
  args: {},
  handler: async (ctx) => {
    const actor = await getActor(ctx);
    if (!actor) return null;
    return {
      userId: actor.userId,
      user: actor.user,
      profile: actor.profile,
    };
  },
});

export const findBySystemId = query({
  args: { systemId: v.string() },
  handler: async (ctx, { systemId }) => {
    const trimmed = systemId.trim().toUpperCase();
    const profiles = await ctx.db.query("profiles").collect();
    const match = profiles.find(
      (p) =>
        p.role !== "CLIENT" &&
        staffIdMatches(p.staffId, p.legacyStaffIds, trimmed),
    );
    if (!match) return null;
    return {
      profileId: match._id,
      systemId: match.staffId,
      name: match.name,
      role: match.role,
      status: match.status,
      hasCredential: !!match.credentialHash,
      // Owners sign in with System ID + PIN only, so the sign-in page needs to
      // know whether to run the device handshake first. Not a credential: the
      // backend still re-checks this on the real sign-in.
      ownerAuthority: hasOwnerAuthority(match),
    };
  },
});

export const verifyStaffLogin = mutation({
  args: {
    systemId: v.string(),
    credential: v.string(),
    deviceEnrollmentId: v.optional(v.string()),
    deviceProof: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { systemId, credential } = args;
    const trimmedSystemId = systemId.trim().toUpperCase();
    const profiles = await ctx.db.query("profiles").collect();
    const target = profiles.find(
      (p) =>
        p.role !== "CLIENT" &&
        staffIdMatches(p.staffId, p.legacyStaffIds, trimmedSystemId),
    );
    if (!target) {
      throw new AppError("Invalid system ID or credentials.");
    }
    if (target.status !== "ACTIVE") {
      throw new AppError(
        `Your account is ${target.status.toLowerCase()}. Contact your administrator.`,
      );
    }
    if (!target.credentialHash) {
      throw new AppError(
        "This account has no login credentials configured. Contact your administrator.",
      );
    }
    const normalized = normalizeCredential(credential);
    const verified = await verifyCredential(normalized, target.credentialHash);
    if (!verified) {
      await bumpFailedAttempt(ctx, target._id);
      throw new AppError("Invalid system ID or credentials.");
    }
    // Device authorization is part of authentication: a correct PIN is never
    // enough on its own, for any role (SUPER_ADMIN included).
    const device = await consumeDeviceProof(ctx, {
      proof: args.deviceProof,
      enrollmentId: args.deviceEnrollmentId,
      profile: target,
    });
    if (!device.ok) throw new AppError(proofFailureMessage(device.reason));
    await clearFailedAttempts(ctx, target._id);
    await touchLastLogin(ctx, target._id);
    return {
      profileId: target._id,
      role: target.role,
      status: target.status,
    };
  },
});

/**
 * System ID + PIN sign-in for admin-created staff accounts.
 *
 * Runs inside the Convex Auth `staff-credentials` provider (see
 * auth/staffCredentials.ts), so the resulting session/tokens are the SAME
 * standard Convex Auth sessions the email-OTP flow issues — no second auth
 * architecture. This only validates the stored credential and resolves the
 * Convex user to sign in as. Never returns the stored hash.
 *
 * IMPORTANT: failures are RETURNED, not thrown — a thrown mutation rolls
 * back its writes, which would discard the failed-attempt counter and break
 * the lockout. The provider throws after this mutation commits.
 */
export const staffCredentialsSignIn = internalMutation({
  args: {
    systemId: v.string(),
    credential: v.string(),
    deviceEnrollmentId: v.optional(v.string()),
    deviceProof: v.optional(v.string()),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<
    { ok: true; userId: Id<"users"> } | { ok: false; message: string }
  > => {
    const { systemId, credential } = args;
    const trimmed = systemId.trim().toUpperCase();
    if (!trimmed || !credential) {
      return { ok: false, message: "Enter your System ID and PIN." };
    }

    const profiles = await ctx.db.query("profiles").collect();
    const target = profiles.find(
      (p) =>
        p.role !== "CLIENT" && staffIdMatches(p.staffId, p.legacyStaffIds, trimmed),
    );
    if (!target) {
      await recordStaffLogin(ctx, {
        staffId: trimmed,
        action: "STAFF_LOGIN_FAILED",
        outcome: "FAILED",
        reason: "Invalid system ID",
      });
      return { ok: false, message: "Invalid system ID or credentials." };
    }
    if (target.lockedUntil && target.lockedUntil > Date.now()) {
      await recordStaffLogin(ctx, {
        profile: target,
        staffId: target.staffId,
        staffName: target.name,
        action: "STAFF_LOGIN_LOCKED",
        outcome: "LOCKED",
        reason: "Account lockout active",
      });
      return {
        ok: false,
        message: "Too many failed attempts. This account is locked for 15 minutes.",
      };
    }
    if (target.status !== "ACTIVE") {
      return {
        ok: false,
        message: `Your account is ${target.status.toLowerCase()}. Contact your administrator.`,
      };
    }
    if (!target.credentialHash) {
      return {
        ok: false,
        message:
          "This account has no login credentials configured. Contact your administrator.",
      };
    }

    const verified = await verifyCredential(
      normalizeCredential(credential),
      target.credentialHash,
    );
    if (!verified) {
      // Commits because this mutation returns normally; the provider then
      // throws with the message below.
      await bumpFailedAttempt(ctx, target._id);
      await recordStaffLogin(ctx, {
        profile: target,
        staffId: target.staffId,
        staffName: target.name,
        action: "STAFF_LOGIN_FAILED",
        outcome: "FAILED",
        reason: "Incorrect PIN",
      });
      return { ok: false, message: "Invalid system ID or credentials." };
    }

    // ---- Device authorization.
    // SUPER_ADMIN / app owner (backend grant or stored SUPER_ADMIN role) signs
    // in with System ID + PIN only: they are the authority that registers and
    // approves devices for every other staff member, so no device approval is
    // required for them and a missing or revoked owner device never locks them
    // out. The bypass is recorded in the login log, so it is never silent.
    const isOwner = hasOwnerAuthority(target);
    let deviceEnrollmentId: string | undefined;
    let deviceLabel: string | undefined;
    if (!isOwner) {
      const deviceCheck = await consumeDeviceProof(ctx, {
        proof: args.deviceProof,
        enrollmentId: args.deviceEnrollmentId,
        profile: target,
      });
      if (!deviceCheck.ok) {
        await logDeviceEvent(ctx, {
          kind: "LOGIN_DENIED_DEVICE",
          deviceKey: args.deviceEnrollmentId ?? "unverified",
          enrollmentId: args.deviceEnrollmentId,
          profileId: target._id,
          staffId: target.staffId,
          staffName: target.name,
          ip: args.ip,
          userAgent: args.userAgent,
          detail: `Sign-in denied: ${deviceCheck.reason}`,
          actor: "STAFF",
        });
        await recordStaffLogin(ctx, {
          profile: target,
          staffId: target.staffId,
          staffName: target.name,
          action: "STAFF_LOGIN_DENIED_DEVICE",
          outcome: "FAILED",
          reason: deviceCheck.reason,
          deviceKey: args.deviceEnrollmentId,
        });
        // A correct PIN from an unauthorized device is still a failed sign-in.
        await bumpFailedAttempt(ctx, target._id);
        return { ok: false, message: proofFailureMessage(deviceCheck.reason) };
      }
      deviceEnrollmentId = deviceCheck.device?.enrollmentId;
      deviceLabel = deviceCheck.device?.label;
    }

    await clearFailedAttempts(ctx, target._id);
    await touchLastLogin(ctx, target._id);
    await recordStaffLogin(ctx, {
      profile: target,
      staffId: target.staffId,
      staffName: target.name,
      action: isOwner ? "SUPER_ADMIN_LOGIN" : "STAFF_LOGIN",
      outcome: "SUCCESS",
      reason: isOwner
        ? "SUPER_ADMIN sign-in: device approval not required"
        : "Device verified cryptographically",
      deviceKey: deviceEnrollmentId ?? args.deviceEnrollmentId,
      deviceLabel,
    });

    // Resolve the Convex user this session acts as. Admin-created staff may
    // not have one yet: reuse the user for the same email if present,
    // otherwise create and link one so profile/session identity stay aligned.
    let userId = target.userId;
    if (!userId) {
      const email = target.email;
      const existing = email
        ? await ctx.db
            .query("users")
            .withIndex("email", (q) => q.eq("email", email))
            .first()
        : null;
      userId =
        existing?._id ??
        (await ctx.db.insert("users", {
          name: target.name,
          ...(email ? { email } : {}),
        }));
      await ctx.db.patch(target._id, { userId });
    }

    await logAudit(ctx, {
      actorId: target._id,
      actorName: target.name,
      role: target.role,
      action: "SESSION_STARTED",
      entity: "profiles",
      entityId: target.staffId,
      device: "system-id-login",
    });

    return { ok: true, userId };
  },
});

export const createStaffUser = mutation({
  args: {
    name: v.string(),
    mobile: v.string(),
    email: v.optional(v.string()),
    role: v.string(),
    branchId: v.id("branches"),
    walletLimit: v.optional(v.number()),
    status: v.optional(v.string()),
    credential: v.optional(v.string()),
    forceCredential: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "staff_management");

    const name = requiredString(args.name, "name", 120);
    const role = oneOf(args.role, FS_ROLES, "role");
    const status = args.status
      ? oneOf(args.status, USER_STATUSES, "status")
      : "ACTIVE";
    const email = optionalString(args.email, "email", 160)?.toLowerCase();

    if (email) {
      const existing = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique();
      if (existing) throw new AppError("A user with this email already exists.");
    }

    const mobile = requiredString(args.mobile, "mobile", 20);

    // Branch relationship is validated here in the backend: new users can
    // only join an ACTIVE branch (Ballia is the sole active branch — the
    // retired ones are kept for history but can never receive new staff).
    const branch = await ctx.db.get(args.branchId);
    if (!branch) throw new AppError("Branch not found.");
    if (branch.status !== "ACTIVE") {
      throw new AppError(
        `Branch "${branch.name}" is not active. New users can only be created in an active branch.`,
      );
    }

    // Backend-generated sequential number (0004, 0005, ...) — no role
    // prefix, no hyphen, leading zeros kept, collision-free under
    // concurrent creation. Never entered manually.
    const staffId = await nextStaffNumber(ctx);

    let credentialHash: string | null = null;
    let needsSetup = false;
    // Returned to the creating SUPER_ADMIN exactly once, so the admin can
    // hand the staff member their initial PIN. Only the hash is stored.
    let initialCredential: string | null = null;

    if (role === "SUPER_ADMIN") {
      if (!args.credential || args.credential.trim().length === 0) {
        throw new AppError("SUPER ADMIN must be created with a credential.");
      }
      credentialHash = await hashCredential(normalizeCredential(args.credential));
    } else if (args.credential && args.credential.trim().length > 0) {
      credentialHash = await hashCredential(normalizeCredential(args.credential));
    } else {
      initialCredential = generateTempPin();
      credentialHash = await hashCredential(normalizeCredential(initialCredential));
      needsSetup = true;
    }

    const createAt = Date.now();
    const profileId = await ctx.db.insert("profiles", {
      name,
      mobile,
      email,
      role,
      branchId: args.branchId,
      status,
      staffId,
      credentialHash,
      joiningDate: createAt,
      createdBy: me._id,
      createdAt: createAt,
      failedLoginAttempts: 0,
    });

    if (role === "FIELD_STAFF" && args.walletLimit && args.walletLimit > 0) {
      const limit = money(args.walletLimit, "walletLimit");
      const walletId = await ctx.db.insert("wallets", {
        profileId,
        branchId: args.branchId,
        walletLimit: limit,
        status: "ACTIVE",
        createdAt: createAt,
      });
      await ctx.runMutation(internal.users.staffWalletTx, {
        walletId,
        profileId,
        branchId: args.branchId,
        amount: limit,
        createdBy: me._id,
      });
      await logAudit(ctx, {
        actorId: me._id,
        actorName: me.name,
        role: me.role,
        action: "WALLET_LIMIT_SET",
        entity: "wallets",
        entityId: staffId,
        after: { walletLimit: limit },
        branchId: args.branchId,
      });
    }

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "STAFF_CREATED",
      entity: "profiles",
      entityId: staffId,
      after: {
        name,
        role,
        status,
        branchId: args.branchId,
        email,
        mobile,
        credentialSet: credentialHash !== null,
        tempPin: needsSetup ? "generated" : "provided",
      },
      branchId: args.branchId,
    });

    return {
      ok: true,
      profileId,
      staffId,
      needsCredentialSetup: needsSetup,
      initialCredential,
    };
  },
});

export const setStaffCredential = mutation({
  args: {
    profileId: v.id("profiles"),
    credential: v.string(),
    generate: v.optional(v.boolean()),
  },
  handler: async (ctx, { profileId, credential, generate }) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "staff_management");

    const target = await ctx.db.get(profileId);
    if (!target) throw new AppError("Staff not found.");
    if (target.role === "SUPER_ADMIN") {
      throw new AppError("Use the SUPER ADMIN setup flow for this account.");
    }

    let hash: string;
    // When generating, return the new PIN to the SUPER_ADMIN exactly once;
    // only its hash is stored on the profile.
    let initialCredential: string | null = null;
    if (generate) {
      initialCredential = generateTempPin();
      hash = await hashCredential(normalizeCredential(initialCredential));
    } else {
      hash = await hashCredential(normalizeCredential(credential));
    }

    await ctx.db.patch(profileId, { credentialHash: hash });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "STAFF_CREDENTIAL_RESET",
      entity: "profiles",
      entityId: target.staffId,
      after: { generated: generate },
      branchId: target.branchId,
    });

    return { ok: true, generated: generate, initialCredential };
  },
});

export const markNeedsCredentialSetup = mutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "staff_management");
    const target = await ctx.db.get(profileId);
    if (!target) throw new AppError("Staff not found.");
    await ctx.db.patch(profileId, { mustChangePassword: true });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "STAFF_CREDENTIAL_RESET",
      entity: "profiles",
      entityId: target.staffId,
      after: { mustChangePassword: true },
      branchId: target.branchId,
    });
    return { ok: true };
  },
});

export const bootstrapSuperAdmin = mutation({
  args: {
    password: v.string(),
  },
  handler: async (ctx, { password }) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "staff_management");

    const email = SUPER_ADMIN_EMAIL.toLowerCase();

    const existingByEmail = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existingByEmail && existingByEmail.role !== "SUPER_ADMIN") {
      throw new AppError("An active profile already uses this email.");
    }

    let adminProfile = existingByEmail;

    if (!adminProfile) {
      const branches = await ctx.db.query("branches").collect();
      if (branches.length === 0) {
        throw new AppError("No branches exist yet. Create a branch first.");
      }
      const adminBranch = branches[0]._id;

      const createAt = Date.now();
      const bootstrapStaffId = await nextStaffNumber(ctx);
      const adminId = await ctx.db.insert("profiles", {
        name: "System Administrator",
        mobile: "",
        email,
        role: "SUPER_ADMIN",
        branchId: adminBranch,
        status: "ACTIVE",
        staffId: bootstrapStaffId,
        credentialHash: await hashCredential(normalizeCredential(password)),
        joiningDate: createAt,
        createdAt: createAt,
        failedLoginAttempts: 0,
      });
      adminProfile = await ctx.db.get(adminId);
      await logAudit(ctx, {
        actorId: me._id,
        actorName: me.name,
        role: me.role,
        action: "SUPER_ADMIN_BOOTSTRAP",
        entity: "profiles",
        entityId: bootstrapStaffId,
        after: { email, created: true },
        branchId: adminBranch,
      });
    } else {
      if (!password || password.trim().length === 0) {
        throw new AppError("A new password is required to secure the SUPER ADMIN account.");
      }
      await ctx.db.patch(adminProfile._id, {
        credentialHash: await hashCredential(normalizeCredential(password)),
        status: "ACTIVE",
        role: "SUPER_ADMIN",
      });
      await logAudit(ctx, {
        actorId: me._id,
        actorName: me.name,
        role: me.role,
        action: "SUPER_ADMIN_PASSWORD_RESET",
        entity: "profiles",
        entityId: adminProfile.staffId,
        after: { email },
        branchId: adminProfile.branchId,
      });
    }

    return {
      ok: true,
      staffId: adminProfile!.staffId,
      email: adminProfile!.email,
    };
  },
});

export const impersonateProfile = mutation({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "staff_management");

    const target = await ctx.db.get(profileId);
    if (!target) throw new AppError("Profile not found.");
    if (target.role === "SUPER_ADMIN") {
      throw new AppError("You cannot impersonate another SUPER ADMIN.");
    }

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "IMPERSONATE_START",
      entity: "profiles",
      entityId: target.staffId,
      after: { impersonatedProfileId: target._id, impersonatedRole: target.role },
      branchId: target.branchId,
    });

    return {
      ok: true,
      impersonating: {
        profileId: target._id,
        name: target.name,
        role: target.role,
        staffId: target.staffId,
        status: target.status,
      },
    };
  },
});

export const stopImpersonation = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "staff_management");

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "IMPERSONATE_END",
      entity: "profiles",
      entityId: "",
    });

    return { ok: true };
  },
});

export const changeSuperAdminPassword = mutation({
  args: {
    newPassword: v.string(),
  },
  handler: async (ctx, { newPassword }) => {
    const me = await requireProfile(ctx);
    if (me.role !== "SUPER_ADMIN") {
      throw new AppError("Only the SUPER ADMIN can change this password.");
    }
    if (!newPassword || newPassword.trim().length === 0) {
      throw new AppError("A new password is required.");
    }
    await ctx.db.patch(me._id, {
      credentialHash: await hashCredential(normalizeCredential(newPassword)),
      lockedUntil: undefined,
    });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "SUPER_ADMIN_PASSWORD_CHANGE",
      entity: "profiles",
      entityId: me.staffId,
      after: {},
      branchId: me.branchId,
    });
    return { ok: true };
  },
});

export const staffWalletTx = internalMutation({
  args: {
    walletId: v.id("wallets"),
    profileId: v.id("profiles"),
    branchId: v.id("branches"),
    amount: v.number(),
    createdBy: v.id("profiles"),
  },
  handler: async (ctx, { walletId, profileId, branchId, amount, createdBy }) => {
    await writeWalletTx(ctx, {
      walletId,
      profileId,
      branchId,
      type: "OPENING_ALLOCATION",
      amount,
      direction: "CREDIT",
      referenceType: "OPENING",
      referenceId: "",
      createdBy,
      approvedBy: createdBy,
      remarks: "Initial working cash allocation",
    });
  },
});

async function bumpFailedAttempt(ctx: Mtx, profileId: Id<"profiles">) {
  const p = await ctx.db.get(profileId);
  if (!p) return;
  const attempts = (p.failedLoginAttempts ?? 0) + 1;
  const lockUntil = attempts >= 5 ? Date.now() + 15 * 60 * 1000 : undefined;
  await ctx.db.patch(profileId, {
    failedLoginAttempts: attempts,
    lockedUntil: lockUntil,
  });
}

async function clearFailedAttempts(ctx: Mtx, profileId: Id<"profiles">) {
  const p = await ctx.db.get(profileId);
  if (!p) return;
  await ctx.db.patch(profileId, {
    failedLoginAttempts: 0,
    lockedUntil: undefined,
  });
}

async function touchLastLogin(ctx: Mtx, profileId: Id<"profiles">) {
  await ctx.db.patch(profileId, {
    lastLoginAt: Date.now(),
  });
}

function generateTempPin(): string {
  const digits = "0123456789";
  // Cryptographically secure — this value becomes a stored credential hash.
  const random = new Uint32Array(6);
  crypto.getRandomValues(random);
  let pin = "";
  for (let i = 0; i < 6; i += 1) {
    pin += digits[random[i] % 10];
  }
  return pin;
}
