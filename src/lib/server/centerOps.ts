import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  AppError,
  logAudit,
  type Mtx,
} from "./convexHelpers";
import { optionalString, requiredString } from "../finance/validate";

/**
 * Shared centre (center) operations — the single source of truth for
 * creating centres, generating Centre IDs (six-digit, e.g. 257510), linking
 * clients to centres and building centre-wise reports.
 *
 * The Centre ID is generated ONCE, when the centre is created, and stored
 * permanently on the centre record. Clients only ever reference it — they
 * never generate their own.
 */

/**
 * Allocate the next globally unique six-digit Centre ID (e.g. 257510).
 *
 * ONE `counters` row (key "centers") drives the sequence for the whole
 * application — not a counter per branch or per centre name — so IDs are
 * unique across every branch, district and centre name. The first allocation
 * seeds a random six-digit number; every later call increments from the
 * stored value. Every candidate is checked against every existing centre
 * code inside the same transaction, and Convex serialises mutation commits
 * (OCC with automatic retry), so a duplicate can never be issued even by
 * concurrent creations — a colliding candidate is skipped and the sequence
 * advances. Users never type a Centre ID themselves.
 */
export async function nextCenterCode(ctx: Mtx): Promise<string> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_key", (q) => q.eq("key", "centers"))
    .unique();
  const used = new Set(
    (await ctx.db.query("centers").collect()).map((c) => c.code),
  );
  let n = counter
    ? counter.value + 1
    : 100000 + Math.floor(Math.random() * 900000);
  for (let i = 0; i < 900000; i += 1) {
    if (n < 100000 || n > 999999) n = 100000;
    const code = String(n).padStart(6, "0");
    if (!used.has(code)) {
      if (counter) {
        if (counter.value !== n) await ctx.db.patch(counter._id, { value: n });
      } else {
        await ctx.db.insert("counters", { key: "centers", value: n });
      }
      return code;
    }
    n += 1;
  }
  throw new AppError(
    "Could not allocate a unique six-digit Centre ID — please retry.",
  );
}

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

  // A centre name must be meaningful — it drives duplicate prevention and
  // the name search in the centre picker.
  const letters = name.toUpperCase().replace(/[^A-Z]/g, "");
  if (letters.length < 3) {
    throw new AppError("Centre name must contain at least 3 letters.");
  }

  // Unique, system-generated six-digit Centre ID (e.g. 257510): allocated on
  // the backend, globally unique across the whole application, never typed
  // or supplied by the frontend.
  const code = await nextCenterCode(ctx);

  const now = Date.now();
  const centerId = await ctx.db.insert("centers", {
    code,
    name,
    // Branch comes from the AUTHENTICATED staff member's own profile — a
    // frontend-supplied branch can never place a centre elsewhere.
    branchId,
    village,
    // Creating staff member, from the backend identity.
    staffId: me._id,
    createdBy: me._id,
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
