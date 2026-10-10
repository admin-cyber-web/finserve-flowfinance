import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  AppError,
  logAudit,
  notify,
  requirePermission,
  requireProfile,
  requireRole,
} from "../lib/server/convexHelpers";
import { istDateKey } from "../lib/server/convexHelpers";
import {
  mobileNumber,
  optionalString,
  requiredString,
  intInRange,
  money,
  oneOf,
} from "../lib/finance/validate";
import { KYC_STATUS, DOC_STATUS } from "../lib/finance/types";
import {
  geoValidationError,
  MAX_CLIENT_PHOTO_BYTES,
  type GeoFix,
} from "../lib/geo";

/** Scope the client list to what this viewer is allowed to see. */
async function visibleClients(
  ctx: { db: any },
  me: Doc<"profiles">,
  opts: { staffId?: Id<"profiles"> | null; branchId?: Id<"branches"> | null } = {},
): Promise<Doc<"clients">[]> {
  let clients = await ctx.db.query("clients").collect();
  if (me.role === "FIELD_STAFF") {
    const target = opts.staffId ?? me._id;
    clients = clients.filter((c: Doc<"clients">) => c.assignedTo === target);
  } else if (me.role === "BRANCH_MANAGER") {
    clients = clients.filter((c: Doc<"clients">) => c.branchId === me.branchId);
  } else if (me.role === "ACCOUNTANT" || me.role === "CLIENT") {
    if (me.role === "CLIENT" && me.clientId) {
      clients = clients.filter((c: Doc<"clients">) => c._id === me.clientId);
    } else {
      clients = clients.filter((c: Doc<"clients">) =>
        opts.branchId ? c.branchId === opts.branchId : true,
      );
    }
  } else if (opts.branchId) {
    clients = clients.filter((c: Doc<"clients">) => c.branchId === opts.branchId);
  }
  if (opts.staffId && me.role !== "FIELD_STAFF") {
    clients = clients.filter((c: Doc<"clients">) => c.assignedTo === opts.staffId);
  }
  return clients;
}

export const list = query({
  args: {
    search: v.optional(v.string()),
    staffId: v.optional(v.id("profiles")),
    branchId: v.optional(v.id("branches")),
    kycStatus: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "view_clients");

    let clients = await visibleClients(ctx, me, {
      staffId: args.staffId ?? null,
      branchId: args.branchId ?? null,
    });
    if (args.kycStatus) clients = clients.filter((c) => c.kycStatus === args.kycStatus);

    const q = (args.search ?? "").trim().toLowerCase();
    if (q) {
      const digits = q.replace(/\D/g, "");
      clients = clients.filter(
        (c) =>
          c.searchText.includes(q) ||
          (digits.length >= 3 && c.mobile.includes(digits)) ||
          c.code.toLowerCase().startsWith(q),
      );
    }
    clients = clients.sort((a, b) => b.createdAt - a.createdAt);
    if (args.limit) clients = clients.slice(0, args.limit);

    const loans = await ctx.db.query("loans").collect();
    const profiles = await ctx.db.query("profiles").collect();
    const staffById = new Map(profiles.map((p) => [p._id, p]));

    return clients.map((c) => {
      const mine = loans.filter((l) => l.clientId === c._id);
      const active = mine.filter((l) => ["ACTIVE", "OVERDUE"].includes(l.status));
      const overdue = mine.filter((l) => l.status === "OVERDUE");
      return {
        ...c,
        staffName: staffById.get(c.assignedTo)?.name ?? "—",
        activeLoans: active.length,
        overdueLoans: overdue.length,
        outstanding: active.reduce((s, l) => s + l.outstanding, 0),
        overdueAmount: overdue.reduce((s, l) => s + l.outstanding, 0),
      };
    });
  },
});

/** Client 360° — everything about one client, in one query. */
export const get = query({
  args: { clientId: v.id("clients") },
  handler: async (ctx, { clientId }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "view_clients");
    const client = await ctx.db.get(clientId);
    if (!client) throw new AppError("Client not found.");
    if (me.role === "FIELD_STAFF" && client.assignedTo !== me._id) {
      // Staff may still open a client reassigned away — allow within branch.
      if (client.branchId !== me.branchId) throw new AppError("Not your client.");
    }
    if (me.role === "CLIENT" && me.clientId !== clientId) {
      throw new AppError("You can only view your own profile.");
    }

    const now = Date.now();
    const allLoans = await ctx.db.query("loans").collect();
    const loans = allLoans
      .filter((l) => l.clientId === clientId)
      .sort((a, b) => b.createdAt - a.createdAt);

    // Schedules for this client's loans (small N).
    const schedules: Record<string, Doc<"loanSchedules">[]> = {};
    for (const loan of loans) {
      schedules[loan.loanId] = (
        await ctx.db
          .query("loanSchedules")
          .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
          .collect()
      ).sort((a, b) => a.index - b.index);
    }

    const payments = (await ctx.db.query("collections").collect())
      .filter((c) => c.clientId === clientId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const receipts = (await ctx.db.query("receipts").collect())
      .filter((r) => r.clientId === clientId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const staffHistory = (await ctx.db.query("clientStaffHistory").collect())
      .filter((h) => h.clientId === clientId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const docRows = (await ctx.db.query("clientDocuments").collect())
      .filter((d) => d.clientId === clientId)
      .sort((a, b) => b.createdAt - a.createdAt);
    // Signed, short-lived URLs for stored files (e.g. the stamp) — issued only
    // to viewers who passed this query's client-level access checks.
    const documents = await Promise.all(
      docRows.map(async (d) => ({
        ...d,
        url: d.storageId ? await ctx.storage.getUrl(d.storageId) : null,
      })),
    );
    const notes = (await ctx.db.query("clientNotes").collect())
      .filter((n) => n.clientId === clientId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const recovery = (await ctx.db.query("recoveryActivities").collect())
      .filter((r) => r.clientId === clientId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const grievances = (await ctx.db.query("grievances").collect())
      .filter((g) => g.clientId === clientId)
      .sort((a, b) => b.createdAt - a.createdAt);

    const profiles = await ctx.db.query("profiles").collect();
    const byId = new Map(profiles.map((p) => [p._id, p]));

    const active = loans.filter((l) => ["ACTIVE", "OVERDUE"].includes(l.status));
    const closed = loans.filter((l) => l.status === "CLOSED");
    const totalBorrowed = loans
      .filter((l) => l.disbursedAt)
      .reduce((s, l) => s + l.principal, 0);
    const totalPaid = payments
      .filter((p) => p.status === "NORMAL")
      .reduce((s, p) => s + p.amount, 0);
    const outstanding = active.reduce((s, l) => s + l.outstanding, 0);

    // Overdue amount across every open installment.
    let overdueAmount = 0;
    for (const loan of active) {
      for (const row of schedules[loan.loanId] ?? []) {
        if (row.paid < row.totalDue && row.dueDate < now) {
          overdueAmount += row.totalDue - row.paid;
        }
      }
    }

    const center = client.centerCode
      ? ((await ctx.db.query("centers").collect()).find(
          (c) => c.code === client.centerCode,
        ) ?? null)
      : null;
    const group = client.groupCode
      ? ((await ctx.db.query("groups").collect()).find(
          (g) => g.code === client.groupCode,
        ) ?? null)
      : null;

    const activity = [
      ...staffHistory.map((h) => ({
        kind: "STAFF" as const,
        at: h.createdAt,
        text: `Assigned to ${byId.get(h.toStaffId)?.name ?? "—"}`,
        detail: h.reason ?? "",
      })),
      ...documents.map((d) => ({
        kind: "DOCUMENT" as const,
        at: d.createdAt,
        text: `${d.type.replace("_", " ")} uploaded — ${d.status.replace("_", " ").toLowerCase()}`,
        detail: d.fileName,
      })),
      ...payments.slice(0, 25).map((p) => ({
        kind: "PAYMENT" as const,
        at: p.createdAt,
        text: `${p.mode} payment ₹${p.amount.toLocaleString("en-IN")}${p.status === "REVERSED" ? " (reversed)" : p.status === "REVERSAL" ? " (reversal)" : ""}`,
        detail: p.receiptNumber ?? p.code,
      })),
      ...notes.map((n) => ({
        kind: "NOTE" as const,
        at: n.createdAt,
        text: n.body,
        detail: byId.get(n.profileId)?.name ?? "",
      })),
    ].sort((a, b) => b.at - a.at);

    return {
      client,
      assignedStaff: byId.get(client.assignedTo) ?? null,
      createdBy: byId.get(client.createdBy) ?? null,
      loans: loans.map((l) => ({
        loan: l,
        product: null,
        rows: schedules[l.loanId] ?? [],
      })),
      payments,
      receipts,
      staffHistory: staffHistory.map((h) => ({
        ...h,
        fromName: h.fromStaffId ? (byId.get(h.fromStaffId)?.name ?? null) : null,
        toName: byId.get(h.toStaffId)?.name ?? null,
        createdByName: byId.get(h.createdBy)?.name ?? null,
      })),
      documents,
      notes: notes.map((n) => ({ ...n, author: byId.get(n.profileId)?.name ?? null })),
      recovery,
      grievances,
      activity,
      center,
      group,
      totals: {
        totalBorrowed,
        totalPaid,
        outstanding,
        overdueAmount: Math.round(overdueAmount * 100) / 100,
        activeLoans: active.length,
        closedLoans: closed.length,
      },
    };
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    fatherName: v.optional(v.string()),
    age: v.number(),
    gender: v.string(),
    mobile: v.string(),
    altMobile: v.optional(v.string()),
    address: v.optional(v.string()),
    village: v.string(),
    district: v.optional(v.string()),
    state: v.optional(v.string()),
    pin: v.optional(v.string()),
    occupation: v.string(),
    monthlyIncome: v.number(),
    householdIncome: v.number(),
    familyMembers: v.number(),
    assignedTo: v.optional(v.id("profiles")),
    kycDocType: v.optional(v.string()),
    kycDocRef: v.optional(v.string()),
    documentName: v.optional(v.string()),
    photoName: v.optional(v.string()),
    centerCode: v.optional(v.string()),
    groupCode: v.optional(v.string()),
    device: v.optional(v.string()),
    // Mandatory geo-tagged client photo: the stamped JPEG the capture widget
    // uploaded to Convex storage (via a server-issued upload URL) plus the
    // device-reported GPS fix it was stamped with.
    photoStorageId: v.id("_storage"),
    // Mandatory stamp document (uploaded to private Convex storage via a
    // server-issued upload URL before this mutation runs).
    stampStorageId: v.id("_storage"),
    geo: v.object({
      latitude: v.number(),
      longitude: v.number(),
      accuracyMeters: v.number(),
      capturedAt: v.number(), // GPS fix timestamp
      photoCapturedAt: v.optional(v.number()), // photo frame timestamp (separate)
      permissionStatus: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "create_client");

    const name = requiredString(args.name, "name", 80);
    const village = requiredString(args.village, "village", 80);
    const occupation = requiredString(args.occupation, "occupation", 80);
    const mobile = mobileNumber(args.mobile);
    const age = intInRange(args.age, "age", 18, 100);
    const gender = oneOf(args.gender, ["MALE", "FEMALE", "OTHER"], "gender");

    // KYC — Aadhaar is mandatory for every NEW client (legacy rows are
    // untouched; this only guards creation). Enforced here as well as in the
    // form so a direct backend call cannot bypass it.
    const kycDocType =
      optionalString(args.kycDocType, "kycDocType", 40) ?? "AADHAAR";
    const kycDocRef = optionalString(args.kycDocRef, "kycDocRef", 40);
    if (!kycDocRef) {
      throw new AppError("Aadhaar number is required for KYC.");
    }
    if (kycDocType === "AADHAAR" && !/^\d{12}$/.test(kycDocRef)) {
      throw new AppError("Aadhaar must be exactly 12 digits.");
    }
    const monthlyIncome = money(args.monthlyIncome, "monthlyIncome", { allowZero: true });
    const householdIncome = money(args.householdIncome, "householdIncome", { allowZero: true });

    let branchId = me.branchId;
    if (!branchId) {
      if (me.role === "SUPER_ADMIN") {
        // Org-wide admin without a home branch (e.g. bootstrapped before the
        // org existed): default to the oldest active branch so onboarding is
        // never blocked by bootstrap ordering.
        const branches = (await ctx.db.query("branches").collect()).filter(
          (b: Doc<"branches">) => b.status === "ACTIVE",
        );
        branches.sort((a, b) => a._creationTime - b._creationTime);
        if (!branches[0]) {
          throw new AppError(
            "No active branch exists yet — create a branch before onboarding clients.",
          );
        }
        branchId = branches[0]._id;
      } else {
        throw new AppError("Your profile has no branch assigned.");
      }
    }

    const assignee = args.assignedTo ?? (me.role === "FIELD_STAFF" ? me._id : me._id);
    const assigneeProfile = await ctx.db.get(assignee);
    if (!assigneeProfile) throw new AppError("Assignee not found.");
    if (
      me.role === "BRANCH_MANAGER" &&
      assigneeProfile.branchId !== me.branchId
    ) {
      throw new AppError("You can only assign within your branch.");
    }
    branchId = assigneeProfile.branchId ?? branchId;

    // Client codes continue from the highest issued code.
    const existing = await ctx.db.query("clients").collect();
    const maxCode = existing.reduce((max, c) => {
      const n = Number(c.code.split("-")[1] ?? 0);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    const code = `C-${String(maxCode + 1).padStart(6, "0")}`;

    const now = Date.now();
    const clientId = await ctx.db.insert("clients", {
      code,
      name,
      fatherName: optionalString(args.fatherName, "fatherName", 80),
      age,
      gender,
      mobile,
      altMobile: args.altMobile ? mobileNumber(args.altMobile, "altMobile") : undefined,
      address: optionalString(args.address, "address", 200),
      village,
      district: optionalString(args.district, "district", 80) ?? "—",
      state: optionalString(args.state, "state", 80) ?? "Uttar Pradesh",
      pin: optionalString(args.pin, "pin", 8) ?? "000000",
      occupation,
      monthlyIncome,
      householdIncome: householdIncome || monthlyIncome,
      familyMembers: intInRange(args.familyMembers, "familyMembers", 1, 30),
      branchId,
      assignedTo: assignee,
      createdBy: me._id,
      kycStatus: "PENDING",
      kycDocType,
      kycDocRef,
      centerCode: optionalString(args.centerCode, "centerCode", 40),
      groupCode: optionalString(args.groupCode, "groupCode", 40),
      status: "ACTIVE",
      searchText: `${name} ${mobile} ${code} ${village}`.toLowerCase(),
      createdAt: now,
    });

    await ctx.db.insert("clientStaffHistory", {
      clientId,
      toStaffId: assignee,
      reason: "Client onboarding",
      createdBy: me._id,
      createdAt: now,
    });

    if (args.documentName) {
      await ctx.db.insert("clientDocuments", {
        clientId,
        type: "KYC",
        fileName: requiredString(args.documentName, "documentName", 120),
        status: "PENDING_VERIFICATION",
        uploadedBy: me._id,
        createdAt: now,
      });
    }
    if (args.photoName) {
      await ctx.db.insert("clientDocuments", {
        clientId,
        type: "CLIENT_PHOTO",
        fileName: requiredString(args.photoName, "photoName", 120),
        status: "UPLOADED",
        uploadedBy: me._id,
        createdAt: now,
      });
    }

    // ---- Mandatory geo-tagged client photo --------------------------------
    // Server-side re-validation: the browser's capture UI already blocks
    // stale/poor fixes, but the client is untrusted — the SAME rules run here
    // so fabricated coordinates, (0, 0) or stale timestamps can never be
    // stored. The photo was uploaded before this mutation ran, so every
    // rejection path deletes the uploaded file first (no orphaned photos),
    // and a thrown error rolls the whole mutation back (no half-created
    // client, so a retry can never duplicate the client).
    const geoFix: GeoFix = {
      latitude: args.geo.latitude,
      longitude: args.geo.longitude,
      accuracyMeters: args.geo.accuracyMeters,
      capturedAt: args.geo.capturedAt,
      permissionStatus: args.geo.permissionStatus ?? "granted",
    };
    const photoCapturedAt = args.geo.photoCapturedAt ?? args.geo.capturedAt;
    const geoError = geoValidationError(geoFix, now);
    if (geoError) {
      await ctx.storage.delete(args.photoStorageId);
      throw new AppError(`Client photo location rejected: ${geoError}`);
    }

    const meta = await ctx.db.system.get("_storage", args.photoStorageId);
    if (!meta) {
      throw new AppError("Uploaded client photo not found — capture and upload it again.");
    }
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!meta.contentType || !allowedTypes.includes(meta.contentType)) {
      await ctx.storage.delete(args.photoStorageId);
      throw new AppError("Client photo must be a JPEG, PNG or WebP image.");
    }
    if (meta.size <= 0 || meta.size > MAX_CLIENT_PHOTO_BYTES) {
      await ctx.storage.delete(args.photoStorageId);
      throw new AppError(
        `Client photo must be between 1 byte and ${Math.round(MAX_CLIENT_PHOTO_BYTES / 1024 / 1024)} MB.`,
      );
    }

    // ---- Mandatory stamp document -----------------------------------------
    const MAX_STAMP_BYTES = 5 * 1024 * 1024;
    const stampMeta = await ctx.db.system.get("_storage", args.stampStorageId);
    if (!stampMeta) {
      throw new AppError(
        "Uploaded stamp document not found — upload it again.",
      );
    }
    const stampTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ];
    if (!stampMeta.contentType || !stampTypes.includes(stampMeta.contentType)) {
      await ctx.storage.delete(args.stampStorageId);
      throw new AppError(
        "Stamp must be a JPEG, PNG, WebP or PDF file.",
      );
    }
    if (stampMeta.size <= 0 || stampMeta.size > MAX_STAMP_BYTES) {
      await ctx.storage.delete(args.stampStorageId);
      throw new AppError(
        `Stamp must be between 1 byte and ${Math.round(MAX_STAMP_BYTES / 1024 / 1024)} MB.`,
      );
    }

    const fileName = `client-photo-${code}.jpg`;
    await ctx.db.insert("clientGeoPhotos", {
      clientId,
      storageId: args.photoStorageId,
      fileName,
      sizeBytes: meta.size,
      mimeType: meta.contentType,
      latitude: geoFix.latitude,
      longitude: geoFix.longitude,
      accuracyMeters: Math.round(geoFix.accuracyMeters * 100) / 100,
      capturedAt: geoFix.capturedAt,
      photoCapturedAt,
      uploadedAt: now,
      uploadedBy: me._id,
      branchId,
      permissionStatus: geoFix.permissionStatus,
      device: args.device,
      status: "GEO_TAGGED",
    });

    const stampFileName = `client-stamp-${code}.${
      stampMeta.contentType === "application/pdf" ? "pdf" : "jpg"
    }`;
    await ctx.db.insert("clientDocuments", {
      clientId,
      type: "STAMP",
      fileName: stampFileName,
      status: "UPLOADED",
      uploadedBy: me._id,
      storageId: args.stampStorageId,
      sizeBytes: stampMeta.size,
      mimeType: stampMeta.contentType,
      createdAt: now,
    });

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "CLIENT_PHOTO_CAPTURED",
      entity: "clients",
      entityId: code,
      after: {
        fileName,
        sizeBytes: meta.size,
        latitude: geoFix.latitude,
        longitude: geoFix.longitude,
        accuracyMeters: geoFix.accuracyMeters,
        capturedAt: geoFix.capturedAt,
        photoCapturedAt,
        source: "device-reported",
      },
      referenceId: code,
      branchId,
      device: args.device,
    });

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "CLIENT_CREATED",
      entity: "clients",
      entityId: code,
      after: {
        name,
        mobile,
        village,
        assignedTo: assigneeProfile.name,
        kycDocType,
        // Masked in the audit trail — full Aadhaar stays on the client record.
        kycDocRefTail: `xxxx${kycDocRef.slice(-4)}`,
        stampFileName,
      },
      referenceId: code,
      branchId,
      device: args.device,
    });

    if (assignee !== me._id) {
      await notify(ctx, assignee, {
        title: "New client assigned",
        body: `${name} (${code}) has been assigned to you.`,
        kind: "SYSTEM",
        link: `/dashboard/clients/${clientId}`,
      });
    }

    return { ok: true, clientId, code };
  },
});

/**
 * Short-lived upload URL for the stamped client photo.
 *
 * Issued only to users who may create clients; the file lands in private
 * Convex storage and is linked to its client inside `create`, which re-checks
 * type/size from storage metadata and geo validity before committing.
 */
export const photoUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "create_client");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Latest geo-tagged photo for a client, with a short-lived signed URL.
 *
 * Read access mirrors `clients.get` scoping (field staff: own/branch clients,
 * client portal: own profile, other staff roles: as their page access), so
 * location data never reaches an unauthorized viewer. The URL is generated
 * on demand by Convex storage — photos are never exposed as permanent
 * public links.
 */
export const geoPhoto = query({
  args: { clientId: v.id("clients") },
  handler: async (ctx, { clientId }) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "view_clients");
    const client = await ctx.db.get(clientId);
    if (!client) throw new AppError("Client not found.");
    if (me.role === "FIELD_STAFF" && client.assignedTo !== me._id) {
      // Same rule as `get`: staff may still open a client reassigned away,
      // but only within their own branch.
      if (client.branchId !== me.branchId) throw new AppError("Not your client.");
    }
    if (me.role === "CLIENT" && me.clientId !== clientId) {
      throw new AppError("You can only view your own profile.");
    }

    const photo = await ctx.db
      .query("clientGeoPhotos")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .order("desc")
      .first();
    if (!photo) return null;

    const url = await ctx.storage.getUrl(photo.storageId);
    const { storageId: _storageId, ...rest } = photo;
    return { ...rest, url };
  },
});

export const update = mutation({
  args: {
    clientId: v.id("clients"),
    name: v.optional(v.string()),
    fatherName: v.optional(v.string()),
    mobile: v.optional(v.string()),
    altMobile: v.optional(v.string()),
    address: v.optional(v.string()),
    village: v.optional(v.string()),
    occupation: v.optional(v.string()),
    monthlyIncome: v.optional(v.number()),
    householdIncome: v.optional(v.number()),
    familyMembers: v.optional(v.number()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "edit_client");
    const client = await ctx.db.get(args.clientId);
    if (!client) throw new AppError("Client not found.");

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = requiredString(args.name, "name", 80);
    if (args.fatherName !== undefined)
      patch.fatherName = optionalString(args.fatherName, "fatherName", 80);
    if (args.mobile !== undefined) patch.mobile = mobileNumber(args.mobile);
    if (args.altMobile !== undefined)
      patch.altMobile = args.altMobile
        ? mobileNumber(args.altMobile, "altMobile")
        : undefined;
    if (args.address !== undefined)
      patch.address = optionalString(args.address, "address", 200);
    if (args.village !== undefined) patch.village = requiredString(args.village, "village", 80);
    if (args.occupation !== undefined)
      patch.occupation = requiredString(args.occupation, "occupation", 80);
    if (args.monthlyIncome !== undefined)
      patch.monthlyIncome = money(args.monthlyIncome, "monthlyIncome", { allowZero: true });
    if (args.householdIncome !== undefined)
      patch.householdIncome = money(args.householdIncome, "householdIncome", { allowZero: true });
    if (args.familyMembers !== undefined)
      patch.familyMembers = intInRange(args.familyMembers, "familyMembers", 1, 30);
    if (patch.name || patch.mobile) {
      patch.searchText = `${patch.name ?? client.name} ${patch.mobile ?? client.mobile} ${client.code} ${patch.village ?? client.village}`.toLowerCase();
    }

    await ctx.db.patch(args.clientId, patch);
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "CLIENT_UPDATED",
      entity: "clients",
      entityId: client.code,
      before: {
        name: client.name,
        mobile: client.mobile,
        village: client.village,
        occupation: client.occupation,
      },
      after: patch,
      referenceId: client.code,
      branchId: client.branchId,
      device: args.device,
    });
    return { ok: true };
  },
});

export const verifyKyc = mutation({
  args: {
    clientId: v.id("clients"),
    status: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { clientId, status, note }) => {
    const me = await requireProfile(ctx);
    requireRole(me, "SUPER_ADMIN", "BRANCH_MANAGER");
    const client = await ctx.db.get(clientId);
    if (!client) throw new AppError("Client not found.");
    const next = oneOf(status, KYC_STATUS, "kycStatus");

    await ctx.db.patch(clientId, {
      kycStatus: next,
      verifiedBy: next === "VERIFIED" ? me._id : client.verifiedBy,
      verifiedAt: next === "VERIFIED" ? Date.now() : client.verifiedAt,
    });

    const docs = (await ctx.db.query("clientDocuments").collect()).filter(
      (d) => d.clientId === clientId && d.type === "KYC",
    );
    for (const doc of docs) {
      await ctx.db.patch(doc._id, {
        status:
          next === "VERIFIED" ? "VERIFIED" : next === "REJECTED" ? "REJECTED" : "PENDING_VERIFICATION",
        verifiedBy: next === "VERIFIED" ? me._id : undefined,
        note: note ?? doc.note,
      });
    }

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "KYC_VERIFIED",
      entity: "clients",
      entityId: client.code,
      before: { kycStatus: client.kycStatus },
      after: { kycStatus: next, note },
      referenceId: client.code,
      branchId: client.branchId,
    });
    return { ok: true };
  },
});

/** Reassignment appends to staff history — the previous record is kept. */
export const assign = mutation({
  args: {
    clientId: v.id("clients"),
    toStaffId: v.id("profiles"),
    reason: v.string(),
  },
  handler: async (ctx, { clientId, toStaffId, reason }) => {
    const me = await requireProfile(ctx);
    requireRole(me, "SUPER_ADMIN", "BRANCH_MANAGER");
    const client = await ctx.db.get(clientId);
    const target = await ctx.db.get(toStaffId);
    if (!client || !target) throw new AppError("Client or staff not found.");
    if (target.branchId !== client.branchId) {
      throw new AppError("Target staff belongs to a different branch.");
    }
    const why = requiredString(reason, "reason", 200);

    await ctx.db.insert("clientStaffHistory", {
      clientId,
      fromStaffId: client.assignedTo,
      toStaffId,
      reason: why,
      createdBy: me._id,
      createdAt: Date.now(),
    });
    await ctx.db.patch(clientId, { assignedTo: toStaffId });

    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "CLIENT_REASSIGNED",
      entity: "clients",
      entityId: client.code,
      before: { assignedTo: client.assignedTo },
      after: { assignedTo: toStaffId, reason: why },
      referenceId: client.code,
      branchId: client.branchId,
    });
    await notify(ctx, toStaffId, {
      title: "Client reassigned",
      body: `${client.name} (${client.code}) is now assigned to you. ${why}`,
      kind: "SYSTEM",
      link: `/dashboard/clients/${clientId}`,
    });
    return { ok: true };
  },
});

export const addNote = mutation({
  args: { clientId: v.id("clients"), body: v.string() },
  handler: async (ctx, { clientId, body }) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "view_clients");
    const client = await ctx.db.get(clientId);
    if (!client) throw new AppError("Client not found.");
    const text = requiredString(body, "note", 1000);
    await ctx.db.insert("clientNotes", {
      clientId,
      profileId: me._id,
      body: text,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "NOTE_ADDED",
      entity: "clients",
      entityId: client.code,
      after: { note: text },
      branchId: client.branchId,
    });
    return { ok: true };
  },
});

/** Document upload stand-in: records the file name + verification state. */
export const addDocument = mutation({
  args: {
    clientId: v.id("clients"),
    type: v.string(),
    fileName: v.string(),
    status: v.optional(v.string()),
  },
  handler: async (ctx, { clientId, type, fileName, status }) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "edit_client");
    const client = await ctx.db.get(clientId);
    if (!client) throw new AppError("Client not found.");
    const docStatus = status
      ? oneOf(status, DOC_STATUS, "status")
      : "PENDING_VERIFICATION";
    const id = await ctx.db.insert("clientDocuments", {
      clientId,
      type: oneOf(type, ["CLIENT_PHOTO", "KYC", "ADDRESS_PROOF", "OTHER"], "type"),
      fileName: requiredString(fileName, "fileName", 120),
      status: docStatus,
      uploadedBy: me._id,
      createdAt: Date.now(),
    });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "DOCUMENT_UPLOADED",
      entity: "clients",
      entityId: client.code,
      after: { type, fileName, status: docStatus },
      branchId: client.branchId,
    });
    return { ok: true, documentId: id };
  },
});

export const decideDocument = mutation({
  args: {
    documentId: v.id("clientDocuments"),
    status: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { documentId, status, note }) => {
    const me = await requireProfile(ctx);
    requireRole(me, "SUPER_ADMIN", "BRANCH_MANAGER");
    const doc = await ctx.db.get(documentId);
    if (!doc) throw new AppError("Document not found.");
    const next = oneOf(status, ["VERIFIED", "REJECTED", "PENDING_VERIFICATION"], "status");
    await ctx.db.patch(documentId, {
      status: next,
      verifiedBy: next === "VERIFIED" ? me._id : undefined,
      note: note ?? doc.note,
    });
    const client = await ctx.db.get(doc.clientId);
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "DOCUMENT_DECIDED",
      entity: "clientDocuments",
      entityId: doc.fileName,
      before: { status: doc.status },
      after: { status: next, note },
      branchId: client?.branchId,
    });
    return { ok: true };
  },
});

/* ------------------------- Centres, groups & meetings --------------------- */

export const centres = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    const centers = (await ctx.db.query("centers").collect()).filter(
      (c) => !me.branchId || c.branchId === me.branchId || me.role === "SUPER_ADMIN",
    );
    const groups = (await ctx.db.query("groups").collect()).filter((g) =>
      centers.some((c) => c._id === g.centerId),
    );
    const members = await ctx.db.query("groupMembers").collect();
    const clients = await ctx.db.query("clients").collect();
    const meetings = (await ctx.db.query("meetings").collect()).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    return centers.map((c) => ({
      center: c,
      groups: groups
        .filter((g) => g.centerId === c._id)
        .map((g) => ({
          ...g,
          members: members
            .filter((m) => m.groupId === g._id)
            .map((m) => clients.find((cl) => cl._id === m.clientId))
            .filter(Boolean),
          meetings: meetings.filter((m) => m.groupId === g._id),
        })),
    }));
  },
});
