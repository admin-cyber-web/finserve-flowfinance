import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { logAudit, revokeUserSessions } from "../lib/server/convexHelpers";

/**
 * Fresh-start cleanup for KIRAT MICRO CREDIT.
 *
 * This module removes demo / sample / old operational records from the LIVE
 * database while preserving:
 *
 *   - the BM-10002 (Pankaj Tiwari, KNP) account — profile, credential, role,
 *     branch — and every SUPER_ADMIN account,
 *   - organisation configuration: branches, loanProducts, accountLedgers,
 *   - authentication infrastructure (users, sessions, accounts, auth config),
 *   - the append-only audit trail (auditLogs) and the double-entry ledger
 *     (journalEntries) — financial/accounting history is never destroyed,
 *   - application code and schema.
 *
 * Safety model:
 *   1. `exportSnapshot` MUST be run first: it writes a JSON backup of every
 *      table that the cleanup touches, both to Convex file storage (durable)
 *      and to the CLI (so a local copy can be kept).
 *   2. `runDemoCleanup` refuses to run without the exact confirmation phrase,
 *      so it can never be triggered accidentally.
 *   3. Convex mutations are transactional: either the whole cleanup commits
 *      or nothing does. The function only ever deletes rows from the tables
 *      listed in WIPE_TABLES plus rows that belong to a removed profile, so
 *      it is also safe to re-run — a second run simply reports zeros.
 *   4. Every run writes a DEMO_DATA_CLEANUP audit entry with the counts that
 *      were removed and the backup storage id.
 */

/** Exact phrase the operator must type to run the deletion. */
export const CLEANUP_CONFIRMATION = "KIRAT-FRESH-START";

/** Profiles that must survive the fresh start. Everything else is removable. */
export const PRESERVED_STAFF_IDS = ["BM-10002"] as const;

/**
 * Tables that are emptied completely. Configuration tables (branches,
 * loanProducts, accountLedgers), identity tables (users, profiles),
 * authTables, auditLogs and journalEntries are deliberately NOT here.
 */
const WIPE_TABLES: TableNames[] = [
  // clients + everything keyed by clientId
  "clients",
  "clientGeoPhotos",
  "clientFamilyMembers",
  "clientStaffHistory",
  "clientDocuments",
  "clientNotes",
  // loans + everything keyed by loanId / clientId
  "loanApplications",
  "loans",
  "loanSchedules",
  "collections",
  "receipts",
  // cash operations
  "cashHandovers",
  "cashIssues",
  "cashClosings",
  "expenses",
  // demo wallet movement (wallets themselves are kept for kept profiles so
  // the approved limit survives; their derived balance simply becomes 0)
  "walletTransactions",
  // grouping / field ops
  "centers",
  "groups",
  "groupMembers",
  "meetings",
  // reminders, approvals, recovery, complaints
  "notifications",
  "approvalRequests",
  "recoveryActivities",
  "grievances",
];

/** Tables copied into the backup before anything is deleted. */
const BACKUP_TABLES: TableNames[] = [...WIPE_TABLES, "wallets", "devices"];

/** Tables whose row counts the verification report checks. */
const REPORT_TABLES: TableNames[] = [
  ...WIPE_TABLES,
  "wallets",
  "devices",
  "profiles",
  "users",
  "counters",
  "branches",
  "loanProducts",
  "accountLedgers",
  "journalEntries",
  "auditLogs",
];

async function clearTable(
  ctx: MutationCtx,
  table: TableNames,
): Promise<number> {
  const rows = await ctx.db.query(table).collect();
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

/** Delete the private Convex storage blobs behind a client's uploads. */
async function deleteClientStorage(
  ctx: MutationCtx,
): Promise<{ documents: number; geoPhotos: number; coApplicant: number }> {
  let documents = 0;
  let geoPhotos = 0;
  let coApplicant = 0;

  const docRows = await ctx.db.query("clientDocuments").collect();
  for (const row of docRows) {
    if (row.storageId) {
      await ctx.storage.delete(row.storageId);
      documents += 1;
    }
  }

  const geoRows = await ctx.db.query("clientGeoPhotos").collect();
  for (const row of geoRows) {
    await ctx.storage.delete(row.storageId);
    geoPhotos += 1;
  }

  const clients = await ctx.db.query("clients").collect();
  for (const client of clients) {
    const photoId = client.coApplicant?.photoStorageId;
    if (photoId) {
      await ctx.storage.delete(photoId);
      coApplicant += 1;
    }
  }

  return { documents, geoPhotos, coApplicant };
}

/** True when this profile must survive the fresh start. */
function isPreservedProfile(profile: Doc<"profiles">): boolean {
  if (profile.role === "SUPER_ADMIN") return true;
  return (PRESERVED_STAFF_IDS as readonly string[]).includes(profile.staffId);
}

/** Shape returned by `snapshotData` (declared explicitly so the action
 * below — which reads it through `internal.cleanup` — can never become
 * circularly typed). */
type Snapshot = {
  takenAt: number;
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
};

/**
 * Reads every table the backup covers. Runs as an internal query because
 * only actions can write a Blob into Convex file storage.
 */
export const snapshotData = internalQuery({
  args: {},
  handler: async (ctx): Promise<Snapshot> => {
    const takenAt = Date.now();
    const counts: Record<string, number> = {};
    const tables: Record<string, unknown[]> = {};

    for (const table of BACKUP_TABLES) {
      const rows = await ctx.db.query(table).collect();
      tables[table] = rows as unknown[];
      counts[table] = rows.length;
    }

    // Identity tables: included so removed accounts can be recovered, but the
    // stored password/PIN hash is never exported.
    const profiles = await ctx.db.query("profiles").collect();
    tables.profiles = profiles.map((p) => ({
      ...p,
      credentialHash: p.credentialHash ? "[REDACTED]" : undefined,
    }));
    counts.profiles = profiles.length;

    const users = await ctx.db.query("users").collect();
    tables.users = users as unknown[];
    counts.users = users.length;

    // Configuration context (not deleted — recorded so the backup is
    // self-describing).
    const branches = await ctx.db.query("branches").collect();
    tables.branches = branches as unknown[];
    counts.branches = branches.length;
    const products = await ctx.db.query("loanProducts").collect();
    tables.loanProducts = products as unknown[];
    counts.loanProducts = products.length;
    const ledgers = await ctx.db.query("accountLedgers").collect();
    tables.accountLedgers = ledgers as unknown[];
    counts.accountLedgers = ledgers.length;
    const audits = await ctx.db.query("auditLogs").collect();
    tables.auditLogs = audits as unknown[];
    counts.auditLogs = audits.length;
    const journals = await ctx.db.query("journalEntries").collect();
    tables.journalEntries = journals as unknown[];
    counts.journalEntries = journals.length;

    return { takenAt, counts, tables };
  },
});

/**
 * Full JSON backup of every table the cleanup can touch.
 *
 * Credential hashes are redacted so no secret ever leaves the Convex backend.
 * The snapshot is stored in Convex file storage (durable, private) AND
 * returned so the operator can keep a local copy from the CLI output.
 */
export const exportSnapshot = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    ok: true;
    takenAt: number;
    storageId: string;
    bytes: number;
    counts: Record<string, number>;
    json: string | null;
  }> => {
    const snapshot: Snapshot = await ctx.runQuery(
      internal.cleanup.snapshotData,
      {},
    );
    const json = JSON.stringify(snapshot);
    const storageId = await ctx.storage.store(
      new Blob([json], { type: "application/json" }),
    );

    return {
      ok: true as const,
      takenAt: snapshot.takenAt,
      storageId,
      bytes: json.length,
      counts: snapshot.counts,
      // Large snapshots stay in file storage only, so the CLI output never
      // blows up; 1.5 MB is plenty for this database.
      json: json.length <= 1_500_000 ? json : null,
    };
  },
});

/**
 * Delete demo / sample / old operational records.
 *
 * Requires `confirm` to equal CLEANUP_CONFIRMATION. Run `exportSnapshot`
 * first and pass its storageId so the audit entry links to the backup.
 */
export const runDemoCleanup = internalMutation({
  args: {
    confirm: v.string(),
    backupStorageId: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { confirm, backupStorageId, note }) => {
    if (confirm !== CLEANUP_CONFIRMATION) {
      throw new Error(
        `Refusing to delete data: confirmation phrase must be exactly "${CLEANUP_CONFIRMATION}". Run exportSnapshot first and pass its storageId as backupStorageId.`,
      );
    }

    const startedAt = Date.now();
    const deleted: Record<string, number> = {};
    const bump = (table: string, n: number) => {
      if (n > 0) deleted[table] = (deleted[table] ?? 0) + n;
    };

    /* ------------------- 1. profiles that must go ------------------- */
    const profiles = await ctx.db.query("profiles").collect();
    const removedProfiles = profiles.filter((p) => !isPreservedProfile(p));
    let sessionsRevoked = 0;
    for (const profile of removedProfiles) {
      if (profile.userId) {
        sessionsRevoked += await revokeUserSessions(ctx, profile.userId);
      }
      const devices = await ctx.db
        .query("devices")
        .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
        .collect();
      for (const device of devices) await ctx.db.delete(device._id);
      bump("devices", devices.length);

      const wallets = await ctx.db
        .query("wallets")
        .withIndex("by_profile", (q) => q.eq("profileId", profile._id))
        .collect();
      for (const wallet of wallets) await ctx.db.delete(wallet._id);
      bump("wallets", wallets.length);

      await ctx.db.delete(profile._id);
      bump("profiles", 1);
    }
    if (sessionsRevoked > 0) deleted.authSessions = sessionsRevoked;

    /* ------------- 2. files attached to removed clients ------------- */
    const files = await deleteClientStorage(ctx);

    /* ------------------ 3. operational records ---------------------- */
    for (const table of WIPE_TABLES) {
      bump(table, await clearTable(ctx, table));
    }

    /* -------------- 4. wallets of removed profiles only -------------- */
    // (kept profiles keep their approved wallet limit; with all wallet
    //  transactions gone their derived balance is 0 — never stale)
    const allWallets = await ctx.db.query("wallets").collect();
    const profileIds = new Set(
      (await ctx.db.query("profiles").collect()).map((p) => p._id),
    );
    for (const wallet of allWallets) {
      if (!profileIds.has(wallet.profileId)) {
        await ctx.db.delete(wallet._id);
        bump("wallets", 1);
      }
    }

    /* ------------------- 5. code sequences -------------------------- */
    // Keep the counter rows (they are configuration lookups), reset the
    // sequences so a fresh start numbers clients/receipts from the top.
    const counters = await ctx.db.query("counters").collect();
    let resetCounters = 0;
    for (const counter of counters) {
      if (counter.value !== 0) {
        await ctx.db.patch(counter._id, { value: 0 });
        resetCounters += 1;
      }
    }

    /* ------------------- 6. accountability -------------------------- */
    const kept = {
      branches: (await ctx.db.query("branches").collect()).length,
      loanProducts: (await ctx.db.query("loanProducts").collect()).length,
      accountLedgers: (await ctx.db.query("accountLedgers").collect()).length,
      journalEntries: (await ctx.db.query("journalEntries").collect()).length,
      auditLogs: (await ctx.db.query("auditLogs").collect()).length,
      profiles: (await ctx.db.query("profiles").collect()).length,
      users: (await ctx.db.query("users").collect()).length,
    };
    const preservedProfiles = (await ctx.db.query("profiles").collect()).map(
      (p) => ({ staffId: p.staffId, name: p.name, role: p.role, status: p.status }),
    );

    await logAudit(ctx, {
      actorName: "fresh-start cleanup (operator)",
      role: "SYSTEM",
      action: "DEMO_DATA_CLEANUP",
      entity: "database",
      entityId: "fresh-start",
      before: { note: note ?? "demo/operational records present" },
      after: {
        deleted,
        storageFilesDeleted: files,
        countersReset: resetCounters,
        backupStorageId: backupStorageId ?? null,
        preservedProfiles,
        kept,
        startedAt,
        finishedAt: Date.now(),
      },
    });

    return {
      ok: true as const,
      deleted,
      storageFilesDeleted: files,
      countersReset: resetCounters,
      backupStorageId: backupStorageId ?? null,
      preservedProfiles,
      kept,
      finishedAt: Date.now(),
    };
  },
});

/**
 * Verification report: row counts, BM-10002 integrity, SUPER_ADMIN coverage,
 * configuration that survived, and an orphan scan (no broken references).
 */
export const freshStartReport = query({
  args: {},
  handler: async (ctx) => {
    const counts: Record<string, number> = {};
    for (const table of REPORT_TABLES) {
      counts[table] = (await ctx.db.query(table).collect()).length;
    }

    const profiles = await ctx.db.query("profiles").collect();
    const bm = profiles.find((p) => p.staffId === "BM-10002") ?? null;
    const bmBranch = bm?.branchId ? await ctx.db.get(bm.branchId) : null;
    const branches = await ctx.db.query("branches").collect();
    const knp = branches.find((b) => b.code === "KNP") ?? null;

    const clients = await ctx.db.query("clients").collect();
    const clientIds = new Set(clients.map((c) => c._id));
    const loans = await ctx.db.query("loans").collect();
    const loanIds = new Set(loans.map((l) => l._id));
    const groups = await ctx.db.query("groups").collect();
    const groupIds = new Set(groups.map((g) => g._id));
    const wallets = await ctx.db.query("wallets").collect();
    const walletIds = new Set(wallets.map((w) => w._id));
    const profileIds = new Set(profiles.map((p) => p._id));

    const orphans: Record<string, number> = {};
    const note = (key: string, n: number) => {
      if (n > 0) orphans[key] = n;
    };

    const docRows = await ctx.db.query("clientDocuments").collect();
    note("clientDocuments", docRows.filter((r) => !clientIds.has(r.clientId)).length);
    const geoRows = await ctx.db.query("clientGeoPhotos").collect();
    note("clientGeoPhotos", geoRows.filter((r) => !clientIds.has(r.clientId)).length);
    const noteRows = await ctx.db.query("clientNotes").collect();
    note("clientNotes", noteRows.filter((r) => !clientIds.has(r.clientId)).length);
    const famRows = await ctx.db.query("clientFamilyMembers").collect();
    note(
      "clientFamilyMembers",
      famRows.filter((r) => !clientIds.has(r.clientId)).length,
    );
    const staffHist = await ctx.db.query("clientStaffHistory").collect();
    note(
      "clientStaffHistory",
      staffHist.filter((r) => !clientIds.has(r.clientId)).length,
    );
    const schedules = await ctx.db.query("loanSchedules").collect();
    note(
      "loanSchedules",
      schedules.filter((r) => !loanIds.has(r.loanId)).length,
    );
    const collRows = await ctx.db.query("collections").collect();
    note(
      "collections",
      collRows.filter((r) => !clientIds.has(r.clientId)).length,
    );
    const receiptRows = await ctx.db.query("receipts").collect();
    note(
      "receipts",
      receiptRows.filter((r) => !clientIds.has(r.clientId)).length,
    );
    const memberRows = await ctx.db.query("groupMembers").collect();
    note(
      "groupMembers",
      memberRows.filter(
        (r) => !clientIds.has(r.clientId) || !groupIds.has(r.groupId),
      ).length,
    );
    const walletTx = await ctx.db.query("walletTransactions").collect();
    note(
      "walletTransactions",
      walletTx.filter(
        (r) => !walletIds.has(r.walletId) || !profileIds.has(r.profileId),
      ).length,
    );
    note(
      "wallets",
      wallets.filter((r) => !profileIds.has(r.profileId)).length,
    );
    const deviceRows = await ctx.db.query("devices").collect();
    note(
      "devices",
      deviceRows.filter((r) => !profileIds.has(r.profileId)).length,
    );
    const notifRows = await ctx.db.query("notifications").collect();
    note(
      "notifications",
      notifRows.filter((r) => !profileIds.has(r.profileId)).length,
    );
    note(
      "clientPortals",
      profiles.filter(
        (p) => p.role === "CLIENT" && p.clientId && !clientIds.has(p.clientId),
      ).length,
    );

    return {
      counts,
      bm: bm
        ? {
            exists: true,
            staffId: bm.staffId,
            name: bm.name,
            role: bm.role,
            status: bm.status,
            hasCredential: !!bm.credentialHash,
            branchCode: bmBranch?.code ?? null,
            branchName: bmBranch?.name ?? null,
          }
        : { exists: false as const },
      bmBranchMatchesKnp: !!(bm && knp && bm.branchId === knp._id),
      activeSuperAdmins: profiles.filter(
        (p) => p.role === "SUPER_ADMIN" && p.status === "ACTIVE",
      ).length,
      profiles: profiles.map((p) => ({
        staffId: p.staffId,
        name: p.name,
        role: p.role,
        status: p.status,
        branch: p.branchId
          ? branches.find((b) => b._id === p.branchId)?.code ?? null
          : null,
      })),
      orphans,
      orphanCount: Object.values(orphans).reduce((a, b) => a + b, 0),
    };
  },
});

/**
 * The cleanup's own audit entries (proof that the removal was recorded with
 * actor, timestamp, target and action). Read-only.
 */
export const cleanupAudit = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("auditLogs")
      .withIndex("by_entity", (q) => q.eq("entity", "database"))
      .collect();
    return rows
      .filter((r) => r.action === "DEMO_DATA_CLEANUP")
      .map((r) => ({
        action: r.action,
        actorName: r.actorName,
        role: r.role,
        entityId: r.entityId,
        createdAt: r.createdAt,
        after: r.after,
      }));
  },
});

/** Convenience: BM-10002 credential presence without exposing the hash. */
export const bmIntegrity = query({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_staffId", (q) => q.eq("staffId", "BM-10002"))
      .unique();
    if (!profiles) return { exists: false as const };
    return {
      exists: true as const,
      profileId: profiles._id as Id<"profiles">,
      role: profiles.role,
      status: profiles.status,
      hasCredential: !!profiles.credentialHash,
      branchId: profiles.branchId ?? null,
      mustChangePassword: profiles.mustChangePassword ?? false,
    };
  },
});
