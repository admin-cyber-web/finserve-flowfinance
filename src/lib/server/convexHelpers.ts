/**
 * Server-side helpers shared by every Convex module.
 *
 * Lives outside the convex/ directory on purpose: it is plain TypeScript that
 * receives `ctx` as an argument, so both the API layer (convex/*.ts) and the
 * seed can reuse the exact same financial + authorization code paths.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import type { Permission } from "../finance/permissions";
import {
  effectivePermissions,
  effectiveRole,
  hasSuperAdminGrant,
} from "../finance/permissions";
import type { TxDirection, WalletTxType } from "../finance/types";
import { deriveBalance, txDelta } from "../finance/wallet";
import { isBalanced, type JournalEntrySpec } from "../finance/journal";
import { round2 } from "../finance/money";

export type Ctx = QueryCtx | MutationCtx;
export type Mtx = MutationCtx;

export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}

/* ------------------------------- Identity -------------------------------- */

/**
 * The authorization view of a profile.
 *
 * For a backend-granted account (see `SUPER_ADMIN_GRANTS`) `role` carries the
 * EFFECTIVE role the server authorizes with, while `designationRole` keeps the
 * stored role that must continue to display ("Branch Manager"). Everyone else
 * has no `designationRole` and `role` is simply their stored role.
 *
 * This is a read-only projection: the stored profile document is never
 * patched, so the record, its staff number, PIN and history stay untouched.
 */
export type AuthProfile = Doc<"profiles"> & { designationRole?: string };

export function withEffectiveRole(profile: Doc<"profiles">): AuthProfile {
  if (!hasSuperAdminGrant(profile)) return profile;
  return { ...profile, role: effectiveRole(profile), designationRole: profile.role };
}

export interface Actor {
  userId: Id<"users">;
  user: Doc<"users">;
  profile: AuthProfile | null;
}

export async function getActor(ctx: Ctx): Promise<Actor | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;
  const user = await ctx.db.get(userId);
  if (!user) return null;
  const stored = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return { userId, user, profile: stored ? withEffectiveRole(stored) : null };
}

/** Signed in AND has a FinServe workspace profile. */
export async function requireActor(ctx: Ctx): Promise<Actor> {
  const actor = await getActor(ctx);
  if (!actor) throw new AppError("Not signed in.");
  return actor;
}

/**
 * Device authorization backstop — deliberately inactive.
 *
 * Mandatory device verification has been removed from the KMC login and API
 * flow: staff sign in with Staff ID + PIN, and their dashboard and business API
 * access never depend on a device approval. The security tables and modules are
 * kept (device inventory, audit, portal) but are disconnected from normal
 * authentication, so this helper is a no-op kept for call-site compatibility.
 */
export async function assertDeviceAuthorized(
  _ctx: Ctx,
  _profile: Doc<"profiles">,
): Promise<void> {
  return;
}

/**
 * The profile used for authorization. Rejects blocked/suspended/deactivated
 * accounts for anything that mutates data — historical records stay readable.
 * Device authorization is NOT part of this check: device verification no longer
 * gates login or normal API access.
 */
export async function requireProfile(
  ctx: Ctx,
  opts: { allowInactive?: boolean; skipDeviceCheck?: boolean } = {},
): Promise<AuthProfile> {
  const actor = await requireActor(ctx);
  if (!actor.profile) {
    throw new AppError("No KIRAT MICRO CREDIT workspace is linked to this sign-in.");
  }
  const profile = actor.profile;
  if (!opts.allowInactive && profile.status !== "ACTIVE") {
    throw new AppError(
      `Your account is ${profile.status.toLowerCase()}. Contact your administrator.`,
    );
  }
  return profile;
}

export function hasPermission(
  profile: Doc<"profiles">,
  permission: Permission,
): boolean {
  return effectivePermissions(profile).includes(permission);
}

export function requirePermission(
  profile: Doc<"profiles">,
  permission: Permission,
): void {
  if (!hasPermission(profile, permission)) {
    throw new AppError(
      `Not permitted: "${permission}". Ask an administrator to update your role permissions.`,
    );
  }
}

export function requireRole(
  profile: Doc<"profiles">,
  ...roles: string[]
): void {
  if (!roles.includes(profile.role)) {
    throw new AppError("Your role cannot perform this action.");
  }
}

/**
 * Branch scoping: BM / staff / accountant are pinned to their own branch,
 * admins may act on any branch.
 */
export function scopedBranchId(
  profile: Doc<"profiles">,
  requested?: Id<"branches"> | null,
): Id<"branches"> | null {
  if (profile.role === "SUPER_ADMIN") return requested ?? null;
  if (requested && requested !== profile.branchId) {
    throw new AppError("You can only operate within your own branch.");
  }
  return profile.branchId ?? null;
}

/** True when the profile may see another profile's data. */
export function canSeeProfile(
  viewer: Doc<"profiles">,
  subject: Doc<"profiles">,
): boolean {
  if (viewer.role === "SUPER_ADMIN" || viewer.role === "ACCOUNTANT") return true;
  if (viewer._id === subject._id) return true;
  if (viewer.role === "BRANCH_MANAGER")
    return viewer.branchId === subject.branchId;
  return false;
}

/* -------------------------------- Audit ---------------------------------- */

export async function logAudit(
  ctx: Mtx,
  entry: {
    actorId?: Id<"profiles"> | null;
    actorName?: string;
    role?: string;
    action: string;
    entity: string;
    entityId?: string;
    before?: unknown;
    after?: unknown;
    referenceId?: string;
    branchId?: Id<"branches"> | null;
    device?: string;
  },
): Promise<Id<"auditLogs">> {
  // The audit trail records the actor's DESIGNATION (their stored role).
  // For every account without a backend grant that is identical to the role
  // the caller passes; a granted account keeps showing its own title
  // ("Branch Manager") on every audit row instead of the effective role.
  let role = entry.role;
  if (entry.actorId) {
    const actorProfile = await ctx.db.get(entry.actorId);
    if (actorProfile) role = actorProfile.role;
  }
  return await ctx.db.insert("auditLogs", {
    actorId: entry.actorId ?? undefined,
    actorName: entry.actorName ?? "system",
    role,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    before: entry.before,
    after: entry.after,
    referenceId: entry.referenceId,
    branchId: entry.branchId ?? undefined,
    device: entry.device,
    createdAt: Date.now(),
  });
}

/* ---------------------------- Access revocation --------------------------- */

/**
 * Cut off a user's live sessions: every Convex Auth session row plus its
 * refresh tokens is deleted, so any browser or device holding tokens is
 * signed out on the next request. Used when an account is removed or blocked.
 *
 * Returns the number of sessions revoked.
 */
export async function revokeUserSessions(
  ctx: Mtx,
  userId: Id<"users">,
): Promise<number> {
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  let revoked = 0;
  for (const session of sessions) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    for (const token of tokens) await ctx.db.delete(token._id);
    await ctx.db.delete(session._id);
    revoked += 1;
  }
  return revoked;
}

/* ------------------------------- Counters -------------------------------- */

export async function nextSeq(ctx: Mtx, key: string): Promise<number> {
  const existing = await ctx.db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (!existing) {
    await ctx.db.insert("counters", { key, value: 1 });
    return 1;
  }
  const next = existing.value + 1;
  await ctx.db.patch(existing._id, { value: next });
  return next;
}

/** Human-readable, gap-free code generator WITHOUT hyphens: PY000123, WT000123…
 *  (prefixes are passed by the caller — never include a hyphen.) */
export async function makeCode(
  ctx: Mtx,
  key: string,
  prefix: string,
  pad = 4,
  suffix = "",
): Promise<string> {
  const seq = await nextSeq(ctx, key);
  return `${prefix}${String(seq).padStart(pad, "0")}${suffix}`;
}

/**
 * Next displayed staff number (0001, 0002, 0003, ...) from the atomic
 * `counters` table. Convex serialises mutation commits (OCC with automatic
 * retry), so the read-modify-write below can never hand the same number to
 * two concurrent staff creations.
 *
 * The counter is only ever advanced past numbers already present on a
 * profile, so a fresh or partially migrated database self-heals. Legacy
 * prefixed IDs (BM-10002) and CLIENT portal profiles never feed the
 * sequence — they live in their own namespaces.
 *
 * 0001 (SUPER_ADMIN) and 0002 (Pankaj Tiwari) are already on file; 0003 is
 * reserved for Roshan Mishra — the next account created through New Staff
 * receives 0003, and every account after that continues 0004, 0005, ...
 */
export async function nextStaffNumber(ctx: Mtx): Promise<string> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", "staff"))
    .unique();

  let highest = counter?.value ?? 0;
  const profiles = await ctx.db.query("profiles").collect();
  for (const p of profiles) {
    if (p.role === "CLIENT") continue;
    const n = Number(String(p.staffId ?? "").replace(/\D/g, "") || 0);
    if (n > highest) highest = n;
  }

  const next = highest + 1;
  if (counter) {
    if (counter.value !== next) await ctx.db.patch(counter._id, { value: next });
  } else {
    await ctx.db.insert("counters", { key: "staff", value: next });
  }
  return String(next).padStart(4, "0");
}

export function istDateKey(now: number): string {
  // Business runs on IST regardless of server timezone.
  return new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function daySuffix(now: number): string {
  const d = new Date(now + 5.5 * 3600 * 1000);
  const y = String(d.getUTCFullYear()).slice(2);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/* -------------------------------- Wallet --------------------------------- */

export async function getWalletByProfile(
  ctx: Ctx,
  profileId: Id<"profiles">,
): Promise<Doc<"wallets"> | null> {
  return await ctx.db
    .query("wallets")
    .withIndex("by_profile", (q) => q.eq("profileId", profileId))
    .unique();
}

/**
 * THE source of truth: available balance is always derived from the immutable
 * wallet ledger. Nothing ever patches a balance field.
 */
export async function walletBalance(
  ctx: Ctx,
  walletId: Id<"wallets">,
): Promise<number> {
  const txns = await ctx.db
    .query("walletTransactions")
    .withIndex("by_wallet", (q) => q.eq("walletId", walletId))
    .collect();
  return deriveBalance(
    txns.map((t) => ({
      type: t.type,
      amount: t.amount,
      direction: t.direction,
    })),
  );
}

export interface WalletState {
  wallet: Doc<"wallets">;
  balance: number;
  limit: number;
}

export async function walletState(
  ctx: Ctx,
  walletId: Id<"wallets">,
): Promise<WalletState> {
  const wallet = await ctx.db.get(walletId);
  if (!wallet) throw new AppError("Wallet not found.");
  const balance = await walletBalance(ctx, walletId);
  return { wallet, balance, limit: wallet.walletLimit };
}

export interface WriteWalletTxArgs {
  walletId: Id<"wallets">;
  profileId: Id<"profiles">;
  branchId: Id<"branches">;
  type: WalletTxType;
  amount: number;
  /** Defaults to the type's canonical effect; override for REVERSAL / ADJUSTMENT. */
  direction?: TxDirection;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  createdBy?: Id<"profiles">;
  approvedBy?: Id<"profiles">;
  remarks?: string;
  reversalOfId?: Id<"walletTransactions">;
  /** Seeds may supply a historical timestamp. */
  createdAt?: number;
  /** Allow the ledger to go negative (seed normalisation only). */
  allowNegative?: boolean;
}

export interface WriteWalletTxResult {
  txnId: Id<"walletTransactions">;
  duplicate: boolean;
  balanceBefore: number;
  balanceAfter: number;
}

/**
 * Appends a wallet transaction. Computes balanceBefore/After from the ledger,
 * enforces idempotency keys (offline-safe) and refuses debits that would make
 * available cash negative.
 */
export async function writeWalletTx(
  ctx: Mtx,
  args: WriteWalletTxArgs,
): Promise<WriteWalletTxResult> {
  if (args.idempotencyKey) {
    const existing = await ctx.db
      .query("walletTransactions")
      .withIndex("by_idem", (q) => q.eq("idempotencyKey", args.idempotencyKey!))
      .unique();
    if (existing) {
      return {
        txnId: existing._id,
        duplicate: true,
        balanceBefore: existing.balanceBefore,
        balanceAfter: existing.balanceAfter,
      };
    }
  }

  const before = await walletBalance(ctx, args.walletId);
  const direction: TxDirection = args.direction ?? "NONE";
  const after = round2(before + txDelta(direction, args.amount));

  if (after < 0 && !args.allowNegative) {
    throw new AppError(
      `Insufficient wallet balance: available ₹${before.toLocaleString("en-IN")}, needed ₹${args.amount.toLocaleString("en-IN")}.`,
    );
  }

  const id = await ctx.db.insert("walletTransactions", {
    txnId: await makeCode(ctx, "walletTxn", "WT", 6),
    walletId: args.walletId,
    profileId: args.profileId,
    branchId: args.branchId,
    type: args.type,
    amount: args.amount,
    direction,
    balanceBefore: before,
    balanceAfter: after,
    referenceType: args.referenceType,
    referenceId: args.referenceId,
    idempotencyKey: args.idempotencyKey,
    createdBy: args.createdBy,
    approvedBy: args.approvedBy,
    remarks: args.remarks,
    reversalOfId: args.reversalOfId,
    createdAt: args.createdAt ?? Date.now(),
  });

  return { txnId: id, duplicate: false, balanceBefore: before, balanceAfter: after };
}

/* ------------------------------- Journal --------------------------------- */

export async function writeJournal(
  ctx: Mtx,
  spec: JournalEntrySpec,
  meta: {
    branchId?: Id<"branches"> | null;
    createdBy?: Id<"profiles"> | null;
    createdAt?: number;
  } = {},
): Promise<Id<"journalEntries">> {
  if (!isBalanced(spec.lines)) {
    throw new AppError(
      "Unbalanced journal entry rejected — debits must equal credits.",
    );
  }
  return await ctx.db.insert("journalEntries", {
    entryId: await makeCode(ctx, "journal", "JE", 6),
    dateKey: istDateKey(meta.createdAt ?? Date.now()),
    memo: spec.memo,
    refType: spec.refType,
    refId: spec.refId,
    lines: spec.lines,
    branchId: meta.branchId ?? undefined,
    createdBy: meta.createdBy ?? undefined,
    createdAt: meta.createdAt ?? Date.now(),
  });
}

/* ----------------------------- Notifications ----------------------------- */

export async function notify(
  ctx: Mtx,
  profileId: Id<"profiles">,
  n: { title: string; body: string; kind: string; link?: string },
): Promise<void> {
  await ctx.db.insert("notifications", {
    profileId,
    title: n.title,
    body: n.body,
    kind: n.kind,
    link: n.link,
    read: false,
    createdAt: Date.now(),
  });
}
