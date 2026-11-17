/**
 * KIRAT MICRO CREDIT — INDEPENDENT SECURITY DEPARTMENT (backend)
 *
 * This module is a separate authorization universe from the KMC staff API:
 *
 *  - It never calls `requireProfile` / `requirePermission` and never reads a
 *    Convex Auth role. A SUPER_ADMIN JWT is not an accepted credential here.
 *  - Callers must present a Security Operator session token issued by this
 *    module. Tokens are 256-bit random values; only their SHA-256 hash is
 *    stored, and every function re-validates the operator row, its status,
 *    its permission list and its session version.
 *  - Pin/credential secrets use salted PBKDF2-HMAC-SHA256 (see
 *    lib/server/securityCrypto.ts), never the staff credential helpers.
 *  - Audit rows are insert-only and hash-chained (`prevHash` → `hash`), so
 *    edits or deletions are detectable by `audit.verify`.
 *
 * Staff device authorization (`registerDevice`) is the only function that
 * accepts a normal Convex identity, and it can only create/refresh a device
 * request — it can never approve, block, revoke or replace anything.
 */
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { AppError, getActor, makeCode, revokeUserSessions } from "../lib/server/convexHelpers";
import {
  auditHash,
  auditPayload,
  hashSecret,
  hashSessionToken,
  newRecoveryCode,
  newSessionToken,
  normalizeRecoveryCode,
  sha256Hex,
  verifySecret,
} from "../lib/server/securityCrypto";
import {
  SECURITY_PERMISSIONS,
  SECURITY_ROLE_PERMISSIONS,
  credentialPolicyError,
  pinPolicyError,
  type SecurityPermission,
} from "../lib/security/permissions";

type Ctx = QueryCtx | MutationCtx;

const SINGLETON = "kmc-security";
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_MINUTES = 45;
const MAX_SESSION_MINUTES = 480;
const MAX_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

const OPERATOR_ID_RE = /^[A-Z0-9][A-Z0-9-]{2,19}$/;

/* ------------------------------- helpers --------------------------------- */

async function readConfig(ctx: Ctx): Promise<Doc<"securityConfig"> | null> {
  return await ctx.db
    .query("securityConfig")
    .withIndex("by_singleton", (q) => q.eq("singleton", SINGLETON))
    .unique();
}

async function listOperators(ctx: Ctx): Promise<Doc<"securityOperators">[]> {
  return await ctx.db.query("securityOperators").collect();
}

function minutesLeft(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 60000));
}

function operatorIdOf(value: string): string {
  return value.trim().toUpperCase();
}

function operatorState(o: Doc<"securityOperators">): string {
  return JSON.stringify({
    operatorId: o.operatorId,
    name: o.name,
    role: o.role,
    status: o.status,
    permissions: o.permissions,
    sessionVersion: o.sessionVersion,
  });
}

function deviceState(d: Doc<"securityDevices">): string {
  return JSON.stringify({
    status: d.status,
    staffId: d.staffId ?? null,
    profileId: d.profileId,
    fingerprint: d.fingerprint.slice(0, 12),
    decidedBy: d.decidedBy ?? null,
    reason: d.reason ?? null,
  });
}

/** Append-only audit row with a hash chain over the previous row. */
async function appendAudit(
  ctx: MutationCtx,
  entry: {
    operatorId: string;
    operatorName: string;
    action: string;
    targetType: string;
    targetId: string;
    previousState?: string;
    newState?: string;
    reason?: string;
    eventRef?: string;
    ip?: string;
  },
): Promise<{ ref: string; at: number }> {
  const last = await ctx.db
    .query("securityAudit")
    .withIndex("by_seq")
    .order("desc")
    .first();
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? "GENESIS";
  const at = Date.now();
  const ref = `SEC-${String(seq).padStart(6, "0")}`;
  const payload = auditPayload({
    seq,
    ref,
    operatorId: entry.operatorId,
    operatorName: entry.operatorName,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    previousState: entry.previousState ?? "",
    newState: entry.newState ?? "",
    reason: entry.reason ?? "",
    eventRef: entry.eventRef ?? "",
    ip: entry.ip ?? "unavailable",
    at,
  });
  const hash = await auditHash(prevHash, payload);
  await ctx.db.insert("securityAudit", {
    seq,
    ref,
    operatorId: entry.operatorId,
    operatorName: entry.operatorName,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    previousState: entry.previousState ?? "",
    newState: entry.newState ?? "",
    reason: entry.reason ?? "",
    eventRef: entry.eventRef ?? "",
    ip: entry.ip ?? "unavailable",
    at,
    prevHash,
    hash,
  });
  return { ref, at };
}

async function logEvent(
  ctx: MutationCtx,
  entry: {
    kind: string;
    deviceKey: string;
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
    detail: entry.detail,
    actor: entry.actor,
    at: Date.now(),
  });
  return ref;
}

async function recordAttempt(
  ctx: MutationCtx,
  entry: {
    kind: "ACTIVATION" | "LOGIN" | "RECOVERY";
    outcome: "SUCCESS" | "FAILED" | "LOCKED";
    operatorId?: string;
    ip?: string;
    userAgent?: string;
    detail?: string;
  },
): Promise<void> {
  await ctx.db.insert("securityLoginAttempts", { ...entry, at: Date.now() });
}

function sessionMinutes(cfg: Doc<"securityConfig"> | null): number {
  const v = cfg?.sessionPolicyMinutes ?? DEFAULT_SESSION_MINUTES;
  return Math.min(MAX_SESSION_MINUTES, Math.max(5, v));
}

interface SessionGrant {
  session: Doc<"securitySessions">;
  operator: Doc<"securityOperators">;
  permissions: SecurityPermission[];
}

async function issueSession(
  ctx: MutationCtx,
  args: {
    operator: Doc<"securityOperators">;
    mode: "BOOTSTRAP" | "FULL" | "ROTATION";
    permissions: readonly string[];
    ip?: string;
    userAgent?: string;
  },
): Promise<{ token: string; expiresAt: number }> {
  const cfg = await readConfig(ctx);
  const now = Date.now();
  const { token, tokenHash } = await newSessionToken();
  const expiresAt = now + sessionMinutes(cfg) * 60000;
  await ctx.db.insert("securitySessions", {
    tokenHash,
    operatorRef: args.operator._id,
    operatorId: args.operator.operatorId,
    mode: args.mode,
    permissions: [...args.permissions],
    issuedAt: now,
    expiresAt,
    lastSeenAt: now,
    ip: args.ip,
    userAgent: args.userAgent,
    sessionVersion: args.operator.sessionVersion,
  });
  return { token, expiresAt };
}

/**
 * Validate a Security Operator session token. Throws unless the token exists,
 * is unexpired/unrevoked/idle within policy, the operator is ACTIVE and the
 * session was issued for the operator's current session version.
 */
async function authenticate(
  ctx: Ctx,
  token: string,
  opts: { permission?: SecurityPermission; allowBootstrap?: boolean } = {},
): Promise<SessionGrant> {
  const raw = token?.trim();
  if (!raw) throw new AppError("Security session required.");
  const tokenHash = await hashSessionToken(raw);
  const session = await ctx.db
    .query("securitySessions")
    .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!session) throw new AppError("Security session invalid. Sign in again.");
  const now = Date.now();
  if (session.revokedAt) {
    throw new AppError("This security session was revoked. Sign in again.");
  }
  if (session.expiresAt <= now) {
    throw new AppError("Security session expired. Sign in again.");
  }
  const cfg = await readConfig(ctx);
  const idleLimit = (sessionMinutes(cfg) + 5) * 60000;
  if (now - session.lastSeenAt > idleLimit) {
    throw new AppError("Security session timed out. Sign in again.");
  }
  if (session.mode === "BOOTSTRAP") {
    if (!opts.allowBootstrap) {
      throw new AppError("Finish security activation before using the portal.");
    }
    const bootstrapOperator: Doc<"securityOperators"> = {
      _id: "bootstrap" as Id<"securityOperators">,
      _creationTime: session.issuedAt,
      operatorId: "BOOTSTRAP",
      name: "Activation session",
      credentialHash: "",
      role: "SECURITY_ADMIN",
      permissions: ["security.credentials.rotate"],
      status: "ACTIVE",
      createdAt: session.issuedAt,
      createdBy: "SYSTEM",
      sessionVersion: session.sessionVersion,
      failedAttempts: 0,
      mustRotateCredential: true,
    };
    return {
      session,
      operator: bootstrapOperator,
      permissions: ["security.credentials.rotate"],
    };
  }
  const operator = await ctx.db.get(session.operatorRef as Id<"securityOperators">);
  if (!operator) throw new AppError("Security operator no longer exists.");
  if (operator.status !== "ACTIVE") {
    throw new AppError("This security operator account is not active.");
  }
  if (operator.sessionVersion !== session.sessionVersion) {
    throw new AppError("This security session was invalidated. Sign in again.");
  }
  if (session.mode !== "BOOTSTRAP" && opts.permission) {
    if (!operator.permissions.includes(opts.permission)) {
      throw new AppError(
        `Security permission denied: "${opts.permission}".`,
      );
    }
    if (!session.permissions.includes(opts.permission)) {
      throw new AppError("This security session does not carry that permission.");
    }
  }
  if (session.mode === "ROTATION" && !opts.allowBootstrap) {
    throw new AppError("Set a new operator credential before continuing.");
  }
  return {
    session,
    operator,
    permissions: operator.permissions.filter((p) =>
      session.permissions.includes(p),
    ) as SecurityPermission[],
  };
}

/** Slide the expiry forward on every authenticated mutation (idle timeout). */
async function touchSession(
  ctx: MutationCtx,
  session: Doc<"securitySessions">,
  cfg: Doc<"securityConfig"> | null,
  ip?: string,
): Promise<void> {
  const now = Date.now();
  const expiresAt = Math.min(
    session.issuedAt + MAX_SESSION_LIFETIME_MS,
    now + sessionMinutes(cfg) * 60000,
  );
  await ctx.db.patch(session._id, {
    lastSeenAt: now,
    expiresAt: Math.max(session.expiresAt, expiresAt),
    ...(ip ? { ip } : {}),
  });
}

/** Additional verification for sensitive operations. */
async function confirmOperator(
  operator: Doc<"securityOperators">,
  credential: string | undefined,
): Promise<void> {
  const ok = await verifySecret((credential ?? "").trim(), operator.credentialHash);
  if (!ok) {
    throw new AppError(
      "Additional verification failed: re-enter your security credential.",
    );
  }
}

function bumpFailure(failed: number): { failedAttempts: number; lockedUntil?: number } {
  const next = failed + 1;
  if (next >= MAX_FAILURES) {
    return { failedAttempts: 0, lockedUntil: Date.now() + LOCK_MS };
  }
  return { failedAttempts: next };
}

/**
 * Kill every Convex Auth session for a staff profile (immediate session
 * invalidation on block/revoke/replace). Device rows reference the PROFILE, so
 * resolve its linked sign-in user first.
 */
async function revokeStaffSessions(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
): Promise<number> {
  const profile = await ctx.db.get(profileId);
  if (!profile?.userId) return 0;
  return await revokeUserSessions(ctx, profile.userId);
}

async function revokeOperatorSessions(
  ctx: MutationCtx,
  operatorRef: string,
  reason: string,
  exceptSessionId?: string,
): Promise<void> {
  const sessions = await ctx.db
    .query("securitySessions")
    .withIndex("by_operator", (q) => q.eq("operatorRef", operatorRef))
    .collect();
  for (const s of sessions) {
    if (s._id === exceptSessionId || s.revokedAt) continue;
    await ctx.db.patch(s._id, { revokedAt: Date.now(), revokedReason: reason });
  }
}

/* --------------------------- activation / login --------------------------- */

/** Safe, secret-free status for the login screen. */
export const bootstrapState = query({
  args: {},
  handler: async (ctx) => {
    const cfg = await readConfig(ctx);
    const operators = await listOperators(ctx);
    const now = Date.now();
    return {
      provisioned: !!cfg?.bootstrapPinHash,
      initialized: !!cfg?.pinHash,
      activated:
        !!cfg?.bootstrapUsedAt && operators.some((o) => o.status === "ACTIVE"),
      bootstrapAvailable:
        !!cfg?.bootstrapPinHash && !cfg.bootstrapUsedAt && operators.length === 0,
      recoveryAvailable: !!cfg?.recoveryHash,
      lockedUntil: cfg?.lockedUntil && cfg.lockedUntil > now ? cfg.lockedUntil : null,
      sessionPolicyMinutes: sessionMinutes(cfg),
    };
  },
});

/** Step 1 of first-run activation: verify the one-time bootstrap PIN. */
export const beginActivation = mutation({
  args: {
    activationPin: v.string(),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const cfg = await readConfig(ctx);
    const operators = await listOperators(ctx);
    if (cfg?.bootstrapUsedAt || operators.length > 0) {
      throw new AppError(
        "This deployment is already activated. The one-time activation PIN no longer works.",
      );
    }
    if (!cfg || !cfg.bootstrapPinHash) {
      throw new AppError(
        "Security Department is not provisioned on this deployment yet.",
      );
    }
    if (cfg.lockedUntil && cfg.lockedUntil > now) {
      throw new AppError(
        `Activation is locked. Try again in ${minutesLeft(cfg.lockedUntil, now)} minute(s).`,
      );
    }
    const ok = await verifySecret(args.activationPin.trim(), cfg.bootstrapPinHash);
    if (!ok) {
      const next = bumpFailure(cfg.failedAttempts);
      await ctx.db.patch(cfg._id, { ...next, lastFailedAt: now, updatedAt: now });
      await recordAttempt(ctx, {
        kind: "ACTIVATION",
        outcome: next.lockedUntil ? "LOCKED" : "FAILED",
        ip: args.ip,
        userAgent: args.userAgent,
        detail: next.lockedUntil ? "Activation locked after repeated failures" : undefined,
      });
      await appendAudit(ctx, {
        operatorId: "SYSTEM",
        operatorName: "Activation guard",
        action: "SECURITY_ACTIVATION_FAILED",
        targetType: "securityConfig",
        targetId: SINGLETON,
        previousState: JSON.stringify({ failedAttempts: cfg.failedAttempts }),
        newState: JSON.stringify({ failedAttempts: next.failedAttempts }),
        reason: next.lockedUntil ? "Locked after repeated failures" : "Wrong activation PIN",
        ip: args.ip,
      });
      throw new AppError(
        next.lockedUntil
          ? "Wrong activation PIN. Activation is locked for 15 minutes."
          : "Wrong activation PIN.",
      );
    }
    await ctx.db.patch(cfg._id, {
      failedAttempts: 0,
      lockedUntil: undefined,
      updatedAt: now,
    });
    // A bootstrap session may only complete activation — nothing else.
    const bootstrapOperator: Doc<"securityOperators"> = {
      _id: "bootstrap" as Id<"securityOperators">,
      _creationTime: now,
      operatorId: "BOOTSTRAP",
      name: "Activation session",
      credentialHash: "",
      role: "SECURITY_ADMIN",
      permissions: ["security.credentials.rotate"],
      status: "ACTIVE",
      createdAt: now,
      createdBy: "SYSTEM",
      sessionVersion: 0,
      failedAttempts: 0,
      mustRotateCredential: true,
    };
    const { token, expiresAt } = await issueSession(ctx, {
      operator: bootstrapOperator,
      mode: "BOOTSTRAP",
      permissions: ["security.credentials.rotate"],
      ip: args.ip,
      userAgent: args.userAgent,
    });
    await recordAttempt(ctx, {
      kind: "ACTIVATION",
      outcome: "SUCCESS",
      ip: args.ip,
      userAgent: args.userAgent,
      detail: "Bootstrap PIN accepted",
    });
    return { token, expiresAt, mustChangePin: true };
  },
});

/**
 * Step 2: set the real department PIN, create the first operator and issue the
 * one-time recovery code. Until this completes, no device/operator/audit
 * operation is reachable.
 */
export const completeActivation = mutation({
  args: {
    token: v.string(),
    newPin: v.string(),
    confirmPin: v.string(),
    operatorId: v.string(),
    operatorName: v.string(),
    credential: v.string(),
    confirmCredential: v.string(),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, { allowBootstrap: true });
    if (grant.session.mode !== "BOOTSTRAP") {
      throw new AppError("Activation already completed.");
    }
    const cfg = await readConfig(ctx);
    if (!cfg) throw new AppError("Security Department is not provisioned.");
    const pinError = pinPolicyError(args.newPin);
    if (pinError) throw new AppError(pinError);
    if (args.newPin !== args.confirmPin) throw new AppError("PINs do not match.");
    const credError = credentialPolicyError(args.credential);
    if (credError) throw new AppError(credError);
    if (args.credential !== args.confirmCredential) {
      throw new AppError("Credentials do not match.");
    }
    if (args.credential.trim() === args.newPin) {
      throw new AppError("Credential must differ from the department PIN.");
    }
    const operatorId = operatorIdOf(args.operatorId);
    if (!OPERATOR_ID_RE.test(operatorId)) {
      throw new AppError(
        "Operator ID must be 3–20 uppercase letters/digits (dashes allowed).",
      );
    }
    const name = args.operatorName.trim();
    if (name.length < 3 || name.length > 60) {
      throw new AppError("Operator name must be 3–60 characters.");
    }
    const existing = await listOperators(ctx);
    if (existing.some((o) => o.operatorId === operatorId)) {
      throw new AppError("That operator ID is already registered.");
    }

    const now = Date.now();
    const recoveryCode = newRecoveryCode();
    const recoveryHash = await hashSecret(normalizeRecoveryCode(recoveryCode));
    const operatorRef = await ctx.db.insert("securityOperators", {
      operatorId,
      name,
      credentialHash: await hashSecret(args.credential.trim()),
      role: "SECURITY_ADMIN",
      permissions: [...SECURITY_ROLE_PERMISSIONS.SECURITY_ADMIN],
      status: "ACTIVE",
      createdAt: now,
      createdBy: "ACTIVATION",
      sessionVersion: 1,
      failedAttempts: 0,
      mustRotateCredential: false,
      credentialUpdatedAt: now,
      notes: "Created from the one-time Security Department activation.",
    });
    await ctx.db.patch(cfg._id, {
      pinHash: await hashSecret(args.newPin),
      pinVersion: cfg.pinVersion + 1,
      pinChangedAt: now,
      mustChangePin: false,
      bootstrapUsedAt: now,
      bootstrapPinHash: undefined,
      recoveryHash,
      recoveryIssuedAt: now,
      failedAttempts: 0,
      lockedUntil: undefined,
      updatedAt: now,
      updatedBy: operatorId,
    });
    const operator = await ctx.db.get(operatorRef);
    if (!operator) throw new AppError("Could not create the security operator.");
    await ctx.db.patch(grant.session._id, {
      revokedAt: now,
      revokedReason: "Activation completed",
    });
    const session = await issueSession(ctx, {
      operator,
      mode: "FULL",
      permissions: operator.permissions,
      ip: args.ip,
      userAgent: args.userAgent,
    });
    await appendAudit(ctx, {
      operatorId,
      operatorName: name,
      action: "SECURITY_ACTIVATION_COMPLETED",
      targetType: "securityConfig",
      targetId: SINGLETON,
      previousState: JSON.stringify({ initialized: false }),
      newState: JSON.stringify({ initialized: true, pinVersion: cfg.pinVersion + 1 }),
      reason: "First-run activation",
      ip: args.ip,
    });
    await appendAudit(ctx, {
      operatorId,
      operatorName: name,
      action: "SECURITY_OPERATOR_CREATED",
      targetType: "securityOperator",
      targetId: operatorId,
      newState: operatorState(operator),
      reason: "Bootstrap administrator",
      ip: args.ip,
    });
    await recordAttempt(ctx, {
      kind: "ACTIVATION",
      outcome: "SUCCESS",
      operatorId,
      ip: args.ip,
      userAgent: args.userAgent,
      detail: "Portal activated and first operator created",
    });
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      recoveryCode,
      operator: {
        operatorId: operator.operatorId,
        name: operator.name,
        role: operator.role,
      },
    };
  },
});

interface LoginResult {
  ok: boolean;
  message?: string;
  token?: string;
  expiresAt?: number;
  mustRotateCredential?: boolean;
  operator?: { operatorId: string; name: string; role: string };
}

async function loginCore(
  ctx: MutationCtx,
  args: {
    operatorId: string;
    credential: string;
    pin: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<LoginResult> {
  const now = Date.now();
  const cfg = await readConfig(ctx);
  if (!cfg || !cfg.pinHash) {
    return {
      ok: false,
      message: "Security Department is not activated on this deployment.",
    };
  }
  if (cfg.lockedUntil && cfg.lockedUntil > now) {
    return {
      ok: false,
      message: `Security Department is locked. Try again in ${minutesLeft(cfg.lockedUntil, now)} minute(s).`,
    };
  }
  const operatorId = operatorIdOf(args.operatorId);
  const operators = await listOperators(ctx);
  const operator = operators.find((o) => o.operatorId === operatorId) ?? null;
  if (operator?.lockedUntil && operator.lockedUntil > now) {
    return {
      ok: false,
      message: `This operator is locked. Try again in ${minutesLeft(operator.lockedUntil, now)} minute(s).`,
    };
  }

  // Verify both factors (no short-circuit) so a failure never reveals which
  // one was wrong.
  const pinOk = await verifySecret(args.pin.trim(), cfg.pinHash);
  const credentialOk = operator
    ? await verifySecret(args.credential.trim(), operator.credentialHash)
    : false;
  if (!operator || operator.status !== "ACTIVE" || !pinOk || !credentialOk) {
    const next = bumpFailure(cfg.failedAttempts);
    await ctx.db.patch(cfg._id, { ...next, lastFailedAt: now });
    let operatorLocked = false;
    if (operator) {
      const opNext = bumpFailure(operator.failedAttempts);
      operatorLocked = !!opNext.lockedUntil;
      await ctx.db.patch(operator._id, opNext);
    }
    await recordAttempt(ctx, {
      kind: "LOGIN",
      outcome: next.lockedUntil ? "LOCKED" : "FAILED",
      operatorId: operatorId || undefined,
      ip: args.ip,
      userAgent: args.userAgent,
      detail: !operator
        ? "Unknown operator ID"
        : operator.status !== "ACTIVE"
          ? "Operator not active"
          : "Wrong PIN or credential",
    });
    await appendAudit(ctx, {
      operatorId: operatorId || "UNKNOWN",
      operatorName: operator?.name ?? "Unknown operator",
      action: "SECURITY_LOGIN_FAILED",
      targetType: "securityPortal",
      targetId: operatorId || "unknown",
      reason: "Invalid credentials",
      ip: args.ip,
    });
    const locked = next.lockedUntil || operatorLocked;
    return {
      ok: false,
      message: locked
        ? "Too many failed attempts — Security Department locked for 15 minutes."
        : "Invalid Security Department credentials.",
    };
  }

  await ctx.db.patch(cfg._id, {
    failedAttempts: 0,
    lockedUntil: undefined,
    updatedAt: now,
  });
  await ctx.db.patch(operator._id, {
    failedAttempts: 0,
    lockedUntil: undefined,
    lastLoginAt: now,
  });
  const mode = operator.mustRotateCredential ? "ROTATION" : "FULL";
  const permissions = operator.mustRotateCredential
    ? ["security.credentials.rotate"]
    : operator.permissions;
  const { token, expiresAt } = await issueSession(ctx, {
    operator,
    mode,
    permissions,
    ip: args.ip,
    userAgent: args.userAgent,
  });
  await recordAttempt(ctx, {
    kind: "LOGIN",
    outcome: "SUCCESS",
    operatorId,
    ip: args.ip,
    userAgent: args.userAgent,
  });
  await appendAudit(ctx, {
    operatorId,
    operatorName: operator.name,
    action: "SECURITY_LOGIN",
    targetType: "securityPortal",
    targetId: operatorId,
    newState: JSON.stringify({ mode }),
    reason: "Successful sign-in",
    ip: args.ip,
  });
  return {
    ok: true,
    token,
    expiresAt,
    mustRotateCredential: operator.mustRotateCredential,
    operator: {
      operatorId: operator.operatorId,
      name: operator.name,
      role: operator.role,
    },
  };
}

/** Public entry point (no IP capture — used when the HTTP edge is unavailable). */
export const login = mutation({
  args: {
    operatorId: v.string(),
    credential: v.string(),
    pin: v.string(),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => await loginCore(ctx, args),
});

/** Used by the `/security/login` HTTP action so the edge-supplied IP is real. */
export const loginInternal = internalMutation({
  args: {
    operatorId: v.string(),
    credential: v.string(),
    pin: v.string(),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => await loginCore(ctx, args),
});

/** Current session + operator, or null. Never returns a secret. */
export const session = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    let grant: SessionGrant;
    try {
      grant = await authenticate(ctx, args.token, { allowBootstrap: true });
    } catch {
      return null;
    }
    const cfg = await readConfig(ctx);
    const op = grant.operator;
    const isBootstrap = grant.session.mode === "BOOTSTRAP";
    return {
      mode: grant.session.mode,
      expiresAt: grant.session.expiresAt,
      mustChangePin: cfg?.mustChangePin ?? false,
      pinChangedAt: cfg?.pinChangedAt ?? null,
      sessionPolicyMinutes: sessionMinutes(cfg),
      recoveryConfigured: !!cfg?.recoveryHash,
      operator: isBootstrap
        ? null
        : {
            operatorId: op.operatorId,
            name: op.name,
            role: op.role,
            status: op.status,
            permissions: grant.permissions,
            mustRotateCredential: op.mustRotateCredential,
            lastLoginAt: op.lastLoginAt ?? null,
            credentialUpdatedAt: op.credentialUpdatedAt ?? null,
          },
    };
  },
});

export const logout = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    try {
      const grant = await authenticate(ctx, args.token, { allowBootstrap: true });
      await ctx.db.patch(grant.session._id, {
        revokedAt: Date.now(),
        revokedReason: "Signed out",
      });
      if (grant.session.mode !== "BOOTSTRAP") {
        await appendAudit(ctx, {
          operatorId: grant.operator.operatorId,
          operatorName: grant.operator.name,
          action: "SECURITY_LOGOUT",
          targetType: "securitySession",
          targetId: grant.session._id,
          reason: "Signed out",
        });
      }
    } catch {
      // Logout is idempotent: an expired token is already unusable.
    }
    return { ok: true };
  },
});

/** Replace the signed-in operator's own credential (also exits ROTATION mode). */
export const rotateOperatorCredential = mutation({
  args: {
    token: v.string(),
    currentCredential: v.string(),
    newCredential: v.string(),
    confirmCredential: v.string(),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, { allowBootstrap: true });
    if (grant.session.mode === "BOOTSTRAP") {
      throw new AppError("Finish activation first.");
    }
    const op = grant.operator;
    if (!(await verifySecret(args.currentCredential.trim(), op.credentialHash))) {
      throw new AppError("Current credential is incorrect.");
    }
    const error = credentialPolicyError(args.newCredential);
    if (error) throw new AppError(error);
    if (args.newCredential !== args.confirmCredential) {
      throw new AppError("New credentials do not match.");
    }
    if (args.newCredential.trim() === args.currentCredential.trim()) {
      throw new AppError("New credential must differ from the current one.");
    }
    const now = Date.now();
    const sessionVersion = op.sessionVersion + 1;
    await ctx.db.patch(op._id, {
      credentialHash: await hashSecret(args.newCredential.trim()),
      credentialUpdatedAt: now,
      mustRotateCredential: false,
      sessionVersion,
    });
    // Invalidate every other session for this operator, then re-issue ours.
    await revokeOperatorSessions(ctx, op._id, "Credential rotated", grant.session._id);
    await ctx.db.patch(grant.session._id, { revokedAt: now, revokedReason: "Credential rotated" });
    const updated = await ctx.db.get(op._id);
    if (!updated) throw new AppError("Operator disappeared.");
    const session = await issueSession(ctx, {
      operator: updated,
      mode: "FULL",
      permissions: updated.permissions,
      ip: args.ip,
      userAgent: args.userAgent,
    });
    await appendAudit(ctx, {
      operatorId: op.operatorId,
      operatorName: op.name,
      action: "SECURITY_OPERATOR_CREDENTIAL_ROTATED",
      targetType: "securityOperator",
      targetId: op.operatorId,
      previousState: JSON.stringify({ credentialUpdatedAt: op.credentialUpdatedAt ?? null }),
      newState: JSON.stringify({ credentialUpdatedAt: now }),
      reason: "Self-service credential rotation",
      ip: args.ip,
    });
    return { token: session.token, expiresAt: session.expiresAt };
  },
});

/** Rotate the department PIN. Revokes every security session, issues a new one. */
export const changePin = mutation({
  args: {
    token: v.string(),
    currentPin: v.string(),
    newPin: v.string(),
    confirmPin: v.string(),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.credentials.rotate",
    });
    const cfg = await readConfig(ctx);
    if (!cfg?.pinHash) throw new AppError("Security PIN is not configured.");
    if (!(await verifySecret(args.currentPin.trim(), cfg.pinHash))) {
      throw new AppError("Current security PIN is incorrect.");
    }
    const error = pinPolicyError(args.newPin);
    if (error) throw new AppError(error);
    if (args.newPin !== args.confirmPin) throw new AppError("PINs do not match.");
    if (await verifySecret(args.newPin, grant.operator.credentialHash)) {
      throw new AppError("PIN must differ from your operator credential.");
    }
    const now = Date.now();
    const pinVersion = cfg.pinVersion + 1;
    await ctx.db.patch(cfg._id, {
      pinHash: await hashSecret(args.newPin),
      pinVersion,
      pinChangedAt: now,
      mustChangePin: false,
      failedAttempts: 0,
      lockedUntil: undefined,
      updatedAt: now,
      updatedBy: grant.operator.operatorId,
    });
    // Every other security session dies with the old PIN.
    const sessions = await ctx.db.query("securitySessions").collect();
    for (const s of sessions) {
      if (s._id === grant.session._id || s.revokedAt) continue;
      await ctx.db.patch(s._id, {
        revokedAt: now,
        revokedReason: "Security PIN rotated",
      });
    }
    const session = await issueSession(ctx, {
      operator: grant.operator,
      mode: "FULL",
      permissions: grant.operator.permissions,
      ip: args.ip,
      userAgent: args.userAgent,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "SECURITY_PIN_CHANGED",
      targetType: "securityConfig",
      targetId: SINGLETON,
      previousState: JSON.stringify({ pinVersion: cfg.pinVersion }),
      newState: JSON.stringify({ pinVersion }),
      reason: "Department PIN rotation",
      ip: args.ip,
    });
    return { token: session.token, expiresAt: session.expiresAt };
  },
});

/* ------------------------------ dashboard -------------------------------- */

export const dashboard = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await authenticate(ctx, args.token, { permission: "security.portal.access" });
    const now = Date.now();
    const [devices, events, incidents, operators, cfg, attempts] = await Promise.all([
      ctx.db.query("securityDevices").collect(),
      ctx.db.query("securityDeviceEvents").withIndex("by_at").order("desc").take(40),
      ctx.db.query("securityIncidents").collect(),
      ctx.db.query("securityOperators").collect(),
      readConfig(ctx),
      ctx.db.query("securityLoginAttempts").withIndex("by_at").order("desc").take(40),
    ]);
    const count = (status: string) => devices.filter((d) => d.status === status).length;
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const audit = await ctx.db
      .query("securityAudit")
      .withIndex("by_seq")
      .order("desc")
      .take(10);
    return {
      generatedAt: now,
      devices: {
        authorized: count("AUTHORIZED"),
        pending: count("PENDING"),
        blocked: count("BLOCKED"),
        revoked: count("REVOKED") + count("REPLACED"),
        rejected: count("REJECTED"),
        total: devices.length,
      },
      unauthorizedAttempts24h: events.filter(
        (e) => e.kind === "UNAUTHORIZED_ATTEMPT" && e.at >= dayAgo,
      ).length,
      unauthorizedAttempts: events
        .filter((e) => e.kind === "UNAUTHORIZED_ATTEMPT")
        .slice(0, 10),
      incidents: {
        open: incidents.filter((i) => i.status !== "CLOSED").length,
        total: incidents.length,
        recent: incidents
          .slice()
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 5),
      },
      operators: {
        active: operators.filter((o) => o.status === "ACTIVE").length,
        total: operators.length,
        failedLogins24h: attempts.filter(
          (a) => a.outcome !== "SUCCESS" && a.at >= dayAgo,
        ).length,
      },
      recentEvents: events.slice(0, 12),
      recentAudit: audit,
      config: {
        pinChangedAt: cfg?.pinChangedAt ?? null,
        sessionPolicyMinutes: sessionMinutes(cfg),
        lockedUntil: cfg?.lockedUntil ?? null,
        recoveryConfigured: !!cfg?.recoveryHash,
      },
    };
  },
});

/* --------------------------- device authorization ------------------------- */

export const devices = query({
  args: { token: v.string(), status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await authenticate(ctx, args.token, { permission: "security.devices.read" });
    const all = await ctx.db.query("securityDevices").collect();
    const rows = (args.status ? all.filter((d) => d.status === args.status) : all)
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
      fingerprint: d.fingerprint,
      fingerprintShort: `${d.fingerprint.slice(0, 8)}…${d.fingerprint.slice(-4)}`,
      status: d.status,
      priorStatus: d.priorStatus ?? null,
      source: d.source,
      requestedAt: d.requestedAt,
      lastSeenAt: d.lastSeenAt,
      decidedAt: d.decidedAt ?? null,
      decidedBy: d.decidedBy ?? null,
      reason: d.reason ?? null,
      ip: d.ip ?? null,
      userAgent: d.userAgent ?? null,
      multipleAuthorized: (conflict.get(d.profileId) ?? 0) > 1,
    }));
  },
});

async function deviceById(
  ctx: MutationCtx,
  deviceId: Id<"securityDevices">,
): Promise<Doc<"securityDevices">> {
  const device = await ctx.db.get(deviceId);
  if (!device) throw new AppError("Device record not found.");
  return device;
}

export const approveDevice = mutation({
  args: {
    token: v.string(),
    deviceId: v.id("securityDevices"),
    reason: v.optional(v.string()),
    replaceActive: v.optional(v.boolean()),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.devices.approve",
    });
    const device = await deviceById(ctx, args.deviceId);
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
    const active = siblings.filter(
      (d) => d.status === "AUTHORIZED" && d._id !== device._id,
    );
    if (active.length > 0 && !args.replaceActive) {
      throw new AppError(
        `${device.staffName} already has an authorized device. Use Replace to move authorization.`,
      );
    }
    const now = Date.now();
    const before = deviceState(device);
    for (const old of active) {
      await ctx.db.patch(old._id, {
        status: "REPLACED",
        decidedAt: now,
        decidedBy: grant.operator.operatorId,
        reason: args.reason ?? "Replaced during device approval",
      });
      await logEvent(ctx, {
        kind: "DEVICE_REPLACED",
        deviceKey: old.deviceKey,
        profileId: old.profileId,
        staffId: old.staffId,
        staffName: old.staffName,
        detail: `Device replaced by ${grant.operator.operatorId} during approval`,
        actor: grant.operator.operatorId,
      });
    }
    await ctx.db.patch(device._id, {
      status: "AUTHORIZED",
      priorStatus: undefined,
      source: active.length > 0 ? "REPLACEMENT" : "SECURITY_APPROVAL",
      decidedAt: now,
      decidedBy: grant.operator.operatorId,
      reason: args.reason,
    });
    const updated = await deviceById(ctx, device._id);
    const eventRef = await logEvent(ctx, {
      kind: "DEVICE_APPROVED",
      deviceKey: device.deviceKey,
      profileId: device.profileId,
      staffId: device.staffId,
      staffName: device.staffName,
      ip: args.ip,
      detail: `Approved by ${grant.operator.operatorId}`,
      actor: grant.operator.operatorId,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "DEVICE_APPROVED",
      targetType: "securityDevice",
      targetId: device.deviceKey,
      previousState: before,
      newState: deviceState(updated),
      reason: args.reason ?? "",
      eventRef,
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true, eventRef };
  },
});

export const rejectDevice = mutation({
  args: {
    token: v.string(),
    deviceId: v.id("securityDevices"),
    reason: v.string(),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.devices.approve",
    });
    const device = await deviceById(ctx, args.deviceId);
    if (device.status !== "PENDING") {
      throw new AppError("Only pending device requests can be rejected.");
    }
    const before = deviceState(device);
    const now = Date.now();
    await ctx.db.patch(device._id, {
      status: "REJECTED",
      decidedAt: now,
      decidedBy: grant.operator.operatorId,
      reason: args.reason,
    });
    const updated = await deviceById(ctx, device._id);
    const eventRef = await logEvent(ctx, {
      kind: "DEVICE_REJECTED",
      deviceKey: device.deviceKey,
      profileId: device.profileId,
      staffId: device.staffId,
      staffName: device.staffName,
      ip: args.ip,
      detail: args.reason,
      actor: grant.operator.operatorId,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "DEVICE_REJECTED",
      targetType: "securityDevice",
      targetId: device.deviceKey,
      previousState: before,
      newState: deviceState(updated),
      reason: args.reason,
      eventRef,
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true };
  },
});

export const blockDevice = mutation({
  args: {
    token: v.string(),
    deviceId: v.id("securityDevices"),
    reason: v.string(),
    confirmCredential: v.string(),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.devices.block",
    });
    await confirmOperator(grant.operator, args.confirmCredential);
    const device = await deviceById(ctx, args.deviceId);
    const before = deviceState(device);
    const now = Date.now();
    await ctx.db.patch(device._id, {
      status: "BLOCKED",
      priorStatus: device.status,
      decidedAt: now,
      decidedBy: grant.operator.operatorId,
      reason: args.reason,
    });
    const sessions = await revokeStaffSessions(ctx, device.profileId);
    const updated = await deviceById(ctx, device._id);
    const eventRef = await logEvent(ctx, {
      kind: "DEVICE_BLOCKED",
      deviceKey: device.deviceKey,
      profileId: device.profileId,
      staffId: device.staffId,
      staffName: device.staffName,
      ip: args.ip,
      detail: `${args.reason} — ${sessions} staff session(s) invalidated`,
      actor: grant.operator.operatorId,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "DEVICE_BLOCKED",
      targetType: "securityDevice",
      targetId: device.deviceKey,
      previousState: before,
      newState: deviceState(updated),
      reason: args.reason,
      eventRef,
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true, sessionsRevoked: sessions };
  },
});

export const unblockDevice = mutation({
  args: {
    token: v.string(),
    deviceId: v.id("securityDevices"),
    reason: v.optional(v.string()),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.devices.block",
    });
    const device = await deviceById(ctx, args.deviceId);
    if (device.status !== "BLOCKED") {
      throw new AppError("Only blocked devices can be unblocked.");
    }
    const before = deviceState(device);
    const restore =
      device.priorStatus === "AUTHORIZED" || device.priorStatus === "PENDING"
        ? device.priorStatus
        : "PENDING";
    await ctx.db.patch(device._id, {
      status: restore,
      priorStatus: undefined,
      decidedAt: Date.now(),
      decidedBy: grant.operator.operatorId,
      reason: args.reason ?? undefined,
    });
    const updated = await deviceById(ctx, device._id);
    const eventRef = await logEvent(ctx, {
      kind: "DEVICE_UNBLOCKED",
      deviceKey: device.deviceKey,
      profileId: device.profileId,
      staffId: device.staffId,
      staffName: device.staffName,
      ip: args.ip,
      detail: `Unblocked by ${grant.operator.operatorId} → ${restore}`,
      actor: grant.operator.operatorId,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "DEVICE_UNBLOCKED",
      targetType: "securityDevice",
      targetId: device.deviceKey,
      previousState: before,
      newState: deviceState(updated),
      reason: args.reason ?? "",
      eventRef,
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true, status: restore };
  },
});

export const revokeDevice = mutation({
  args: {
    token: v.string(),
    deviceId: v.id("securityDevices"),
    reason: v.string(),
    confirmCredential: v.string(),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.devices.revoke",
    });
    await confirmOperator(grant.operator, args.confirmCredential);
    const device = await deviceById(ctx, args.deviceId);
    const before = deviceState(device);
    await ctx.db.patch(device._id, {
      status: "REVOKED",
      priorStatus: device.status,
      decidedAt: Date.now(),
      decidedBy: grant.operator.operatorId,
      reason: args.reason,
    });
    const sessions = await revokeStaffSessions(ctx, device.profileId);
    const updated = await deviceById(ctx, device._id);
    const eventRef = await logEvent(ctx, {
      kind: "DEVICE_REVOKED",
      deviceKey: device.deviceKey,
      profileId: device.profileId,
      staffId: device.staffId,
      staffName: device.staffName,
      ip: args.ip,
      detail: `${args.reason} — ${sessions} staff session(s) invalidated`,
      actor: grant.operator.operatorId,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "DEVICE_REVOKED",
      targetType: "securityDevice",
      targetId: device.deviceKey,
      previousState: before,
      newState: deviceState(updated),
      reason: args.reason,
      eventRef,
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true, sessionsRevoked: sessions };
  },
});

/** Emergency replacement: authorize the new device and revoke the old one. */
export const replaceDevice = mutation({
  args: {
    token: v.string(),
    oldDeviceId: v.id("securityDevices"),
    newDeviceId: v.id("securityDevices"),
    reason: v.string(),
    confirmCredential: v.string(),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.devices.replace",
    });
    await confirmOperator(grant.operator, args.confirmCredential);
    if (args.oldDeviceId === args.newDeviceId) {
      throw new AppError("Old and new device must differ.");
    }
    const oldDevice = await deviceById(ctx, args.oldDeviceId);
    const newDevice = await deviceById(ctx, args.newDeviceId);
    if (oldDevice.profileId !== newDevice.profileId) {
      throw new AppError("Both devices must belong to the same staff ID.");
    }
    if (!["AUTHORIZED", "BLOCKED", "REVOKED"].includes(oldDevice.status)) {
      throw new AppError("The old device is not an active authorization.");
    }
    if (!["PENDING", "REJECTED"].includes(newDevice.status)) {
      throw new AppError("The replacement device must be a pending request.");
    }
    const now = Date.now();
    await ctx.db.patch(oldDevice._id, {
      status: "REPLACED",
      decidedAt: now,
      decidedBy: grant.operator.operatorId,
      reason: args.reason,
    });
    await ctx.db.patch(newDevice._id, {
      status: "AUTHORIZED",
      source: "REPLACEMENT",
      priorStatus: undefined,
      decidedAt: now,
      decidedBy: grant.operator.operatorId,
      reason: args.reason,
    });
    const sessions = await revokeStaffSessions(ctx, oldDevice.profileId);
    const eventRef = await logEvent(ctx, {
      kind: "DEVICE_REPLACED",
      deviceKey: newDevice.deviceKey,
      profileId: newDevice.profileId,
      staffId: newDevice.staffId,
      staffName: newDevice.staffName,
      ip: args.ip,
      detail: `Replaced ${oldDevice.deviceKey.slice(0, 12)} → ${newDevice.deviceKey.slice(0, 12)}; ${sessions} session(s) invalidated. ${args.reason}`,
      actor: grant.operator.operatorId,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "DEVICE_REPLACED",
      targetType: "securityDevice",
      targetId: newDevice.deviceKey,
      previousState: JSON.stringify({
        old: deviceState(oldDevice),
        new: deviceState(newDevice),
      }),
      newState: JSON.stringify({
        oldStatus: "REPLACED",
        newStatus: "AUTHORIZED",
      }),
      reason: args.reason,
      eventRef,
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true, sessionsRevoked: sessions };
  },
});

/* ---------------------------- events / incidents -------------------------- */

export const deviceEvents = query({
  args: { token: v.string(), kind: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await authenticate(ctx, args.token, { permission: "security.events.read" });
    const limit = Math.min(200, Math.max(1, args.limit ?? 100));
    const rows = await ctx.db
      .query("securityDeviceEvents")
      .withIndex("by_at")
      .order("desc")
      .take(limit * 3);
    const filtered = args.kind ? rows.filter((r) => r.kind === args.kind) : rows;
    return filtered.slice(0, limit);
  },
});

export const incidents = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await authenticate(ctx, args.token, { permission: "security.events.read" });
    const rows = await ctx.db.query("securityIncidents").collect();
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const openIncident = mutation({
  args: {
    token: v.string(),
    title: v.string(),
    severity: v.string(),
    summary: v.string(),
    deviceKey: v.optional(v.string()),
    staffId: v.optional(v.string()),
    staffName: v.optional(v.string()),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.incidents.manage",
    });
    const title = args.title.trim();
    const summary = args.summary.trim();
    if (title.length < 5) throw new AppError("Incident title is too short.");
    if (summary.length < 10) throw new AppError("Add a short summary of the incident.");
    const severity = args.severity.toUpperCase();
    if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severity)) {
      throw new AppError("Severity must be LOW, MEDIUM, HIGH or CRITICAL.");
    }
    const ref = await makeCode(ctx, "securityIncident", "INC", 6);
    const now = Date.now();
    const id = await ctx.db.insert("securityIncidents", {
      ref,
      title,
      severity,
      status: "OPEN",
      deviceKey: args.deviceKey,
      staffId: args.staffId,
      staffName: args.staffName,
      summary,
      notes: [],
      openedAt: now,
      openedBy: grant.operator.operatorId,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "INCIDENT_OPENED",
      targetType: "securityIncident",
      targetId: ref,
      newState: JSON.stringify({ title, severity, status: "OPEN" }),
      reason: summary,
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true, id, ref };
  },
});

export const addIncidentNote = mutation({
  args: {
    token: v.string(),
    incidentId: v.id("securityIncidents"),
    body: v.string(),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.incidents.manage",
    });
    const incident = await ctx.db.get(args.incidentId);
    if (!incident) throw new AppError("Incident not found.");
    const body = args.body.trim();
    if (body.length < 3) throw new AppError("Note is too short.");
    await ctx.db.patch(incident._id, {
      notes: [
        ...incident.notes,
        {
          at: Date.now(),
          operatorId: grant.operator.operatorId,
          operatorName: grant.operator.name,
          body,
        },
      ],
      updatedAt: Date.now(),
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "INCIDENT_NOTE_ADDED",
      targetType: "securityIncident",
      targetId: incident.ref,
      reason: body.slice(0, 400),
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true };
  },
});

export const setIncidentStatus = mutation({
  args: {
    token: v.string(),
    incidentId: v.id("securityIncidents"),
    status: v.string(),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.incidents.manage",
    });
    const incident = await ctx.db.get(args.incidentId);
    if (!incident) throw new AppError("Incident not found.");
    const status = args.status.toUpperCase();
    if (!["OPEN", "INVESTIGATING", "CONTAINED", "CLOSED"].includes(status)) {
      throw new AppError("Unknown incident status.");
    }
    await ctx.db.patch(incident._id, {
      status,
      updatedAt: Date.now(),
      closedAt: status === "CLOSED" ? Date.now() : undefined,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "INCIDENT_STATUS_CHANGED",
      targetType: "securityIncident",
      targetId: incident.ref,
      previousState: JSON.stringify({ status: incident.status }),
      newState: JSON.stringify({ status }),
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true };
  },
});

/* ------------------------------- operators -------------------------------- */

export const operators = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await authenticate(ctx, args.token, { permission: "security.operators.manage" });
    const rows = await listOperators(ctx);
    return rows
      .sort((a, b) => a.operatorId.localeCompare(b.operatorId))
      .map((o) => ({
        operatorId: o.operatorId,
        name: o.name,
        role: o.role,
        permissions: o.permissions,
        status: o.status,
        createdAt: o.createdAt,
        createdBy: o.createdBy,
        lastLoginAt: o.lastLoginAt ?? null,
        mustRotateCredential: o.mustRotateCredential,
        credentialUpdatedAt: o.credentialUpdatedAt ?? null,
        lockedUntil: o.lockedUntil ?? null,
      }));
  },
});

export const createOperator = mutation({
  args: {
    token: v.string(),
    operatorId: v.string(),
    name: v.string(),
    role: v.string(),
    credential: v.string(),
    confirmCredential: v.string(),
    confirmOperatorCredential: v.string(),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.operators.manage",
    });
    await confirmOperator(grant.operator, args.confirmOperatorCredential);
    const operatorId = operatorIdOf(args.operatorId);
    if (!OPERATOR_ID_RE.test(operatorId)) {
      throw new AppError("Operator ID must be 3–20 uppercase letters/digits.");
    }
    const name = args.name.trim();
    if (name.length < 3) throw new AppError("Operator name is too short.");
    const role = args.role.toUpperCase();
    if (!(role in SECURITY_ROLE_PERMISSIONS)) {
      throw new AppError("Unknown security role.");
    }
    const error = credentialPolicyError(args.credential);
    if (error) throw new AppError(error);
    if (args.credential !== args.confirmCredential) {
      throw new AppError("Credentials do not match.");
    }
    const existing = await listOperators(ctx);
    if (existing.some((o) => o.operatorId === operatorId)) {
      throw new AppError("That operator ID already exists.");
    }
    const now = Date.now();
    await ctx.db.insert("securityOperators", {
      operatorId,
      name,
      credentialHash: await hashSecret(args.credential.trim()),
      role,
      permissions: [
        ...SECURITY_ROLE_PERMISSIONS[role as keyof typeof SECURITY_ROLE_PERMISSIONS],
      ],
      status: "ACTIVE",
      createdAt: now,
      createdBy: grant.operator.operatorId,
      sessionVersion: 1,
      failedAttempts: 0,
      mustRotateCredential: true,
      credentialUpdatedAt: now,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "SECURITY_OPERATOR_CREATED",
      targetType: "securityOperator",
      targetId: operatorId,
      newState: JSON.stringify({ role, status: "ACTIVE", name }),
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true, operatorId };
  },
});

export const updateOperator = mutation({
  args: {
    token: v.string(),
    operatorId: v.string(),
    name: v.optional(v.string()),
    role: v.optional(v.string()),
    permissions: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    confirmOperatorCredential: v.string(),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.operators.manage",
    });
    await confirmOperator(grant.operator, args.confirmOperatorCredential);
    const target = (await listOperators(ctx)).find(
      (o) => o.operatorId === operatorIdOf(args.operatorId),
    );
    if (!target) throw new AppError("Security operator not found.");
    const before = operatorState(target);
    const patch: Partial<Doc<"securityOperators">> = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (name.length < 3) throw new AppError("Operator name is too short.");
      patch.name = name;
    }
    if (args.role !== undefined) {
      const role = args.role.toUpperCase();
      if (!(role in SECURITY_ROLE_PERMISSIONS)) {
        throw new AppError("Unknown security role.");
      }
      patch.role = role;
      if (args.permissions === undefined) {
        patch.permissions = [
          ...SECURITY_ROLE_PERMISSIONS[role as keyof typeof SECURITY_ROLE_PERMISSIONS],
        ];
      }
    }
    if (args.permissions !== undefined) {
      const allowed = new Set<string>(SECURITY_PERMISSIONS);
      const permissions = args.permissions.filter((p) => allowed.has(p));
      if (permissions.length !== args.permissions.length) {
        throw new AppError("Unknown security permission in the request.");
      }
      patch.permissions = permissions;
    }
    if (args.status !== undefined) {
      const status = args.status.toUpperCase();
      if (!["ACTIVE", "SUSPENDED", "DISABLED"].includes(status)) {
        throw new AppError("Unknown operator status.");
      }
      if (
        target.operatorId === grant.operator.operatorId &&
        status !== "ACTIVE"
      ) {
        throw new AppError("You cannot suspend or disable your own operator account.");
      }
      patch.status = status;
    }
    const invalidating =
      (patch.status !== undefined && patch.status !== "ACTIVE") ||
      patch.permissions !== undefined ||
      patch.role !== undefined;
    if (invalidating) patch.sessionVersion = target.sessionVersion + 1;
    await ctx.db.patch(target._id, patch);
    const updated = await ctx.db.get(target._id);
    if (!updated) throw new AppError("Operator disappeared.");
    if (invalidating) {
      await revokeOperatorSessions(ctx, target._id, "Operator authority changed");
    }
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "SECURITY_OPERATOR_UPDATED",
      targetType: "securityOperator",
      targetId: target.operatorId,
      previousState: before,
      newState: operatorState(updated),
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true };
  },
});

/** Rotation by an administrator: the operator must change it again at sign-in. */
export const resetOperatorCredential = mutation({
  args: {
    token: v.string(),
    operatorId: v.string(),
    credential: v.string(),
    confirmCredential: v.string(),
    confirmOperatorCredential: v.string(),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.operators.manage",
    });
    await confirmOperator(grant.operator, args.confirmOperatorCredential);
    const target = (await listOperators(ctx)).find(
      (o) => o.operatorId === operatorIdOf(args.operatorId),
    );
    if (!target) throw new AppError("Security operator not found.");
    const error = credentialPolicyError(args.credential);
    if (error) throw new AppError(error);
    if (args.credential !== args.confirmCredential) {
      throw new AppError("Credentials do not match.");
    }
    const now = Date.now();
    const sessionVersion = target.sessionVersion + 1;
    await ctx.db.patch(target._id, {
      credentialHash: await hashSecret(args.credential.trim()),
      credentialUpdatedAt: now,
      mustRotateCredential: true,
      sessionVersion,
      failedAttempts: 0,
      lockedUntil: undefined,
    });
    await revokeOperatorSessions(ctx, target._id, "Credential reset by security administrator");
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "SECURITY_OPERATOR_CREDENTIAL_RESET",
      targetType: "securityOperator",
      targetId: target.operatorId,
      previousState: JSON.stringify({ sessionVersion: target.sessionVersion }),
      newState: JSON.stringify({ sessionVersion, mustRotateCredential: true }),
      reason: "Administrative credential reset",
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true };
  },
});

/* -------------------------- settings / recovery --------------------------- */

export const updateSessionPolicy = mutation({
  args: {
    token: v.string(),
    minutes: v.number(),
    confirmOperatorCredential: v.string(),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.settings.update",
    });
    await confirmOperator(grant.operator, args.confirmOperatorCredential);
    if (!Number.isFinite(args.minutes) || args.minutes < 5 || args.minutes > MAX_SESSION_MINUTES) {
      throw new AppError("Session timeout must be between 5 and 480 minutes.");
    }
    const cfg = await readConfig(ctx);
    if (!cfg) throw new AppError("Security Department is not provisioned.");
    const minutes = Math.round(args.minutes);
    await ctx.db.patch(cfg._id, {
      sessionPolicyMinutes: minutes,
      updatedAt: Date.now(),
      updatedBy: grant.operator.operatorId,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "SECURITY_SESSION_POLICY_UPDATED",
      targetType: "securityConfig",
      targetId: SINGLETON,
      previousState: JSON.stringify({ sessionPolicyMinutes: cfg.sessionPolicyMinutes }),
      newState: JSON.stringify({ sessionPolicyMinutes: minutes }),
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { ok: true, minutes };
  },
});

/** Issue a new emergency recovery code (shown exactly once). */
export const rotateRecoveryCode = mutation({
  args: {
    token: v.string(),
    confirmOperatorCredential: v.string(),
    ip: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await authenticate(ctx, args.token, {
      permission: "security.credentials.rotate",
    });
    await confirmOperator(grant.operator, args.confirmOperatorCredential);
    const cfg = await readConfig(ctx);
    if (!cfg) throw new AppError("Security Department is not provisioned.");
    const recoveryCode = newRecoveryCode();
    await ctx.db.patch(cfg._id, {
      recoveryHash: await hashSecret(normalizeRecoveryCode(recoveryCode)),
      recoveryIssuedAt: Date.now(),
      updatedAt: Date.now(),
      updatedBy: grant.operator.operatorId,
    });
    await appendAudit(ctx, {
      operatorId: grant.operator.operatorId,
      operatorName: grant.operator.name,
      action: "SECURITY_RECOVERY_CODE_ROTATED",
      targetType: "securityConfig",
      targetId: SINGLETON,
      previousState: JSON.stringify({ recoveryIssuedAt: cfg.recoveryIssuedAt ?? null }),
      newState: JSON.stringify({ recoveryIssuedAt: Date.now() }),
      reason: "Recovery code rotated",
      ip: args.ip,
    });
    await touchSession(ctx, grant.session, await readConfig(ctx), args.ip);
    return { recoveryCode };
  },
});

export const recoveryState = query({
  args: {},
  handler: async (ctx) => {
    const cfg = await readConfig(ctx);
    const now = Date.now();
    return {
      available: !!cfg?.recoveryHash,
      initialized: !!cfg?.pinHash,
      lockedUntil: cfg?.lockedUntil && cfg.lockedUntil > now ? cfg.lockedUntil : null,
    };
  },
});

/**
 * Independent recovery: recovery code + a new PIN + a new operator credential.
 * Never based on the bootstrap PIN, and never reachable with a staff session.
 */
export const recover = mutation({
  args: {
    recoveryCode: v.string(),
    newPin: v.string(),
    confirmPin: v.string(),
    operatorId: v.string(),
    newCredential: v.string(),
    confirmCredential: v.string(),
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const cfg = await readConfig(ctx);
    if (!cfg?.recoveryHash) {
      throw new AppError(
        "No recovery credential is configured. Use deployment-owner recovery.",
      );
    }
    if (cfg.lockedUntil && cfg.lockedUntil > now) {
      throw new AppError(
        `Recovery is locked. Try again in ${minutesLeft(cfg.lockedUntil, now)} minute(s).`,
      );
    }
    const codeOk = await verifySecret(
      normalizeRecoveryCode(args.recoveryCode),
      cfg.recoveryHash,
    );
    if (!codeOk) {
      const next = bumpFailure(cfg.failedAttempts);
      await ctx.db.patch(cfg._id, { ...next, lastFailedAt: now });
      await recordAttempt(ctx, {
        kind: "RECOVERY",
        outcome: next.lockedUntil ? "LOCKED" : "FAILED",
        ip: args.ip,
        userAgent: args.userAgent,
        detail: "Wrong recovery code",
      });
      throw new AppError(
        next.lockedUntil
          ? "Wrong recovery code. Recovery is locked for 15 minutes."
          : "Wrong recovery code.",
      );
    }
    const pinError = pinPolicyError(args.newPin);
    if (pinError) throw new AppError(pinError);
    if (args.newPin !== args.confirmPin) throw new AppError("PINs do not match.");
    const credError = credentialPolicyError(args.newCredential);
    if (credError) throw new AppError(credError);
    if (args.newCredential !== args.confirmCredential) {
      throw new AppError("Credentials do not match.");
    }
    const target = (await listOperators(ctx)).find(
      (o) => o.operatorId === operatorIdOf(args.operatorId),
    );
    if (!target) throw new AppError("Security operator not found.");
    if (target.status !== "ACTIVE") {
      throw new AppError("That security operator account is not active.");
    }
    const rotatedRecoveryCode = newRecoveryCode();
    await ctx.db.patch(cfg._id, {
      pinHash: await hashSecret(args.newPin),
      pinVersion: cfg.pinVersion + 1,
      pinChangedAt: now,
      mustChangePin: false,
      recoveryHash: await hashSecret(normalizeRecoveryCode(rotatedRecoveryCode)),
      recoveryIssuedAt: now,
      failedAttempts: 0,
      lockedUntil: undefined,
      updatedAt: now,
      updatedBy: `RECOVERY:${target.operatorId}`,
    });
    const sessionVersion = target.sessionVersion + 1;
    await ctx.db.patch(target._id, {
      credentialHash: await hashSecret(args.newCredential.trim()),
      credentialUpdatedAt: now,
      mustRotateCredential: false,
      sessionVersion,
      failedAttempts: 0,
      lockedUntil: undefined,
    });
    const allSessions = await ctx.db.query("securitySessions").collect();
    for (const s of allSessions) {
      if (s.revokedAt) continue;
      await ctx.db.patch(s._id, {
        revokedAt: now,
        revokedReason: "Emergency recovery completed",
      });
    }
    const operator = await ctx.db.get(target._id);
    if (!operator) throw new AppError("Operator disappeared.");
    const session = await issueSession(ctx, {
      operator,
      mode: "FULL",
      permissions: operator.permissions,
      ip: args.ip,
      userAgent: args.userAgent,
    });
    await recordAttempt(ctx, {
      kind: "RECOVERY",
      outcome: "SUCCESS",
      operatorId: target.operatorId,
      ip: args.ip,
      userAgent: args.userAgent,
    });
    await appendAudit(ctx, {
      operatorId: target.operatorId,
      operatorName: target.name,
      action: "SECURITY_RECOVERY_COMPLETED",
      targetType: "securityConfig",
      targetId: SINGLETON,
      previousState: JSON.stringify({ pinVersion: cfg.pinVersion }),
      newState: JSON.stringify({
        pinVersion: cfg.pinVersion + 1,
        operator: target.operatorId,
        sessionVersion,
      }),
      reason: "Emergency recovery with recovery credential",
      ip: args.ip,
    });
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      recoveryCode: rotatedRecoveryCode,
    };
  },
});

/* --------------------------------- audit --------------------------------- */

export const auditLog = query({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await authenticate(ctx, args.token, { permission: "security.events.read" });
    const limit = Math.min(500, Math.max(1, args.limit ?? 200));
    const rows = await ctx.db
      .query("securityAudit")
      .withIndex("by_seq")
      .order("desc")
      .take(limit);

    // Recompute the chain over the retained window, newest → oldest.
    let chainOk = true;
    let firstBrokenRef: string | null = null;
    for (const row of rows) {
      const payload = auditPayload({
        seq: row.seq,
        ref: row.ref,
        operatorId: row.operatorId,
        operatorName: row.operatorName,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        previousState: row.previousState,
        newState: row.newState,
        reason: row.reason,
        eventRef: row.eventRef,
        ip: row.ip,
        at: row.at,
      });
      const recomputed = await auditHash(row.prevHash, payload);
      if (recomputed !== row.hash) {
        chainOk = false;
        firstBrokenRef = row.ref;
        break;
      }
    }
    // Continuity: each older row's hash must be the newer row's prevHash.
    if (chainOk) {
      for (let i = 0; i + 1 < rows.length; i += 1) {
        if (rows[i].prevHash !== rows[i + 1].hash) {
          chainOk = false;
          firstBrokenRef = rows[i + 1].ref;
          break;
        }
      }
    }
    return {
      entries: rows,
      integrity: {
        ok: chainOk,
        checked: rows.length,
        firstBrokenRef,
      },
    };
  },
});

/* --------------------- staff-facing device registration ------------------- */

const FINGERPRINT_RE = /^[A-Za-z0-9:_-]{16,128}$/;

/**
 * Register the current browser as this staff member's device. This is the ONLY
 * security function that uses the KMC staff identity, and it cannot change a
 * device's authorization beyond creating a first-time baseline row.
 */
export const registerDevice = mutation({
  args: {
    fingerprint: v.string(),
    label: v.string(),
    platform: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await getActor(ctx);
    if (!actor?.profile) {
      return { status: "UNKNOWN" as const, message: "No KMC profile for this sign-in." };
    }
    const profile = actor.profile;
    if (profile.role === "CLIENT") {
      return { status: "NOT_APPLICABLE" as const, message: "Client portal does not use device authorization." };
    }
    const fingerprint = args.fingerprint.trim();
    if (!FINGERPRINT_RE.test(fingerprint)) {
      throw new AppError("Invalid device fingerprint.");
    }
    const deviceKey = await sha256Hex(`${profile._id}:${fingerprint}`);
    const now = Date.now();
    const existing = await ctx.db
      .query("securityDevices")
      .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
      .collect();
    const match = existing.find((d) => d.deviceKey === deviceKey);

    if (match) {
      if (match.status === "AUTHORIZED") {
        await ctx.db.patch(match._id, { lastSeenAt: now });
        return {
          status: "AUTHORIZED" as const,
          message: "Device authorized by the Security Department.",
          deviceId: match._id,
        };
      }
      if (match.status === "PENDING") {
        await logEvent(ctx, {
          kind: "DEVICE_RECHECK",
          deviceKey,
          profileId: profile._id,
          staffId: profile.staffId,
          staffName: profile.name,
          detail: "Pending device attempted to open the workspace",
          actor: "STAFF",
        });
        return {
          status: "PENDING" as const,
          message:
            "This device is awaiting Security Department approval. Contact security with your staff ID.",
          deviceId: match._id,
        };
      }
      await logEvent(ctx, {
        kind: "UNAUTHORIZED_ATTEMPT",
        deviceKey,
        profileId: profile._id,
        staffId: profile.staffId,
        staffName: profile.name,
        userAgent: args.userAgent,
        detail: `Sign-in attempt from a ${match.status.toLowerCase()} device`,
        actor: "STAFF",
      });
      return {
        status: match.status,
        message:
          match.status === "BLOCKED"
            ? "This device is blocked by the Security Department."
            : "This device credential was revoked by the Security Department.",
        deviceId: match._id,
      };
    }

    const hasAuthorized = existing.some((d) => d.status === "AUTHORIZED");
    const hasHistory = existing.length > 0;
    // First-ever device for this staff ID is grandfathered as the baseline so
    // existing KMC staff keep working; every later device needs Security.
    const status = hasHistory ? "PENDING" : "AUTHORIZED";
    const eventRef = await makeCode(ctx, "securityEvent", "EVT", 6);
    const id = await ctx.db.insert("securityDevices", {
      profileId: profile._id,
      staffId: profile.staffId,
      staffName: profile.name,
      role: profile.role,
      fingerprint,
      deviceKey,
      label: args.label.slice(0, 80) || "Unnamed device",
      platform: args.platform,
      userAgent: args.userAgent,
      status,
      source: hasHistory ? "REGISTRATION" : "BASELINE",
      requestedAt: now,
      lastSeenAt: now,
      decidedAt: hasHistory ? undefined : now,
      decidedBy: hasHistory ? undefined : "BASELINE_MIGRATION",
      eventRef,
    });
    await logEvent(ctx, {
      kind: hasHistory ? "DEVICE_REQUESTED" : "DEVICE_AUTHORIZED_BASELINE",
      deviceKey,
      profileId: profile._id,
      staffId: profile.staffId,
      staffName: profile.name,
      userAgent: args.userAgent,
      detail: hasHistory
        ? "New device request — awaiting Security Department approval"
        : `Baseline device authorized${hasAuthorized ? " (conflict)" : ""}`,
      actor: "STAFF",
    });
    return {
      status: status as "AUTHORIZED" | "PENDING",
      message: hasHistory
        ? "New device request submitted. A Security Operator must approve it."
        : "Device registered as the baseline authorized device.",
      deviceId: id,
    };
  },
});

/* ---------------------- deployment-owner operations ----------------------- */

/**
 * One-time: install the bootstrap PIN hash. Internal mutation — it is not
 * callable from any client (staff or security portal); only from the Convex
 * CLI / dashboard by the deployment owner. Refuses once any operator exists.
 */
export const seedBootstrap = internalMutation({
  args: { activationPin: v.string() },
  handler: async (ctx, args) => {
    if (!/^\d{4,12}$/.test(args.activationPin)) {
      throw new AppError("Bootstrap PIN must be 4–12 digits.");
    }
    const operators = await listOperators(ctx);
    if (operators.length > 0) {
      throw new AppError(
        "Security operators already exist — bootstrap seeding is closed.",
      );
    }
    const cfg = await readConfig(ctx);
    const hash = await hashSecret(args.activationPin.trim());
    const now = Date.now();
    if (cfg) {
      await ctx.db.patch(cfg._id, {
        bootstrapPinHash: hash,
        bootstrapIssuedAt: now,
        bootstrapUsedAt: undefined,
        updatedAt: now,
        updatedBy: "DEPLOYMENT_OWNER",
      });
      return { ok: true, updated: true };
    }
    await ctx.db.insert("securityConfig", {
      singleton: SINGLETON,
      bootstrapPinHash: hash,
      bootstrapIssuedAt: now,
      pinVersion: 0,
      mustChangePin: true,
      sessionPolicyMinutes: DEFAULT_SESSION_MINUTES,
      failedAttempts: 0,
      updatedAt: now,
      updatedBy: "DEPLOYMENT_OWNER",
    });
    return { ok: true, updated: false };
  },
});

/**
 * Last-resort owner recovery (deployment owner only, disabled unless the
 * SECURITY_OWNER_RECOVERY_KEY env var is configured). Rotates the PIN and one
 * operator credential; cannot be used from the app or with a staff session.
 */
export const ownerRecovery = internalMutation({
  args: {
    ownerKey: v.string(),
    operatorId: v.string(),
    newPin: v.string(),
    newCredential: v.string(),
  },
  handler: async (ctx, args) => {
    const expected = process.env.SECURITY_OWNER_RECOVERY_KEY;
    if (!expected) {
      throw new AppError(
        "Deployment-owner recovery is not configured on this deployment.",
      );
    }
    if (!timingSafeEqualString(args.ownerKey, expected)) {
      throw new AppError("Owner recovery key rejected.");
    }
    const cfg = await readConfig(ctx);
    if (!cfg) throw new AppError("Security Department is not provisioned.");
    const pinError = pinPolicyError(args.newPin);
    if (pinError) throw new AppError(pinError);
    const credError = credentialPolicyError(args.newCredential);
    if (credError) throw new AppError(credError);
    const target = (await listOperators(ctx)).find(
      (o) => o.operatorId === operatorIdOf(args.operatorId),
    );
    if (!target) throw new AppError("Security operator not found.");
    const now = Date.now();
    await ctx.db.patch(cfg._id, {
      pinHash: await hashSecret(args.newPin),
      pinVersion: cfg.pinVersion + 1,
      pinChangedAt: now,
      mustChangePin: false,
      failedAttempts: 0,
      lockedUntil: undefined,
      updatedAt: now,
      updatedBy: "OWNER_RECOVERY",
    });
    const sessionVersion = target.sessionVersion + 1;
    await ctx.db.patch(target._id, {
      credentialHash: await hashSecret(args.newCredential),
      credentialUpdatedAt: now,
      mustRotateCredential: false,
      sessionVersion,
      failedAttempts: 0,
      lockedUntil: undefined,
    });
    const sessions = await ctx.db.query("securitySessions").collect();
    for (const s of sessions) {
      if (s.revokedAt) continue;
      await ctx.db.patch(s._id, {
        revokedAt: now,
        revokedReason: "Owner recovery",
      });
    }
    await appendAudit(ctx, {
      operatorId: "OWNER",
      operatorName: "Deployment owner recovery",
      action: "SECURITY_OWNER_RECOVERY",
      targetType: "securityConfig",
      targetId: SINGLETON,
      previousState: JSON.stringify({ pinVersion: cfg.pinVersion }),
      newState: JSON.stringify({ pinVersion: cfg.pinVersion + 1, operator: target.operatorId }),
      reason: "Out-of-band owner recovery",
      ip: "cli",
    });
    return { ok: true };
  },
});

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
