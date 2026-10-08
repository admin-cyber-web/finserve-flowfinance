import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import {
  AppError,
  getActor,
  logAudit,
  notify,
  requirePermission,
  requireProfile,
  writeWalletTx,
} from "../lib/server/convexHelpers";
import { effectivePermissions } from "../lib/finance/permissions";
import { SUPER_ADMIN_EMAIL } from "./users";
import { FS_ROLES, USER_STATUSES } from "../lib/finance/types";
import { oneOf, requiredString, optionalString, money } from "../lib/finance/validate";
import type { Doc, Id } from "./_generated/dataModel";

/** Current identity + workspace profile + effective permissions. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const actor = await getActor(ctx);
    if (!actor) return null;
    const base = {
      user: {
        name: actor.user.name ?? null,
        email: actor.user.email ?? null,
        image: actor.user.image ?? null,
        isAnonymous: actor.user.isAnonymous ?? false,
      },
    };
    if (!actor.profile) return { ...base, profile: null, permissions: [] };
    const profile = actor.profile;
    if (!profile) return { ...base, profile: null, permissions: [] };
    const permissions = effectivePermissions(profile);
    const branchId = profile.branchId;
    const branch = branchId ? (await ctx.db.get(branchId)) ?? null : null;
    return {
      ...base,
      profile: {
        _id: profile._id,
        name: profile.name,
        email: profile.email,
        role: profile.role,
        status: profile.status,
        staffId: profile.staffId ?? null,
        image: profile.image ?? null,
        branch: branch ? { _id: branch._id, name: branch.name } : null,
        joiningDate: profile.joiningDate,
        credentialSet: !!profile.credentialHash,
        mustChangePassword: !!profile.mustChangePassword,
        lastLoginAt: profile.lastLoginAt,
        failedLoginAttempts: profile.failedLoginAttempts,
        lockedUntil: profile.lockedUntil,
        personaLoaded: false,
      },
      permissions,
    };
  },
});

/**
 * Claims a profile by verified email after real authentication.
 *
 * This is the ONLY path from a signed-in auth session to a workspace
 * profile — the old demo `selectWorkspace`/`attachPersona` mutations were
 * removed. If the designated SUPER ADMIN address signs in before its
 * profile exists, the profile is bootstrapped here: mailbox ownership was
 * just proven by the OTP, and no other email can take this path.
 */
export const linkByEmail = mutation({
  args: {},
  handler: async (ctx) => {
    const actor = await getActor(ctx);
    if (!actor) throw new AppError("Sign in first.");
    if (actor.profile) return { ok: true, alreadyLinked: true };
    const email = actor.user.email;
    if (!email) return { ok: false, reason: "no-email" };

    let profile = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", email.toLowerCase()))
      .unique();

    if (!profile && email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase()) {
      // First-run bootstrap of the real SUPER ADMIN account.
      const now = Date.now();
      const branches = await ctx.db.query("branches").collect();
      const profileId = await ctx.db.insert("profiles", {
        userId: actor.userId,
        name: actor.user.name?.trim() || "Super Admin",
        email: email.toLowerCase(),
        role: "SUPER_ADMIN",
        status: "ACTIVE",
        staffId: "SA-00001",
        ...(branches.length > 0 ? { branchId: branches[0]._id } : {}),
        joiningDate: now,
        createdAt: now,
        failedLoginAttempts: 0,
      });
      await ctx.db.insert("devices", {
        profileId,
        label: "Email sign-in",
        lastSeenAt: now,
      });
      await logAudit(ctx, {
        actorId: profileId,
        actorName: actor.user.name ?? "Super Admin",
        role: "SUPER_ADMIN",
        action: "SUPER_ADMIN_BOOTSTRAP",
        entity: "profiles",
        entityId: "SA-00001",
        after: { email: email.toLowerCase(), created: true },
        device: "email-otp",
      });
      return { ok: true };
    }

    if (!profile) return { ok: false, reason: "no-workspace" };
    if (profile.status !== "ACTIVE" && profile.status !== "CLIENT") {
      throw new AppError(
        `Access denied: this account is ${profile.status.toLowerCase()}.`,
      );
    }
    if (profile.userId && profile.userId !== actor.userId) {
      throw new AppError("This email is linked to another session.");
    }
    await ctx.db.patch(profile._id, { userId: actor.userId });
    await ctx.db.insert("devices", {
      profileId: profile._id,
      label: "Email sign-in",
      lastSeenAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: profile._id,
      actorName: profile.name,
      role: profile.role,
      action: "SESSION_STARTED",
      entity: "profiles",
      entityId: profile.staffId,
      device: "email-otp",
    });
    return { ok: true };
  },
});

/** Registers / refreshes this device in the session list. */
export const touchSession = mutation({
  args: { label: v.optional(v.string()), platform: v.optional(v.string()) },
  handler: async (ctx, { label, platform }) => {
    const profile = await requireProfile(ctx, { allowInactive: true });
    const existing = (
      await ctx.db
        .query("devices")
        .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
        .collect()
    ).filter((d) => !d.revokedAt);
    const device =
      existing.find((d) => d.label === (label ?? d.label)) ?? existing[0];
    if (device) {
      await ctx.db.patch(device._id, { lastSeenAt: Date.now() });
    } else {
      await ctx.db.insert("devices", {
        profileId: profile._id,
        label: label ?? "This device",
        platform,
        lastSeenAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

export const sessions = query({
  args: {},
  handler: async (ctx) => {
    const profile = await requireProfile(ctx, { allowInactive: true });
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
      .collect();
    return devices.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  },
});

/** Logout from other devices — marks every other session revoked. */
export const revokeOtherSessions = mutation({
  args: { keepDeviceId: v.optional(v.id("devices")) },
  handler: async (ctx, { keepDeviceId }) => {
    const profile = await requireProfile(ctx, { allowInactive: true });
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
      .collect();
    let revoked = 0;
    for (const d of devices) {
      if (d._id !== keepDeviceId && !d.revokedAt) {
        await ctx.db.patch(d._id, { revokedAt: Date.now() });
        revoked += 1;
      }
    }
    await logAudit(ctx, {
      actorId: profile._id,
      actorName: profile.name,
      role: profile.role,
      action: "SESSIONS_REVOKED",
      entity: "devices",
      after: { revoked },
    });
    return { ok: true, revoked };
  },
});

/* ----------------------------- Staff admin ------------------------------ */

export const listStaff = query({
  args: {
    branchId: v.optional(v.id("branches")),
    role: v.optional(v.string()),
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const scoped =
      me.role === "SUPER_ADMIN"
        ? (args.branchId ?? null)
        : (me.branchId ?? null);

    let all = await ctx.db.query("profiles").collect();
    if (scoped) all = all.filter((p) => p.branchId === scoped);
    else if (args.branchId) all = all.filter((p) => p.branchId === args.branchId);
    if (args.role) all = all.filter((p) => p.role === args.role);
    if (!args.includeInactive) all = all.filter((p) => p.role !== "CLIENT");

    const wallets = await ctx.db.query("wallets").collect();
    const walletByProfile = new Map(wallets.map((w) => [w.profileId, w]));

    const out = [] as {
      profile: Doc<"profiles">;
      branch: Doc<"branches"> | null;
      wallet: { walletLimit: number } | null;
      activeLoans: number;
      clients: number;
    }[];
    const loans = await ctx.db.query("loans").collect();
    const clients = await ctx.db.query("clients").collect();

    for (const p of all.filter((p) => p.role !== "CLIENT")) {
      const wallet = walletByProfile.get(p._id) ?? null;
      out.push({
        profile: p,
        branch: p.branchId ? await ctx.db.get(p.branchId) : null,
        wallet: wallet ? { walletLimit: wallet.walletLimit } : null,
        activeLoans: loans.filter(
          (l) => l.staffId === p._id && ["ACTIVE", "OVERDUE"].includes(l.status),
        ).length,
        clients: clients.filter((c) => c.assignedTo === p._id).length,
      });
    }
    return out;
  },
});

/** Staff 360° — profile, wallet, performance, transactions and audit trail. */
export const staff360 = query({
  args: { profileId: v.id("profiles") },
  handler: async (ctx, { profileId }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const subject = await ctx.db.get(profileId);
    if (!subject) throw new AppError("Staff profile not found.");
    if (
      me.role !== "SUPER_ADMIN" &&
      me.role !== "ACCOUNTANT" &&
      (me._id !== subject._id && me.branchId !== subject.branchId)
    ) {
      throw new AppError("You can only view staff in your own branch.");
    }

    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId))
      .unique();
    const txns = wallet
      ? await ctx.db
          .query("walletTransactions")
          .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
          .order("desc")
          .take(30)
      : [];
    const balance = txns.reduce((sum, t) => {
      if (t.direction === "CREDIT") return sum + t.amount;
      if (t.direction === "DEBIT") return sum - t.amount;
      return sum;
    }, 0);

    const loans = (await ctx.db.query("loans").collect()).filter(
      (l) => l.staffId === profileId,
    );
    const clients = (await ctx.db.query("clients").collect()).filter(
      (c) => c.assignedTo === profileId,
    );
    const collections = (await ctx.db.query("collections").collect()).filter(
      (c) => c.staffId === profileId,
    );
    const handovers = (await ctx.db.query("cashHandovers").collect()).filter(
      (h) => h.staffId === profileId,
    );
    const closings = (await ctx.db.query("cashClosings").collect()).filter(
      (c) => c.profileId === profileId,
    );
    const audit = await ctx.db
      .query("auditLogs")
      .withIndex("by_actor", (q) => q.eq("actorId", profileId))
      .order("desc")
      .take(30);

    const disbursed = loans
      .filter((l) => l.disbursedAt)
      .reduce((s, l) => s + l.principal, 0);
    const collected = collections
      .filter((c) => c.status === "NORMAL")
      .reduce((s, c) => s + c.amount, 0);
    const cashCollected = collections
      .filter((c) => c.status === "NORMAL" && c.mode === "CASH")
      .reduce((s, c) => s + c.amount, 0);
    const handoverTotal = handovers
      .filter((h) => h.status === "ACCEPTED")
      .reduce((s, h) => s + h.amount, 0);

    return {
      profile: subject,
      branch: subject.branchId ? await ctx.db.get(subject.branchId) : null,
      wallet: wallet
        ? {
            walletLimit: wallet.walletLimit,
            balance: Math.round(balance * 100) / 100,
          }
        : null,
      txns,
      loans,
      clients,
      handovers,
      closings,
      audit,
      performance: {
        disbursed,
        collected,
        cashCollected,
        handoverTotal,
        activeLoans: loans.filter((l) => ["ACTIVE", "OVERDUE"].includes(l.status))
          .length,
        overdueLoans: loans.filter((l) => l.status === "OVERDUE").length,
        activeClients: clients.length,
        cashDifference: closings.reduce((s, c) => s + c.difference, 0),
      },
    };
  },
});

export const createStaff = mutation({
  args: {
    name: v.string(),
    mobile: v.string(),
    email: v.optional(v.string()),
    role: v.string(),
    branchId: v.id("branches"),
    staffId: v.optional(v.string()),
    walletLimit: v.optional(v.number()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "staff_management");

    const name = requiredString(args.name, "name", 80);
    const role = oneOf(args.role, FS_ROLES, "role");
    const status = args.status ? oneOf(args.status, USER_STATUSES, "status") : "ACTIVE";
    const email = optionalString(args.email, "email", 120)?.toLowerCase();

    const existing = email
      ? await ctx.db
          .query("profiles")
          .withIndex("by_email", (q) => q.eq("email", email))
          .unique()
      : null;
    if (existing) throw new AppError("A user with this email already exists.");

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
    const staffId =
      args.staffId?.trim() ||
      `${prefix}-${String(10001 + seq.length).padStart(5, "0")}`;

    const profileId = await ctx.db.insert("profiles", {
      name,
      mobile: args.mobile,
      email,
      role,
      branchId: args.branchId,
      status,
      staffId,
      joiningDate: Date.now(),
      createdBy: me._id,
      createdAt: Date.now(),
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
      await writeWalletTx(ctx, {
        walletId,
        profileId,
        branchId: args.branchId,
        type: "OPENING_ALLOCATION",
        amount: limit,
        direction: "CREDIT",
        referenceType: "OPENING",
        referenceId: staffId,
        createdBy: me._id,
        approvedBy: me._id,
        remarks: `Opening working cash for ${name}`,
      });
    }

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "STAFF_CREATED",
      entity: "profiles",
      entityId: staffId,
      after: { name, role, status, branchId: args.branchId, walletLimit: args.walletLimit },
      branchId: args.branchId,
    });

    return { ok: true, profileId, staffId };
  },
});

export const setStatus = mutation({
  args: {
    profileId: v.id("profiles"),
    status: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, { profileId, status, reason }) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "block_staff");
    const target = await ctx.db.get(profileId);
    if (!target) throw new AppError("Staff not found.");
    if (target._id === me._id) throw new AppError("You cannot change your own status.");
    const next = oneOf(status, USER_STATUSES, "status");
    const why = requiredString(reason, "reason", 300);

    const before = { status: target.status };
    await ctx.db.patch(profileId, { status: next });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: next === "BLOCKED" ? "STAFF_BLOCKED" : "STAFF_STATUS_CHANGED",
      entity: "profiles",
      entityId: target.staffId,
      before,
      after: { status: next, reason: why },
      referenceId: target.staffId,
      branchId: target.branchId,
    });
    await notify(ctx, profileId, {
      title: `Account ${next.toLowerCase()}`,
      body: why,
      kind: "SYSTEM",
    });
    return { ok: true };
  },
});

export const setPermissions = mutation({
  args: { profileId: v.id("profiles"), permissions: v.array(v.string()) },
  handler: async (ctx, { profileId, permissions }) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "staff_management");
    const target = await ctx.db.get(profileId);
    if (!target) throw new AppError("Staff not found.");
    const before = target.permissions ?? null;
    await ctx.db.patch(profileId, { permissions });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "PERMISSIONS_CHANGED",
      entity: "profiles",
      entityId: target.staffId,
      before: { permissions: before },
      after: { permissions },
      branchId: target.branchId,
    });
    return { ok: true };
  },
});

/** Change an APPROVED wallet limit (never the balance). */
export const setWalletLimit = mutation({
  args: { profileId: v.id("profiles"), walletLimit: v.number() },
  handler: async (ctx, { profileId, walletLimit }) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "wallet_management");
    const target = await ctx.db.get(profileId);
    if (!target) throw new AppError("Staff not found.");
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_profile", (q) => q.eq("profileId", profileId))
      .unique();
    if (!wallet) throw new AppError("This staff member has no wallet.");
    const limit = money(walletLimit, "walletLimit");
    const before = { walletLimit: wallet.walletLimit };
    await ctx.db.patch(wallet._id, { walletLimit: limit });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "WALLET_LIMIT_CHANGED",
      entity: "wallets",
      entityId: target.staffId,
      before,
      after: { walletLimit: limit },
      branchId: target.branchId,
    });
    await notify(ctx, profileId, {
      title: "Wallet limit updated",
      body: `Your approved working limit is now ₹${limit.toLocaleString("en-IN")}.`,
      kind: "WALLET",
    });
    return { ok: true };
  },
});
