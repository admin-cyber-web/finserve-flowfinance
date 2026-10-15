import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { hashCredential, normalizeCredential } from "../lib/server/credentials";
import { logAudit } from "../lib/server/convexHelpers";

/**
 * One-off bootstrap for Pankaj Tiwari / BM-10002 / KNP.
 *
 * Creates the Branch Manager account with credential PIN 9876 and the exact
 * staff ID BM-10002 the organisation expects. This is the counterpart to the
 * existing `bootstrapSuperAdmin` one-off — delete this function after running
 * it once.
 */
export const bootstrapBm10002 = internalMutation({
  args: { credential: v.string() },
  handler: async (ctx, { credential }) => {
    // Resolve the KNP branch by code (branches table has no by_code index, so
    // we collect and find by code). We use the returned doc's _id so it is the
    // branded Id<"branches"> the schema expects.
    const branches = await ctx.db.query("branches").collect();
    const knp = branches.find((b) => b.code === "KNP");
    if (!knp) throw new Error("KNP branch not found in the database.");

    // Idempotent: if BM-10002 already exists, just ensure the credential and
    // status are correct and return the existing record.
    const existing = (
      await ctx.db.query("profiles").collect()
    ).find((p) => p.staffId === "BM-10002");

    if (existing) {
      if (existing.role !== "BRANCH_MANAGER" || existing.branchId !== knp._id) {
        throw new Error(
          `A profile with staffId BM-10002 exists but is not the expected BRANCH_MANAGER in KNP: ${JSON.stringify({ role: existing.role, branchId: existing.branchId })}`,
        );
      }
      await ctx.db.patch(existing._id, {
        status: "ACTIVE",
        credentialHash: await hashCredential(normalizeCredential(credential)),
        mustChangePassword: false,
      });
      await logAudit(ctx, {
        actorId: existing._id,
        actorName: existing.name,
        role: existing.role,
        action: "BM_10002_CREDENTIAL_SET",
        entity: "profiles",
        entityId: "BM-10002",
        after: { credentialSet: true, status: "ACTIVE" },
        branchId: knp._id,
      });
      return { ok: true, created: false as const, profileId: existing._id, staffId: "BM-10002" };
    }

    const createAt = Date.now();
    const profileId = await ctx.db.insert("profiles", {
      name: "Pankaj Tiwari",
      mobile: "9876543210",
      email: undefined,
      role: "BRANCH_MANAGER",
      branchId: knp._id,
      status: "ACTIVE",
      staffId: "BM-10002",
      credentialHash: await hashCredential(normalizeCredential(credential)),
      joiningDate: createAt,
      createdAt: createAt,
      failedLoginAttempts: 0,
      createdBy: undefined,
    });

    const profile = await ctx.db.get(profileId);

    await logAudit(ctx, {
      actorId: profileId,
      actorName: "Pankaj Tiwari",
      role: "BRANCH_MANAGER",
      action: "STAFF_CREATED",
      entity: "profiles",
      entityId: "BM-10002",
      after: {
        name: "Pankaj Tiwari",
        role: "BRANCH_MANAGER",
        status: "ACTIVE",
        branchId: knp._id,
        mobile: "9876543210",
        credentialSet: true,
        tempPin: "provided",
      },
      branchId: knp._id,
    });

    return { ok: true, created: true as const, profileId, staffId: "BM-10002", profileName: profile?.name };
  },
});
