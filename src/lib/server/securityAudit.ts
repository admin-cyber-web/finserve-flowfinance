import type { MutationCtx } from "../../convex/_generated/server";
import { auditHash, auditPayload } from "./securityCrypto";

/**
 * The single writer for the Security Department's append-only audit chain.
 *
 * Every security-relevant event — portal logins, device enrollment/approval/
 * blocking/revocation, PIN changes, operator changes, bootstrap, and KMC staff
 * login attempts — appends exactly one row whose hash covers the previous
 * row's hash. There is no update or delete path anywhere in the codebase.
 *
 * Actor identifiers for staff-originated events use a `STAFF:<staffId>` /
 * `SYSTEM:` prefix so they can never be mistaken for a Security Operator ID.
 */
export interface SecurityAuditEntry {
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
}

export async function appendSecurityAudit(
  ctx: MutationCtx,
  entry: SecurityAuditEntry,
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
