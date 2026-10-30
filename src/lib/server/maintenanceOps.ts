import type { Doc, Id } from "../../convex/_generated/dataModel";
import { AppError, logAudit, type Mtx } from "./convexHelpers";
import { nextCenterCode } from "./centerOps";

/**
 * Maintenance operations for SUPER_ADMIN data hygiene.
 *
 * Both functions are pure transaction bodies: the public mutations in
 * `convex/admin.ts` guard them with the SUPER_ADMIN role, and the internal
 * verification harness calls the exact same code so tests exercise the real
 * implementation (no duplicated logic).
 */

const SIX_DIGIT = /^\d{6}$/;

export interface CenterIdMapping {
  from: string;
  to: string;
  name: string;
}

/**
 * Migrate every legacy Centre ID (e.g. RAMPUR-001, BALLIA-001) to a unique
 * six-digit numeric Centre ID (e.g. 257510).
 *
 * - Centre primary keys (`_id`) are never touched, so centreId foreign keys
 *   (clients.centerId, groups.centerId, meetings…) keep pointing at the same
 *   centre.
 * - Every client row whose denormalised `centerCode` carries the old code is
 *   rewritten in the SAME Convex transaction, so no reference can be left
 *   behind: either the whole migration commits or nothing changes.
 * - Centres that already have a six-digit code are left untouched, and the
 *   allocator skips any code that already exists, so the operation is safe
 *   to re-run.
 */
export async function migrateCenterIdsTx(
  ctx: Mtx,
  actor: Doc<"profiles">,
): Promise<{
  ok: true;
  migrated: number;
  clientsPatched: number;
  mapping: CenterIdMapping[];
}> {
  const centers = await ctx.db.query("centers").collect();
  const clients = await ctx.db.query("clients").collect();
  const mapping: CenterIdMapping[] = [];
  let clientsPatched = 0;

  for (const center of centers) {
    if (SIX_DIGIT.test(center.code)) continue;
    const oldCode = center.code;
    const newCode = await nextCenterCode(ctx);
    for (const client of clients) {
      if (client.centerCode === oldCode) {
        await ctx.db.patch(client._id, { centerCode: newCode });
        clientsPatched += 1;
      }
    }
    await ctx.db.patch(center._id, { code: newCode });
    mapping.push({ from: oldCode, to: newCode, name: center.name });
  }

  if (mapping.length > 0) {
    await logAudit(ctx, {
      actorId: actor._id,
      actorName: actor.name,
      role: actor.role,
      action: "CENTER_IDS_MIGRATED",
      entity: "centers",
      entityId: "six-digit-migration",
      after: { mapping, clientsPatched },
    });
  }
  return { ok: true, migrated: mapping.length, clientsPatched, mapping };
}

export interface BranchRepairRow {
  id: string;
  label: string;
  from: string | null;
  to: string;
}

/**
 * Repair missing or stale branch relationships so the correct Branch Manager
 * can see the records created by their staff.
 *
 * Derivation rules (only ever patched when a reliable source exists):
 *  1. A centre follows the CURRENT branch of the staff member who created it
 *     (`centers.staffId`).
 *  2. A client follows the CURRENT branch of its assigned staff member
 *     (`clients.assignedTo`), falling back to its centre's branch.
 *  3. A loan application follows its client's (repaired) branch.
 *
 * Records whose relationship cannot be established reliably (deleted staff,
 * no centre, no branch on the profile) are reported but never guessed.
 * Everything runs in one Convex transaction — the whole repair commits
 * atomically or not at all.
 */
export async function repairBranchLinksTx(
  ctx: Mtx,
  actor: Doc<"profiles">,
): Promise<{
  ok: true;
  centers: BranchRepairRow[];
  clients: BranchRepairRow[];
  applications: BranchRepairRow[];
}> {
  const profiles = await ctx.db.query("profiles").collect();
  const branchOfStaff = new Map<Id<"profiles">, Id<"branches"> | undefined>(
    profiles.map((p) => [p._id, p.branchId]),
  );

  const centers = await ctx.db.query("centers").collect();
  const clients = await ctx.db.query("clients").collect();
  const applications = await ctx.db.query("loanApplications").collect();

  const centerReport: BranchRepairRow[] = [];
  const branchByCenter = new Map<
    Id<"centers">,
    Id<"branches"> | undefined
  >();

  // 1. Centres → creating staff member's current branch.
  for (const center of centers) {
    const creatorBranch = center.staffId
      ? branchOfStaff.get(center.staffId)
      : undefined;
    branchByCenter.set(center._id, creatorBranch ?? center.branchId);
    if (creatorBranch && center.branchId !== creatorBranch) {
      await ctx.db.patch(center._id, { branchId: creatorBranch });
      centerReport.push({
        id: center.code,
        label: center.name,
        from: center.branchId ?? null,
        to: creatorBranch,
      });
    }
  }

  const clientReport: BranchRepairRow[] = [];
  const branchByClient = new Map<Id<"clients">, Id<"branches"> | undefined>();
  const clientById = new Map(clients.map((c) => [c._id, c]));

  // 2. Clients → assigned staff member's branch, else their centre's branch.
  for (const client of clients) {
    const staffBranch = client.assignedTo
      ? branchOfStaff.get(client.assignedTo)
      : undefined;
    const centerBranch = client.centerId
      ? branchByCenter.get(client.centerId)
      : undefined;
    const target = staffBranch ?? centerBranch ?? client.branchId;
    branchByClient.set(client._id, target);
    if (target && client.branchId !== target) {
      await ctx.db.patch(client._id, { branchId: target });
      clientReport.push({
        id: client.code,
        label: client.name,
        from: client.branchId ?? null,
        to: target,
      });
    }
  }

  const applicationReport: BranchRepairRow[] = [];

  // 3. Loan applications → their client's (repaired) branch.
  for (const app of applications) {
    const client = app.clientId ? clientById.get(app.clientId) : undefined;
    const target = client ? branchByClient.get(client._id) : undefined;
    if (target && app.branchId !== target) {
      await ctx.db.patch(app._id, { branchId: target });
      applicationReport.push({
        id: app.appId,
        label: client?.name ?? app.appId,
        from: app.branchId ?? null,
        to: target,
      });
    }
  }

  if (
    centerReport.length > 0 ||
    clientReport.length > 0 ||
    applicationReport.length > 0
  ) {
    await logAudit(ctx, {
      actorId: actor._id,
      actorName: actor.name,
      role: actor.role,
      action: "BRANCH_LINKS_REPAIRED",
      entity: "database",
      entityId: "branch-repair",
      after: {
        centers: centerReport,
        clients: clientReport,
        applications: applicationReport,
      },
    });
  }

  return {
    ok: true,
    centers: centerReport,
    clients: clientReport,
    applications: applicationReport,
  };
}
