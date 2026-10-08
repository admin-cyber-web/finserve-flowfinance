import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  AppError,
  getActor,
  logAudit,
  requirePermission,
  requireProfile,
  type Mtx,
} from "../lib/server/convexHelpers";
import { FS_ROLES, USER_STATUSES } from "../lib/finance/types";
import { oneOf, requiredString, optionalString, money } from "../lib/finance/validate";
import type { Id } from "./_generated/dataModel";
import { normalizeCredential, hashCredential, verifyCredential } from "../lib/server/credentials";

const SUPER_ADMIN_EMAIL = "tiwarijhumki@gmail.com";

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
        p.staffId?.toUpperCase() === trimmed,
    );
    if (!match) return null;
    return {
      profileId: match._id,
      systemId: match.staffId,
      name: match.name,
      role: match.role,
      status: match.status,
      hasCredential: !!match.credentialHash,
    };
  },
});

export const verifyStaffLogin = mutation({
  args: {
    systemId: v.string(),
    credential: v.string(),
  },
  handler: async (ctx, { systemId, credential }) => {
    const trimmedSystemId = systemId.trim().toUpperCase();
    const profiles = await ctx.db.query("profiles").collect();
    const target = profiles.find(
      (p) =>
        p.role !== "CLIENT" &&
        p.staffId?.toUpperCase() === trimmedSystemId,
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
    await clearFailedAttempts(ctx, target._id);
    await touchLastLogin(ctx, target._id);
    return {
      profileId: target._id,
      role: target.role,
      status: target.status,
    };
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

    const seq = await ctx.db
      .query("profiles")
      .withIndex("by_role", (q) => q.eq("role", role))
      .collect();
    const prefix =
      role === "FIELD_STAFF"
        ? "ST"
        : role === "BRANCH_MANAGER"
          ? "BM"
          : role === "ACCOUNTANT"
            ? "AC"
            : "SA";
    const staffId = `${prefix}-${String(10001 + seq.length).padStart(5, "0")}`;

    let credentialHash: string | null = null;
    let needsSetup = false;

    if (role === "SUPER_ADMIN") {
      if (!args.credential || args.credential.trim().length === 0) {
        throw new AppError("SUPER ADMIN must be created with a credential.");
      }
      credentialHash = await hashCredential(normalizeCredential(args.credential));
    } else {
      if (args.credential && args.credential.trim().length > 0) {
        credentialHash = await hashCredential(normalizeCredential(args.credential));
      } else {
        credentialHash = await hashCredential(generateTempPin());
        needsSetup = true;
      }
    }

    const profileId = await ctx.db.insert("profiles", {
      name,
      mobile,
      email,
      role,
      branchId: args.branchId,
      status,
      staffId,
      credentialHash,
      joiningDate: Date.now(),
      createdBy: me._id,
      createdAt: Date.now(),
      failedLoginAttempts: 0,
      lockedUntil: null,
    });

    if (role === "FIELD_STAFF" && args.walletLimit && args.walletLimit > 0) {
      const limit = money(args.walletLimit, "walletLimit");
      const walletId = await ctx.db.insert("wallets", {
        profileId,
        branchId: args.branchId,
        walletLimit: limit,
        status: "ACTIVE",
        createdAt: Date.now(),
      });
      await ctx.runMutation(internalMutation.users.createWalletTx, {
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
    if (generate) {
      hash = await hashCredential(generateTempPin());
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

    return { ok: true, generated: generate };
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

      const adminId = await ctx.db.insert("profiles", {
        name: "System Administrator",
        mobile: "",
        email,
        role: "SUPER_ADMIN",
        branchId: adminBranch,
        status: "ACTIVE",
        staffId: "SA-00001",
        credentialHash: await hashCredential(normalizeCredential(password)),
        joiningDate: Date.now(),
        createdAt: Date.now(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
      adminProfile = await ctx.db.get(adminId);
      await logAudit(ctx, {
        actorId: me._id,
        actorName: me.name,
        role: me.role,
        action: "SUPER_ADMIN_BOOTSTRAP",
        entity: "profiles",
        entityId: "SA-00001",
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

export const createWalletTx = internalMutation({
  args: {
    walletId: v.id("wallets"),
    profileId: v.id("profiles"),
    branchId: v.id("branches"),
    amount: v.number(),
    createdBy: v.id("profiles"),
  },
  handler: async (ctx, { walletId, profileId, branchId, amount, createdBy }) => {
    const { writeWalletTx } = await import("../lib/server/convexHelpers");
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
  const lockUntil = attempts >= 5 ? Date.now() + 15 * 60 * 1000 : null;
  await ctx.db.patch(profileId, {
    failedLoginAttempts: attempts,
    lockedUntil: lockUntil ?? undefined,
  });
}

async function clearFailedAttempts(ctx: Mtx, profileId: Id<"profiles">) {
  const p = await ctx.db.get(profileId);
  if (!p) return;    await ctx.db.patch(profileId, {
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
}

async function touchLastLogin(ctx: Mtx, profileId: Id<"profiles">) {
  await ctx.db.patch(profileId, {
    lastLoginAt: Date.now(),
  });
}

function generateTempPin(): string {
  const digits = "0123456789";
  let pin = "";
  for (let i = 0; i < 6; i += 1) {
    pin += digits[Math.floor(Math.random() * digits.length)];
  }
  return pin;
}

async function hashCredential(pin: string): Promise<string> {
  const tokens = await import("@convex-dev/auth/server").then((m) =>
    m.modifyAccountCredentials({ password: pin }),
  );
  return tokens.hash as string;
}

async function verifyCredential(verified: string, hash: string): Promise<boolean> {
  const tokens = await import("@convex-dev/auth/server").then((m) =>
    m.modifyAccountCredentials({ password: verified }),
  );
  return (tokens.hash as string) === hash;
}

