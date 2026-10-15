import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  AppError,
  logAudit,
  makeCode,
  type Mtx,
} from "./convexHelpers";
import { optionalString, requiredString } from "../finance/validate";

/**
 * Shared centre (center) operations — the single source of truth for
 * creating centres, generating Centre IDs (e.g. BALLIA-001), linking
 * clients to centres and building centre-wise reports.
 *
 * The Centre ID is generated ONCE, when the centre is created, and stored
 * permanently on the centre record. Clients only ever reference it — they
 * never generate their own.
 */

/** Resolve the branch a staff actor operates in (mirrors clients.create). */
export async function resolveBranchForActor(
  ctx: Mtx,
  me: Doc<"profiles">,
): Promise<Id<"branches">> {
  if (me.branchId) return me.branchId;
  if (me.role === "SUPER_ADMIN") {
    // Org-wide admin without a home branch: default to the oldest active
    // branch (same fallback as client onboarding).
    const branches = (await ctx.db.query("branches").collect()).filter(
      (b) => b.status === "ACTIVE",
    );
    branches.sort((a, b) => a._creationTime - b._creationTime);
    if (!branches[0]) {
      throw new AppError(
        "No active branch exists yet — create a branch before creating centres.",
      );
    }
    return branches[0]._id;
  }
  throw new AppError("Your profile has no branch assigned.");
}

/**
 * Create a centre and generate its unique Centre ID (PREFIX-001) exactly
 * once. Validates the name, rejects duplicates within the branch, and
 * writes an audit entry. Returns the persisted centre document.
 */
export async function createCenterForActor(
  ctx: Mtx,
  me: Doc<"profiles">,
  args: { name: string; village?: string },
): Promise<Doc<"centers">> {
  const branchId = await resolveBranchForActor(ctx, me);

  const name = requiredString(args.name, "name", 80).replace(/\s+/g, " ").trim();
  const village = optionalString(args.village, "village", 80) ?? "";

  // Duplicate prevention: same name (case-insensitive) in the same branch.
  const all = await ctx.db.query("centers").collect();
  const duplicate = all.some(
    (c) => c.branchId === branchId && c.name.toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) {
    throw new AppError(`A centre named "${name}" already exists in this branch.`);
  }

  // Centre ID prefix: first letters of the name, e.g. "Ballia" -> BALLIA.
  const prefix = name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 12);
  if (prefix.length < 3) {
    throw new AppError("Centre name must contain at least 3 letters.");
  }

  // Unique, stable ID generated once per centre: BALLIA-001, BALLIA-002, ...
  // The counter key includes the branch so IDs stay globally unique while
  // still following the existing NAME-001 convention.
  const code = await makeCode(
    ctx,
    `center:${String(branchId)}:${prefix}`,
    `${prefix}-`,
    3,
  );

  const now = Date.now();
  const centerId = await ctx.db.insert("centers", {
    code,
    name,
    branchId,
    village,
    staffId: me._id,
    createdAt: now,
  });
  await logAudit(ctx, {
    actorId: me._id,
    actorName: me.name,
    role: me.role,
    action: "CENTER_CREATED",
    entity: "centers",
    entityId: code,
    after: { name, village },
    branchId,
  });

  const center = await ctx.db.get(centerId);
  if (!center) throw new AppError("Centre creation failed.");
  return center;
}

/**
 * Resolve the centre a client is being linked to. Called at client-create
 * time with the centre selected in the joining form:
 *  - empty/undefined -> no centre (legacy behaviour preserved)
 *  - unknown ID      -> throws "Centre not found"
 *  - other branch    -> throws (cross-branch access denied)
 * Returns the centre's permanent code plus its database id, so every client
 * joining the same centre stores the exact same Centre ID + a real reference.
 */
export async function resolveCenterForClient(
  ctx: Mtx,
  branchId: Id<"branches">,
  centerCode: string | undefined,
): Promise<{ centerId?: Id<"centers">; centerCode?: string }> {
  const raw = (centerCode ?? "").trim();
  if (!raw) return {};
  const centers = await ctx.db.query("centers").collect();
  const lower = raw.toLowerCase();
  // Match by permanent Centre ID first (BALLIA-001), then — because the
  // picker also selects by name — by exact centre name within the same
  // branch. Either way the client stores the centre's generated code.
  const center =
    centers.find((c) => c.code.toLowerCase() === lower) ??
    centers.find(
      (c) => c.branchId === branchId && c.name.toLowerCase() === lower,
    );
  if (!center) {
    throw new AppError(
      "Selected centre not found. Create the centre before adding clients.",
    );
  }
  if (center.branchId !== branchId) {
    throw new AppError("Selected centre belongs to a different branch.");
  }
  return { centerId: center._id, centerCode: center.code };
}

export type CenterReportStatus = "OK" | "NOT_FOUND" | "FORBIDDEN";

export interface CenterReportResult {
  status: CenterReportStatus;
  center: {
    _id: Id<"centers">;
    code: string;
    name: string;
    village: string;
  } | null;
  total: number;
  clients: Doc<"clients">[];
}

/**
 * Centre-wise report core (pure): find the centre by ID, enforce centre
 * access, filter the caller's *visible* clients to that centre only, sort
 * and paginate. The caller passes the scope-filtered client list (the same
 * visibility rules as the client list query), so staff never see clients
 * outside their own scope — and never clients of another centre.
 */
export function centerReportRows(
  me: Doc<"profiles">,
  centers: Doc<"centers">[],
  visibleClients: Doc<"clients">[],
  args: { centerCode: string; limit?: number; offset?: number },
): CenterReportResult {
  const code = args.centerCode.trim().toUpperCase();
  if (!code) throw new AppError("Centre ID is required.");

  const center =
    centers.find((c) => c.code.toUpperCase() === code) ?? null;
  if (!center) {
    return { status: "NOT_FOUND", center: null, total: 0, clients: [] };
  }

  // Centre access rule (mirrors the centres query): a profile with a
  // branch only sees centres of that branch; SUPER_ADMIN and branch-less
  // org-wide profiles see all.
  if (me.role !== "SUPER_ADMIN" && me.branchId && center.branchId !== me.branchId) {
    return { status: "FORBIDDEN", center: null, total: 0, clients: [] };
  }

  const rows = visibleClients
    .filter((c) => c.centerCode === center.code)
    .sort((a, b) => a.code.localeCompare(b.code));

  const limit = Math.min(Math.max(Math.floor(args.limit ?? 25), 1), 100);
  const offset = Math.max(Math.floor(args.offset ?? 0), 0);

  return {
    status: "OK",
    center: {
      _id: center._id,
      code: center.code,
      name: center.name,
      village: center.village,
    },
    total: rows.length,
    clients: rows.slice(offset, offset + limit),
  };
}
